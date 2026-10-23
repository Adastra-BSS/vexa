/**
 * Post one message into the Teams meeting chat as the bot.
 *
 * Used for the notice the bot posts right after admission (Attend's legal join notice). The pane
 * is opened only for the post and closed again when this routine opened it, so the meeting
 * layout - which the speaker detection reads - is left as it was.
 *
 * Never throws: every outcome is a typed result, because a chat that cannot be posted to (guest
 * chat disabled by the tenant or organizer, a Teams build that moved the editor) must never cost
 * the recording.
 */

import type { Page } from "playwright";
import { renderChatText } from "./chat-format";
import {
  teamsChatButtonSelectors,
  teamsChatInputSelectors,
  teamsChatMessageSelectors,
  teamsChatSendButtonSelectors,
} from "./selectors";

/** How long a guest's Chat button may take to become usable after admission. Teams builds the
 *  guest's chat late and slowly on a small machine: on the bot's 0.75 vCPU the button showed but
 *  stayed disabled for 22-30 s (Attend dev, 2026-10-23), and a 20 s wait lost the notice. The
 *  button is polled, so a long bound costs nothing when Teams is quick. */
export const TEAMS_CHAT_BUTTON_TIMEOUT_MS = 120_000;

export type TeamsChatFailure = "chat_disabled" | "input_not_found" | "not_rendered" | "error";

/** Where a successful post spent its time: waiting for a usable chat button (0 when the pane was
 *  already open), for the compose box, and from typing until the message showed in the list. */
export type TeamsChatTimings = {
  button_ms: number;
  input_ms: number;
  delivery_ms: number;
};

export type TeamsChatSendResult =
  /** `format`: `html` when the formatted text was pasted and Teams took it, `plain` when it was typed.
   *  `resent`: Enter left the message in the compose box and the Send button sent it. */
  | { ok: true; timings: TeamsChatTimings; format: "html" | "plain"; resent?: boolean }
  | { ok: false; reason: TeamsChatFailure; detail?: string };

export interface TeamsChatSendOptions {
  /** How long to wait for a usable chat button (default TEAMS_CHAT_BUTTON_TIMEOUT_MS). Right
   *  after admission Teams is still building the guest's chat. */
  buttonTimeoutMs?: number;
  /** How long to wait for the compose box after opening the pane. */
  inputTimeoutMs?: number;
  /** How long to wait for the sent message to appear in the message list. */
  renderTimeoutMs?: number;
  pollMs?: number;
  /** Leave a pane this routine opened open, for a listener reading the chat (the bot's commands). */
  keepOpen?: boolean;
}

export type TeamsChatOpenResult = { ok: true } | { ok: false; reason: "chat_disabled" | "input_not_found" | "error"; detail?: string };

interface ChatLocator {
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  click(): Promise<void>;
}

/** The part of a Playwright Page this routine uses, so tests can drive it without a browser. */
export interface ChatPage {
  locator(selector: string): { first(): ChatLocator };
  keyboard: { insertText(text: string): Promise<void>; press(key: string): Promise<void> };
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * Browser context: whether a rendered message-list entry contains `needle`. Only list entries
 * count; the compose box holds the same text until Teams has accepted the message.
 */
export function chatMessageRendered({ needle, selectors }: { needle: string; selectors: string[] }): boolean {
  for (const selector of selectors) {
    let nodes: Element[];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      continue;
    }
    if (nodes.some((node) => (node.textContent || "").includes(needle))) return true;
  }
  return false;
}

/**
 * Browser context: the labels of the in-call toolbar's buttons. Carried on a chat_disabled
 * failure so it says what the bot could see - a "More" with no "Chat" is a toolbar that folded the
 * button away, an empty list is a toolbar that never rendered.
 */
export function toolbarButtonLabels(): string[] {
  const labels = Array.from(document.querySelectorAll('[role="toolbar"] button, button[id$="-button"]'))
    .map((button) => (button.getAttribute("aria-label") || button.textContent || "").trim().slice(0, 40))
    .filter(Boolean);
  return Array.from(new Set(labels)).slice(0, 20);
}

/**
 * Browser context: paste formatted text into the focused compose box, the way a person pasting from
 * a document does. Teams renders pasted HTML (bold, lists, links) but shows typed markdown literally.
 */
