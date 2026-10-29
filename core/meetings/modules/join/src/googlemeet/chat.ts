/**
 * Post one message into the Google Meet in-call chat as the bot - the Meet counterpart of
 * msteams/chat.ts, for the notice the bot posts right after admission (Attend's legal join notice).
 *
 * Meet's chat is plain text: typed markdown shows literally and pasted HTML is flattened, so the
 * text is always typed in its plain rendering (no bold markers, a link as "text: url"), one line at
 * a time with Shift+Enter between. The panel is opened only for the post and closed again when this
 * routine opened it, so the tile layout the speaker attribution reads is left as it was.
 *
 * Never throws: every outcome is a typed result, because a chat that cannot be posted to (the host
 * turned participant messages off, a Meet build that moved the panel) must never cost the recording.
 */

import type { Page } from "playwright";
import { chatMessageRendered, type ChatPage } from "../msteams/chat";
import { renderChatText } from "../msteams/chat-format";
import {
  googleChatButtonSelectors,
  googleChatInputSelectors,
  googleChatMessageSelectors,
  googleChatSendButtonSelectors,
} from "./selectors";

/** How long the chat toggle may take to render after admission. Polled, so a long bound costs
 *  nothing when Meet is quick; the join notice's own timeout still caps the whole post. */
export const GOOGLE_MEET_CHAT_BUTTON_TIMEOUT_MS = 60_000;

export type GoogleMeetChatFailure = "chat_disabled" | "input_not_found" | "not_rendered" | "error";

/** Where a successful post spent its time: waiting for the chat toggle (0 when the panel was
 *  already open), for the compose box, and from typing until the message showed in the list. */
export type GoogleMeetChatTimings = {
  button_ms: number;
  input_ms: number;
  delivery_ms: number;
};

export type GoogleMeetChatSendResult =
  /** `resent`: Enter left the message in the compose box and the Send button sent it. */
  | { ok: true; timings: GoogleMeetChatTimings; format: "plain"; resent?: boolean }
  | { ok: false; reason: GoogleMeetChatFailure; detail?: string };

export interface GoogleMeetChatSendOptions {
  buttonTimeoutMs?: number;
  inputTimeoutMs?: number;
  renderTimeoutMs?: number;
  pollMs?: number;
}

/** Browser context: whether the compose box holds any text. Meet's box is a textarea, whose typed
 *  text is in `value` - its textContent stays empty. */
export function textareaHasText({ selectors }: { selectors: string[] }): boolean {
  for (const selector of selectors) {
    const box = document.querySelector(selector) as HTMLTextAreaElement | null;
    if (box && (box.value || "").trim()) return true;
  }
  return false;
}

type Found = { locator: ReturnType<ReturnType<ChatPage["locator"]>["first"]> };

async function firstVisible(page: ChatPage, selectors: string[]): Promise<Found | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { locator };
  }
  return null;
}

async function waitFor<T>(probe: () => Promise<T | null | false>, timeoutMs: number, pollMs: number, page: ChatPage): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(pollMs);
  }
}

export async function sendGoogleMeetChatMessage(
  page: ChatPage | Page,
  text: string,
  options: GoogleMeetChatSendOptions = {},
): Promise<GoogleMeetChatSendResult> {
  const chatPage = page as ChatPage;
  const { buttonTimeoutMs = GOOGLE_MEET_CHAT_BUTTON_TIMEOUT_MS, inputTimeoutMs = 5000, renderTimeoutMs = 10000, pollMs = 250 } = options;
  const lines = renderChatText(text).plain.split(/\r?\n/);
  const needle = lines.find((line) => line.trim())?.trim();
  if (!needle) return { ok: false, reason: "error", detail: "empty message" };

  let openedPanel: Found["locator"] | null = null;
  try {
    let input = await firstVisible(chatPage, googleChatInputSelectors);
    let button_ms = 0;
    let input_ms = 0;
    if (!input) {
      const started = Date.now();
      const button = await waitFor(() => firstVisible(chatPage, googleChatButtonSelectors), buttonTimeoutMs, pollMs, chatPage);
      if (!button) return { ok: false, reason: "chat_disabled", detail: "no chat button" };
      const clickedAt = Date.now();
      await button.locator.click();
      openedPanel = button.locator;
      input = await waitFor(() => firstVisible(chatPage, googleChatInputSelectors), inputTimeoutMs, pollMs, chatPage);
      if (!input) return { ok: false, reason: "input_not_found" };
      button_ms = clickedAt - started;
      input_ms = Date.now() - clickedAt;
    }
    // "Let participants send messages" off leaves the box on screen but disabled for a guest.
    if (!(await input.locator.isEnabled().catch(() => false))) return { ok: false, reason: "chat_disabled", detail: "compose box disabled" };

    const typedAt = Date.now();
    await input.locator.click();
    for (const [index, line] of lines.entries()) {
      if (line) await chatPage.keyboard.insertText(line);
      if (index < lines.length - 1) await chatPage.keyboard.press("Shift+Enter");
    }
    const boxHasText = () => chatPage.evaluate(textareaHasText, { selectors: googleChatInputSelectors });
    await chatPage.keyboard.press("Enter");
    let resent = false;
    const cleared = await waitFor(async () => !(await boxHasText()), 1500, pollMs, chatPage);
    if (!cleared) {
      const send = await firstVisible(chatPage, googleChatSendButtonSelectors);
      if (send) {
        await send.locator.click();
        resent = true;
      }
    }

    const delivered = await waitFor(
      () => chatPage.evaluate(chatMessageRendered, { needle, selectors: googleChatMessageSelectors }),
      renderTimeoutMs,
      pollMs,
      chatPage,
    );
    if (!delivered) {
      const detail = (await boxHasText()) ? "text left in the compose box" : "the box emptied but the message never appeared";
      return { ok: false, reason: "not_rendered", detail };
    }
    return { ok: true, format: "plain", ...(resent ? { resent: true } : {}), timings: { button_ms, input_ms, delivery_ms: Date.now() - typedAt } };
  } catch (e: any) {
    return { ok: false, reason: "error", detail: String(e?.message || e).slice(0, 200) };
  } finally {
    if (openedPanel) await openedPanel.click().catch(() => { /* best-effort: the post already counted */ });
  }
}
