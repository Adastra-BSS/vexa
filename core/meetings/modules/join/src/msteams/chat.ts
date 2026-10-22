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
import { teamsChatButtonSelectors, teamsChatInputSelectors, teamsChatMessageSelectors } from "./selectors";

export type TeamsChatFailure = "chat_disabled" | "input_not_found" | "not_rendered" | "error";

/** Where a successful post spent its time: waiting for a usable chat button (0 when the pane was
 *  already open), for the compose box, and from typing until the message showed in the list. */
export type TeamsChatTimings = {
  button_ms: number;
  input_ms: number;
  delivery_ms: number;
};

export type TeamsChatSendResult =
  | { ok: true; timings: TeamsChatTimings }
  | { ok: false; reason: TeamsChatFailure; detail?: string };

export interface TeamsChatSendOptions {
  /** How long to wait for a usable chat button. Right after admission Teams is still building
   *  the in-call toolbar: a single look 165 ms in found none on a live dev meeting. */
  buttonTimeoutMs?: number;
  /** How long to wait for the compose box after opening the pane. */
  inputTimeoutMs?: number;
  /** How long to wait for the sent message to appear in the message list. */
  renderTimeoutMs?: number;
  pollMs?: number;
}

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

export async function sendTeamsChatMessage(
  page: ChatPage | Page,
  text: string,
  options: TeamsChatSendOptions = {},
): Promise<TeamsChatSendResult> {
  const chatPage = page as ChatPage;
  const { buttonTimeoutMs = 20000, inputTimeoutMs = 5000, renderTimeoutMs = 10000, pollMs = 250 } = options;
  const lines = text.split(/\r?\n/);
  const needle = lines.find((line) => line.trim())?.trim();
  if (!needle) return { ok: false, reason: "error", detail: "empty message" };

  let openedPane: ChatLocator | null = null;
  let mark = Date.now();
  const lap = (): number => {
    const now = Date.now();
    const elapsed = now - mark;
    mark = now;
    return elapsed;
  };
  const timings: TeamsChatTimings = { button_ms: 0, input_ms: 0, delivery_ms: 0 };
  try {
    let input = await firstVisible(chatPage, teamsChatInputSelectors);
    if (!input) {
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
      timings.button_ms = lap();
      await button.locator.click();
      openedPane = button.locator;
      input = await waitFor(() => firstVisible(chatPage, teamsChatInputSelectors), inputTimeoutMs, pollMs, chatPage);
      if (!input) return { ok: false, reason: "input_not_found" };
      timings.input_ms = lap();
    }
    lap();

    // One line at a time: Enter sends in Teams, Shift+Enter is the line break.
    await input.locator.click();
    for (const [index, line] of lines.entries()) {
      if (line) await chatPage.keyboard.insertText(line);
      if (index < lines.length - 1) await chatPage.keyboard.press("Shift+Enter");
    }
    await chatPage.keyboard.press("Enter");

    const rendered = await waitFor(
      () => chatPage.evaluate(chatMessageRendered, { needle, selectors: teamsChatMessageSelectors }),
      renderTimeoutMs,
      pollMs,
      chatPage,
    );
    if (!rendered) return { ok: false, reason: "not_rendered" };
    timings.delivery_ms = lap();
    return { ok: true, timings };
  } catch (e: any) {
    return { ok: false, reason: "error", detail: String(e?.message || e).slice(0, 200) };
  } finally {
    if (openedPane) await openedPane.click().catch(() => { /* best-effort: the post already counted */ });
  }
}
