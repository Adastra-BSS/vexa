/**
 * The bot's chat texts (join notice, command replies) are written in a small markdown subset:
 *
 *   **bold**          bold
 *   - item            a bulleted list (consecutive lines)
 *   [text](https://)  a link (http and https only)
 *   blank line        a new paragraph; a single line break stays a line break
 *
 * Teams renders formatting only when it is pasted as HTML - typed markdown shows up literally - so
 * this yields both the HTML to paste and the plain text to type when the paste is refused.
 * Everything that is not one of these markers is escaped: the text comes from configuration and is
 * never trusted as markup.
 */

export interface RenderedChatText {
  html: string;
  plain: string;
  /** Whether there is any formatting to lose: plain text is typed directly, no paste needed. */
  formatted: boolean;
}

const BOLD = /\*\*(.+?)\*\*/g;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
const BULLET = /^- (.*)$/;

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inlineHtml(text: string): string {
  // Links first, on the raw text, so their addresses are escaped as attributes, not as prose.
  let out = "";
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    out += escapeHtml(text.slice(last, match.index)) + `<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`;
    last = (match.index ?? 0) + match[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out.replace(BOLD, "<strong>$1</strong>");
}

const inlinePlain = (text: string): string => text.replace(LINK, "$1: $2").replace(BOLD, "$1");

export function renderChatText(text: string): RenderedChatText {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const html: string[] = [];
  for (const paragraph of paragraphs) {
    let prose: string[] = [];
    let items: string[] = [];
    const flushProse = () => { if (prose.length) html.push(`<p>${prose.join("<br>")}</p>`); prose = []; };
    const flushItems = () => { if (items.length) html.push(`<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`); items = []; };
    for (const line of paragraph.split("\n")) {
      const bullet = BULLET.exec(line.trim());
      if (bullet) {
        flushProse();
        items.push(inlineHtml(bullet[1]));
      } else {
        flushItems();
        prose.push(inlineHtml(line.trim()));
      }
    }
    flushProse();
    flushItems();
  }
  const plain = paragraphs.map((p) => p.split("\n").map((line) => inlinePlain(line.trim())).join("\n")).join("\n\n");
  const formatted = /\*\*.+?\*\*/.test(text) || /\[[^\]]+\]\(https?:\/\//.test(text) || /^\s*- /m.test(text);
  return { html: html.join(""), plain, formatted };
}
