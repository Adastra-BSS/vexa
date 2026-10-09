/**
 * The speaker timeline a post-call transcription names its voices from. OFFLINE, no browser.
 *
 * With in-call STT off, the lit Teams tile is the only record of who spoke when, and it dies with
 * the pod unless the terminal lifecycle event carries it out. Asserts the collector's contract
 * (hint stream in, recording-relative spans out) AND the orchestrator wiring: the terminal event
 * carries the timeline, a non-terminal one never does.
 * Run: npx tsx src/speaker-timeline.test.ts
 */
import { createSpeakerTimeline, MAX_SPEAKER_EVENTS } from './speaker-timeline.js';
import { createOrchestrator } from './orchestrator.js';
import type { Invocation } from './config.js';
import type { LifecycleEvent } from './contracts.js';
import type { JoinDriver, Pipeline, ActsSource, LifecycleSink } from './ports.js';
import { noopAloneness } from './test-doubles.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  - ' + detail}`);
  if (!cond) failed++;
};
const show = (v: unknown): string => JSON.stringify(v);

const T0 = 1_780_000_000_000;

console.log('speaker timeline: collector');
{
  const tl = createSpeakerTimeline();
  tl.markRecordingStart(T0);
  // The watcher re-sends "start" every 2 s for as long as the tile stays lit.
  tl.record('Woller, David', T0 + 1000, false);
  tl.record('Woller, David', T0 + 3000, false);
  tl.record('Woller, David', T0 + 5000, false);
  tl.record('Woller, David', T0 + 6000, true);
  tl.record('Eichler, Petr', T0 + 7000, false);
  tl.record('Eichler, Petr', T0 + 9000, true);
  const snap = tl.snapshot();
  check('re-sent starts collapse into one span per turn, relative to the recording', show(snap.speaker_events) === show([
    { name: 'Woller, David', start_ms: 1000, end_ms: 6000 },
    { name: 'Eichler, Petr', start_ms: 7000, end_ms: 9000 },
  ]), show(snap.speaker_events));
  check('the recording t0 rides along on the epoch clock', snap.recording_t0_ms === T0, show(snap.recording_t0_ms));
}
{
  const tl = createSpeakerTimeline();
  tl.markRecordingStart(T0);
  tl.record('Woller, David', T0 + 1000, false);
  tl.record('Woller, David', T0 + 3000, false);
  // No end event: the tile stopped re-sending, then lit again much later.
  tl.record('Woller, David', T0 + 20_000, false);
  tl.record('Woller, David', T0 + 21_000, true);
  const spans = tl.snapshot().speaker_events ?? [];
  check('a start long after the last re-send opens a new turn instead of bridging the silence', show(spans) === show([
    { name: 'Woller, David', start_ms: 1000, end_ms: 3000 },
    { name: 'Woller, David', start_ms: 20_000, end_ms: 21_000 },
  ]), show(spans));
}
{
  const tl = createSpeakerTimeline();
  tl.markRecordingStart(T0);
  tl.record('Woller, David', T0 + 1000, false);
  tl.record('Woller, David', T0 + 3000, false);
  const spans = tl.snapshot().speaker_events ?? [];
  check('a turn still open at teardown is closed at its last sighting', show(spans) === show([
    { name: 'Woller, David', start_ms: 1000, end_ms: 3000 },
  ]), show(spans));
}
{
  const tl = createSpeakerTimeline();
  tl.record('Woller, David', T0 - 4000, false);
  tl.record('Woller, David', T0 - 1000, true);
  tl.markRecordingStart(T0);
  tl.record('Eichler, Petr', T0 - 500, false);
  tl.record('Eichler, Petr', T0 + 1500, true);
  const spans = tl.snapshot().speaker_events ?? [];
  check('speech before the recording started is dropped or clipped to t0', show(spans) === show([
    { name: 'Eichler, Petr', start_ms: 0, end_ms: 1500 },
  ]), show(spans));
}
{
  const tl = createSpeakerTimeline();
  tl.record('Woller, David', T0 + 1000, false);
  tl.record('Woller, David', T0 + 2000, true);
  const snap = tl.snapshot();
  check('without a recording there is nothing to place the timeline in, so nothing is reported',
    snap.speaker_events === undefined && snap.recording_t0_ms === undefined, show(snap));
}
{
  const tl = createSpeakerTimeline();
  tl.markRecordingStart(T0);
  tl.markRecordingStart(T0 + 60_000);
  tl.record('Woller, David', T0 + 1000, false);
  tl.record('Woller, David', T0 + 2000, true);
  check('only the first recording start is t0', tl.snapshot().recording_t0_ms === T0, show(tl.snapshot()));
}
{
  const tl = createSpeakerTimeline();
  tl.markRecordingStart(T0);
  for (let i = 0; i < MAX_SPEAKER_EVENTS + 50; i++) {
    tl.record(`P${i % 3}`, T0 + i * 10_000, false);
    tl.record(`P${i % 3}`, T0 + i * 10_000 + 500, true);
  }
  tl.record('x'.repeat(1000), T0 + 1, false);
  const spans = tl.snapshot().speaker_events ?? [];
  check('the timeline is capped so a marathon meeting cannot bloat the lifecycle event',
    spans.length === MAX_SPEAKER_EVENTS, String(spans.length));
  check('an absurd name is truncated', spans.every((s) => s.name.length <= 200), 'long name kept');
}

async function wiring(): Promise<void> {
console.log('speaker timeline: terminal lifecycle wiring');
const inv = {
  platform: 'teams', meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x', botName: 'B',
  connectionId: 'conn-tl-1', redisUrl: 'redis://unused:6379', nativeMeetingId: 'x',
} as Invocation;
{
  const events: LifecycleEvent[] = [];
  const lifecycle: LifecycleSink = { async emit(e) { events.push(e); } };
  const join: JoinDriver = {
    async join(report) { await report('awaiting_admission'); return 'admitted'; },
    onRemoval() { return () => { /* */ }; },
    async leave() { /* */ }, async withdraw() { /* */ },
  };
  const pipeline: Pipeline = { async start() { /* */ }, async stop() { /* */ } };
  const acts: ActsSource = { subscribe() { return () => { /* */ }; } };
  const tl = createSpeakerTimeline();
  tl.markRecordingStart(T0);
  tl.record('Woller, David', T0 + 1000, false);
  tl.record('Woller, David', T0 + 2000, true);
  const orchestrator = createOrchestrator(inv, {
    lifecycle, join, pipeline, acts, aloneness: noopAloneness(),
    degraded: () => tl.snapshot(),
  });
  await orchestrator.run({ maxActiveMs: 50 });
  const terminal = events[events.length - 1] as LifecycleEvent & { speaker_events?: unknown; recording_t0_ms?: unknown };
  check('the terminal event carries the timeline', show(terminal.speaker_events) === show([
    { name: 'Woller, David', start_ms: 1000, end_ms: 2000 },
  ]) && terminal.recording_t0_ms === T0, show(terminal));
  const earlier = events.slice(0, -1) as Array<LifecycleEvent & { speaker_events?: unknown }>;
  check('no non-terminal event carries it', earlier.every((e) => e.speaker_events === undefined), show(earlier));
}

}

wiring().then(() => {
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nall speaker-timeline checks passed');
}).catch((e) => { console.error(e); process.exit(1); });
