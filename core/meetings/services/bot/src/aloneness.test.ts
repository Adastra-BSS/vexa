/** Deterministic proof for silence-based active-phase aloneness. */
import {
  DEFAULT_ALONE_SILENCE_WINDOW_MS,
  DEFAULT_EMPTY_ROOM_WINDOW_MS,
  createRemoteAudioActivityTap,
  createSilenceAlonenessSource,
  resolveAloneSilenceWindowMs,
  resolveEmptyRoomWindowMs,
} from './aloneness.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? '✅' : '❌'} ${name}${condition ? '' : ` — ${detail}`}`);
  if (!condition) failed++;
};

class FakeClock {
  nowMs = 0;
  now = (): number => this.nowMs;
  advance(ms: number): void { this.nowMs += ms; }
}

class FakeScheduler {
  private callbacks = new Map<number, () => void>();
  private nextId = 1;
  readonly setInterval = (callback: () => void, _ms: number): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };
  readonly clearInterval = (id: unknown): void => { this.callbacks.delete(id as number); };
  tick(): void { for (const callback of [...this.callbacks.values()]) callback(); }
  get activeCount(): number { return this.callbacks.size; }
}

const loudEnergy = 0.02;
const quietEnergy = 0.001;

function fixture(windowMs = 1_000, emptyRoomMs = 0) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const activity = createRemoteAudioActivityTap({ now: clock.now });
  const source = createSilenceAlonenessSource({
    activity,
    windowMs,
    emptyRoomMs,
    now: clock.now,
    pollMs: 10,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
    log: () => { /* deterministic fixture: logs asserted by live evidence */ },
  });
  return { clock, scheduler, activity, source };
}

// silence(W) fires once from the capture-ready anchor.
{
  const f = fixture();
  let fired = 0;
  f.activity.ready();
  const stop = f.source.onAlone(() => fired++);
  f.clock.advance(999); f.scheduler.tick();
  check('silence before W does not fire', fired === 0);
  f.clock.advance(1); f.scheduler.tick();
  f.scheduler.tick();
  check('silence at W fires exactly once', fired === 1);
  check('exactly-once verdict stops polling', f.scheduler.activeCount === 0);
  stop();
}

// A qualifying REMOTE frame at W-epsilon resets the full window.
{
  const f = fixture();
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.clock.advance(999);
  f.activity.observeRemoteEnergy(loudEnergy);
  f.clock.advance(999); f.scheduler.tick();
  check('remote speech at W-epsilon resets the window', fired === 0);
  f.clock.advance(1); f.scheduler.tick();
  check('reset window eventually fires', fired === 1);
}

// Repeated remote speech keeps the room active.
{
  const f = fixture();
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  for (let i = 0; i < 4; i++) {
    f.clock.advance(750);
    f.activity.observeRemoteEnergy(loudEnergy);
    f.scheduler.tick();
  }
  check('repeated remote speech prevents leave', fired === 0);
}

// Local bot speech has no path into the REMOTE activity tap, so silence still elapses.
{
  const f = fixture();
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.clock.advance(500);
  // The bot speaks locally here; only remote capture is allowed to call observeRemoteEnergy().
  f.scheduler.tick();
  f.clock.advance(500); f.scheduler.tick();
  check('local bot speech does not reset remote silence', fired === 1);
}

// A QUIET delivered frame is still presence. Capture is the single silence oracle: the page emits
// a frame only when its PEAK clears the capture gate, and this tap sits downstream of it — so an
// arriving frame has already proven it carries audio and was transcribed on that basis. Re-judging
// it by RMS (always <= peak) could only discard real speech, letting the bot leave a meeting it
// could hear. Quiet must NOT reset-suppress.
{
  const f = fixture();
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.clock.advance(900);
  f.activity.observeRemoteEnergy(quietEnergy);
  f.clock.advance(100); f.scheduler.tick();
  check('a quiet delivered frame counts as presence (no false leave)', fired === 0);
}

// ...but digital silence is not presence: a zero-energy reading must never hold the meeting open.
{
  const f = fixture();
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.clock.advance(900);
  f.activity.observeRemoteEnergy(0);
  f.clock.advance(100); f.scheduler.tick();
  check('a zero-energy frame is silence, not presence', fired === 1);
}

// No capture readiness means no signal, not silence: fail closed forever.
{
  const f = fixture();
  let fired = 0;
  f.source.onAlone(() => fired++);
  f.clock.advance(10_000); f.scheduler.tick();
  check('absent audio tap fails closed', fired === 0);
  f.activity.ready();
  f.activity.unavailable();
  f.clock.advance(10_000); f.scheduler.tick();
  check('failed or torn-down audio tap fails closed', fired === 0);
}

