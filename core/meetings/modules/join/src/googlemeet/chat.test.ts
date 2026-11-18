/**
 * Google Meet in-call chat send - the routine behind the Attend join notice on Meet.
 *
 * Drives sendGoogleMeetChatMessage against a fake page whose DOM is a real jsdom document, shaped
 * like the live Meet panel (Attend playground/meet_chat_probe, 2026-10-29): a "Chat with everyone"
 * toggle, a "Send a message" textarea and a Send button with the same label, and messages carrying
 * `data-message-id`. Meet's chat is plain text, so the notice's markdown is always typed plain.
 *
 * Run: npx tsx src/googlemeet/chat.test.ts
 */

import { JSDOM } from 'jsdom';
import type { ChatPage } from '../msteams/chat';
import { sendGoogleMeetChatMessage } from './chat';
import { googleChatButtonSelectors, googleChatInputSelectors, googleChatSendButtonSelectors } from './selectors';

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failed++; }
}

interface FakeOptions {
  chatButton?: 'present' | 'absent';
  /** The toolbar is still rendering: no chat button until this many waits have passed. */
  buttonAfterWaits?: number;
  panelOpen?: boolean;
  /** Whether opening the panel shows a compose box. */
  inputInPanel?: boolean;
  /** The host turned "Let participants send messages" off: the box shows but is disabled. */
  inputEnabled?: boolean;
  /** Whether Enter sends the composed message. */
  enterSends?: boolean;
  /** Whether clicking the Send button sends it. */
  sendButtonSends?: boolean;
  /** Make every click throw, as a detached page does. */
  clickThrows?: boolean;
}

function fakePage(opts: FakeOptions = {}) {
  const { chatButton = 'present', inputInPanel = true, inputEnabled = true, clickThrows = false } = opts;
  const { enterSends = true, sendButtonSends = true } = opts;
  let panelOpen = opts.panelOpen ?? false;
  let waits = 0;
  let composed = '';
  let delivered = 0;
  const actions: string[] = [];
  const dom = new JSDOM('<!doctype html><html><body><div id="panel"></div><div id="list"></div></body></html>');
  const doc = dom.window.document;
  const render = () => {
    // The typed text goes into the textarea's value, as in a browser; its textContent stays empty.
    doc.getElementById('panel')!.innerHTML = panelOpen && inputInPanel
      ? '<textarea aria-label="Send a message" placeholder="Send a message"></textarea>'
      : '';
    const box = doc.querySelector('textarea');
    if (box) box.value = composed;
  };
  render();

  const buttonShown = () => chatButton === 'present' && waits >= (opts.buttonAfterWaits ?? 0);
  const isChatButton = (sel: string) => googleChatButtonSelectors.includes(sel);
  const isInput = (sel: string) => googleChatInputSelectors.includes(sel);
  const isSendButton = (sel: string) => googleChatSendButtonSelectors.includes(sel);
  const deliver = () => {
    const message = doc.createElement('div');
    message.setAttribute('data-message-id', `spaces/abc/messages/${++delivered}`);
    message.textContent = composed;
    doc.getElementById('list')!.appendChild(message);
    composed = '';
    render();
  };

  const page: ChatPage = {
    locator(sel: string) {
      return {
        first() {
          return {
            async isVisible() {
              if (isChatButton(sel)) return buttonShown();
              if (isInput(sel) || isSendButton(sel)) return panelOpen && inputInPanel;
              return false;
            },
            async isEnabled() {
              return isInput(sel) ? inputEnabled : true;
            },
            async click() {
              if (clickThrows) throw new Error('Target page, context or browser has been closed');
              if (isChatButton(sel)) {
                panelOpen = !panelOpen;
                actions.push(panelOpen ? 'open-panel' : 'close-panel');
                render();
              } else if (isInput(sel)) {
                actions.push('focus-input');
              } else if (isSendButton(sel)) {
                actions.push('click-send');
                if (sendButtonSends && composed) deliver();
              }
            },
          };
        },
      };
    },
    keyboard: {
      async insertText(text: string) { composed += text; actions.push(`type:${text}`); render(); },
      async press(key: string) {
        actions.push(`press:${key}`);
        if (key === 'Shift+Enter') { composed += '\n'; render(); return; }
        if (key === 'Enter' && enterSends) deliver();
      },
    },
    async evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R> {
      (globalThis as any).document = doc;
      return fn(arg);
    },
    async waitForTimeout() { waits++; },
  };
  return { page, actions, isPanelOpen: () => panelOpen, messages: () => Array.from(doc.querySelectorAll('[data-message-id]')).map((m) => m.textContent) };
}

const FAST = { buttonTimeoutMs: 20, inputTimeoutMs: 20, renderTimeoutMs: 20, pollMs: 1 };
const NOTICE = 'This meeting is recorded by Attend Notetaker.\nTato schuzka je nahravana.';

