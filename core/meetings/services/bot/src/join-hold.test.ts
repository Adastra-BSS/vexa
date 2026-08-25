/**
 * join-hold seam (jana #40, spawn-early-join-late) — the bot may be spawned minutes before the
 * meeting (absorbing node scale-up + image pull off the critical path) and must then WAIT until
 * VEXA_JOIN_NOT_BEFORE before starting the join flow, so it appears in the lobby shortly before
 * the scheduled start instead of loitering there for the whole spawn lead.
 *
 * The hold must be harmless in every degenerate case: unset/garbage env (manual sends) → no hold;
 * a timestamp already past (late dispatch inside the grace window) → no hold; a timestamp
 * absurdly far out (clock skew, a wrong row) → clamped, never a bot that sleeps forever.
 *
 * Run: tsx src/join-hold.test.ts
 */
import { computeHoldMs, holdUntilJoinTime, MAX_HOLD_MS } from './join-hold.js';

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`); failed++; }
};

console.log('\n=== join-hold: computeHoldMs ===');

const NOW = Date.parse('2026-08-25T10:00:00.000Z');

check('unset → 0 (manual send joins immediately)', computeHoldMs(undefined, NOW) === 0);
check('empty → 0', computeHoldMs('', NOW) === 0);
check('garbage → 0 (never a NaN sleep)', computeHoldMs('not-a-date', NOW) === 0);
check('past timestamp → 0 (late dispatch joins immediately)',
  computeHoldMs('2026-08-25T09:59:00.000Z', NOW) === 0);
check('4 minutes out → 240000ms',
  computeHoldMs('2026-08-25T10:04:00.000Z', NOW) === 240_000);
check('an hour out → clamped to MAX_HOLD_MS (never sleeps past sanity)',
  computeHoldMs('2026-08-25T11:00:00.000Z', NOW) === MAX_HOLD_MS);
check('naive-Z and offset forms both parse',
  computeHoldMs('2026-08-25T12:00:30+02:00', NOW) === 30_000);

console.log('\n=== join-hold: holdUntilJoinTime ===');

{
  // The hold sleeps exactly the computed window, through the injected sleeper.
  const slept: number[] = [];
  const logs: string[] = [];
  await holdUntilJoinTime('2026-08-25T10:04:00.000Z', {
    nowMs: () => NOW,
    sleep: async (ms) => { slept.push(ms); },
    log: (m) => logs.push(m),
  });
  check('sleeps the computed window', slept.length === 1 && slept[0] === 240_000);
  check('logs the hold so the pod log explains the silence', logs.length === 1 && logs[0].includes('240'));
}

{
  // No target → no sleep, no log noise.
  const slept: number[] = [];
  const logs: string[] = [];
  await holdUntilJoinTime(undefined, {
    nowMs: () => NOW,
    sleep: async (ms) => { slept.push(ms); },
    log: (m) => logs.push(m),
  });
  check('no target → does not sleep', slept.length === 0);
  check('no target → does not log', logs.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
