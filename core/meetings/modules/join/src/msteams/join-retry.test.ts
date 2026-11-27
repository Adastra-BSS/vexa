/**
 * Teams join retried inside the same pod (Attend INATTE-30).
 *
 * A Teams join that fails before the bot reaches the lobby opens the meeting link again and runs
 * the join once more, in the same browser, instead of exiting and leaving the meeting unrecorded.
 * Two prod failure kinds motivate it: the pre-join page never rendering (Vexa meetings 915 and 988,
 * 2026-11-24) and Teams dropping the call straight after "Join now" (587 on 2026-11-20, 1207 on
 * 2026-11-25). A fresh pod would join minutes late; a second attempt here costs ~25-40 s.
 *
 * A verdict is never retried: a host denial, a lobby timeout and a sign-in redirect end the join
 * exactly as before, and so does any failure after the bot reached the lobby (a second "Join now"
 * would put a duplicate guest in front of the host).
 *
 * Seam: `joinMeeting`, the join layer's public entry. The page is fabricated; each `goto` starts
 * the next scripted attempt. Clock is virtual, as in auth-redirect.test.ts.
 *
 * Run: npx tsx src/msteams/join-retry.test.ts
 */

import { joinMeeting, AdmissionError, TeamsJoinRedirectError, TeamsPreJoinTimeoutError } from '../index';

let vnow = 1_000_000;
const realDateNow = Date.now;
(Date as any).now = () => vnow;

let captured: string[] = [];
let records: Record<string, any>[] = [];
const realConsoleLog = console.log;
function startCapture() {
  captured = [];
  records = [];
  console.log = (...a: any[]) => {
    const s = a.map(String).join(' ');
    try {
      const parsed = JSON.parse(s);
      records.push(parsed);
      captured.push(parsed.msg ?? s);
    } catch { captured.push(s); }
  };
}
function stopCapture(): string[] { console.log = realConsoleLog; return captured; }

/** The per-attempt records the retry writes, in order - what prod queries count. */
const attemptRecords = () => records.filter((r) => r.event === 'teams_join_attempt');
const describe = (rs: Record<string, any>[]) =>
  rs.map((r) => `${r.attempt}/${r.max_attempts}:${r.outcome}${r.reason ? `(${r.reason})` : ''}`).join(' ');

/**
 * What one attempt's page does.
 *  - `blank`: the pre-join never renders (915/988).
 *  - otherwise the pre-join renders at once, and clicking "Join now" leads to:
 *    `admitted` (in the meeting), `nothing` (call dropped, no indicator at all - 587),
 *    `lobby` (waiting room until the lobby timeout), `denied` (host clicked Deny),
 *    `lobby_then_crash` (waiting room, then the page breaks once the lobby was reported).
 */
type Attempt = 'blank' | 'admitted' | 'nothing' | 'lobby' | 'denied' | 'lobby_then_crash';

const SIGNS: Record<string, string> = {
  prejoin: 'Join now',
  admitted: 'hangup-button',
  lobby: 'Someone will let you in shortly',
  denied: 'you were denied',
};

function mockTeams(attempts: Attempt[], url = 'https://teams.microsoft.com/light-meetings/launch?agent=web') {
  let gotos = 0;
  let state: string = 'none';
  let script: Attempt = attempts[0];
  let crashed = false;

  const visible = (sel: string): boolean => {
    if (crashed) throw new Error('Target page, context or browser has been closed');
    if (state === 'prejoin') return sel.includes(SIGNS.prejoin);
    if (state === 'admitted') return sel.includes(SIGNS.admitted);
    if (state === 'lobby' || state === 'lobby_then_crash') return sel.includes(SIGNS.lobby);
    if (state === 'denied') return sel.includes(SIGNS.denied);
    return false;
  };
  const node = (sel: string): any => ({
    first: () => node(sel),
    isVisible: async () => visible(sel),
    waitFor: async () => { throw new Error(`timeout waiting for ${sel}`); },
    click: async () => {
      if (state === 'prejoin' && sel.includes(SIGNS.prejoin)) state = script;
      else if (!visible(sel)) throw new Error(`no element for ${sel}`);
    },
    fill: async () => {},
    getAttribute: async () => null,
  });
  const page = {
    url: () => url,
    goto: async () => {
      script = attempts[Math.min(gotos, attempts.length - 1)];
      gotos += 1;
      state = script === 'blank' ? 'blank' : 'prejoin';
    },
    waitForTimeout: async (ms: number) => { vnow += ms; },
    locator: node,
    evaluate: async () => 'media warm-up success (tracks=0)',
    keyboard: { press: async () => {} },
    isClosed: () => false,
  };
  return {
    page,
    gotos: () => gotos,
    crashIfInLobby: () => { if (state === 'lobby_then_crash') crashed = true; },
  };
}

const MEETUP_JOIN_URL =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_REDACTED%40thread.v2/0?context=%7b%7d';

