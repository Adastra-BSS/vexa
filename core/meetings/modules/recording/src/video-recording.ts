/**
 * VideoRecordingService — x11grab + PulseAudio capture, emitted as recording.v1 chunks.
 *
 * ONE ffmpeg captures the bot's Xvfb display AND the meeting audio (record_sink.monitor) in a single
 * process, so both streams share one clock: lip-sync is inherent, with no server-side offset and no
 * post-hoc mux step to get wrong.
 *
 * WHY SEGMENTS RATHER THAN ONE FILE. The previous shape wrote a single file and uploaded it after the
 * meeting. Two problems, and the second is the one that bites in practice:
 *   - a SIGKILLed / OOMed / evicted bot loses the whole recording, and a plain mp4 killed mid-write is
 *     not even playable (its index is written last);
 *   - even a GRACEFUL stop has only the signal handler's force-exit budget (<25s) to push the bytes,
 *     which an hour of 1080p will not fit.
 * Uploading each segment the moment it is written removes both: the chunks are already on the server,
 * and the master is assembled there on read (finalize_master is re-assemblable, not write-once).
 *
 * WHY THE HLS MUXER. It is used ONLY as a segmenter, never served as HLS: `-hls_segment_type fmp4`
 * writes `init.mp4` plus `chunk-NNNNN.m4s` fragments whose PLAIN BYTE CONCATENATION is a valid
 * fragmented mp4 (this is what CMAF is). That is exactly what meeting-api's existing master builder
 * does for non-wav formats, so video needs no new assembly path — chunk 0 is the init segment and the
 * fragments follow in seq order. The playlist is written but ignored and never uploaded.
 *
 * Codec is h264 + aac, fixed: the only combination that plays natively everywhere, including the
 * SharePoint/Stream player the harvest publishes into. Hardware encoding stays selectable because the
 * encode is the dominant CPU cost of a video bot, and a bot pool sized for audio has none spare.
 *
 * The meeting audio reaches ffmpeg because the bot's entrypoint makes `record_sink` the default
 * PulseAudio output, so Chromium renders the meeting there and `record_sink.monitor` is its loopback.
 * That sink is best-effort, so the source is PROBED before ffmpeg starts and its absence drops the
 * audio input rather than the capture: one ffmpeg with two mapped inputs exits when EITHER cannot be
 * opened, so an unreadable monitor previously took the video down with it. A silent recording of the
 * meeting is worth having; no recording is not. The transcript never comes through here - the page
 * captures it inside Chromium - so nothing on this path can affect it either way.
 */
import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './log';

/** Hardware encode selection (VIDEO_HWACCEL). `none` = libx264, the case the bot pool is sized on. */
export type VideoHwAccel = 'none' | 'vaapi' | 'nvenc';

/** The init segment is always chunk 0; `chunk-NNNNN.m4s` takes chunk_seq NNNNN+1. */
export const VIDEO_INIT_SEGMENT = 'init.mp4';

/** recording.v1 `format` for the concatenated fragmented-mp4 master. */
export const VIDEO_MEDIA_FORMAT = 'mp4';

/** `chunk-NNNNN.m4s` name pattern — the only fragments the segmenter writes. */
const FRAGMENT_NAME = /^chunk-(\d+)\.m4s$/;

/**
 * The recording.v1 chunk_seq a segment file must carry, or null when the name is not ours (the
 * playlist ffmpeg also writes into this directory, and its temp files).
 */
export function seqForSegment(name: string): number | null {
  if (name === VIDEO_INIT_SEGMENT) return 0;
  const m = FRAGMENT_NAME.exec(name);
  return m ? parseInt(m[1], 10) + 1 : null;
}

export interface VideoRecordingOptions {
  meetingId: number;
  sessionUid: string;
  /**
   * Fires once per fully-written segment. `seq` is the recording.v1 chunk_seq, derived from the
   * FILENAME rather than the firing order — 0 for the init segment, NNNNN+1 for `chunk-NNNNN.m4s`
   * — so a watcher event that arrives late or out of order still concatenates in the right place.
   */
  onSegment?: (seq: number, absPath: string) => void;
}

