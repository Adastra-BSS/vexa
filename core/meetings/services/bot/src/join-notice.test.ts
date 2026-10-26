/**
 * The join notice - the one message the bot posts into the meeting chat right after admission
 * (Attend's legal notice: the meeting is recorded, by whom, and how to object).
 *
 * Asserts the contract the orchestrator relies on: off when BOT_JOIN_NOTICE is empty, posted at
 * most once, every outcome reported as exactly one structured event, and post() never rejects -
 * a notice that cannot be posted must never cost the recording.
 *
 * Run: npx tsx src/join-notice.test.ts
 */
import { JOIN_NOTICE_TIMEOUT_MS, createJoinNotice, resolveJoinNotice, type NoticeSendResult } from './join-notice.js';
import { TEAMS_CHAT_BUTTON_TIMEOUT_MS } from '@vexa/join';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  - ' + detail}`);
  if (!cond) failed++;
};

type Emitted = { event: string; fields: Record<string, unknown> };
const recorder = () => {
  const events: Emitted[] = [];
  return { events, emit: (event: string, fields: Record<string, unknown> = {}) => { events.push({ event, fields }); } };
};

const NOTICE = 'This meeting is recorded by Attend Notetaker.\nTato schuzka je nahravana.';

async function main() {
  console.log('\n=== resolveJoinNotice ===');
  check('unset -> off', resolveJoinNotice({}) === '');
  check('whitespace only -> off', resolveJoinNotice({ BOT_JOIN_NOTICE: ' \n ' }) === '');
  check('multi-line text kept, outer whitespace trimmed', resolveJoinNotice({ BOT_JOIN_NOTICE: `\n${NOTICE}\n` }) === NOTICE);

  console.log('\n=== bound ===');
  check('the notice outlasts the wait for Teams to enable the chat', JOIN_NOTICE_TIMEOUT_MS > TEAMS_CHAT_BUTTON_TIMEOUT_MS + 15_000, String(JOIN_NOTICE_TIMEOUT_MS));

  console.log('\n=== off ===');
  check('empty text -> no notice at all', createJoinNotice({ text: '', send: async () => ({ ok: true }) }) === undefined);

  console.log('\n=== posted ===');
  {
    const { events, emit } = recorder();
    const sent: string[] = [];
    const notice = createJoinNotice({ text: NOTICE, meetingId: 42, emit, send: async (t) => { sent.push(t); return { ok: true }; } })!;
    await notice.post();
    await notice.post();
    check('sends the exact text', sent[0] === NOTICE, JSON.stringify(sent));
    check('posted once, a second post() is a no-op', sent.length === 1, String(sent.length));
    check('one join_notice_posted event', events.length === 1 && events[0].event === 'join_notice_posted', JSON.stringify(events));
    check('event carries the meeting id', events[0]?.fields.meeting_id === 42, JSON.stringify(events[0]));
    check('event never carries the notice text', !JSON.stringify(events).includes('recorded by'), JSON.stringify(events));
  }

  {
    const { events, emit } = recorder();
    const timings = { button_ms: 1800, input_ms: 400, delivery_ms: 21000 };
    await createJoinNotice({ text: NOTICE, emit, send: async () => ({ ok: true, timings, format: 'html' }) })!.post();
    check('the posted event says where the time went', events[0]?.fields.button_ms === 1800 && events[0].fields.delivery_ms === 21000, JSON.stringify(events));
    check('...and whether it went formatted or plain', events[0]?.fields.format === 'html', JSON.stringify(events));
  }

  console.log('\n=== failed ===');
  {
    const { events, emit } = recorder();
    const notice = createJoinNotice({ text: NOTICE, meetingId: 7, emit, send: async (): Promise<NoticeSendResult> => ({ ok: false, reason: 'chat_disabled' }) })!;
    await notice.post();
    check('a refused send -> join_notice_failed with its reason', events.length === 1 && events[0].event === 'join_notice_failed' && events[0].fields.reason === 'chat_disabled', JSON.stringify(events));
  }
  {
    const { events, emit } = recorder();
    const notice = createJoinNotice({ text: NOTICE, emit, send: async () => { throw new Error('page crashed'); } })!;
    let rejected = false;
    await notice.post().catch(() => { rejected = true; });
    check('a throwing send never rejects post()', !rejected);
    check('...and reports reason=error with the cause', events[0]?.event === 'join_notice_failed' && events[0].fields.reason === 'error' && String(events[0].fields.detail).includes('page crashed'), JSON.stringify(events));
  }
  {
    const { events, emit } = recorder();
    const notice = createJoinNotice({ text: NOTICE, emit, timeoutMs: 10, send: () => new Promise<NoticeSendResult>(() => { /* a page that never answers */ }) })!;
    await notice.post();
    check('a hung send -> reason=timeout', events[0]?.event === 'join_notice_failed' && events[0].fields.reason === 'timeout', JSON.stringify(events));
  }

  if (failed) { console.error(`\nFAIL join-notice: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\nPASS join-notice: off when empty, posted once, every outcome one event, never rejects.');
}

void main();
