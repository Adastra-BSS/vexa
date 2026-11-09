/**
 * The chat keepalive: which remedies BOT_CHAT_KEEPALIVE turns on, that each runs on its own
 * interval, that a slow refresh is never overlapped by the next one, that a refresh shares the
 * chat's one writer with the posts, and that stop ends everything.
 *
 * Run: npx tsx src/chat-keepalive.test.ts
 */
import { serialTasks } from './chat-commands.js';
import { CHAT_NUDGE_INTERVAL_MS, CHAT_REFRESH_INTERVAL_MS, resolveChatKeepalive, startChatKeepalive, type ChatRefreshResult } from './chat-keepalive.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  - ' + detail}`);
  if (!cond) failed++;
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Interval timers driven by hand: tick(ms) fires every timer whose period divides the time. */
function clock() {
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let at = 0;
  return {
    setInterval: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearInterval: (t: unknown) => { (t as { live: boolean }).live = false; },
    now: () => at,
    async advance(ms: number, step = 1000) {
      for (let end = at + ms; at < end;) {
        at += step;
        for (const t of timers) if (t.live && at % t.ms === 0) t.fn();
        await flush();
      }
    },
    live: () => timers.filter((t) => t.live).length,
  };
}

(async () => {
  console.log('\n=== resolveChatKeepalive ===');
  const mode = (v?: string) => JSON.stringify(resolveChatKeepalive(v === undefined ? {} : { BOT_CHAT_KEEPALIVE: v }));
  check('unset -> both', mode() === JSON.stringify({ nudge: true, refresh: true }));
  check('on -> both', mode(' ON ') === JSON.stringify({ nudge: true, refresh: true }));
  check('off -> none', mode('off') === JSON.stringify({ nudge: false, refresh: false }));
  check('nudge -> pointer only', mode('nudge') === JSON.stringify({ nudge: true, refresh: false }));
  check('refresh -> pane only', mode('refresh') === JSON.stringify({ nudge: false, refresh: true }));
  check('anything else -> both (the safe side)', mode('yes') === JSON.stringify({ nudge: true, refresh: true }));

  console.log('\n=== intervals ===');
  {
    const c = clock();
    const nudges: number[] = [];
    const reports: ChatRefreshResult[] = [];
    let refreshes = 0;
    const stop = startChatKeepalive({
      mode: { nudge: true, refresh: true }, ...c,
      nudge: async (step) => { nudges.push(step); },
      refresh: async () => { refreshes++; return { ok: true }; },
      onRefresh: (r) => reports.push(r),
    });
    await c.advance(CHAT_REFRESH_INTERVAL_MS * 2);
    check('a nudge every minute, counted', JSON.stringify(nudges) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), JSON.stringify(nudges));
    check('a refresh every five minutes', refreshes === 2, String(refreshes));
    check('each refresh reported', reports.length === 2 && reports.every((r) => r.ok));
    stop();
    stop();
    check('stop clears both timers, twice is harmless', c.live() === 0);
    await c.advance(CHAT_REFRESH_INTERVAL_MS);
    check('nothing runs after stop', nudges.length === 10 && refreshes === 2);
  }
  {
    const c = clock();
    let nudges = 0, refreshes = 0;
    startChatKeepalive({ mode: { nudge: false, refresh: false }, ...c, nudge: async () => { nudges++; }, refresh: async () => { refreshes++; return { ok: true }; } });
    await c.advance(CHAT_REFRESH_INTERVAL_MS);
    check('off starts no timers', c.live() === 0 && nudges === 0 && refreshes === 0);
  }

  console.log('\n=== a slow or failing refresh ===');
  {
    const c = clock();
    let started = 0;
    let release!: () => void;
    const reports: ChatRefreshResult[] = [];
    startChatKeepalive({
      mode: { nudge: false, refresh: true }, ...c,
      nudge: async () => {},
      refresh: () => { started++; return new Promise<ChatRefreshResult>((resolve) => { release = () => resolve({ ok: true }); }); },
      onRefresh: (r) => reports.push(r),
    });
    await c.advance(CHAT_REFRESH_INTERVAL_MS * 3);
    check('a refresh still running is not overlapped', started === 1, String(started));
    release();
    await flush();
    await c.advance(CHAT_REFRESH_INTERVAL_MS);
    check('the next one runs once it is done', started === 2 && reports.length === 1, `${started} ${reports.length}`);
  }
  {
    const c = clock();
    const reports: ChatRefreshResult[] = [];
    let nudges = 0;
    startChatKeepalive({
      mode: { nudge: true, refresh: true }, ...c,
      nudge: async () => { nudges++; throw new Error('Target closed'); },
      refresh: async () => { throw new Error('Target closed'); },
      onRefresh: (r) => reports.push(r),
    });
    await c.advance(CHAT_REFRESH_INTERVAL_MS * 2);
    check('a throwing refresh is reported as an error and keeps its schedule',
      reports.length === 2 && reports.every((r) => !r.ok && r.reason === 'error' && /Target closed/.test(r.detail ?? '')), JSON.stringify(reports));
    check('a throwing nudge keeps its schedule', nudges === 10, String(nudges));
  }
  {
    const c = clock();
    const reports: ChatRefreshResult[] = [];
    let release!: () => void;
    const stop = startChatKeepalive({
      mode: { nudge: false, refresh: true }, ...c,
      nudge: async () => {},
      refresh: () => new Promise<ChatRefreshResult>((resolve) => { release = () => resolve({ ok: true }); }),
      onRefresh: (r) => reports.push(r),
    });
    await c.advance(CHAT_REFRESH_INTERVAL_MS);
    stop();
    release();
    await flush();
    check('a refresh that ends after stop is not reported', reports.length === 0);
  }

  console.log('\n=== one writer for posts and refreshes ===');
  {
    const run = serialTasks();
    const order: string[] = [];
    let releasePost!: () => void;
    const post = run(() => new Promise<void>((resolve) => { order.push('post:start'); releasePost = () => { order.push('post:end'); resolve(); }; }));
    const refresh = run(async () => { order.push('refresh'); });
    await flush();
    check('a refresh waits for the post in flight', JSON.stringify(order) === JSON.stringify(['post:start']), JSON.stringify(order));
    releasePost();
    await Promise.all([post, refresh]);
    check('then runs', JSON.stringify(order) === JSON.stringify(['post:start', 'post:end', 'refresh']), JSON.stringify(order));
  }

  check('intervals are one and five minutes', CHAT_NUDGE_INTERVAL_MS === 60_000 && CHAT_REFRESH_INTERVAL_MS === 300_000);
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  if (failed) process.exit(1);
})();
