/**
 * Teams meeting-chat send - the routine behind the Attend join notice.
 *
 * Drives sendTeamsChatMessage against a fake page whose DOM is a real jsdom
 * document: the chat pane, its compose box and the rendered message list are
 * modelled separately, because the live spike (Attend playground/teams_chat_spike)
 * showed the text sitting in the compose box for a moment before Teams moves it
 * into the list - a check that looks at the whole page reports success for a
 * message nobody has received yet.
 *
 * Run: npx tsx src/msteams/chat.test.ts
 */

import { JSDOM } from 'jsdom';
import { chatMessageRendered, openTeamsChatPane, sendTeamsChatMessage, type ChatPage } from './chat';
import { teamsChatButtonSelectors, teamsChatInputSelectors, teamsChatMessageSelectors } from './selectors';

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failed++; }
}

interface FakeOptions {
  chatButton?: 'enabled' | 'disabled' | 'absent';
  paneOpen?: boolean;
  /** Whether opening the pane shows a compose box (false: Teams shows the pane but no input). */
  inputInPane?: boolean;
  /** Whether Enter moves the composed text into the message list (false: it stays composed). */
  delivers?: boolean;
  /** Make every click throw, as a detached page does. */
  clickThrows?: boolean;
  /** The toolbar is still rendering: no chat button until this many waits have passed. */
  buttonAfterWaits?: number;
  /** The chat button shows disabled until this many waits have passed. */
  enabledAfterWaits?: number;
}

