/**
 * video-segments — the chunk_seq mapping the video master's playability rests on.
 *
 * The video path uploads ffmpeg's fmp4 segments as recording.v1 chunks and lets the server's
 * byte-concat be the container. That only produces a playable file if the init segment lands at a
 * lower chunk_seq than every fragment and the fragments keep ffmpeg's write order — so the seq must
 * be a pure function of the FILENAME, never of the order fs.watch happened to fire.
 *
 * Pure (no ffmpeg, no display, no I/O). The capture itself is L4 — proven on a live bot.
 *
 * No assert lib — same shape as assemble.smoke.test.ts (tsx + exit).
 */
import { buildRecordingMaster, seqForSegment, VIDEO_INIT_SEGMENT, VIDEO_MEDIA_FORMAT } from './index';

const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

const frag = (n: number) => `chunk-${String(n).padStart(5, '0')}.m4s`;

// ── the mapping: init is 0, chunk-NNNNN is NNNNN+1 ───────────────────────────
{
  check(seqForSegment(VIDEO_INIT_SEGMENT) === 0, 'init segment is not chunk_seq 0');
  check(seqForSegment(frag(0)) === 1, 'chunk-00000 is not chunk_seq 1');
  check(seqForSegment(frag(42)) === 43, 'chunk-00042 is not chunk_seq 43');
  // ffmpeg rolls past 5 digits rather than truncating; an hour of 15s segments is only 240.
  check(seqForSegment('chunk-123456.m4s') === 123457, 'a 6-digit fragment name is not accepted');
}

// ── everything else in the directory is not ours ─────────────────────────────
{
  check(seqForSegment('playlist.m3u8') === null, 'the playlist was treated as a segment');
  check(seqForSegment('chunk-00000.m4s.tmp') === null, 'an ffmpeg temp file was treated as a segment');
  check(seqForSegment('chunk-.m4s') === null, 'a nameless fragment was treated as a segment');
  check(seqForSegment('init.mp4.tmp') === null, 'a partial init segment was treated as a segment');
}

// ── the invariant: discovery order cannot transpose two fragments ────────────
{
  // The order a dropped/duplicated/late fs.watch event could produce.
  const discovered = [frag(2), VIDEO_INIT_SEGMENT, frag(0), frag(2), frag(1)];
  const seen = new Set<string>();
  const placed: Array<{ seq: number; name: string }> = [];
  for (const name of discovered) {
    if (seen.has(name)) continue;          // the service dedups by name
    seen.add(name);
    const seq = seqForSegment(name);
    if (seq !== null) placed.push({ seq, name });
  }
  // The server orders by chunk_seq — that ordering must be ffmpeg's write order.
  const ordered = [...placed].sort((a, b) => a.seq - b.seq).map((p) => p.name);
  const expected = [VIDEO_INIT_SEGMENT, frag(0), frag(1), frag(2)];
  check(
    ordered.join(',') === expected.join(','),
    `out-of-order discovery transposed the master: got ${ordered.join(',')}`,
  );
  check(placed.length === 4, 'the duplicate fragment was not deduped');
}

// ── mp4 assembles by the same byte-concat as webm (no new builder) ───────────
{
  const init = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]); // ftyp box header
  const f0 = Buffer.from([0x00, 0x00, 0x00, 0x10, 0x6d, 0x6f, 0x6f, 0x66]);   // moof box header
  const f1 = Buffer.from([0x00, 0x00, 0x00, 0x10, 0x6d, 0x64, 0x61, 0x74]);   // mdat box header
  const master = buildRecordingMaster(VIDEO_MEDIA_FORMAT, [init, f0, f1, Buffer.alloc(0)]);
  check(master.equals(Buffer.concat([init, f0, f1])), 'mp4 master != byte-concat of its segments');
  check(master.subarray(4, 8).toString('ascii') === 'ftyp', 'mp4 master does not start with the init segment');
}

if (fails.length) {
  console.log('❌ FAIL —\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log('✅ PASS — chunk_seq comes from the segment name (init=0, chunk-NNNNN=NNNNN+1), out-of-order discovery cannot transpose the master, and mp4 assembles by byte-concat.');
process.exit(0);
