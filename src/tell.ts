import { HerdrError, notify, openPane, type Notified, type Sound } from './herdr.ts';
import { RelayError } from './roles.ts';

/** What the user reads when the relay stops or needs them. */
export interface Message {
  /** Names the cause. */
  title: string;
  /** One sentence: what the user does next. */
  nextStep: string;
  /** Long paths, pane ids, raw gh output. Only the popup and the log show them. */
  details?: string;
}

/** A Refusal and a Failure, as `GLOSSARY.md` defines them, and an agent that waits for the user. */
export type Kind = 'refusal' | 'failure' | 'needsYou';

export type Channel = 'popup' | 'notification' | 'log';

export interface TellDeps {
  notify(title: string, body: string, sound: Sound): Promise<Notified>;
  /** Throws when herdr refuses the popup. */
  popup(message: Message): Promise<void>;
  /** stderr or the run log; both land in the plugin log. */
  log(line: string): void;
}

/** The variable the popup (`src/popup.ts`) reads its message from. */
export const POPUP_MESSAGE_ENV = 'REVIEW_RELAY_MESSAGE';

/** `TellDeps` that go through herdr. */
export function herdrTellDeps(log: (line: string) => void): TellDeps {
  return {
    notify,
    popup: (message) => openPane('message', { [POPUP_MESSAGE_ENV]: JSON.stringify(message) }),
    log,
  };
}

/**
 * Gets the message to the user. A Refusal comes while the user looks at herdr, so it opens the popup
 * first; a Failure and "needs you" come while they are likely away, so they start with a notification.
 * Each falls back to the other channel, and the log is the last link of both chains. See
 * `docs/adr/0001-refusals-as-popup.md`. Returns the channel that took the message.
 */
export async function tell(deps: TellDeps, kind: Kind, message: Message): Promise<Channel> {
  deps.log(`${kind}: ${messageText(message)}`);
  const attempts: Record<Exclude<Channel, 'log'>, () => Promise<boolean>> = {
    popup: () => deps.popup(message).then(() => true),
    notification: () => notified(deps, message.title, message.nextStep, 'request'),
  };
  const chain = kind === 'refusal' ? (['popup', 'notification'] as const) : (['notification', 'popup'] as const);
  for (const channel of chain) {
    try {
      if (await attempts[channel]()) return channel;
    } catch (error) {
      deps.log(`${channel} failed: ${(error as Error).message}`);
    }
  }
  return 'log';
}

/** Whether herdr showed the notification. One it did not show, or failed to send, is logged with why. */
async function notified(deps: TellDeps, title: string, body: string, sound: Sound): Promise<boolean> {
  try {
    const { shown, reason } = await deps.notify(title, body, sound);
    if (!shown) deps.log(`notification "${title}" not shown: ${reason}`);
    return shown;
  } catch (error) {
    deps.log(`notification "${title}" failed: ${(error as Error).message}`);
    return false;
  }
}

/**
 * "review started", "ready", "Copied": news that needs nothing from the user goes to a notification
 * only, never to the popup, which would take the keyboard. One that is not shown stays in the log.
 */
export async function inform(deps: TellDeps, title: string, body: string, sound: Sound): Promise<void> {
  await notified(deps, title, body, sound);
}

/** An error the relay cannot explain: neither a RelayError nor a HerdrError, so a bug. */
export const isCrash = (error: unknown): boolean => !(error instanceof RelayError || error instanceof HerdrError);

/** What to tell the user about an error. A crash says it is a bug, whenever it happens. */
export function messageOf(error: unknown): Message {
  if (error instanceof RelayError) {
    return { title: error.title, nextStep: error.nextStep, ...(error.details ? { details: error.details } : {}) };
  }
  if (error instanceof HerdrError) {
    return {
      title: `herdr: ${error.message}`,
      nextStep: 'Run the review relay again; if herdr refuses again, its plugin log has the details.',
      details: `herdr error code: ${error.code}`,
    };
  }
  return {
    title: 'Review relay crashed',
    nextStep: 'This is a bug. The stack trace is in `herdr plugin log list --plugin review-relay`.',
    details: error instanceof Error ? (error.stack ?? String(error)) : String(error),
  };
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Enter, Esc and Ctrl-C close the popup. An arrow key starts with Esc too; only Esc on its own closes. */
export function closesPopup(keys: string): boolean {
  return keys === '\x1b' || keys === '\x03' || keys.includes('\r') || keys.includes('\n');
}

/** What the popup prints: the cause as heading, the next step, then the details under their own heading. */
export function renderPopup(message: Message): string {
  const details = message.details ? [`${BOLD}Details${RESET}`, message.details, ''] : [];
  return [`${BOLD}${message.title}${RESET}`, '', message.nextStep, '', ...details, `${DIM}Enter or Esc to close${RESET}`, ''].join('\n');
}

/** The message as plain text, for the log and the terminal. */
export function messageText(message: Message): string {
  return [message.title, message.nextStep, ...(message.details ? ['', 'Details:', message.details] : [])].join('\n');
}
