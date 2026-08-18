/**
 * P5 + P18 gate: the STT adapter must TRANSLATE a dependency failure into a typed,
 * attributable fault — never a bare Error, never swallowed, and never a retry-storm on a
 * permanent 402. Stubs global fetch to inject HTTP statuses.
 * Run: npm test (chained)  or  npx tsx src/errors.test.ts
 */
import { TranscriptionClient, TranscriptionError, serverRetryAfterMs } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const realFetch = globalThis.fetch;
/** Replace global fetch with one that returns `status`/`body`; returns a call counter. */
function stubFetch(status: number, body: string): () => number {
  let calls = 0;
  (globalThis as any).fetch = async () => { calls++; return new Response(body, { status }); };
  return () => calls;
}
async function faultOf(fn: () => Promise<unknown>): Promise<TranscriptionError | null> {
  try { await fn(); return null; } catch (e) { return e instanceof TranscriptionError ? e : null; }
}

async function run() {
  const pcm = new Float32Array(1600).fill(0.05);   // 0.1s of audio

  // 402 — out of balance: payment_required, NON-retryable, called exactly ONCE.
  {
    const calls = stubFetch(402, JSON.stringify({ detail: 'Insufficient balance. Available: 0.00 minutes' }));
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', maxRetries: 3, retryDelayMs: 1 });
    const f = await faultOf(() => client.transcribe(pcm, 'en'));
    check('402 → a typed TranscriptionError (not a bare Error)', !!f);
    check('402 → attributed source=stt, kind=payment_required', f?.source === 'stt' && f?.kind === 'payment_required', JSON.stringify({ s: f?.source, k: f?.kind }));
    check('402 → non-retryable', f?.retryable === false);
    check('402 → STT called exactly once (no retry storm)', calls() === 1, `calls=${calls()}`);
    check('402 → balance detail preserved', !!f?.detail && /balance/i.test(f.detail), f?.detail);
  }
  // 503 — transient: unavailable, retryable, retried maxRetries+1 times.
  {
    const calls = stubFetch(503, 'upstream down');
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', maxRetries: 2, retryDelayMs: 1 });
    const f = await faultOf(() => client.transcribe(pcm, 'en'));
    check('503 → kind=unavailable, retryable', f?.kind === 'unavailable' && f?.retryable === true);
    check('503 → retried (maxRetries+1 = 3 attempts)', calls() === 3, `calls=${calls()}`);
  }
  // 401 — bad token: unauthorized, non-retryable.
  {
    stubFetch(401, 'bad token');
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', maxRetries: 1, retryDelayMs: 1 });
    const f = await faultOf(() => client.transcribe(pcm, 'en'));
    check('401 → kind=unauthorized, non-retryable', f?.kind === 'unauthorized' && f?.retryable === false);
  }

  // The server's retry pace, read off the throttle response in every shape Azure sends it.
  {
    const h = (pairs: Record<string, string> = {}) => new Headers(pairs);
    check('Retry-After delta-seconds header → that many ms',
      serverRetryAfterMs(h({ 'retry-after': '59' }), '') === 59_000);
    const azureBody = '{"error":{"code":"RateLimitReached","message": "Please retry after 59 seconds. To increase your default rate limit, visit: https://aka.ms/oai/quotaincrease."}}';
    check('Azure prose body (no header) → 59s',
      serverRetryAfterMs(h(), azureBody) === 59_000);
    check('header wins over body prose',
      serverRetryAfterMs(h({ 'retry-after': '2' }), azureBody) === 2_000);
    check('pathological directive is capped, not obeyed',
      serverRetryAfterMs(h({ 'retry-after': '86400' }), '') === 120_000);
    check('no directive anywhere → undefined (client backoff applies)',
      serverRetryAfterMs(h(), 'plain error') === undefined);
  }

  // 429 with a server directive: the wait between attempts is the directive, not the
  // client's own backoff — a retry inside the quota window is guaranteed to fail again.
  {
    let calls = 0;
    const times: number[] = [];
    (globalThis as any).fetch = async () => {
      calls++;
      times.push(Date.now());
      if (calls === 1) return new Response('throttled', { status: 429, headers: { 'retry-after': '1' } });
      return new Response(JSON.stringify({ text: 'ok', language: 'en', duration: 0.1, segments: [] }), { status: 200 });
    };
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', maxRetries: 2, retryDelayMs: 1 });
    const result = await client.transcribe(pcm, 'en');
    const waited = times[1] - times[0];
    check('429 + Retry-After: 1 → second attempt succeeds', result.text === 'ok' && calls === 2, `calls=${calls}`);
    check('429 + Retry-After: 1 → waited the directed second, not retryDelayMs', waited >= 1000, `waited=${waited}ms`);
  }
  // 429 with no directive: the client's own exponential backoff still applies.
  {
    const calls = stubFetch(429, 'throttled, no directive');
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', maxRetries: 2, retryDelayMs: 1 });
    const f = await faultOf(() => client.transcribe(pcm, 'en'));
    check('429 (no directive) → kind=rate_limited, retried maxRetries+1 times', f?.kind === 'rate_limited' && calls() === 3, `calls=${calls()}`);
    check('429 (no directive) → no retryAfterMs on the fault', f?.retryAfterMs === undefined);
  }

  (globalThis as any).fetch = realFetch;
  if (failed) { console.error(`\n❌ stt errors: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ stt errors (P5/P18): HTTP failures become typed, attributable, correctly-retried faults — never swallowed.');
}
run().catch((e) => { console.error(e); process.exit(1); });