// Stopping the subscription prevents a later terminal verdict.
{
  const f = fixture();
  let fired = 0;
  f.activity.ready();
  const stop = f.source.onAlone(() => fired++);
  stop();
  f.clock.advance(10_000); f.scheduler.tick();
  check('stop cancels the monitor', fired === 0 && f.scheduler.activeCount === 0);
}

// The adapter seam can veto silence without changing the monitor.
{
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const activity = createRemoteAudioActivityTap({ now: clock.now });
  activity.ready();
  let fired = 0;
  const source = createSilenceAlonenessSource({
    activity,
    windowMs: 1_000,
    adapters: [
      { name: 'silence', evaluate: (snapshot, now, windowMs) =>
        snapshot.available && snapshot.lastRemoteAudioAt !== undefined && now - snapshot.lastRemoteAudioAt >= windowMs
          ? 'alone' : 'not-alone' },
      { name: 'presence-veto', evaluate: () => 'not-alone' },
    ],
    now: clock.now,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
    log: () => {},
  });
  source.onAlone(() => fired++);
  clock.advance(10_000); scheduler.tick();
  check('a future adapter can veto the silence verdict', fired === 0);
}

// Room states as the Teams scan reports them (participants and names exclude the bot itself).
const people = (n: number) => ({ participants: n, named: n, bots: 0 });
const nobody = { participants: 0, named: 0, bots: 0 };
// Alone, Teams shows the bot's own avatar without a name label; the scan counts it as one unnamed.
const soloAvatar = { participants: 1, named: 0, bots: 0 };
const onlyBots = (n: number) => ({ participants: n, named: n, bots: n });

// Everyone left: an empty room ends the meeting after the empty-room window, long before the
// silence window would.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(2));
  f.clock.advance(1_000);
  f.activity.observeRoster(nobody);
  f.clock.advance(299); f.scheduler.tick();
  check('an empty room before the empty-room window does not fire', fired === 0);
  f.clock.advance(1); f.scheduler.tick();
  check('an empty room at the empty-room window fires', fired === 1);
}

// Meetings 18/19 on dev: the bot's own nameless avatar is what an empty Teams room looks like.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(1));
  f.activity.observeRoster(soloAvatar);
  f.clock.advance(300); f.scheduler.tick();
  check('one unnamed surface and nobody named is an empty room', fired === 1);
}

// Prod: another notetaker stays five minutes after the people; a room of bots is an empty room.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster({ participants: 2, named: 2, bots: 1 });
  f.clock.advance(1_000); f.scheduler.tick();
  check('a person beside another bot keeps the room occupied', fired === 0);
  f.activity.observeRoster(onlyBots(1));
  f.clock.advance(300); f.scheduler.tick();
  check('only other bots left is an empty room', fired === 1);
}

// One named person alone with the bot is a person: the silence window decides, not the empty room.
{
  const f = fixture(1_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(1));
  f.clock.advance(999); f.scheduler.tick();
  check('a lone named person keeps a silent room open until the silence window', fired === 0);
  f.clock.advance(1); f.scheduler.tick();
  check('a lone named person who stays silent is left at the silence window', fired === 1);
  check('that leave is reported as the silence rule', f.source.firedRule() === 'silence');
}

// Two unnamed surfaces are more than the bot's own avatar: someone is there.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(1));
  f.activity.observeRoster({ participants: 2, named: 0, bots: 0 });
  f.clock.advance(1_000); f.scheduler.tick();
  check('two unnamed surfaces keep the room occupied', fired === 0);
}

// Before anyone has joined, the bot is alone too, but the meeting may simply start late: the empty
// room only counts once somebody has been in it.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(soloAvatar);
  f.clock.advance(5_000); f.scheduler.tick();
  check('an empty room nobody has joined yet does not trigger the empty-room rule', fired === 0);
  f.activity.observeRoster(people(1));
  f.activity.observeRoster(soloAvatar);
  f.clock.advance(300); f.scheduler.tick();
  check('once someone has come and gone, the empty-room rule applies', fired === 1);
}

// Someone rejoining inside the empty-room window resets it: a dropped connection is not a leave.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(1));
  f.activity.observeRoster(nobody);
  f.clock.advance(200);
  f.activity.observeRoster(people(1));
  f.clock.advance(200);
  f.activity.observeRoster(soloAvatar);
  f.clock.advance(299); f.scheduler.tick();
  check('a rejoin resets the empty-room window', fired === 0);
  f.clock.advance(1); f.scheduler.tick();
  check('the reset empty-room window eventually fires', fired === 1);
}

// Two empty readings in a row (nobody, then the avatar appearing) are one empty spell, not a reset.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(1));
  f.activity.observeRoster(nobody);
  f.clock.advance(200);
  f.activity.observeRoster(soloAvatar);
  f.clock.advance(100); f.scheduler.tick();
  check('the empty-room window runs from the first empty reading', fired === 1);
}

