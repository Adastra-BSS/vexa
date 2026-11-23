/**
 * The dead-call watch (INATTE-17): a Teams call that drops under the bot shows no ending text, so the
 * removal monitor never fires. The watch ends the meeting only when the call is gone on every signal
 * at once - the hangup button is missing, the roster is empty and no remote audio is heard - for a
 * sustained window, and only after the button has been seen once (so it cannot fire while Teams is
 * still building the in-call UI). A closed page ends it at once.
 *
 * Run: npx tsx src/call-lost.test.ts
 */
import { createCallLostWatch, resolveCallLostWindowMs, startCallLostMonitor, type CallLostSample } from './call-lost.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  - ' + detail}`);
  if (!cond) failed++;
};

const WINDOW = 30_000;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const live = (nowMs: number, over: Partial<CallLostSample> = {}): CallLostSample => ({
  nowMs, hangupVisible: true, pageClosed: false, roomEmpty: false, lastRemoteAudioAt: nowMs, ...over,
});
const dead = (nowMs: number, over: Partial<CallLostSample> = {}): CallLostSample =>
  live(nowMs, { hangupVisible: false, roomEmpty: true, lastRemoteAudioAt: undefined, ...over });

function watchWith(windowMs = WINDOW) {
  const fired: number[] = [];
  const watch = createCallLostWatch({ windowMs, onLost: () => fired.push(1) });
  return { watch, fired };
}

async function main() {
  console.log('\n=== resolveCallLostWindowMs ===');
  check('unset -> 30 s', resolveCallLostWindowMs({}) === 30_000);
  check('0 disables the watch', resolveCallLostWindowMs({ BOT_CALL_LOST_WINDOW_MS: '0' }) === 0);
  check('a configured window is used', resolveCallLostWindowMs({ BOT_CALL_LOST_WINDOW_MS: '45000' }) === 45_000);
  check('garbage falls back to the default', resolveCallLostWindowMs({ BOT_CALL_LOST_WINDOW_MS: 'soon' }) === 30_000);
  check('a negative value falls back to the default', resolveCallLostWindowMs({ BOT_CALL_LOST_WINDOW_MS: '-5' }) === 30_000);

  console.log('\n=== the call dies after admission ===');
  {
    const { watch, fired } = watchWith();
    watch.observe(live(0));
    watch.observe(dead(1_000));
    watch.observe(dead(1_000 + WINDOW - 1));
    check('no fire before the window is over', fired.length === 0, String(fired.length));
    watch.observe(dead(1_000 + WINDOW));
    check('fires once the window is over', fired.length === 1, String(fired.length));
    watch.observe(dead(1_000 + WINDOW + 5_000));
    check('fires only once', fired.length === 1, String(fired.length));
  }

  console.log('\n=== never armed: the hangup button was never seen ===');
  {
    const { watch, fired } = watchWith();
    for (let t = 0; t <= 3 * WINDOW; t += 1_000) watch.observe(dead(t, { hangupVisible: false }));
    check('a call whose button never showed never fires', fired.length === 0, String(fired.length));
  }

  console.log('\n=== a signal that disagrees resets the window ===');
  {
    const { watch, fired } = watchWith();
    watch.observe(live(0));
    watch.observe(dead(1_000));
    watch.observe(dead(10_000, { roomEmpty: false })); // a participant is back in the roster
    watch.observe(dead(11_000));
    watch.observe(dead(1_000 + WINDOW + 5_000));
    check('a non-empty roster restarts the count', fired.length === 0, String(fired.length));
    watch.observe(dead(11_000 + WINDOW));
    check('the count runs again from the reset and then fires', fired.length === 1, String(fired.length));
  }
  {
    const { watch, fired } = watchWith();
    watch.observe(live(0));
    watch.observe(dead(1_000));
    watch.observe(live(10_000)); // the button is back
    watch.observe(dead(11_000));
    watch.observe(dead(11_000 + WINDOW - 1));
    check('the button reappearing restarts the count', fired.length === 0, String(fired.length));
  }
  {
    const { watch, fired } = watchWith();
    watch.observe(live(0));
    watch.observe(dead(1_000));
    watch.observe(dead(20_000, { lastRemoteAudioAt: 19_000 })); // audio heard a second ago
    watch.observe(dead(1_000 + WINDOW + 1_000, { lastRemoteAudioAt: 1_000 + WINDOW }));
    check('remote audio still arriving means the call is alive', fired.length === 0, String(fired.length));
  }

  console.log('\n=== a closed page ends the call at once, once armed ===');
  {
    const { watch, fired } = watchWith();
    watch.observe(live(0));
    watch.observe(live(1_000, { pageClosed: true }));
    check('a closed page fires immediately', fired.length === 1, String(fired.length));
  }
  {
    const { watch, fired } = watchWith();
    watch.observe(live(1_000, { pageClosed: true, hangupVisible: false }));
    check('a closed page before the button was ever seen does not fire', fired.length === 0, String(fired.length));
  }

  console.log('\n=== disabled ===');
  {
    const { watch, fired } = watchWith(0);
    watch.observe(live(0));
    watch.observe(dead(1_000));
    watch.observe(dead(10 * WINDOW));
    check('a zero window never fires', fired.length === 0, String(fired.length));
  }

  console.log('\n=== the monitor polls the sample and feeds the watch ===');
  {
    const { watch, fired } = watchWith();
    const samples: CallLostSample[] = [live(0), dead(1_000), dead(1_000 + WINDOW)];
    let next = 0;
    let tick: (() => void) | undefined;
    const stop = startCallLostMonitor({
      watch,
      intervalMs: 1_000,
      sample: async () => samples[Math.min(next++, samples.length - 1)],
      scheduler: { setInterval: (cb) => { tick = cb; return 1; }, clearInterval: () => { tick = undefined; } },
    });
    for (let i = 0; i < 3; i++) { tick!(); await settle(); }
    check('three ticks feed the watch in order and fire once', fired.length === 1, String(fired.length));
    stop();
    check('stop clears the timer', tick === undefined);
  }
  {
    const { watch, fired } = watchWith();
    let tick: (() => void) | undefined;
    startCallLostMonitor({
      watch,
      intervalMs: 1_000,
      sample: async () => null,
      scheduler: { setInterval: (cb) => { tick = cb; return 1; }, clearInterval: () => {} },
    });
    tick!();
    await settle();
    check('a null sample (no page to read) feeds nothing', fired.length === 0);
  }

  console.log(`\n=== summary: ${failed === 0 ? 'all passed' : failed + ' failed'} ===`);
  if (failed) process.exit(1);
}

main();
