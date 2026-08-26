/**
 * P5 gate for the AZURE SPEECH envelope: a fast-transcription URL already names the operation and
 * the api-version, authenticates with `Ocp-Apim-Subscription-Key`, takes ONE file part named
 * `audio` plus ONE `definition` JSON field, and serves none of the OpenAI-compatible fields. The
 * adapter has to speak that envelope without any lane knowing. Response phrases arrive in
 * milliseconds and become the seconds-based segments the lanes already consume.
 * The last case is the control: the Azure OpenAI envelope is unchanged, part for part, except
 * that BCP-47 locales are truncated to the bare codes that envelope expects.
 * Run: npm test (chained)  or  npx tsx src/speech.test.ts
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

const SPEECH_URL =
  'https://northeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15';
const AZURE_URL =
  'https://acct.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?api-version=2025-04-01-preview';

async function run() {
  const SR = 16000;
  const pcm = new Float32Array(SR * 3).fill(0.05); // 3s window

  // ── Speech mode: URL verbatim, subscription-key auth, audio + definition and nothing else ──
  {
    const seen = captureFetch({
      durationMilliseconds: 3000,
      combinedPhrases: [{ channel: 0, text: 'ahoj, tohle je plán' }],
      phrases: [
        { channel: 0, offsetMilliseconds: 0, durationMilliseconds: 1200, text: 'ahoj,', locale: 'cs-CZ', confidence: 0.93 },
        { channel: 0, offsetMilliseconds: 1200, durationMilliseconds: 1800, text: 'tohle je plán', locale: 'cs-CZ', confidence: 0.91 },
      ],
    });
    const client = new TranscriptionClient({
      serviceUrl: SPEECH_URL, apiToken: 'k-123', allowedLanguages: ['cs-CZ'], sampleRate: SR,
    });
    const result = await client.transcribe(pcm);
    const c = seen();
    check('speech URL ships verbatim (no /v1 append)', c.url === SPEECH_URL, c.url);
    check('key rides Ocp-Apim-Subscription-Key', c.headers['Ocp-Apim-Subscription-Key'] === 'k-123', JSON.stringify(c.headers));
    check('no api-key header in speech mode', c.headers['api-key'] === undefined, JSON.stringify(c.headers));
    check('no Authorization header in speech mode', c.headers['Authorization'] === undefined, JSON.stringify(c.headers));
    check('the file part is named audio', c.body.includes('name="audio"; filename="audio.wav"'), c.body.slice(0, 400));
    check('definition carries the locales verbatim', partsOf(c.body, 'definition')[0] === '{"locales":["cs-CZ"]}', JSON.stringify(partsOf(c.body, 'definition')));
    check('no model part', partsOf(c.body, 'model').length === 0);
    check('no response_format part', partsOf(c.body, 'response_format').length === 0);
    check('no languages[] parts', partsOf(c.body, 'languages[]').length === 0);
    check('no singular language part', partsOf(c.body, 'language').length === 0);
    check('no timestamp_granularities part', partsOf(c.body, 'timestamp_granularities').length === 0);
    check('phrases become seconds-based segments', result.segments.length === 2
      && result.segments[0].start === 0 && Math.abs(result.segments[0].end - 1.2) < 0.001
      && Math.abs(result.segments[1].start - 1.2) < 0.001 && Math.abs(result.segments[1].end - 3) < 0.001,
      JSON.stringify(result.segments));
    check('text is rebuilt from the surviving segments', result.text === 'ahoj, tohle je plán', result.text);
    check('duration comes from durationMilliseconds', Math.abs(result.duration - 3) < 0.001, String(result.duration));
    check('language comes from the first phrase locale', result.language === 'cs-CZ', result.language);
  }

  // ── Speech mode, combinedPhrases only: one synthesized segment spanning the window ──
  {
    captureFetch({ combinedPhrases: [{ channel: 0, text: 'jen souhrn' }], phrases: [] });
    const client = new TranscriptionClient({ serviceUrl: SPEECH_URL, apiToken: 'k', sampleRate: SR });
    const result = await client.transcribe(pcm);
    check('combinedPhrases only → one synthesized segment carrying the text',
      result.segments.length === 1 && result.segments[0].text === 'jen souhrn', JSON.stringify(result.segments));
    check('synthesized segment spans the window', result.segments[0]?.start === 0 && Math.abs((result.segments[0]?.end ?? 0) - 3) < 0.01, JSON.stringify(result.segments[0]));
    check('duration falls back to the window length', Math.abs(result.duration - 3) < 0.01, String(result.duration));
  }

  // ── Speech mode, silence: nothing synthesized ──
  {
    captureFetch({ durationMilliseconds: 3000, combinedPhrases: [{ channel: 0, text: '' }], phrases: [] });
    const client = new TranscriptionClient({ serviceUrl: SPEECH_URL, apiToken: 'k', sampleRate: SR });
    const result = await client.transcribe(pcm);
    check('speech: blank text synthesizes nothing', result.segments.length === 0 && result.text.trim() === '', JSON.stringify(result));
  }

  // ── Speech mode, no locale hint: the definition is an empty object, not an empty list ──
  {
    const seen = captureFetch({ combinedPhrases: [], phrases: [] });
    const client = new TranscriptionClient({ serviceUrl: SPEECH_URL, apiToken: 'k', sampleRate: SR });
    await client.transcribe(pcm);
    check('no locales → empty definition object', partsOf(seen().body, 'definition')[0] === '{}', JSON.stringify(partsOf(seen().body, 'definition')));
  }

  // ── CONTROL: the Azure OpenAI envelope is unchanged, except locales truncate to bare codes ──
  {
    const seen = captureFetch({ text: 'ok' });
    const client = new TranscriptionClient({
      serviceUrl: AZURE_URL, apiToken: 'k-123', allowedLanguages: ['cs-CZ', 'en-US'], model: 'gpt-transcribe', sampleRate: SR,
    });
    await client.transcribe(pcm);
    const c = seen();
    check('azure-openai: URL still verbatim', c.url === AZURE_URL, c.url);
    check('azure-openai: key still rides api-key', c.headers['api-key'] === 'k-123', JSON.stringify(c.headers));
    check('azure-openai: no subscription-key header', c.headers['Ocp-Apim-Subscription-Key'] === undefined, JSON.stringify(c.headers));
    check('azure-openai: BCP-47 locales truncate to the bare codes that envelope expects',
      JSON.stringify(partsOf(c.body, 'languages[]')) === JSON.stringify(['cs', 'en']), JSON.stringify(partsOf(c.body, 'languages[]')));
    check('azure-openai: file part still named file', c.body.includes('name="file"; filename="audio.wav"'), c.body.slice(0, 400));
    check('azure-openai: no definition part', partsOf(c.body, 'definition').length === 0);
  }

  globalThis.fetch = realFetch;
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

run();
