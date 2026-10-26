import { Page } from "playwright";
import { log } from "../_host";
import { teamsRemovalIndicators, teamsRemovedByParticipantIndicators } from "./selectors";

/** How the bot's stay ended: a participant removed it, or the call went away under it (meeting
 *  ended, connection lost). Only the first is an objection to the recording. */
export type TeamsRemovalKind = "removed_by_participant" | "ended";

/** Which ending is on screen, or null while the bot is still in the call. */
export async function classifyTeamsRemoval(page: Page): Promise<TeamsRemovalKind | null> {
  const anyVisible = async (selectors: string[]): Promise<boolean> => {
    for (const selector of selectors) {
      try {
        if (await page.locator(selector).first().isVisible()) return true;
      } catch {
        continue;
      }
    }
    return false;
  };
  if (await anyVisible(teamsRemovedByParticipantIndicators)) return "removed_by_participant";
  if (await anyVisible(teamsRemovalIndicators)) return "ended";
  return null;
}

// Function to check if bot has been removed from the meeting
export async function checkForTeamsRemoval(page: Page): Promise<boolean> {
  try {
    // Check for removal indicators
    for (const selector of teamsRemovalIndicators) {
      try {
        const element = await page.locator(selector).first();
        if (await element.isVisible()) {
          log(`🚨 Teams removal detected: Found removal indicator "${selector}"`);
          return true;
        }
      } catch (e) {
        // Continue checking other selectors
        continue;
      }
    }
    return false;
  } catch (error: any) {
    log(`Error checking for Teams removal: ${error.message}`);
    return false;
  }
}

// Start periodic removal monitoring from Node.js side
export function startTeamsRemovalMonitor(page: Page, onRemoval?: (kind: TeamsRemovalKind) => void | Promise<void>): () => void {
  log("Starting periodic Teams removal monitoring...");
  let removalDetected = false;

  const removalCheckInterval = setInterval(async () => {
    try {
      const kind = await classifyTeamsRemoval(page);
      if (kind && !removalDetected) {
        removalDetected = true; // Prevent duplicate detection
        log(`Teams removal detected from Node.js side (${kind}). Initiating graceful shutdown...`);
        clearInterval(removalCheckInterval);

        try {
          // Attempt to click Rejoin/Dismiss to close the modal gracefully
          await page.evaluate(() => {
            const clickIfVisible = (el: HTMLElement | null) => {
              if (!el) return;
              const rect = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              if (rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
                el.click();
              }
            };
            const btns = Array.from(document.querySelectorAll('button')) as HTMLElement[];
            for (const b of btns) {
              const t = (b.textContent || b.innerText || '').trim().toLowerCase();
              const a = (b.getAttribute('aria-label') || '').toLowerCase();
              if (t === 'dismiss' || a.includes('dismiss')) { clickIfVisible(b); break; }
            }
          });
        } catch {}

        // Signal removal to caller
        try { await onRemoval?.(kind); } catch {}
      }
    } catch (error: any) {
      log(`Error during removal check: ${error.message}`);
    }
  }, 1500);

  // Return cleanup function
  return () => {
    clearInterval(removalCheckInterval);
  };
}