// A silent room with people in it sits out the full silence window, not the empty-room one.
{
  const f = fixture(1_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(3));
  f.clock.advance(999); f.scheduler.tick();
  check('people present keep a silent room open until the silence window', fired === 0);
  f.clock.advance(1); f.scheduler.tick();
  check('people present but silent still leave at the silence window', fired === 1);
}

// A page that never reports a roster cannot count, which is not an empty room: silence alone decides.
{
  const f = fixture(1_000, 300);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRemoteEnergy(loudEnergy);
  f.clock.advance(999); f.scheduler.tick();
  check('no roster report never triggers the empty-room rule', fired === 0);
  f.clock.advance(1); f.scheduler.tick();
  check('no roster report falls back to the silence window', fired === 1);
}

// The roster comes from the participant scan, not audio capture: capture becoming ready must not
// forget an empty room, and the empty-room rule does not wait on capture at all.
{
  const f = fixture(10_000, 300);
  let fired = 0;
  f.source.onAlone(() => fired++);
  f.activity.observeRoster(people(1));
  f.activity.observeRoster(nobody);
  f.clock.advance(150);
  f.activity.ready();
  f.clock.advance(150); f.scheduler.tick();
  check('capture readiness does not reset the empty-room window', fired === 1);
}

// The rule is off at 0, so a deployment can opt back into silence-only.
{
  const f = fixture(1_000, 0);
  let fired = 0;
  f.activity.ready();
  f.source.onAlone(() => fired++);
  f.activity.observeRemoteEnergy(loudEnergy);
  f.activity.observeRoster(people(1));
  f.activity.observeRoster(nobody);
  f.clock.advance(999); f.scheduler.tick();
  check('a zero empty-room window disables the rule', fired === 0);
}

// Timeout precedence: explicit invocation > valid env > 10-minute module default.
{
  check('explicit everyoneLeftTimeout wins',
    resolveAloneSilenceWindowMs(12_345, { BOT_ALONE_SILENCE_WINDOW_MS: '23456' }) === 12_345);
  check('env override applies when invocation is absent',
    resolveAloneSilenceWindowMs(undefined, { BOT_ALONE_SILENCE_WINDOW_MS: '23456' }) === 23_456);
  check('module default is ten minutes',
    resolveAloneSilenceWindowMs(undefined, {}) === DEFAULT_ALONE_SILENCE_WINDOW_MS &&
    DEFAULT_ALONE_SILENCE_WINDOW_MS === 600_000);
  check('invalid env falls back to module default',
    resolveAloneSilenceWindowMs(undefined, { BOT_ALONE_SILENCE_WINDOW_MS: 'nope' }, () => {}) === 600_000);
}

// Which rule ended the meeting is reported, because both end it as the same left_alone.
{
  const empty = fixture(10_000, 300);
  empty.activity.ready();
  empty.source.onAlone(() => {});
  check('no rule is reported before a verdict', empty.source.firedRule() === undefined);
  empty.activity.observeRoster(people(1));
  empty.activity.observeRoster(nobody);
  empty.clock.advance(300); empty.scheduler.tick();
  check('an empty-room verdict reports the empty-room rule', empty.source.firedRule() === 'empty-room');

  const silent = fixture(1_000, 300);
  silent.activity.ready();
  silent.source.onAlone(() => {});
  silent.activity.observeRoster(people(2));
  silent.clock.advance(1_000); silent.scheduler.tick();
  check('a silence verdict reports the silence rule', silent.source.firedRule() === 'silence');
}

// Empty-room window: valid env > 5-minute module default; an explicit 0 turns the rule off.
{
  check('empty-room env override applies',
    resolveEmptyRoomWindowMs({ BOT_EMPTY_ROOM_WINDOW_MS: '45000' }) === 45_000);
  check('empty-room module default is 5 minutes',
    resolveEmptyRoomWindowMs({}) === DEFAULT_EMPTY_ROOM_WINDOW_MS && DEFAULT_EMPTY_ROOM_WINDOW_MS === 300_000);
  check('an explicit 0 disables the empty-room rule',
    resolveEmptyRoomWindowMs({ BOT_EMPTY_ROOM_WINDOW_MS: '0' }) === 0);
  const warnings: string[] = [];
  check('invalid empty-room env falls back to the module default',
    resolveEmptyRoomWindowMs({ BOT_EMPTY_ROOM_WINDOW_MS: '-5' }, (m) => warnings.push(m)) === 300_000
    && warnings.length === 1);
}

console.log(failed
  ? `\n❌ aloneness: ${failed} failed`
  : '\n✅ aloneness (L2): scripted remote-audio timelines prove silence, empty room, reset, fail-closed, exactly-once, and timeout precedence.');
process.exit(failed ? 1 : 0);
