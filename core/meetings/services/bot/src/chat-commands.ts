/**
 * The bot's chat commands: anyone in the meeting can write `attend help`, `attend leave` or
 * `attend discard` in the meeting chat (any case, colon optional).
 *
 *   help     the help text (legal basics, what the commands do); at most once per 30 s
 *   leave    reply, then leave - what was recorded so far is processed as usual
 *   discard  reply, then leave and discard everything recorded (the orchestrator's discard path)
 *
 * The texts are a deployment setting (BOT_CHAT_HELP / BOT_CHAT_LEAVE_ACK / BOT_CHAT_DISCARD_ACK);
 * an empty help text turns the commands off. Pure: the chat it reads and writes are injected, so
 * the whole grammar and every rule is unit-tested offline. Nothing anyone writes is logged - the
 * events carry the command name only.
 */
import { botEvent } from './telemetry.js';
import type { NoticeSendResult } from './join-notice.js';

export type ChatCommand = 'help' | 'leave' | 'discard';

export interface ChatCommandTexts {
  help: string;
  leaveAck: string;
  discardAck: string;
}

export interface ChatMessage {
  sender: string;
  text: string;
}

export interface ChatCommands {
  handle(message: ChatMessage): Promise<void>;
}

export interface ChatCommandsOptions {
  texts: ChatCommandTexts;
  /** The bot's display name. Teams may append "(Unverified)" or "(Guest)", so it is a prefix. */
  botName: string;
  send: (text: string) => Promise<NoticeSendResult>;
  onLeave: () => void;
  onDiscard: () => void;
  meetingId?: string | number;
  emit?: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  helpIntervalMs?: number;
  /** A reply that does not land within this is given up on, so a slow chat never stalls a leave. */
  replyTimeoutMs?: number;
}

const COMMAND = /^attend\s*:?\s*(help|leave|discard)\s*[.!]?$/;

export function parseChatCommand(text: string): ChatCommand | null {
  const match = COMMAND.exec(text.replace(/\s+/g, ' ').trim().toLowerCase());
  return match ? (match[1] as ChatCommand) : null;
}

export function resolveChatCommandTexts(env: NodeJS.ProcessEnv): ChatCommandTexts {
  return {
    help: (env.BOT_CHAT_HELP ?? '').trim(),
    leaveAck: (env.BOT_CHAT_LEAVE_ACK ?? '').trim(),
    discardAck: (env.BOT_CHAT_DISCARD_ACK ?? '').trim(),
  };
}

/** One writer for one chat: each post waits for the one before it, and a failed post never jams
 *  the ones behind it. The join notice and the command replies share it. */
export function serializeSends<R>(send: (text: string) => Promise<R>): (text: string) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (text) => {
    const next = tail.then(() => send(text));
    tail = next.catch(() => undefined);
    return next;
  };
}

/** The commands, or undefined when the help text is empty (commands off). */
export function createChatCommands(opts: ChatCommandsOptions): ChatCommands | undefined {
  const { texts, send, onLeave, onDiscard, meetingId, emit = botEvent, now = Date.now } = opts;
  const { helpIntervalMs = 30_000, replyTimeoutMs = 15_000 } = opts;
  if (!texts.help) return undefined;
  const self = opts.botName.trim().toLowerCase();
  let lastHelpAt: number | null = null;
  let ended = false;

  const reply = async (command: ChatCommand, text: string): Promise<void> => {
    if (!text) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<NoticeSendResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), replyTimeoutMs);
    });
    let result: NoticeSendResult;
    try {
      result = await Promise.race([send(text), timedOut]);
    } catch (e) {
      result = { ok: false, reason: 'error', detail: String((e as Error)?.message ?? e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
    if (!result.ok) emit('chat_reply_failed', { meeting_id: meetingId, command, reason: result.reason });
  };

  return {
    async handle({ sender, text }) {
      if (ended || (self && sender.trim().toLowerCase().startsWith(self))) return;
      const command = parseChatCommand(text);
      if (!command) return;

      if (command === 'help') {
        const at = now();
        const limited = lastHelpAt !== null && at - lastHelpAt < helpIntervalMs;
        emit('chat_command', { meeting_id: meetingId, command, ...(limited ? { rate_limited: true } : {}) });
        if (limited) return;
        lastHelpAt = at;
        await reply(command, texts.help);
        return;
      }

      // Leave and discard end the bot's stay: one of them wins, and nothing after it is obeyed.
      ended = true;
      emit('chat_command', { meeting_id: meetingId, command });
      await reply(command, command === 'leave' ? texts.leaveAck : texts.discardAck);
      if (command === 'leave') onLeave();
      else onDiscard();
    },
  };
}
