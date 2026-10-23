/**
 * The bot's chat commands: `attend help`, `attend leave`, `attend discard`, written by anyone in
 * the meeting chat. Asserts the parser's exact grammar, that the bot never obeys itself, that help
 * cannot be spammed, that leave and discard act once and in order (reply, then act), and that a
 * chat that will not take the reply never stops the leave or the discard.
 *
 * Run: npx tsx src/chat-commands.test.ts
 */
import { createChatCommands, parseChatCommand, resolveChatCommandTexts, serializeSends } from './chat-commands.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  - ' + detail}`);
  if (!cond) failed++;
};

const TEXTS = { help: 'HELP TEXT', leaveAck: 'LEAVING', discardAck: 'DISCARDING' };
const BOT = 'Attend Notetaker';

function harness(over: Partial<Parameters<typeof createChatCommands>[0]> = {}) {
  const sent: string[] = [];
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const actions: string[] = [];
  let clock = 0;
  const commands = createChatCommands({
    texts: TEXTS,
    botName: BOT,
    send: async (text) => { sent.push(text); actions.push(`send:${text}`); return { ok: true, timings: { button_ms: 0, input_ms: 0, delivery_ms: 40 } }; },
    onLeave: () => { actions.push('leave'); },
    onDiscard: () => { actions.push('discard'); },
    emit: (event, fields = {}) => { events.push({ event, fields }); },
    now: () => clock,
    meetingId: 9,
    ...over,
  })!;
  return { commands, sent, events, actions, advance: (ms: number) => { clock += ms; } };
}

async function main() {
  console.log('\n=== parser ===');
  for (const text of ['attend help', 'Attend: Help', 'ATTEND:HELP', '  attend   help  ', 'attend help.', 'attend help!', 'attend help']) {
    check(`"${text}" -> help`, parseChatCommand(text) === 'help', String(parseChatCommand(text)));
  }
  check('"attend leave" -> leave', parseChatCommand('attend leave') === 'leave');
  check('"Attend: Discard" -> discard', parseChatCommand('Attend: Discard') === 'discard');
  for (const text of ['attend helping', 'please attend help', 'attend help me', 'help', 'attend', 'attendhelp now', 'attend: leave the room', '']) {
    check(`"${text}" -> nothing`, parseChatCommand(text) === null, String(parseChatCommand(text)));
  }

  console.log('\n=== texts ===');
  check('texts come from the env, trimmed', JSON.stringify(resolveChatCommandTexts({ BOT_CHAT_HELP: ' h \n', BOT_CHAT_LEAVE_ACK: 'l', BOT_CHAT_DISCARD_ACK: 'd' })) === JSON.stringify({ help: 'h', leaveAck: 'l', discardAck: 'd' }));
  check('no help text -> commands off', createChatCommands({ texts: { help: '', leaveAck: 'l', discardAck: 'd' }, botName: BOT, send: async () => ({ ok: true }), onLeave: () => {}, onDiscard: () => {} }) === undefined);

  console.log('\n=== help ===');
  {
    const { commands, sent, events, advance } = harness();
    await commands.handle({ sender: 'Priya Nair', text: 'attend help' });
    check('help replies with the help text', sent.length === 1 && sent[0] === 'HELP TEXT', JSON.stringify(sent));
    advance(10_000);
    await commands.handle({ sender: 'Priya Nair', text: 'attend help' });
    check('a second help within 30 s gets no second reply', sent.length === 1, JSON.stringify(sent));
    advance(25_000);
    await commands.handle({ sender: 'Tom Hill', text: 'Attend: help' });
    check('help after 30 s replies again', sent.length === 2, JSON.stringify(sent));
    check('a reply that landed is reported with its timings',
      events.some((e) => e.event === 'chat_reply_posted' && e.fields.command === 'help' && e.fields.delivery_ms === 40), JSON.stringify(events));
    check('each help is one chat_command event with the command name only',
      events.filter((e) => e.event === 'chat_command').length === 3 && !JSON.stringify(events).includes('Priya'), JSON.stringify(events));
  }

  console.log('\n=== how late the bot saw it ===');
  {
    const { commands, events, advance } = harness();
    advance(Date.parse('2026-10-23T07:56:31.000Z'));
    await commands.handle({ sender: 'Priya Nair', text: 'attend help', sentAt: '2026-10-23T07:56:29.500Z' });
    check('chat_command carries how old the message was when the bot saw it',
      events.some((e) => e.event === 'chat_command' && e.fields.age_ms === 1500), JSON.stringify(events));
  }

  console.log('\n=== the bot never obeys itself ===');
  {
    const { commands, sent } = harness();
    await commands.handle({ sender: 'Attend Notetaker (Unverified)', text: 'attend help' });
    await commands.handle({ sender: 'attend notetaker', text: 'attend leave' });
    check('messages from the bot are ignored', sent.length === 0, JSON.stringify(sent));
  }

  console.log('\n=== leave / discard ===');
  {
    const { commands, actions } = harness();
    await commands.handle({ sender: 'Priya Nair', text: 'attend leave' });
    check('leave: reply first, then leave', JSON.stringify(actions) === JSON.stringify(['send:LEAVING', 'leave']), JSON.stringify(actions));
    await commands.handle({ sender: 'Priya Nair', text: 'attend discard' });
    await commands.handle({ sender: 'Priya Nair', text: 'attend help' });
    check('after leave nothing else is obeyed', actions.length === 2, JSON.stringify(actions));
  }
  {
    const { commands, actions, events } = harness();
    await commands.handle({ sender: 'Priya Nair', text: 'Attend Discard' });
    check('discard: reply first, then discard', JSON.stringify(actions) === JSON.stringify(['send:DISCARDING', 'discard']), JSON.stringify(actions));
    check('discard is logged as a chat_command', events.some((e) => e.event === 'chat_command' && e.fields.command === 'discard' && e.fields.meeting_id === 9), JSON.stringify(events));
  }
  {
    const { commands, actions, events } = harness({ send: () => new Promise(() => { /* a chat that never answers */ }), replyTimeoutMs: 10 });
    await commands.handle({ sender: 'Priya Nair', text: 'attend discard' });
    check('a hung reply never stops the discard', actions.includes('discard'), JSON.stringify(actions));
    check('...and is reported', events.some((e) => e.event === 'chat_reply_failed' && e.fields.reason === 'timeout'), JSON.stringify(events));
  }
  {
    const { commands, actions } = harness({ texts: { ...TEXTS, leaveAck: '' } });
    await commands.handle({ sender: 'Priya Nair', text: 'attend leave' });
    check('an empty reply text leaves without posting', JSON.stringify(actions) === JSON.stringify(['leave']), JSON.stringify(actions));
  }
  {
    const { commands, actions } = harness();
    await commands.handle({ sender: 'Priya Nair', text: 'see you at the attend help desk' });
    check('ordinary chat is ignored', actions.length === 0, JSON.stringify(actions));
  }

  console.log('\n=== one chat, one writer ===');
  {
    const order: string[] = [];
    let release: () => void = () => {};
    const first = new Promise<void>((r) => { release = r; });
    const send = serializeSends(async (text: string) => {
      order.push(`start:${text}`);
      if (text === 'notice') await first;
      order.push(`end:${text}`);
      return { ok: true as const };
    });
    const a = send('notice');
    const b = send('help');
    await Promise.resolve();
    check('a second post waits for the first', JSON.stringify(order) === JSON.stringify(['start:notice']), JSON.stringify(order));
    release();
    await Promise.all([a, b]);
    check('...then runs', JSON.stringify(order) === JSON.stringify(['start:notice', 'end:notice', 'start:help', 'end:help']), JSON.stringify(order));
    const failing = serializeSends(async () => { throw new Error('boom'); });
    await failing('x').catch(() => {});
    check('a failed post does not jam the queue', (await serializeSends(async () => ({ ok: true as const }))('y')).ok === true);
  }

  if (failed) { console.error(`\nFAIL chat-commands: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\nPASS chat-commands: grammar, self filter, help limit, leave/discard order, bounded replies.');
}

void main();