(async () => {
  console.log('\n=== posting into a closed panel ===');
  {
    const { page, actions, isPanelOpen } = fakePage();
    const result = await sendGoogleMeetChatMessage(page, NOTICE, FAST);
    check('result is ok', result.ok, true);
    check('reports how long each wait took', result.ok && Object.keys(result.timings), ['button_ms', 'input_ms', 'delivery_ms']);
    check('opens the panel, types each line with Shift+Enter between, sends with Enter, closes the panel', actions, [
      'open-panel',
      'focus-input',
      'type:This meeting is recorded by Attend Notetaker.',
      'press:Shift+Enter',
      'type:Tato schuzka je nahravana.',
      'press:Enter',
      'close-panel',
    ]);
    check('the panel is closed again', isPanelOpen(), false);
  }

  console.log('\n=== posting into an already open panel ===');
  {
    const { page, actions, isPanelOpen } = fakePage({ panelOpen: true });
    const result = await sendGoogleMeetChatMessage(page, 'one line', FAST);
    check('result is ok', result.ok, true);
    check('does not touch the chat button', actions.includes('open-panel') || actions.includes('close-panel'), false);
    check('leaves the panel open as it found it', isPanelOpen(), true);
  }

  console.log('\n=== the notice markdown, as Meet shows plain text ===');
  {
    const { page, actions, messages } = fakePage();
    const result = await sendGoogleMeetChatMessage(page, '**EN:** Attend records this.\n- **Retention:** 3 years\n- [FAQ](https://example.com/faq)\n\nCommands: attend help', FAST);
    check('typed plain: no bold markers, a link as "text: url", a bullet keeps its dash', actions.filter((a) => a.startsWith('type:')), [
      'type:EN: Attend records this.',
      'type:- Retention: 3 years',
      'type:- FAQ: https://example.com/faq',
      'type:Commands: attend help',
    ]);
    check('a blank line between paragraphs is two line breaks', actions.filter((a) => a === 'press:Shift+Enter').length, 4);
    check('says it went plain', result.ok && result.format, 'plain');
    check('one message, with its line breaks', messages(), ['EN: Attend records this.\n- Retention: 3 years\n- FAQ: https://example.com/faq\n\nCommands: attend help']);
  }

  console.log('\n=== a message Enter did not send ===');
  {
    const { page, actions } = fakePage({ panelOpen: true, enterSends: false });
    const result = await sendGoogleMeetChatMessage(page, NOTICE, FAST);
    check('text left in the box is sent with the Send button', [result.ok, actions.includes('click-send')], [true, true]);
    check('...and the result says it needed the button', result.ok && result.resent, true);
  }
  {
    const { page, actions } = fakePage({ panelOpen: true });
    await sendGoogleMeetChatMessage(page, NOTICE, FAST);
    check('Enter that sends needs no button', actions.includes('click-send'), false);
  }
  {
    const { page } = fakePage({ panelOpen: true, enterSends: false, sendButtonSends: false });
    const result = await sendGoogleMeetChatMessage(page, NOTICE, FAST);
    check('a message that never left the box says so', [!result.ok && result.reason, !result.ok && result.detail], ['not_rendered', 'text left in the compose box']);
  }

  console.log('\n=== the toolbar is still settling right after admission ===');
  {
    const { page } = fakePage({ buttonAfterWaits: 3 });
    check('a chat button that renders late is waited for', (await sendGoogleMeetChatMessage(page, NOTICE, FAST)).ok, true);
  }

  console.log('\n=== chat unavailable ===');
  {
    const { page, actions } = fakePage({ chatButton: 'absent' });
    const result = await sendGoogleMeetChatMessage(page, NOTICE, FAST);
    check('no chat button -> chat_disabled', [!result.ok && result.reason, !result.ok && result.detail], ['chat_disabled', 'no chat button']);
    check('nothing typed', actions.filter((a) => a.startsWith('type:')), []);
  }
  {
    const { page, actions, isPanelOpen } = fakePage({ inputEnabled: false });
    const result = await sendGoogleMeetChatMessage(page, NOTICE, FAST);
    check('the host let nobody send messages -> chat_disabled', [!result.ok && result.reason, !result.ok && result.detail], ['chat_disabled', 'compose box disabled']);
    check('...nothing typed, and the panel it opened is closed again', [actions.filter((a) => a.startsWith('type:')), isPanelOpen()], [[], false]);
  }
  {
    const { page, isPanelOpen } = fakePage({ inputInPanel: false });
    check('a panel without a compose box -> input_not_found', await sendGoogleMeetChatMessage(page, NOTICE, FAST), { ok: false, reason: 'input_not_found' });
    check('...and the panel it opened is closed again', isPanelOpen(), false);
  }

  console.log('\n=== a broken page never throws out of the routine ===');
  {
    const { page } = fakePage({ clickThrows: true });
    const result = await sendGoogleMeetChatMessage(page, NOTICE, FAST);
    check('-> error with the cause attached', [result.ok, !result.ok && result.reason, !result.ok && /closed/.test(result.detail ?? '')], [false, 'error', true]);
  }
  {
    const { page, actions } = fakePage();
    check('blank text -> error', (await sendGoogleMeetChatMessage(page, '  \n ', FAST)).ok, false);
    check('blank text opens nothing', actions, []);
  }

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})();
