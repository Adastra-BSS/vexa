/**
 * recording-tap.reconnect - the recording keeps every participant, including one who drops and rejoins.
 *
 * Two field failures this guards:
 *   - The prod incident (Attend, vexa meeting 1366, 2026-10-22): the tap mixed the page's audio ONCE at
 *     start. A participant dropped 36 s in, Teams renegotiated, and the rejoined participant's audio
 *     arrived on a NEW track that was never mixed in: every 15 s chunk after that was silent opus.
 *   - A live dev test (2026-10-30): the mix connected audio per STREAM. Teams carried two participants'
 *     tracks in one stream, a MediaStreamAudioSourceNode plays only one track of its stream, and the
 *     recording kept the organizer while the other speaker was never heard.
 *
 * This drives the REAL createRecordingTap against stub browser globals (document, MediaStream,
 * AudioContext, MediaRecorder, the rescan interval, the Audio Hook's window event) and replays both:
 *   1. three participants on the page when recording starts - all three are mixed;
 *   2. two participants' tracks in ONE stream - both are mixed, not just the first;
 *   3. one drops: their track ends, and the dead source is pruned from the mix;
 *   4. they rejoin on a new track in a new element - it is mixed in at once on the Audio Hook's event,
 *      and on the next rescan when no event comes;
 *   5. later rescans never connect a track twice (doubled audio), and an element read through
 *      captureStream() is captured once, not once per rescan;
 *   6. the recorder is never restarted: one MediaRecorder, on the mixer's stable stream, so the
 *      recording stays one continuous file;
 *   7. when every track has ended (the meeting is closing), the buffered tail is flushed once.
 *
 * Run: npx tsx src/recording-tap.reconnect.test.ts
 */

// ---- stub browser globals, installed before importing the brick -----------------------------
const listeners = new Map<string, Set<() => void>>();
(globalThis as any).window = {
  logBot: (_m: string) => {},
  addEventListener: (type: string, fn: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
  removeEventListener: (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); },
};
/** What the Audio Hook does after mirroring a new remote track. */
const hookMirrored = () => { for (const fn of listeners.get('vexa:remote-audio-track') ?? []) fn(); };
(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');

let trackSeq = 0;
class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  constructor(public id: string = `track-${++trackSeq}`) {}
  end() { this.readyState = 'ended'; }
}

let streamSeq = 0;
class FakeMediaStream {
  id = `stream-${++streamSeq}`;
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [new FakeTrack()]) { this.tracks = tracks; }
  getAudioTracks() { return this.tracks; }
}
(globalThis as any).MediaStream = FakeMediaStream;

/** An <audio>: either carries its stream as srcObject (the mirrored WebRTC tracks), or only
 *  exposes captureStream(), which mints a new stream on every call as a browser does. */
class FakeAudioElement {
  captureCalls = 0;
  constructor(public srcObject: FakeMediaStream | null, private captured?: () => FakeMediaStream) {}
  captureStream() {
    this.captureCalls++;
    return this.captured ? this.captured() : new FakeMediaStream();
  }
}

let page: FakeAudioElement[] = [];
(globalThis as any).document = { querySelectorAll: (_sel: string) => page };

/** The mix as the AudioContext hears it: which tracks feed the destination right now, and how many
 *  source nodes were ever made per track (two would mean the same voice mixed twice). Like the real
 *  MediaStreamAudioSourceNode, a source plays only the FIRST audio track of the stream it is given. */
const feeding = new Set<string>();
const sourcesMade = new Map<string, number>();
let destStream: FakeMediaStream | null = null;
class FakeAudioContext {
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamDestination() {
    destStream = new FakeMediaStream([new FakeTrack('mix-destination')]);
    return { stream: destStream };
  }
  createMediaStreamSource(stream: FakeMediaStream) {
    const heard = stream.getAudioTracks()[0].id;
    sourcesMade.set(heard, (sourcesMade.get(heard) ?? 0) + 1);
    return {
      connect(_dest: unknown) { feeding.add(heard); },
      disconnect() { feeding.delete(heard); },
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
  // The organizer on their own stream, two more people sharing one stream - as Teams delivers them.
  const alice = new FakeTrack('alice');
  const bob = new FakeTrack('bob');
  const carol = new FakeTrack('carol');
  page = [new FakeAudioElement(new FakeMediaStream([alice])), new FakeAudioElement(new FakeMediaStream([bob, carol]))];

  const tap = createRecordingTap({ onChunk: async () => true, timesliceMs: 15000 });
  await tap.start();

  console.log('\n=== recording starts with three participants ===');
  check('all three are mixed', mixed(), ['alice', 'bob', 'carol']);
  check('...including both tracks of the stream they share', ['bob', 'carol'].every((id) => feeding.has(id)), true);
  check('one recorder, recording the mix', [recorders.length, recorders[0]?.stream === destStream], [1, true]);

  console.log('\n=== bob drops: his track ends, his element is still on the page ===');
  bob.end();
  tick();
  check('the dead track is pruned from the mix', mixed(), ['alice', 'carol']);

  console.log('\n=== bob rejoins on a new track in a fresh <audio> (Teams renegotiated) ===');
  const bobAgain = new FakeTrack('bob-rejoined');
  page.push(new FakeAudioElement(new FakeMediaStream([bobAgain])));
  hookMirrored();
  check('the rejoined track is mixed in at once, on the Audio Hook event', mixed(), ['alice', 'bob-rejoined', 'carol']);

  console.log('\n=== a track that arrives with no event ===');
  const dave = new FakeTrack('dave');
  page.push(new FakeAudioElement(new FakeMediaStream([dave])));
  tick();
  check('the next rescan mixes it in', mixed().includes('dave'), true);

  console.log('\n=== the meeting goes on: many rescans and events ===');
  for (let i = 0; i < 10; i++) { tick(); hookMirrored(); }
  check('no track is ever given a second source node', Array.from(sourcesMade.values()).every((n) => n === 1), true);
  check('the mix is unchanged', mixed(), ['alice', 'bob-rejoined', 'carol', 'dave']);
  check('still the same single recorder, never restarted', [recorders.length, recorders[0]?.state], [1, 'recording']);

  console.log('\n=== an element read through captureStream() ===');
  const screenAudio = new FakeTrack('captured');
  const captured = new FakeAudioElement(null, () => new FakeMediaStream([screenAudio]));
  page.push(captured);
  for (let i = 0; i < 5; i++) tick();
  check('is captured once, not once per rescan', captured.captureCalls, 1);
  check('...and mixed in', mixed().includes('captured'), true);

  console.log('\n=== everyone leaves: every track ends ===');
  for (const t of [alice, carol, bobAgain, dave, screenAudio]) t.end();
  tick();
  check('the mix is empty', mixed(), []);
  check('the recorder flushes its buffered tail once', recorders[0]?.requestDataCalls, 1);
  tick();
  check('...and not again on the next rescan', recorders[0]?.requestDataCalls, 1);

  await tap.stop();
  check('stopping ends the rescan and the event listener', [rescans.length, listeners.get('vexa:remote-audio-track')?.size ?? 0], [0, 0]);

  console.log(`\n=== summary: ${failed ? `${failed} failed` : 'all passed'} ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('FAIL -', e?.message || e); process.exit(1); });