export class VideoRecordingService {
  private proc: ChildProcess | null = null;
  private running = false;
  private startTime = 0;
  private readonly dir: string;
  private readonly display: string;
  private readonly audioSource: string;
  private readonly videoSize: string;
  private readonly outputHeight: string;
  private readonly fps: string;
  private readonly preset: string;
  private readonly crf: string;
  private readonly audioBitrate: string;
  private readonly audioRate: string;
  private readonly segmentSeconds: string;
  private readonly hwaccel: VideoHwAccel;
  private watcher: fs.FSWatcher | null = null;
  /** Emitted segment filenames, so a duplicate fs.watch event cannot upload the same bytes twice. */
  private emitted = new Set<string>();

  public onSegment: VideoRecordingOptions['onSegment'];

  constructor(opts: VideoRecordingOptions) {
    this.onSegment = opts.onSegment;
    this.display = process.env.DISPLAY || ':99';
    this.audioSource = process.env.RECORD_AUDIO_SOURCE || 'record_sink.monitor';
    // The CAPTURE geometry, which must match the bot's Xvfb display: x11grab selects a region, so a
    // smaller value here crops rather than shrinks. Use VIDEO_OUTPUT_HEIGHT to make the file smaller.
    this.videoSize = process.env.VIDEO_RESOLUTION || '1920x1080';
    // The stored height. 720 rather than the captured 1080 because a meeting is faces and shared
    // slides, both legible at 720p, and the pixel count is a permanent storage cost.
    this.outputHeight = process.env.VIDEO_OUTPUT_HEIGHT || '720';
    this.fps = process.env.VIDEO_FRAMERATE || '10';
    this.preset = process.env.VIDEO_PRESET || 'veryfast';
    this.crf = process.env.VIDEO_CRF || '28';
    // 16 kHz mono at 48k: this is speech, and the transcript is produced at 16 kHz anyway. Stereo
    // 128k triples the audio for a room where nobody is positioned in the stereo field.
    this.audioBitrate = process.env.VIDEO_AUDIO_BITRATE || '48k';
    this.audioRate = process.env.VIDEO_AUDIO_SAMPLE_RATE || '16000';
    this.segmentSeconds = process.env.RECORD_SEGMENT_SECONDS || '15';
    this.hwaccel = (process.env.VIDEO_HWACCEL || 'none').toLowerCase() as VideoHwAccel;
    this.dir = path.join('/tmp', `video_${opts.meetingId}_${opts.sessionUid}`);
  }

  start(): void {
    if (this.running) { log('[VideoRecording] already running'); return; }
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* exists */ }

    const audio = this.resolveAudioSource();
    const args = this.buildArgs(audio);  // throws on an unknown hwaccel (fail LOUD, not silently degraded)
    log(`[VideoRecording] starting ffmpeg (hwaccel=${this.hwaccel}, capture ${this.videoSize}`
      + ` -> ${this.scaleFilter() ? `${this.outputHeight}p` : 'native'}@${this.fps}fps, `
      + `x264 ${this.preset} crf${this.crf}, ${this.segmentSeconds}s segments, `
      + `audio=${audio ?? 'NONE — recording will be silent'})`);
    this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.running = true;
    this.startTime = Date.now();