export function pasteChatHtml({ html, plain }: { html: string; plain: string }): void {
  const target = document.activeElement;
  if (!target) return;
  const data = new DataTransfer();
  data.setData("text/html", html);
  data.setData("text/plain", plain);
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** Browser context: whether the compose box holds any text - i.e. whether a paste was taken. */
export function composeHasText({ selectors }: { selectors: string[] }): boolean {
  for (const selector of selectors) {
    let box: Element | null = null;
    try {
      box = document.querySelector(selector);
    } catch {
      continue;
    }
    if (box && (box.textContent || "").trim()) return true;
  }
  return false;
}

async function chatUnavailableDetail(page: ChatPage): Promise<string> {
  const shown = (await firstVisible(page, teamsChatButtonSelectors)) ? "chat button disabled" : "no chat button";
  const labels = await page.evaluate(toolbarButtonLabels, undefined).catch(() => [] as string[]);
  return `${shown}; toolbar: ${labels.length ? labels.join(", ") : "(none)"}`;
}

async function firstVisible(page: ChatPage, selectors: string[]): Promise<{ selector: string; locator: ChatLocator } | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { selector, locator };
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

type PaneOpening =
  | { ok: true; input: { locator: ChatLocator }; openedPane: ChatLocator | null; button_ms: number; input_ms: number }
  | { ok: false; reason: "chat_disabled" | "input_not_found"; detail?: string };

type PaneFailure = Extract<PaneOpening, { ok: false }>;
const paneFailed = (opening: PaneOpening): opening is PaneFailure => !opening.ok;
const failure = (f: PaneFailure) => ({ ok: false as const, reason: f.reason, ...(f.detail ? { detail: f.detail } : {}) });

/** Get the pane's compose box on screen: as it is if the pane is open, else wait for a usable Chat
 *  button, click it and wait for the box. */
async function openPane(chatPage: ChatPage, options: TeamsChatSendOptions): Promise<PaneOpening> {
  const { buttonTimeoutMs = TEAMS_CHAT_BUTTON_TIMEOUT_MS, inputTimeoutMs = 5000, pollMs = 250 } = options;
  const already = await firstVisible(chatPage, teamsChatInputSelectors);
  if (already) return { ok: true, input: already, openedPane: null, button_ms: 0, input_ms: 0 };
  const started = Date.now();
  const button = await waitFor(
    async () => {
      const found = await firstVisible(chatPage, teamsChatButtonSelectors);
      return found && (await found.locator.isEnabled().catch(() => false)) ? found : null;
    },
    buttonTimeoutMs,
    pollMs,
    chatPage,
  );
  if (!button) return { ok: false, reason: "chat_disabled", detail: await chatUnavailableDetail(chatPage) };
  const clickedAt = Date.now();
  await button.locator.click();
  const input = await waitFor(() => firstVisible(chatPage, teamsChatInputSelectors), inputTimeoutMs, pollMs, chatPage);
  if (!input) {
    // Put the layout back: a pane with no compose box is of no use to anyone.
    await button.locator.click().catch(() => { /* best-effort */ });
    return { ok: false, reason: "input_not_found" };
  }
  return { ok: true, input, openedPane: button.locator, button_ms: clickedAt - started, input_ms: Date.now() - clickedAt };
}

/** Open the meeting chat pane and leave it open - for a listener that has nothing to post first.
 *  Never throws. */
export async function openTeamsChatPane(page: ChatPage | Page, options: TeamsChatSendOptions = {}): Promise<TeamsChatOpenResult> {
  try {
    const opened = await openPane(page as ChatPage, options);
    return paneFailed(opened) ? failure(opened) : { ok: true };
  } catch (e: any) {
    return { ok: false, reason: "error", detail: String(e?.message || e).slice(0, 200) };
  }
}

export async function sendTeamsChatMessage(
  page: ChatPage | Page,
  text: string,
  options: TeamsChatSendOptions = {},
): Promise<TeamsChatSendResult> {
  const chatPage = page as ChatPage;
  const { renderTimeoutMs = 10000, pollMs = 250 } = options;
  const rendered = renderChatText(text);
  const lines = rendered.plain.split(/\r?\n/);
  const needle = lines.find((line) => line.trim())?.trim();
  if (!needle) return { ok: false, reason: "error", detail: "empty message" };

  let openedPane: ChatLocator | null = null;
  try {
    const opened = await openPane(chatPage, options);
    if (paneFailed(opened)) return failure(opened);
    openedPane = opened.openedPane;
    const typedAt = Date.now();

    await opened.input.locator.click();
    let format: "html" | "plain" = "plain";
    if (rendered.formatted) {
      await chatPage.evaluate(pasteChatHtml, { html: rendered.html, plain: rendered.plain });
      const taken = await waitFor(
        () => chatPage.evaluate(composeHasText, { selectors: teamsChatInputSelectors }),
        1500,
        pollMs,
        chatPage,
      );
      if (taken) format = "html";
    }
    if (format === "plain") {
      // One line at a time: Enter sends in Teams, Shift+Enter is the line break.
      for (const [index, line] of lines.entries()) {
        if (line) await chatPage.keyboard.insertText(line);
        if (index < lines.length - 1) await chatPage.keyboard.press("Shift+Enter");
      }
    }
    await chatPage.keyboard.press("Enter");

    // Enter has been seen to leave a pasted message in the box (a help reply, live 2026-10-23);
    // the pane's Send button sends whatever the box holds.
    let resent = false;
    const boxHasText = () => chatPage.evaluate(composeHasText, { selectors: teamsChatInputSelectors });
    const cleared = await waitFor(async () => !(await boxHasText()), 1500, pollMs, chatPage);
    if (!cleared) {
      const send = await firstVisible(chatPage, teamsChatSendButtonSelectors);
      if (send) {
        await send.locator.click();
        resent = true;
      }
    }

    const delivered = await waitFor(
      () => chatPage.evaluate(chatMessageRendered, { needle, selectors: teamsChatMessageSelectors }),
      renderTimeoutMs,
      pollMs,
      chatPage,
    );
    if (!delivered) {
      const detail = (await boxHasText()) ? "text left in the compose box" : "the box emptied but the message never appeared";
      return { ok: false, reason: "not_rendered", detail };
    }
    return { ok: true, format, ...(resent ? { resent: true } : {}), timings: { button_ms: opened.button_ms, input_ms: opened.input_ms, delivery_ms: Date.now() - typedAt } };
  } catch (e: any) {
    return { ok: false, reason: "error", detail: String(e?.message || e).slice(0, 200) };
  } finally {
    if (openedPane && !options.keepOpen) await openedPane.click().catch(() => { /* best-effort: the post already counted */ });
  }
}
