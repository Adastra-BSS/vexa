/**
 * recording-tap.reconnect - the recording follows a participant who drops and rejoins.
 *
 * The prod incident (Attend, vexa meeting 1366, 2026-10-22): the tap mixed the page's audio
 * elements ONCE at start. A participant dropped 36 s in, Teams renegotiated, and the rejoined
 * participant's audio arrived on a NEW track in a fresh <audio> element that was never mixed in.
 * Every 15 s chunk after that was silent opus (~3.4 KB) for the remaining 25 minutes, while the
 * speaking signal showed the conversation going on.
 *
 * This drives the REAL createRecordingTap against stub browser globals (document, MediaStream,
 * AudioContext, MediaRecorder, the rescan interval) and replays that meeting:
 *   1. three participants are on the page when recording starts - all three are mixed;
 *   2. one drops: their track ends, and the dead source is pruned from the mix;
 *   3. they rejoin on a new track in a new element - the new stream IS mixed in (the bug);
 *   4. later rescans never connect a stream twice (doubled audio), and an element read through
 *      captureStream() is captured once, not once per rescan;
 *   5. the recorder is never restarted: one MediaRecorder, on the mixer's stable stream, so the
 *      recording stays one continuous file;
 *   6. when every track has ended (the meeting is closing), the buffered tail is flushed once.
 *
 * Run: npx tsx src/recording-tap.reconnect.test.ts
 */

// ---- stub browser globals, installed before importing the brick -----------------------------
(globalThis as any).window = { logBot: (_m: string) => {} };
(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
}

let streamSeq = 0;
class FakeMediaStream {
  id: string;
  private tracks: FakeTrack[];
  constructor(id?: string, tracks: FakeTrack[] = [new FakeTrack()]) {
    this.id = id ?? `stream-${++streamSeq}`;
    this.tracks = tracks;
  }
  getAudioTracks() { return this.tracks; }
  end() { for (const t of this.tracks) t.readyState = 'ended'; }
}
(globalThis as any).MediaStream = FakeMediaStream;

/** An <audio>: either carries its stream as srcObject (the mirrored WebRTC tracks), or only
 *  exposes captureStream(), which mints a new stream on every call as a browser does. */
class FakeAudioElement {
  srcObject: FakeMediaStream | null;
  captureCalls = 0;
  constructor(stream: FakeMediaStream | null, private captured?: () => FakeMediaStream) {
    this.srcObject = stream;
  }
  captureStream() {
    this.captureCalls++;
    return this.captured ? this.captured() : new FakeMediaStream();
  }
}

let page: FakeAudioElement[] = [];
(globalThis as any).document = { querySelectorAll: (_sel: string) => page };

/** The mix as the AudioContext sees it: which streams feed the destination right now, and how
 *  many source nodes were ever made per stream (two would mean the same audio mixed twice). */
const feeding = new Set<string>();
const sourcesMade = new Map<string, number>();
let destStream: FakeMediaStream | null = null;
class FakeAudioContext {
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamDestination() {
    destStream = new FakeMediaStream('mix-destination');
    return { stream: destStream };
  }
  createMediaStreamSource(stream: FakeMediaStream) {
    sourcesMade.set(stream.id, (sourcesMade.get(stream.id) ?? 0) + 1);
    return {
      connect(_dest: unknown) { feeding.add(stream.id); },
      disconnect() { feeding.delete(stream.id); },
    };
  }
}
(globalThis as any).AudioContext = FakeAudioContext;

const recorders: FakeMediaRecorder[] = [];
class FakeMediaRecorder {
  static isTypeSupported(mime: string) { return mime === 'audio/webm;codecs=opus'; }
  onstart: (() => void) | null = null;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  requestDataCalls = 0;
  constructor(public stream: unknown, public opts?: { mimeType?: string }) { recorders.push(this); }
  start(_timeslice?: number) { this.state = 'recording'; this.onstart?.(); }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  requestData() { this.requestDataCalls++; }
}
(globalThis as any).MediaRecorder = FakeMediaRecorder;
(globalThis as any).window.MediaRecorder = FakeMediaRecorder;

/** The 2 s rescan, run by the test instead of the clock. */
let rescans: Array<() => void> = [];
(globalThis as any).setInterval = (fn: () => void, _ms: number) => { rescans.push(fn); return rescans.length; };
(globalThis as any).clearInterval = (_id: unknown) => { rescans = []; };
const tick = () => { for (const fn of rescans) fn(); };

import { createRecordingTap } from './index';

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
  if (!ok) failed++;
}
const mixed = () => Array.from(feeding).sort();

async function main() {
  // Three participants, as when the bot was admitted at 14:01:03.
  const alice = new FakeMediaStream('alice');
  const bob = new FakeMediaStream('bob');
  const carol = new FakeMediaStream('carol');
  page = [new FakeAudioElement(alice), new FakeAudioElement(bob), new FakeAudioElement(carol)];

  const tap = createRecordingTap({ onChunk: async () => true, timesliceMs: 15000 });
  await tap.start();

  console.log('\n=== recording starts with three participants ===');
  check('all three are mixed', mixed(), ['alice', 'bob', 'carol']);
  check('one recorder, recording the mix', [recorders.length, recorders[0]?.stream === destStream], [1, true]);

  console.log('\n=== bob drops: his track ends, his element is still on the page ===');
  bob.end();
  tick();
  check('the dead source is pruned from the mix', mixed(), ['alice', 'carol']);

  console.log('\n=== bob rejoins on a new track in a fresh <audio> (Teams renegotiated) ===');
  const bobAgain = new FakeMediaStream('bob-rejoined');
  page.push(new FakeAudioElement(bobAgain));
  tick();
  check('the rejoined track is mixed in - the bug: it never was', mixed(), ['alice', 'bob-rejoined', 'carol']);

  console.log('\n=== the meeting goes on: many rescans ===');
  for (let i = 0; i < 10; i++) tick();
  check('no stream is ever given a second source node', Array.from(sourcesMade.values()).every((n) => n === 1), true);
  check('the mix is unchanged', mixed(), ['alice', 'bob-rejoined', 'carol']);
  check('still the same single recorder, never restarted', [recorders.length, recorders[0]?.state], [1, 'recording']);

  console.log('\n=== an element read through captureStream() ===');
  const screenAudio = new FakeMediaStream('captured');
  const captured = new FakeAudioElement(null, () => screenAudio);
  page.push(captured);
  for (let i = 0; i < 5; i++) tick();
  check('is captured once, not once per rescan', captured.captureCalls, 1);
  check('...and mixed in', mixed().includes('captured'), true);

  console.log('\n=== everyone leaves: every track ends ===');
  for (const s of [alice, carol, bobAgain, screenAudio]) s.end();
  tick();
  check('the mix is empty', mixed(), []);
  check('the recorder flushes its buffered tail once', recorders[0]?.requestDataCalls, 1);
  tick();
  check('...and not again on the next rescan', recorders[0]?.requestDataCalls, 1);

  await tap.stop();
  check('stopping ends the rescan', rescans.length, 0);

  console.log(`\n=== summary: ${failed ? `${failed} failed` : 'all passed'} ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FAIL -', e?.message || e); process.exit(1); });
