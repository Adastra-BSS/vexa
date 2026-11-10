/**
 * Google turning the bot away at the door (Attend meetings 52, 63, 66 and 72, 2026-11-09/10): the
 * page left the meeting for "You can't join this video call" and then the product page
 * (workspace.google.com/products/meet), and the bot spent its whole join budget looking for a Join
 * button there. A later try on the same link got in, so the link is opened again before giving up.
 *
 * Run: npx tsx src/googlemeet/redirect.test.ts
 */

import { isOffTheMeeting, withMeetLinkRetry } from './join';

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failed++; }
}

const MEETING = 'https://meet.google.com/jqv-rxqe-urw?hl=en';

async function main() {
  console.log('isOffTheMeeting');
  check('the product page is off the meeting',
    isOffTheMeeting('https://workspace.google.com/products/meet/?hl=en', MEETING, 'OK, got it'), true);
  check('Meet\'s own refusal on the meeting\'s URL is off the meeting',
    isOffTheMeeting(MEETING, MEETING, "You can't join this video call\nReturning to home screen"), true);
  check('Meet\'s home screen is off the meeting',
    isOffTheMeeting('https://meet.google.com/landing?hl=en', MEETING, ''), true);
  check('the meeting\'s green room is on the meeting',
    isOffTheMeeting(MEETING, MEETING, 'What\'s your name?\nAsk to join'), false);
  check('a URL that cannot be read is not judged off',
    isOffTheMeeting('not a url', MEETING, ''), false);

  console.log('withMeetLinkRetry');
  {
    const reopened: string[] = [];
    let tries = 0;
    const result = await withMeetLinkRetry(async () => {
      tries++;
      if (tries < 3) throw new Error('Could not locate join button');
      return 'joined';
    }, { offTheMeeting: async () => true, reopen: async () => { reopened.push('reopen'); }, log: () => {} });
    check('turned away twice, the third open of the link gets in', [result, tries, reopened.length], ['joined', 3, 2]);
  }
  {
    let tries = 0;
    let message = '';
    try {
      await withMeetLinkRetry(async () => { tries++; throw new Error('Could not locate join button'); },
        { offTheMeeting: async () => true, reopen: async () => {}, log: () => {} });
    } catch (e: any) { message = String(e?.message || e); }
    check('after the retries it fails with the join error, as before', [tries, message], [3, 'Could not locate join button']);
  }
  {
    let tries = 0;
    let message = '';
    try {
      await withMeetLinkRetry(async () => { tries++; throw new Error('Could not locate join button'); },
        { offTheMeeting: async () => false, reopen: async () => {}, log: () => {} });
    } catch (e: any) { message = String(e?.message || e); }
    check('a failure on the meeting itself is not retried', [tries, message], [1, 'Could not locate join button']);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
