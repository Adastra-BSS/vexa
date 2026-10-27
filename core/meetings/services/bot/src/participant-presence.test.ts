/**
 * Who was in the meeting, carried out on the terminal lifecycle event so a consumer can tell a
 * silent participant from an invitee who never came. Built from the page's roster scans; the
 * times are ms from the recording's own t=0, like the speaker timeline.
 *
 * Run: npx tsx src/participant-presence.test.ts
 */
import { createParticipantPresence, MAX_PARTICIPANTS } from './participant-presence.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : '  - ' + detail}`);
  if (!cond) failed++;
};
const T0 = 1_000_000;

{
  const presence = createParticipantPresence();
  presence.markRecordingStart(T0);
  presence.observe(['Jana Nova', 'Petr Svoboda'], T0 + 1_000);
  presence.observe(['Jana Nova'], T0 + 60_000);
  presence.observe(['Jana Nova'], T0 + 120_000);
  const { participants } = presence.snapshot();
  check('everyone seen is reported once, in order of first sighting',
    JSON.stringify(participants?.map((p) => p.name)) === JSON.stringify(['Jana Nova', 'Petr Svoboda']), JSON.stringify(participants));
  check('someone present throughout spans first to last scan',
    participants?.[0].first_seen_ms === 1_000 && participants?.[0].last_seen_ms === 120_000, JSON.stringify(participants?.[0]));
  check('someone who left keeps the scan they were last seen in... and is gone from the next',
    participants?.[1].first_seen_ms === 1_000 && participants?.[1].last_seen_ms === 1_000, JSON.stringify(participants?.[1]));
}

{
  const presence = createParticipantPresence();
  presence.markRecordingStart(T0);
  presence.observe(['Jana Nova'], T0 + 1_000);
  presence.observe([], T0 + 5_000);
  presence.observe(['Jana Nova'], T0 + 90_000);
  const { participants } = presence.snapshot();
  check('a dropped connection and a rejoin are still one person',
    participants?.length === 1 && participants[0].first_seen_ms === 1_000 && participants[0].last_seen_ms === 90_000, JSON.stringify(participants));
}

{
  const presence = createParticipantPresence();
  presence.observe(['Early Bird'], T0 - 30_000);
  presence.markRecordingStart(T0);
  presence.observe(['Early Bird'], T0 + 10_000);
  const { participants } = presence.snapshot();
  check('someone seen before the recording started is placed at its t=0',
    participants?.[0].first_seen_ms === 0 && participants?.[0].last_seen_ms === 10_000, JSON.stringify(participants));
}

{
  const presence = createParticipantPresence();
  presence.observe(['Jana Nova'], T0);
  check('without a recording there is nothing to place the presence in', presence.snapshot().participants === undefined);
}

{
  const presence = createParticipantPresence();
  presence.markRecordingStart(T0);
  presence.observe(['  Jana Nova  ', '', '   ', 42 as unknown as string], T0 + 1);
  presence.observe('not a list' as unknown as string[], T0 + 2);
  presence.observe(['Jana Nova'], Number.NaN);
  const { participants } = presence.snapshot();
  check('names are trimmed and junk is ignored, never thrown',
    participants?.length === 1 && participants[0].name === 'Jana Nova' && participants[0].last_seen_ms === 1, JSON.stringify(participants));
}

{
  const presence = createParticipantPresence();
  presence.markRecordingStart(T0);
  presence.observe(Array.from({ length: MAX_PARTICIPANTS + 50 }, (_, i) => `Person ${i}`), T0 + 1);
  check('the report is bounded', presence.snapshot().participants?.length === MAX_PARTICIPANTS);
}

{
  const presence = createParticipantPresence();
  presence.markRecordingStart(T0);
  presence.observe(['Jana Nova'], T0 + 1);
  check('no coverage report claims nothing about completeness', presence.snapshot().roster_complete === undefined);
  presence.observeCoverage(1, 1);
  presence.observeCoverage(2, 2);
  presence.observeCoverage(0, 1);
  check('every scan naming everyone it saw is a complete roster - the bot alone with its own nameless tile included',
    presence.snapshot().roster_complete === true);
  presence.observeCoverage(1, 2);
  presence.observeCoverage(2, 2);
  check('one scan with a nameless participant makes it incomplete for good', presence.snapshot().roster_complete === false);
}

if (failed) { console.error(`\nFAIL participant-presence: ${failed} check(s) FAILED.`); process.exit(1); }
console.log('\nPASS participant-presence: first and last sighting per person, from the recording\'s t=0.');