    this.proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (/error|failed|invalid/i.test(text)) log(`[VideoRecording] ffmpeg: ${text}`);
    });
    this.proc.on('exit', (code) => { this.running = false; log(`[VideoRecording] ffmpeg exited ${code}`); });
    this.proc.on('error', (e) => { this.running = false; log(`[VideoRecording] ffmpeg spawn error: ${e.message}`); });

    this.startWatcher();
  }

  /**
   * SIGTERM lets ffmpeg finish the segment it is writing, then we sweep the directory for anything
   * the watcher did not catch. Resolves once every segment has been handed to `onSegment`.
   */
  async stop(): Promise<void> {
    if (this.proc && this.running) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(force); resolve(); };
        this.proc!.once('exit', done);
        this.proc!.kill('SIGTERM');
        // Deliberately short: the caller is inside the bot's shutdown budget, and every segment
        // before this one is already uploaded, so losing the tail costs seconds, not the recording.
        const force = setTimeout(() => { this.proc?.kill('SIGKILL'); resolve(); }, 10_000);
      });
    }
    this.finalize();
  }

  async cleanup(): Promise<void> {
    try { await fs.promises.rm(this.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  getStartTime(): number { return this.startTime; }
  isActive(): boolean { return this.running; }

  // ── ffmpeg ──────────────────────────────────────────────────────────────────

  /**
   * The output scale, as an ffmpeg filter, or null to encode at the captured size.
   *
   * A DOWNSCALE, never a smaller capture: `-video_size` on the x11grab input selects a REGION, so
   * asking it for 1280x720 of a 1920x1080 display records the top-left corner and silently loses
   * the rest of the meeting. The display is always captured whole and resized here instead.
   *
   * `-2` for the width keeps the aspect ratio and rounds to an even number, which h264 requires.
   */
  private scaleFilter(): string | null {
    const target = parseInt(this.outputHeight, 10);
    if (!Number.isFinite(target) || target <= 0) return null;
    const captured = parseInt(this.videoSize.split('x')[1] ?? '', 10);
    if (Number.isFinite(captured) && captured === target) return null;
    return `scale=-2:${target}`;
  }

  /** h264 encoder for the selected hwaccel. An unknown value throws rather than degrading silently. */
  private videoEncoderArgs(): string[] {
    const scale = this.scaleFilter();
    switch (this.hwaccel) {
      case 'none':
        // `preset` is the single biggest lever on file size, and the default is deliberately NOT
        // ultrafast: measured on a real 25-minute standup, ultrafast produced ~4x the bytes of
        // veryfast at identical resolution and crf, while both encode far faster than realtime. The
        // CPU ultrafast buys is headroom a meeting-length encode never needs, and the storage it
        // costs accumulates for as long as the recording is kept.
        return [
          ...(scale ? ['-vf', scale] : []),
          '-c:v', 'libx264', '-preset', this.preset, '-crf', this.crf, '-pix_fmt', 'yuv420p',
        ];
      case 'vaapi':
        // The scale runs BEFORE the hwupload: once frames are on the GPU this filter chain cannot
        // touch them.
        return [
          '-vaapi_device', '/dev/dri/renderD128',
          '-vf', `${scale ? `${scale},` : ''}format=nv12,hwupload`,
          '-c:v', 'h264_vaapi', '-qp', this.crf,
        ];
      case 'nvenc':
        return [
          ...(scale ? ['-vf', scale] : []),
          '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', this.crf, '-pix_fmt', 'yuv420p',
        ];
      default:
        throw new Error(`VIDEO_HWACCEL="${this.hwaccel}" unknown (none|vaapi|nvenc)`);
    }
  }

  /**
   * The PulseAudio source to record, or null to capture the screen alone.
   *
   * Asked of PulseAudio rather than assumed, because ffmpeg maps both inputs and dies when either
   * cannot be opened: an absent sink would cost the whole recording, not just its sound. The sink
   * is created best-effort by the bot's entrypoint, so "absent" is a state this must survive.
   */
  private resolveAudioSource(): string | null {
    try {
      const sources = execFileSync('pactl', ['list', 'short', 'sources'], {
        encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const found = sources.split('\n').some((line) => line.split('\t')[1] === this.audioSource);
      if (found) return this.audioSource;
      log(`[VideoRecording] PulseAudio source "${this.audioSource}" is not present — capturing video only`);
      return null;
    } catch (e) {
      log(`[VideoRecording] could not list PulseAudio sources (${String(e)}) — capturing video only`);
      return null;
    }
  }

  private buildArgs(audioSource: string | null): string[] {
    return [
      '-y',
      // Video: the bot's own Xvfb. Each bot has its own display, so concurrent bots cannot capture
      // each other's screen. -draw_mouse 0 keeps a stray cursor out of the frame.
      '-f', 'x11grab', '-draw_mouse', '0', '-framerate', this.fps, '-video_size', this.videoSize, '-i', this.display,
      // Audio: the monitor of the sink Chromium renders the meeting into, so the video carries its
      // sound. Omitted entirely when absent - a mapped input that cannot be opened is fatal.
      ...(audioSource ? ['-f', 'pulse', '-i', audioSource] : []),
      '-map', '0:v:0',
      ...(audioSource ? ['-map', '1:a:0'] : []),
      ...this.videoEncoderArgs(),
      ...(audioSource ? ['-c:a', 'aac', '-b:a', this.audioBitrate, '-ar', this.audioRate, '-ac', '1'] : []),
      // Every segment must start on a keyframe, or the concatenated master is undecodable from that
      // fragment onward.
      '-force_key_frames', `expr:gte(t,n_forced*${this.segmentSeconds})`,
      // The HLS muxer as a SEGMENTER only (see the file header): init.mp4 + .m4s fragments, whose
      // byte concatenation is a valid fragmented mp4. The playlist is never uploaded.
      '-f', 'hls',
      '-hls_time', this.segmentSeconds,
      '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_flags', 'independent_segments',
      '-hls_fmp4_init_filename', VIDEO_INIT_SEGMENT,
      '-hls_segment_filename', path.join(this.dir, 'chunk-%05d.m4s'),
      path.join(this.dir, 'playlist.m3u8'),
    ];
  }

  // ── segment discovery ───────────────────────────────────────────────────────

  /**
   * Emit segments as they become safe to read. ffmpeg writes `chunk-N` incrementally, so `chunk-N`
   * appearing is the signal that `chunk-(N-1)` is complete; the init segment is complete as soon as
   * the first fragment opens. The tail is swept by finalize() on stop.
   */
  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.dir, (_event, filename) => {
        if (!filename) return;
        const m = FRAGMENT_NAME.exec(filename.toString());
        if (!m) return;
        // init.mp4 is complete once ANY fragment has been opened — ffmpeg writes it first.
        this.emit(VIDEO_INIT_SEGMENT);
        const n = parseInt(m[1], 10);
        if (n > 0) this.emit(`chunk-${String(n - 1).padStart(5, '0')}.m4s`);
      });
    } catch (e) {
      log(`[VideoRecording] watcher failed, falling back to the stop-time sweep: ${String(e)}`);
    }
  }

  /**
   * Hand one segment to the uploader, once. Empty files are skipped — ffmpeg creates a segment
   * before it writes it, so a zero-byte stat means "not ready", and a later event (or the stop-time
   * sweep) picks it up.
   *
   * chunk_seq comes from the NAME, not from a counter: ffmpeg's `chunk-%05d` is already the write
   * order, and deriving the seq from it means a dropped, duplicated or out-of-order watcher event
   * cannot transpose two fragments. The server orders by chunk_seq, so correct placement survives.
   */
  private emit(name: string): void {
    if (this.emitted.has(name)) return;
    const seq = seqForSegment(name);
    if (seq === null) return;
    const abs = path.join(this.dir, name);
    let size = 0;
    try { size = fs.statSync(abs).size; } catch { return; }   // not written yet — a later event retries
    if (size === 0) return;
    this.emitted.add(name);
    try { this.onSegment?.(seq, abs); } catch (e) { log(`[VideoRecording] onSegment error: ${String(e)}`); }
  }

  /**
   * Close the watcher and sweep the directory for anything it missed — the init segment on a
   * meeting too short to produce a fragment, the final fragment ffmpeg flushed on SIGTERM, and any
   * event the watcher dropped. Idempotent (emit dedups by name).
   */
  private finalize(): void {
    try { this.watcher?.close(); } catch { /* noop */ }
    this.watcher = null;
    this.emit(VIDEO_INIT_SEGMENT);
    try {
      const fragments = fs.readdirSync(this.dir).filter((f) => FRAGMENT_NAME.test(f)).sort();
      for (const f of fragments) this.emit(f);
    } catch { /* directory already cleaned */ }
  }
}
