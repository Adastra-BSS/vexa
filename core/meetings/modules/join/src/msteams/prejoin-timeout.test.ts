/**
 * Teams pre-join that never renders (Attend INATTE-30).
 *
 * Prod 2026-11-24, Vexa meetings 915 and 988: the meetup-join landed on Teams'
 * `light-meetings/launch` page and the pre-join controls never appeared. The readiness wait timed
 * out after 45 s and the join flow then ran steps 3-6 against an empty page ("Display name input
 * not found", "Join button not found") before failing ~50 s later as an opaque join_failure.
 *
 * Contract under test: a pre-join that is not ready within TEAMS_PREJOIN_READY_TIMEOUT_MS throws
 * the typed `TeamsPreJoinTimeoutError` (reasonCode `teams_prejoin_timeout`) and runs none of the
 * pre-join steps. The limit is 25 s: across 1,336 prod bots (2026-11-12..27) a healthy pre-join was
 * ready in 9-11 s at the median, 18 s at p99, 39 s at worst.
 *
 * Fabricated page and VIRTUAL clock, the same harness as auth-redirect.test.ts.
 *
 * Run: npx tsx src/msteams/prejoin-timeout.test.ts
 */

import {
  TeamsPreJoinTimeoutError,
  TEAMS_PREJOIN_TIMEOUT,
  TEAMS_PREJOIN_READY_TIMEOUT_MS,
} from './prejoin-timeout';
import { TeamsJoinRedirectError } from './auth-redirect';
import { joinMicrosoftTeams } from './join';

let vnow = 1_000_000;
const realDateNow = Date.now;
(Date as any).now = () => vnow;

let captured: string[] = [];
const realConsoleLog = console.log;
function startCapture() {
  captured = [];
  console.log = (...a: any[]) => {
    const s = a.map(String).join(' ');
    try { captured.push(JSON.parse(s).msg ?? s); } catch { captured.push(s); }
  };
}
function stopCapture(): string[] { console.log = realConsoleLog; return captured; }

/**
 * A Teams page on the meeting host whose pre-join controls ("Join now") become visible once
 * `readyAfterMs` of virtual time has passed since the page was created. `Infinity` = never.
 */
function mockPage(readyAfterMs: number): any {
  const createdAt = vnow;
  const ready = () => vnow - createdAt >= readyAfterMs;
  const node = (sel: string): any => ({
    first: () => node(sel),
    isVisible: async () => ready() && sel.includes('Join now'),
    waitFor: async () => { throw new Error(`timeout waiting for ${sel}`); },
    click: async () => {},
    fill: async () => { throw new Error(`no element for ${sel}`); },
    getAttribute: async () => null,
  });
  return {
    url: () => 'https://teams.microsoft.com/light-meetings/launch?agent=web',
    goto: async () => {},
    waitForTimeout: async (ms: number) => { vnow += ms; },
    locator: node,
    evaluate: async () => 'media warm-up success (tracks=0)',
    keyboard: { press: async () => {} },
    isClosed: () => false,
  };
}

const MEETUP_JOIN_URL =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_REDACTED%40thread.v2/0?context=%7b%7d';

async function driveJoin(page: any) {
  const t0 = vnow;
  startCapture();
  let error: any = null;
  try {
    await joinMicrosoftTeams(page, MEETUP_JOIN_URL, 'Vexa Bot', { platform: 'teams', botName: 'Vexa Bot' } as any);
  } catch (e) { error = e; }
  const logs = stopCapture();
  return { error, elapsedMs: vnow - t0, logs };
}

let passed = 0, failed = 0;
function check(name: string, actual: boolean, expected: boolean) {
  if (actual === expected) { realConsoleLog(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { realConsoleLog(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${expected}, got ${actual})`); failed++; }
}

const PREJOIN_STEPS = ['Step 3:', 'Step 4:', 'Step 5:', 'Step 6:'];

(async () => {
  realConsoleLog('\n=== Teams pre-join never renders (INATTE-30) ===');

  check('the readiness limit is 25 s', TEAMS_PREJOIN_READY_TIMEOUT_MS === 25_000, true);

  // 1. The prod failure: the pre-join never renders.
  {
    const { error, elapsedMs, logs } = await driveJoin(mockPage(Infinity));
    check('never-rendering pre-join -> throws TeamsPreJoinTimeoutError', error instanceof TeamsPreJoinTimeoutError, true);
    check(`typed reason is "${TEAMS_PREJOIN_TIMEOUT}"`, error?.reasonCode === TEAMS_PREJOIN_TIMEOUT, true);
    check(
      'the message starts with the reason code (the orchestrator stamps String(e) as the reason)',
      String(error?.message ?? '').startsWith(`${TEAMS_PREJOIN_TIMEOUT}:`), true,
    );
    check('it is not mistaken for a sign-in redirect', error instanceof TeamsJoinRedirectError, false);
    check(`gives up at the 25 s limit, not 45 s: ${elapsedMs}ms`, elapsedMs >= 25_000 && elapsedMs < 30_000, true);
    for (const step of PREJOIN_STEPS) {
      check(`does not run ${step} against an empty page`, logs.some((l) => l.startsWith(step)), false);
    }
  }

  // 2. A slow but healthy pre-join inside the limit still joins.
  {
    const { error, logs } = await driveJoin(mockPage(20_000));
    check('pre-join ready at 20 s -> no throw', error === null, true);
    check('pre-join ready at 20 s -> readiness reached', logs.some((l) => l.includes('pre-join controls are ready')), true);
    check('pre-join ready at 20 s -> the flow runs Step 6', logs.some((l) => l.startsWith('Step 6:')), true);
  }

  // 3. The query string of the stuck page carries tenant and meeting ids; the error must not.
  {
    const page = mockPage(Infinity);
    page.url = () => 'https://teams.microsoft.com/light-meetings/launch?agent=web&coords=SECRET-TENANT-ID';
    const { error } = await driveJoin(page);
    check('the error text carries no query string', String(error?.message ?? '').includes('SECRET-TENANT-ID'), false);
  }

  (Date as any).now = realDateNow;
  realConsoleLog(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