async function driveJoin(attempts: Attempt[], url?: string) {
  const teams = mockTeams(attempts, url);
  const states: string[] = [];
  const t0 = vnow;
  startCapture();
  let error: any = null;
  let result: any = null;
  try {
    result = await joinMeeting(teams.page as any, {
      meetingUrl: MEETUP_JOIN_URL,
      platform: 'teams',
      botName: 'Vexa Bot',
      waitingRoomTimeoutMs: 10_000,
      hooks: {
        onState: (s) => {
          states.push(s);
          if (s === 'awaiting_admission') teams.crashIfInLobby();
        },
      },
    });
  } catch (e) { error = e; }
  const logs = stopCapture();
  return { error, result, states, gotos: teams.gotos(), elapsedMs: vnow - t0, logs, records: describe(attemptRecords()) };
}

let passed = 0, failed = 0;
function check(name: string, actual: boolean, expected: boolean) {
  if (actual === expected) { realConsoleLog(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { realConsoleLog(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${expected}, got ${actual})`); failed++; }
}

const RETRY_LOG = 'reopening the join link';

(async () => {
  realConsoleLog('\n=== Teams join retried in the same pod (INATTE-30) ===');

  // 1. The 915/988 case: the first pre-join never renders, the second does.
  {
    const r = await driveJoin(['blank', 'admitted']);
    check('stalled pre-join, then healthy -> admitted', r.result?.admitted === true, true);
    check('stalled pre-join -> the link is opened exactly twice', r.gotos === 2, true);
    check('stalled pre-join -> the retry is logged', r.logs.some((l) => l.includes(RETRY_LOG)), true);
    check(
      `stalled pre-join -> in the meeting sooner than today's single 45 s wait: ${r.elapsedMs}ms`,
      r.elapsedMs < 45_000, true,
    );
    check(
      `stalled pre-join -> attempt records "1/2:retrying(teams_prejoin_timeout) 2/2:admitted": ${r.records}`,
      r.records === '1/2:retrying(teams_prejoin_timeout) 2/2:admitted', true,
    );
  }

  // 2. Stalled twice: the bot gives up after the second attempt with the typed reason.
  {
    const r = await driveJoin(['blank', 'blank']);
    check('stalled twice -> throws TeamsPreJoinTimeoutError', r.error instanceof TeamsPreJoinTimeoutError, true);
    check('stalled twice -> exactly two attempts', r.gotos === 2, true);
    check('stalled twice -> never runs Step 6', r.logs.some((l) => l.startsWith('Step 6:')), false);
    check(
      `stalled twice -> attempt records end in "2/2:failed(teams_prejoin_timeout)": ${r.records}`,
      r.records === '1/2:retrying(teams_prejoin_timeout) 2/2:failed(teams_prejoin_timeout)', true,
    );
  }

  // 3. The 587 case: "Join now" clicked, then no meeting, lobby or denial indicator at all.
  {
    const r = await driveJoin(['nothing', 'admitted']);
    check('call dropped after Join now, then healthy -> admitted', r.result?.admitted === true, true);
    check('call dropped after Join now -> exactly two attempts', r.gotos === 2, true);
  }

  // 4. Lobby timeout is the host's verdict: no second attempt.
  {
    const r = await driveJoin(['lobby', 'admitted']);
    check(
      'lobby timeout -> AdmissionError(lobby_timeout)',
      r.error instanceof AdmissionError && r.error.outcome === 'lobby_timeout', true,
    );
    check('lobby timeout -> not retried', r.gotos === 1, true);
  }

  // 5. Denial is the host's verdict: no second attempt.
  {
    const r = await driveJoin(['denied', 'admitted']);
    check('denial -> AdmissionError(denial)', r.error instanceof AdmissionError && r.error.outcome === 'denial', true);
    check('denial -> not retried', r.gotos === 1, true);
    check(`denial -> one final record "1/2:failed(denial)": ${r.records}`, r.records === '1/2:failed(denial)', true);
  }

  // 6. A sign-in redirect is an identity problem a reload cannot fix: no second attempt.
  {
    const r = await driveJoin(['admitted'], 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    check('sign-in redirect -> TeamsJoinRedirectError', r.error instanceof TeamsJoinRedirectError, true);
    check('sign-in redirect -> not retried', r.gotos === 1, true);
  }

  // 7. Any failure once the bot was in the lobby is final: the host may already see it waiting.
  {
    const r = await driveJoin(['lobby_then_crash', 'admitted']);
    check('lobby reached, then page error -> the join fails', r.error !== null, true);
    check('lobby reached, then page error -> lobby was reported', r.states.includes('awaiting_admission'), true);
    check('lobby reached, then page error -> not retried', r.gotos === 1, true);
  }

  // 8. Negative control: a healthy join opens the link once and never mentions a retry.
  {
    const r = await driveJoin(['admitted']);
    check('healthy join -> admitted', r.result?.admitted === true, true);
    check('healthy join -> the link is opened once', r.gotos === 1, true);
    check('healthy join -> no retry logged', r.logs.some((l) => l.includes(RETRY_LOG)), false);
    check(`healthy join -> one record "1/2:admitted": ${r.records}`, r.records === '1/2:admitted', true);
  }

  (Date as any).now = realDateNow;
  realConsoleLog(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
