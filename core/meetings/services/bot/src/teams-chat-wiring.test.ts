/**
 * Teams chat wiring - the page->Node boundary for the bot's chat commands.
 *
 * Drives the REAL page-side bundle (dist/browser-utils.global.js) and the REAL startCaptureBridge
 * against a fake Playwright Page whose exposeFunction/evaluate run in-process, over a Teams-shaped
 * chat pane. With listenTeamsChat on, a message written after the bot started must cross to the
 * Node-side chat sink, and the chat's history must not. With it off, no reader runs at all: a stack
 * without chat commands reads nobody's chat.
 *
 * Run: npx tsx src/teams-chat-wiring.test.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startCaptureBridge } from './capture-bridge.js';
import type { Invocation } from './config.js';
import type { BotPipeline } from './pipeline.js';

let failed = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond || !detail ? '' : ` - ${detail}`}`);
  if (!cond) failed++;
};

const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'browser-utils.global.js');
if (!existsSync(BUNDLE)) {
  console.error(`FAIL missing ${BUNDLE} - build the capture bundle first (pnpm --filter @vexa/bot build).`);
  process.exit(1);
}

// Minimal DOM: only `[attr="v"]` / `[attr*="v"]` selectors match, which is all the chat reader needs.
class El {
  constructor(public attrs: Record<string, string> = {}, public kids: El[] = [], public text = '') {}
  get textContent(): string { return this.text + this.kids.map((k) => k.textContent).join(''); }
  get childElementCount(): number { return this.kids.length; }
  get tagName(): string { return 'DIV'; }
  getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n] : null; }
  querySelector(sel: string): El | null { for (const k of this.all()) if (k.matches(sel)) return k; return null; }
  querySelectorAll(sel: string): El[] { return this.all().filter((k) => k.matches(sel)); }
  matches(sel: string): boolean {
    return sel.split(',').some((one) => {
      const m = one.trim().match(/^\[([a-zA-Z0-9_-]+)(?:(\*?=)"([^"]*)")?\]$/);
      if (!m) return false;
      const v = this.getAttribute(m[1]);
      if (v == null) return false;
      if (!m[2]) return true;
      return m[2] === '*=' ? v.includes(m[3]) : v === m[3];
    });
  }
  private all(): El[] { const out: El[] = []; const w = (e: El) => { for (const k of e.kids) { out.push(k); w(k); } }; w(this); return out; }
}
const message = (sender: string, text: string, mid: string) => new El({ 'data-tid': 'chat-pane-message', 'data-mid': mid }, [
  new El({ 'data-tid': 'message-author-name' }, [], sender),
  new El({ 'data-tid': 'messageBodyContent' }, [], text),
]);
const list = new El({ 'data-tid': 'chat-pane-list' }, [message('Priya Nair', 'attend help', 'old-1')]);
const root = new El({ 'data-tid': 'body' }, [list]);

const g = globalThis as unknown as Record<string, unknown>;
g.document = {
  body: root,
  querySelector: (s: string) => (root.matches(s) ? root : root.querySelector(s)),
  querySelectorAll: (s: string) => (root.matches(s) ? [root, ...root.querySelectorAll(s)] : root.querySelectorAll(s)),
};
g.MutationObserver = class { observe() { /* the poll drives this test */ } disconnect() { /* */ } };
const intervals: Array<() => void> = [];
(g as any).setInterval = (cb: () => void) => { intervals.push(cb); return intervals.length; };
(g as any).clearInterval = () => { /* controlled clock */ };
g.window = g;

new Function(readFileSync(BUNDLE, 'utf8'))();
const utils = g.VexaBrowserUtils as Record<string, unknown> | undefined;
check('bundle: window.VexaBrowserUtils.createTeamsChat is exported', typeof utils?.createTeamsChat === 'function', `keys: ${Object.keys(utils ?? {}).join(',')}`);

const page = {
  async exposeFunction(name: string, fn: unknown): Promise<void> { g[name] = fn; },
  async evaluate(fn: (arg: never) => unknown, arg?: unknown): Promise<unknown> { return fn(arg as never); },
} as never;
const pipeline = {
  async start() { /* */ }, async stop() { /* */ },
  feedAudio() { /* */ }, feedMixedAudio() { /* */ }, recordHint() { /* */ }, recordCaptionName() { /* */ },
} as unknown as BotPipeline;
const inv = { platform: 'teams', botName: 'Attend Notetaker', connectionId: 'test' } as unknown as Invocation;
const tick = () => { for (const cb of [...intervals]) cb(); };

// Off: no reader, nothing read.
{
  const chat: string[] = [];
  const stop = await startCaptureBridge(page, inv, pipeline, undefined, (s, t) => chat.push(`${s}: ${t}`));
  tick();
  check('off: no chat reader runs without listenTeamsChat', !g.__vexaTeamsChat && chat.length === 0, JSON.stringify(chat));
  await stop();
}

// On: only what is written after the bot started crosses.
{
  const chat: string[] = [];
  const stop = await startCaptureBridge(page, inv, pipeline, undefined, (s, t) => chat.push(`${s}: ${t}`), undefined, undefined, { listenTeamsChat: true });
  tick();
  check('on: the chat history is not reported', chat.length === 0, JSON.stringify(chat));
  list.kids.push(message('Tom Hill', 'Attend: Leave', 'new-1'));
  tick();
  check('on: a message written after start crosses page->Node with sender and text',
    chat.length === 1 && chat[0] === 'Tom Hill: Attend: Leave', JSON.stringify(chat));
  await stop();
  check('teardown: the reader is destroyed', !g.__vexaTeamsChat);
}

if (failed) { console.error(`\nFAIL teams-chat-wiring: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nPASS teams-chat-wiring: the bundled reader crosses new chat messages only, and only when asked to.');
