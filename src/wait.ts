import type { AgentStatus } from './herdr.ts';
import type { TurnState } from './replies.ts';
import { RelayError } from './roles.ts';

const MINUTE = 60_000;
const POLL_MS = 10_000;
/** How long an idle agent may show an open turn before the relay takes idle as final. */
const OPEN_TURN_GRACE_MS = 2 * MINUTE;

/** Everything the wait needs from herdr, the agent's records and the clock. */
export interface WaitDeps {
  /** Submits the prompt and waits up to `timeoutMs` for the turn it starts to settle. */
  send(timeoutMs: number): Promise<AgentStatus>;
  status(): Promise<AgentStatus>;
  /** The agent's turn since `since`; null for an agent that records no background work. */
  turn(since: number): Promise<TurnState | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  notify(title: string, body: string, sound: 'request'): Promise<void>;
  log(message: string): void;
}

export interface WaitOptions {
  title: string;
  /** Prefix of the notification title, such as `PR #230`. */
  tag: string;
  timeoutMinutes: number;
  /** How long background tasks may run on once nothing else is left; then they are abandoned. */
  backgroundGraceMinutes: number;
}

/**
 * Sends the prompt and waits until the agent has finished. Idle is not enough on its own: Claude Code
 * goes idle while a background task runs and wakes up when it reports, so its transcript must show
 * no pending background task and a closed turn too. A task that never reports (a dev server, a
 * stopped shell) is abandoned once it alone has held the wait for `backgroundGraceMinutes`.
 *
 * While the agent waits at a question or an approval, the user gets a notification, and the
 * deadline stands still until they have answered.
 */
export async function waitUntilReady(deps: WaitDeps, options: WaitOptions): Promise<void> {
  const { title, tag } = options;
  const sentAt = deps.now();
  let end = sentAt + options.timeoutMinutes * MINUTE;
  let status = await deps.send(end - sentAt);
  let blockedSince: number | null = null;
  let idleSince: number | null = null;
  let backgroundOnlySince: number | null = null;
  let waitingOn = '';
  for (;;) {
    const now = deps.now();
    if (status === 'blocked') {
      if (blockedSince === null) {
        blockedSince = now;
        deps.log(`${title} is blocked`);
        await deps.notify(`${tag}: ${title} needs you`, 'It is waiting at a question or an approval.', 'request').catch(
          (error: Error) => deps.log(`notification failed: ${error.message}`),
        );
      }
      idleSince = null;
      backgroundOnlySince = null;
    } else {
      if (blockedSince !== null) {
        end += now - blockedSince; // The user kept the agent waiting, not the agent the relay.
        blockedSince = null;
      }
      if (status === 'idle' || status === 'done') {
        idleSince ??= now;
        const turn = await deps.turn(sentAt);
        if (!turn) return;
        // A turn without an end marker would otherwise hold the relay until its deadline.
        const turnClosed = !turn.turnOpen || now - idleSince >= OPEN_TURN_GRACE_MS;
        const pending = turn.pendingBackground;
        if (turnClosed && pending.length === 0) return;
        if (turnClosed) {
          backgroundOnlySince ??= now;
          if (now - backgroundOnlySince >= options.backgroundGraceMinutes * MINUTE) {
            deps.log(
              `${title}: abandoned background task(s) ${pending.join(', ')} after ${options.backgroundGraceMinutes} minutes`,
            );
            return;
          }
        } else {
          backgroundOnlySince = null;
        }
        const busy = pending.length > 0 ? `${pending.length} background task(s) running` : 'an unfinished turn';
        if (busy !== waitingOn) deps.log(`${title} is idle with ${busy}; waiting`);
        waitingOn = busy;
      } else {
        idleSince = null;
        backgroundOnlySince = null;
      }
    }
    if (blockedSince === null && deps.now() >= end) throw new RelayError(`Timed out after ${options.timeoutMinutes} minutes`);
    await deps.sleep(POLL_MS);
    status = await deps.status();
  }
}
