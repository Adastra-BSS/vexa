/**
 * P5 gate for the AZURE envelope of the same audio API: an Azure OpenAI deployment URL already
 * names the deployment and the api-version, authenticates with `api-key`, serves `json` only, and
 * does not serve faster-whisper's granularity/VAD knobs. The adapter has to speak that envelope
 * without any lane knowing, and a bilingual room must reach the model as a language SET rather
 * than one pinned language. Stubs global fetch and inspects the URL, headers and multipart body.
 * The last case is the control: a non-Azure URL's request is unchanged, part for part.
 * Run: npm test (chained)  or  npx tsx src/azure.test.ts
 */
import { TranscriptionClient } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const realFetch = globalThis.fetch;

interface Captured { url: string; headers: Record<string, string>; body: string }

/** Replace global fetch with a 200 stub returning `payload`, capturing url + headers + body. */
function captureFetch(payload: unknown): () => Captured {
  const seen: Captured = { url: '', headers: {}, body: '' };
  (globalThis as any).fetch = async (url: unknown, init: { body: Buffer; headers: Record<string, string> }) => {
    seen.url = String(url);
    seen.headers = init.headers;
    seen.body = Buffer.from(init.body).toString('latin1');
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return () => seen;
}

/** Every value of form part `name` in a captured multipart body, in wire order. */
function partsOf(body: string, name: string): string[] {
  const re = new RegExp(`name="${name.replace(/[[\]]/g, '\\$&')}"\\r\\n\\r\\n([^\\r]*)\\r\\n`, 'g');
  return [...body.matchAll(re)].map((m) => m[1]);
}

const AZURE_URL =
  'https://acct.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-04-01-preview';

async function run() {
  const SR = 16000;
  const pcm = new Float32Array(SR * 3).fill(0.05); // 3s window

  // ── Azure mode: the URL ships verbatim, key rides `api-key`, json-only, no whisper knobs ──
  {
    const seen = captureFetch({ text: 'ahoj, this is the plan' });
    const client = new TranscriptionClient({
      serviceUrl: AZURE_URL, apiToken: 'k-123', allowedLanguages: ['cs', 'en'], model: 'gpt-transcribe', sampleRate: SR,
    });
    const result = await client.transcribe(pcm);
    const c = seen();
    check('azure URL ships verbatim (deployment + api-version, no /v1 append)', c.url === AZURE_URL, c.url);
    check('key rides the api-key header', c.headers['api-key'] === 'k-123', JSON.stringify(c.headers));
    check('no Authorization header in azure mode', c.headers['Authorization'] === undefined, JSON.stringify(c.headers));
    check('response_format=json (verbose_json is a 400 there)', partsOf(c.body, 'response_format')[0] === 'json', JSON.stringify(partsOf(c.body, 'response_format')));
    check('no timestamp_granularities part', partsOf(c.body, 'timestamp_granularities').length === 0);
    check('model part carries the deployment model', partsOf(c.body, 'model')[0] === 'gpt-transcribe', JSON.stringify(partsOf(c.body, 'model')));
    check('allowedLanguages ride one languages[] part each, in order',
      JSON.stringify(partsOf(c.body, 'languages[]')) === JSON.stringify(['cs', 'en']), JSON.stringify(partsOf(c.body, 'languages[]')));
    check('no singular language part when none was asked for (model may switch cs↔en)',
      partsOf(c.body, 'language').length === 0, JSON.stringify(partsOf(c.body, 'language')));
    // Plain-json mitigation: one segment spanning the window we actually sent.
    check('plain json → one synthesized segment carrying the text', result.segments.length === 1 && result.segments[0].text === 'ahoj, this is the plan', JSON.stringify(result.segments));
    check('synthesized segment spans the window (not end:0)', result.segments[0]?.start === 0 && Math.abs((result.segments[0]?.end ?? 0) - 3) < 0.01, JSON.stringify(result.segments[0]));
    check('duration falls back to the window length', Math.abs(result.duration - 3) < 0.01, String(result.duration));
  }

  // ── Azure mode with an explicit language: the singular part is sent as-is, hint still rides ──
  {
    const seen = captureFetch({ text: 'ok' });
    const client = new TranscriptionClient({ serviceUrl: AZURE_URL, apiToken: 'k', allowedLanguages: ['cs', 'en'], sampleRate: SR });
    await client.transcribe(pcm, 'cs');
    check('explicit language still rides the language part', partsOf(seen().body, 'language')[0] === 'cs', JSON.stringify(partsOf(seen().body, 'language')));
  }

  // ── Azure mode, segments present: honoured, nothing synthesized ──
  {
    captureFetch({ text: 'a b', segments: [{ start: 1, end: 2, text: 'a' }, { start: 2, end: 3, text: 'b' }] });
    const client = new TranscriptionClient({ serviceUrl: AZURE_URL, sampleRate: SR });
    const result = await client.transcribe(pcm);
    check('azure: real segments are honoured untouched', result.segments.length === 2 && result.segments[1].end === 3, JSON.stringify(result.segments));
  }

  // ── Azure mode, empty text: no phantom segment ──
  {
    captureFetch({ text: '   ' });
    const client = new TranscriptionClient({ serviceUrl: AZURE_URL, sampleRate: SR });
    const result = await client.transcribe(pcm);
    check('azure: blank text synthesizes nothing', result.segments.length === 0 && result.text.trim() === '', JSON.stringify(result));
  }

  // ── CONTROL: a non-Azure URL's request is today's request, part for part ──
  {
    const seen = captureFetch({ text: 'ok', language: 'en', duration: 0.1, segments: [] });
    const client = new TranscriptionClient({
      serviceUrl: 'http://stt.test', apiToken: 'tok', allowedLanguages: ['cs', 'en'], sampleRate: SR,
      maxSpeechDurationSec: 12, minSilenceDurationMs: 100,
    });
    const result = await client.transcribe(pcm, 'en');
    const c = seen();
    check('non-azure: /v1/audio/transcriptions is appended', c.url === 'http://stt.test/v1/audio/transcriptions', c.url);
    check('non-azure: bearer token, no api-key', c.headers['Authorization'] === 'Bearer tok' && c.headers['api-key'] === undefined, JSON.stringify(c.headers));
    check('non-azure: response_format stays verbose_json', partsOf(c.body, 'response_format')[0] === 'verbose_json');
    check('non-azure: word timestamps still requested', partsOf(c.body, 'timestamp_granularities')[0] === 'word');
    check('non-azure: VAD knobs still ride', partsOf(c.body, 'max_speech_duration_s')[0] === '12' && partsOf(c.body, 'min_silence_duration_ms')[0] === '100');
    check('non-azure: allowedLanguages does NOT reach the wire', partsOf(c.body, 'languages[]').length === 0);
    check('non-azure: no segments → no synthesized segment (today\'s shape)', result.segments.length === 0 && result.text === 'ok', JSON.stringify(result));
  }

  globalThis.fetch = realFetch;
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

run();
