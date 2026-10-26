/**
 * The bot's chat texts are written in a small markdown subset - **bold**, "- " bullets, [text](link),
 * blank lines between paragraphs - and become the HTML the bot pastes into Teams (which renders it)
 * plus the plain text it types when Teams refuses the paste.
 *
 * Run: npx tsx src/msteams/chat-format.test.ts
 */

import { renderChatText } from './chat-format';

let passed = 0, failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); passed++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`); failed++; }
}

const LINK = 'https://example.sharepoint.com/:b:/s/Site/IQB?e=zz';

console.log('\n=== html ===');
check('bold', renderChatText('**Attend Notetaker** records').html, '<p><strong>Attend Notetaker</strong> records</p>');
check('a link keeps its address and opens as a link',
  renderChatText(`[FAQ](${LINK})`).html, `<p><a href="${LINK}">FAQ</a></p>`);
check('lines in one paragraph are kept as line breaks', renderChatText('one\ntwo').html, '<p>one<br>two</p>');
check('a blank line starts a new paragraph', renderChatText('one\n\ntwo').html, '<p>one</p><p>two</p>');
check('"- " lines are a bulleted list',
  renderChatText('Facts:\n- **Retention:** 3 years\n- Access').html,
  '<p>Facts:</p><ul><li><strong>Retention:</strong> 3 years</li><li>Access</li></ul>');
check('anything else is escaped, never markup', renderChatText('<script>x</script> & "y"').html, '<p>&lt;script&gt;x&lt;/script&gt; &amp; &quot;y&quot;</p>');
check('only http(s) links become anchors', renderChatText('[x](javascript:alert(1))').html, '<p>[x](javascript:alert(1))</p>');

console.log('\n=== plain fallback ===');
check('plain drops the markers, keeps bullets and spells the link out',
  renderChatText(`**Hi**\n- **A:** b\n[FAQ](${LINK})`).plain, `Hi\n- A: b\nFAQ: ${LINK}`);
check('paragraph breaks survive in plain', renderChatText('one\n\ntwo').plain, 'one\n\ntwo');

console.log('\n=== needs formatting? ===');
check('plain text needs no paste', renderChatText('just words\nand more').formatted, false);
check('bold, bullets or links need the paste', [renderChatText('**a**').formatted, renderChatText('- a').formatted, renderChatText(`[a](${LINK})`).formatted], [true, true, true]);

console.log(`\n=== summary: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
