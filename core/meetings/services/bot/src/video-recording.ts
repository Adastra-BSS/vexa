/**
 * Video recording wiring — the server-side x11grab capture, delivered as recording.v1 chunks.
 *
 * VideoRecordingService captures the bot's Xvfb display plus the meeting audio in one ffmpeg and
 * hands each finished fragment here; this file uploads it through the SAME chunk endpoint the audio
 * recording already uses (`inv.recordingUploadUrl`), tagged `media_type: "video"` so meeting-api
 * keys it to its own MediaFile. The master is assembled server-side on read, so nothing here has to
 * concatenate or hold the recording in memory.
 *
 * Uploads are SERIALIZED on a promise queue: chunk_seq order is what makes the server's byte-concat
 * reproduce a playable fragmented mp4, so fragment N must land before N+1. A failed upload is logged
 * and skipped rather than retried forever — losing one 15-second fragment degrades the recording,
 * whereas blocking the queue would lose everything after it.
 *
 * Gating: `recordingEnabled` plus either `captureModes` including "video" or RECORD_VIDEO=true on the
 * deployment. The env form exists because the capture cost is a deployment property (a bot pool sized
 * for audio cannot absorb an encode), so an operator must be able to turn it off without touching the
 * control plane.
 *
 * L4-gated (needs ffmpeg + PulseAudio + a live X display) — proven on a real bot, not unit tests.
 * Every path is best-effort: a recording fault must never change the bot's join/leave/exit.
 */
import * as fs from 'fs';
import { RecordingService, VideoRecordingService, VIDEO_MEDIA_FORMAT } from '@vexa/recording';
import type { Invocation } from './config.js';

/** True when this invocation should capture the display as well as the audio. */
export function wantsVideoCapture(inv: Invocation, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!inv.recordingEnabled) return false;
  if (Array.isArray(inv.captureModes) && inv.captureModes.includes('video')) return true;
  return env.RECORD_VIDEO === 'true';
}

/**
 * Start video capture and stream its fragments to the recordings chunk endpoint. Returns an
 * idempotent best-effort stop that flushes the tail fragment and sends the empty `is_final` chunk
 * that flips the recording to COMPLETED.
 *
 * Call from pipeline.start() (post-admission, so capture begins once the meeting is actually
 * rendering) and the returned stop from pipeline.stop().
 */
export function startVideoRecording(inv: Invocation, log: (m: string) => void): () => Promise<void> {
  const meetingId = inv.meeting_id ?? 0;
  const sessionUid = inv.connectionId ?? inv.nativeMeetingId ?? 'session';
  const uploadUrl = inv.recordingUploadUrl;
  const token = inv.internalSecret ?? '';

  // A video recording shares the audio recording's session_uid on purpose: meeting-api keys the
  // MediaFile on (session_uid, media_type), so the two land as siblings of one Recording row.
  const uploader = uploadUrl ? new RecordingService(meetingId, sessionUid) : null;
  let queue: Promise<void> = Promise.resolve();
  let uploaded = 0;
  let lastSeq = -1;

  let svc: VideoRecordingService | null = null;
  try {
    svc = new VideoRecordingService({
      meetingId,
      sessionUid,
      onSegment: (seq, absPath) => {
        lastSeq = Math.max(lastSeq, seq);
        if (!uploader || !uploadUrl) return;
        queue = queue.then(async () => {
          try {
            const bytes = await fs.promises.readFile(absPath);
            await uploader.uploadChunk(uploadUrl, token, bytes, seq, false, VIDEO_MEDIA_FORMAT, 'video');
            uploaded += 1;
          } catch (e) {
            // Skip, do not retry: the next fragment is already being written, and a stalled queue
            // would cost the rest of the meeting rather than these few seconds.
            log(`video-rec: fragment ${seq} upload failed, skipping: ${String(e)}`);
          }
        });
      },
    });
    svc.start();
    log(`video-rec: started (session ${sessionUid})`);
  } catch (e) {
    log(`video-rec: start FAILED (session ${sessionUid}): ${String(e)}`);
    svc = null;
  }

  let stopped = false;
  return async () => {
    if (stopped || !svc) return;
    stopped = true;
    const s = svc;
    try {
      await s.stop();   // flushes the tail fragment through onSegment
      await queue;      // drain the uploads those emitted
      if (uploader && uploadUrl && uploaded > 0) {
        // The empty is_final chunk is the COMPLETED signal — the same convention the audio sink
        // uses. Sent only when something actually uploaded, so a capture that never produced a
        // fragment does not register an empty video media-file.
        try {
          await uploader.uploadChunk(uploadUrl, token, Buffer.alloc(0), lastSeq + 1, true, VIDEO_MEDIA_FORMAT, 'video');
          log(`video-rec: finalized ${uploaded} fragment(s) (session ${sessionUid})`);
        } catch (e) {
          log(`video-rec: finalize failed (session ${sessionUid}): ${String(e)}`);
        }
      } else if (uploaded === 0) {
        log(`video-rec: no fragments produced (session ${sessionUid}) — nothing to finalize`);
      }
    } catch (e) {
      log(`video-rec: stop FAILED (session ${sessionUid}): ${String(e)}`);
    } finally {
      await s.cleanup().catch(() => { /* best-effort */ });
    }
  };
}
