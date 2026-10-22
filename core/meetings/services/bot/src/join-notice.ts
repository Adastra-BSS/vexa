/**
 * The join notice: one message the bot posts into the meeting chat right after admission, telling
 * everyone the meeting is being recorded and how to object (Attend's legal notice). Its text is a
 * deployment setting, BOT_JOIN_NOTICE; empty turns it off.
 *
 * Posted once per bot run and never retried: the message stays in the chat history for people who
 * join later. Every outcome is one structured event (`bot.join_notice_posted` /
 * `bot.join_notice_failed` with a reason) so a notice that silently stopped appearing is visible
 * from outside. post() never rejects - a chat that cannot be posted to must never cost the
 * recording, so the bot stays and keeps recording either way.
 */
import { botEvent } from './telemetry.js';

export const JOIN_NOTICE_ENV = 'BOT_JOIN_NOTICE';

export type NoticeSendResult = { ok: true } | { ok: false; reason: string; detail?: string };

export interface JoinNotice {
  post(): Promise<void>;
}

export interface JoinNoticeOptions {
  text: string;
  send: (text: string) => Promise<NoticeSendResult>;
  /** Vexa's meeting id, carried on every event so a failure can be traced to its meeting. */
  meetingId?: string | number;
  emit?: (event: string, fields?: Record<string, unknown>) => void;
  /** Upper bound on one post; the page is shared with the live capture, so it must not hang. */
  timeoutMs?: number;
}

export function resolveJoinNotice(env: NodeJS.ProcessEnv): string {
  return (env[JOIN_NOTICE_ENV] ?? '').trim();
}

/** The notice, or undefined when there is nothing to post. */
export function createJoinNotice(opts: JoinNoticeOptions): JoinNotice | undefined {
  const { text, send, meetingId, emit = botEvent, timeoutMs = 30_000 } = opts;
  if (!text.trim()) return undefined;
  let started = false;

  return {
    async post() {
      if (started) return;
      started = true;
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<NoticeSendResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
      });
      let result: NoticeSendResult;
      try {
        result = await Promise.race([send(text), timedOut]);
      } catch (e) {
        result = { ok: false, reason: 'error', detail: String((e as Error)?.message ?? e).slice(0, 200) };
      } finally {
        clearTimeout(timer);
      }
      const base = { meeting_id: meetingId, duration_ms: Date.now() - startedAt };
      if (result.ok) emit('join_notice_posted', base);
      else emit('join_notice_failed', { ...base, reason: result.reason, ...(result.detail ? { detail: result.detail } : {}) });
    },
  };
}
