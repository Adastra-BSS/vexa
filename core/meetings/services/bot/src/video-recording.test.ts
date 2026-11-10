/**
 * Who records video. meeting-api sends `captureModes: ["audio", "video"]` with EVERY recorded
 * meeting (bot_spawn/service.py), so treating that as the switch recorded the screen of every
 * meeting, Teams included and RECORD_VIDEO off. Teams video is H.264, which this browser cannot
 * decode, so a Teams capture never holds a shared screen. The deployment's RECORD_VIDEO is the
 * switch, and it applies to Google Meet only.
 *
 * Run: npx tsx src/video-recording.test.ts
 */

import { wantsVideoCapture } from './video-recording';

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failed++; }
}

const recorded = (platform: string) => ({ platform, recordingEnabled: true, captureModes: ['audio', 'video'] }) as any;

check('a Google Meet meeting with RECORD_VIDEO on is recorded', wantsVideoCapture(recorded('google_meet'), { RECORD_VIDEO: 'true' }), true);
check('a Teams meeting is never recorded, RECORD_VIDEO or not', wantsVideoCapture(recorded('teams'), { RECORD_VIDEO: 'true' }), false);
check('meeting-api\'s captureModes alone do not switch video on', wantsVideoCapture(recorded('google_meet'), {}), false);
check('RECORD_VIDEO off keeps Meet audio-only', wantsVideoCapture(recorded('google_meet'), { RECORD_VIDEO: 'false' }), false);
check('a meeting not recorded at all records no video',
  wantsVideoCapture({ platform: 'google_meet', recordingEnabled: false } as any, { RECORD_VIDEO: 'true' }), false);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