/** A page whose visibility answers come from a jsdom document the fake keeps in sync. */
function fakePage(opts: FakeOptions = {}) {
  const { chatButton = 'enabled', inputInPane = true, delivers = true, clickThrows = false } = opts;
  let paneOpen = opts.paneOpen ?? false;
  let waits = 0;
  const buttonState = () =>
    waits < (opts.buttonAfterWaits ?? 0) ? 'absent' : waits < (opts.enabledAfterWaits ?? 0) ? 'disabled' : chatButton;
  let composed = '';
  const actions: string[] = [];
  const dom = new JSDOM(
    '<!doctype html><html><body>'
      + '<div role="toolbar"><button aria-label="People"></button><button aria-label="More"></button></div>'
      + '<div id="pane"></div><div id="list"></div></body></html>',
  );
  const doc = dom.window.document;

  const render = () => {
    doc.getElementById('pane')!.innerHTML = paneOpen && inputInPane
      ? `<div data-tid="ckeditor" contenteditable="true">${composed}</div>`
      : '';
  };
  render();

  const isChatButton = (sel: string) => teamsChatButtonSelectors.includes(sel);
  const isInput = (sel: string) => teamsChatInputSelectors.includes(sel);

  const page: ChatPage = {
    locator(sel: string) {
      return {
        first() {
          return {
            async isVisible() {
              if (isChatButton(sel)) return buttonState() !== 'absent';
              if (isInput(sel)) return paneOpen && inputInPane;
              return false;
            },
            async isEnabled() {
              return isChatButton(sel) ? buttonState() === 'enabled' : true;
            },
            async click() {
              if (clickThrows) throw new Error('Target page, context or browser has been closed');
              if (isChatButton(sel)) {
                paneOpen = !paneOpen;
                actions.push(paneOpen ? 'open-pane' : 'close-pane');
                render();
              } else if (isInput(sel)) {
                actions.push('focus-input');
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
        if (key === 'Enter' && delivers) {
          const message = doc.createElement('div');
          message.setAttribute('data-tid', 'chat-pane-message');
          message.innerHTML = `<div id="content-1">${composed}</div>`;
          doc.getElementById('list')!.appendChild(message);
          composed = '';
          render();
        }
      },
    },
    async evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R> {
      (globalThis as any).document = doc;
      return fn(arg);
    },
    async waitForTimeout() { waits++; },
  };
  return { page, actions, isPaneOpen: () => paneOpen };
}

const FAST = { buttonTimeoutMs: 20, inputTimeoutMs: 20, renderTimeoutMs: 20, pollMs: 1 };
const NOTICE = 'This meeting is recorded by Attend Notetaker.\nTato schuzka je nahravana.';

(async () => {
  console.log('\n=== posting into a closed pane ===');
  {
    const { page, actions, isPaneOpen } = fakePage();
    const result = await sendTeamsChatMessage(page, NOTICE, FAST);
    check('result is ok', result.ok, true);
    check('reports how long each wait took', result.ok && Object.keys(result.timings), ['button_ms', 'input_ms', 'delivery_ms']);
    check('...as whole milliseconds', result.ok && Object.values(result.timings).every((ms) => Number.isInteger(ms) && ms >= 0), true);
    check('opens the pane, types each line with Shift+Enter between, sends with Enter, closes the pane', actions, [
      'open-pane',
      'focus-input',
      'type:This meeting is recorded by Attend Notetaker.',
      'press:Shift+Enter',
      'type:Tato schuzka je nahravana.',
      'press:Enter',
      'close-pane',
    ]);
    check('pane is closed again', isPaneOpen(), false);
  }

  console.log('\n=== posting into an already open pane ===');
  {
    const { page, actions, isPaneOpen } = fakePage({ paneOpen: true });
    const result = await sendTeamsChatMessage(page, 'one line', FAST);
    check('result is ok', result.ok, true);
    check('does not touch the chat button', actions.includes('open-pane') || actions.includes('close-pane'), false);
    check('leaves the pane open as it found it', isPaneOpen(), true);
  }

  console.log('\n=== keeping the pane open for a listener ===');
  {
    const { page, actions, isPaneOpen } = fakePage();
    const result = await sendTeamsChatMessage(page, NOTICE, { ...FAST, keepOpen: true });
    check('keepOpen: posted', result.ok, true);
    check('keepOpen: the pane it opened stays open', [isPaneOpen(), actions.includes('close-pane')], [true, false]);
  }
  {
    const { page, actions, isPaneOpen } = fakePage();
    check('openTeamsChatPane: opens a closed pane', await openTeamsChatPane(page, FAST), { ok: true });
    check('...and leaves it open', [isPaneOpen(), actions], [true, ['open-pane']]);
  }
  {
    const { page, actions } = fakePage({ paneOpen: true });
    check('openTeamsChatPane: an open pane is left as it is', [await openTeamsChatPane(page, FAST), actions], [{ ok: true }, []]);
  }
  {
    const { page } = fakePage({ chatButton: 'absent' });
    const result = await openTeamsChatPane(page, FAST);
    check('openTeamsChatPane: no chat -> chat_disabled with what the toolbar showed',
      [!result.ok && result.reason, !result.ok && result.detail], ['chat_disabled', 'no chat button; toolbar: People, More']);
  }

  console.log('\n=== the toolbar is still settling right after admission ===');
  {
    const { page } = fakePage({ buttonAfterWaits: 3 });
    check('a chat button that renders late is waited for', (await sendTeamsChatMessage(page, NOTICE, FAST)).ok, true);
  }
  {
    const { page } = fakePage({ enabledAfterWaits: 3 });
    check('a chat button that enables late is waited for', (await sendTeamsChatMessage(page, NOTICE, FAST)).ok, true);
  }

  console.log('\n=== guest chat unavailable ===');
  {
    const { page, actions } = fakePage({ chatButton: 'absent' });
    const result = await sendTeamsChatMessage(page, NOTICE, FAST);
    check('no chat button -> chat_disabled', !result.ok && result.reason, 'chat_disabled');
    check('...naming what the toolbar did show', !result.ok && result.detail, 'no chat button; toolbar: People, More');
    check('nothing typed', actions.filter((a) => a.startsWith('type:')), []);
  }
  {
    const { page } = fakePage({ chatButton: 'disabled' });
    const result = await sendTeamsChatMessage(page, NOTICE, FAST);
    check('disabled chat button -> chat_disabled', [!result.ok && result.reason, !result.ok && result.detail], ['chat_disabled', 'chat button disabled; toolbar: People, More']);
  }

  console.log('\n=== pane opens without a compose box ===');
  {
    const { page, isPaneOpen } = fakePage({ inputInPane: false });
    check('-> input_not_found', await sendTeamsChatMessage(page, NOTICE, FAST), { ok: false, reason: 'input_not_found' });
    check('the pane it opened is closed again', isPaneOpen(), false);
  }

  console.log('\n=== text never leaves the compose box ===');
  {
    const { page } = fakePage({ delivers: false, paneOpen: true });
    check('composed-but-unsent text is not reported as posted', await sendTeamsChatMessage(page, NOTICE, FAST), { ok: false, reason: 'not_rendered' });
  }

  console.log('\n=== a broken page never throws out of the routine ===');
  {
    const { page } = fakePage({ clickThrows: true });
    const result = await sendTeamsChatMessage(page, NOTICE, FAST);
    check('-> error with the cause attached', [result.ok, !result.ok && result.reason, !result.ok && /closed/.test(result.detail ?? '')], [false, 'error', true]);
  }
  {
    const { page, actions } = fakePage();
    check('blank text -> error, nothing typed', (await sendTeamsChatMessage(page, '  \n ', FAST)).ok, false);
    check('blank text opens nothing', actions, []);
  }

  console.log('\n=== chatMessageRendered (browser context) ===');
  {
    const dom = new JSDOM(`<!doctype html><html><body>
      <div data-tid="ckeditor" contenteditable="true">Attend notice first line</div>
      <div data-tid="chat-pane-message"><div id="content-7">Someone else wrote this</div></div>
    </body></html>`);
    (globalThis as any).document = dom.window.document;
    check('text only in the compose box is not rendered', chatMessageRendered({ needle: 'Attend notice first line', selectors: teamsChatMessageSelectors }), false);
    check('text in a message-list entry is rendered', chatMessageRendered({ needle: 'Someone else wrote this', selectors: teamsChatMessageSelectors }), true);
    check('an invalid selector is skipped, not thrown', chatMessageRendered({ needle: 'Someone else wrote this', selectors: ['div:has-text("x")', ...teamsChatMessageSelectors] }), true);
  }

  console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})();
