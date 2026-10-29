import type { AgentStatus } from './herdr.ts';
import type { TurnState } from './replies.ts';
import { RelayError } from './roles.ts';
import type { Message } from './tell.ts';

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
  /** Tells the user the agent waits for them. Best effort: a message that does not get through must not end the wait. */
  needsYou(message: Message): Promise<void>;
  log(message: string): void;
}

export interface WaitOptions {
  title: string;
  /** Prefix of the notification title, such as `PR #230`. */
  tag: string;
  timeoutMinutes: number;
  /** How long background shells may run on once nothing else is left; then they are abandoned. */
  backgroundGraceMinutes: number;
}

/**
 * Sends the prompt and waits until the agent has finished. Idle is not enough on its own: Claude Code
 * goes idle while a background task runs and wakes up when it reports, so its transcript must show
 * no pending background task and a closed turn too. A shell that never reports (a dev server, a
 * watch loop) is abandoned once shells alone have held the wait for `backgroundGraceMinutes`. A
 * sub-agent is waited for until the deadline: it always reports or is stopped, and abandoning it
 * would take its "I launched the reviewers" for the review.
 *
 * While the agent waits at a question or an approval, the user is told so, and the
 * deadline stands still until they have answered.
 */
export async function waitUntilReady(deps: WaitDeps, options: WaitOptions): Promise<void> {
  const { title, tag } = options;
  const sentAt = deps.now();
  let end = sentAt + options.timeoutMinutes * MINUTE;
  let status = await deps.send(end - sentAt);
  let blockedSince: number | null = null;
  let openSince: number | null = null;
  let shellsOnlySince: number | null = null;
  let waitingOn = '';
  for (;;) {
    const now = deps.now();
    if (status === 'blocked') {
      if (blockedSince === null) {
        blockedSince = now;
        deps.log(`${title} is blocked`);
        await deps.needsYou({
          title: `${tag}: ${title} needs you`,
          nextStep: 'Answer its question or approval in its pane; the review round goes on after that.',
        });
      }
      openSince = null;
      shellsOnlySince = null;
    } else {
      if (blockedSince !== null) {
        end += now - blockedSince; // The user kept the agent waiting, not the agent the relay.
        blockedSince = null;
      }
      if (status === 'idle' || status === 'done') {
        const turn = await deps.turn(sentAt);
        if (!turn) return;
        // A turn without an end marker would otherwise hold the relay until its deadline.
        openSince = turn.turnOpen ? (openSince ?? now) : null;
        const turnClosed = openSince === null || now - openSince >= OPEN_TURN_GRACE_MS;
        const pending = turn.pendingBackground;
        const agents = pending.filter((task) => task.kind === 'agent').length;
        if (turnClosed && pending.length === 0) return;
        if (turnClosed && agents === 0) {
          shellsOnlySince ??= now;
          if (now - shellsOnlySince >= options.backgroundGraceMinutes * MINUTE) {
            const ids = pending.map((task) => task.id).join(', ');
            deps.log(`${title}: abandoned background shell(s) ${ids} after ${options.backgroundGraceMinutes} minutes`);
            return;
          }
        } else {
          shellsOnlySince = null;
        }
        const busy =
          pending.length > 0
            ? `${agents} sub-agent(s) and ${pending.length - agents} background shell(s) running`
            : 'an unfinished turn';
        if (busy !== waitingOn) deps.log(`${title} is idle with ${busy}; waiting`);
        waitingOn = busy;
      } else {
        openSince = null;
        shellsOnlySince = null;
      }
    }
    if (blockedSince === null && deps.now() >= end) {
      throw new RelayError(`${title} timed out after ${options.timeoutMinutes} min`, 'Check its pane.');
    }
    await deps.sleep(POLL_MS);
    status = await deps.status();
  }
}
