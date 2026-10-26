/**
 * Diagnostic for dev meeting 43: seconds after the bot posted the join notice, the speaker scan
 * read 0 participants for the rest of the meeting, while a laptop guest opening the same pane kept
 * every tile. This records what the bot's own page looks like around the notice, as
 * `bot.chat_layout` events, so the next dev meeting shows what changed. Never chat text, only the
 * shape of the page; display names of the tiles are already in the bot's speaker log.
 */

type ProbePage = { evaluate(expression: string): Promise<unknown> };
type Emit = (event: string, fields: Record<string, unknown>) => void;

export interface ChatLayoutSample {
  url: string;
  elements: number;
  iframes: number;
  streams: { tid: string | null; size: string; outline: boolean }[];
  participantish: number;
  menuitems: number;
  dialogs: string[];
  chatPane: boolean;
  chatButtonPressed: string | null;
  focused: string;
  stageTids: Record<string, number>;
}

// Runs in the page; a string because this package compiles without DOM types.
const SAMPLE_LAYOUT_JS = `(() => {
  const streams = Array.from(document.querySelectorAll('[data-stream-type][data-tid]')).map((el) => {
    const r = el.getBoundingClientRect();
    return { tid: el.getAttribute('data-tid'), size: Math.round(r.width) + 'x' + Math.round(r.height),
             outline: !!el.querySelector('[data-tid="voice-level-stream-outline"]') };
  });
  const tids = {};
  for (const el of document.querySelectorAll('[data-tid]')) {
    const t = el.getAttribute('data-tid') || '';
    if (/stage|gallery|video|stream|tile|participant|roster|calling|chat|monitor|compact/i.test(t)) tids[t] = (tids[t] || 0) + 1;
  }
  const active = document.activeElement;
  const button = document.querySelector('#chat-button');
  return {
    url: location.pathname + location.hash.slice(0, 60),
    elements: document.getElementsByTagName('*').length,
    iframes: document.querySelectorAll('iframe').length,
    streams,
    participantish: document.querySelectorAll('[data-tid*="participant"]').length,
    menuitems: document.querySelectorAll('[role="menuitem"]').length,
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
      .map((d) => (d.getAttribute('aria-label') || d.getAttribute('data-tid') || d.tagName).slice(0, 60)),
    chatPane: !!document.querySelector('[data-tid="ckeditor"]'),
    chatButtonPressed: button ? button.getAttribute('aria-pressed') : null,
    focused: active ? active.tagName + (active.getAttribute('data-tid') ? '[' + active.getAttribute('data-tid') + ']' : '') : 'none',
    stageTids: tids,
  };
})()`;

export async function sampleChatLayout(page: ProbePage, emit: Emit, meetingId: unknown, label: string): Promise<void> {
  try {
    emit('chat_layout', { meeting_id: meetingId, label, ...(await page.evaluate(SAMPLE_LAYOUT_JS) as ChatLayoutSample) });
  } catch (e: any) {
    emit('chat_layout', { meeting_id: meetingId, label, error: String(e?.message || e).slice(0, 200) });
  }
}

/** Samples after the pane is set up, at +1 s, +5 s, +15 s and +30 s. */
export function followChatLayout(page: ProbePage, emit: Emit, meetingId: unknown): void {
  for (const seconds of [1, 5, 15, 30]) {
    setTimeout(() => { void sampleChatLayout(page, emit, meetingId, `after+${seconds}s`); }, seconds * 1000);
  }
}
