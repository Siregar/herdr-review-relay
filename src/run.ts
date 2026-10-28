import { loadConfig, type Config } from './config.ts';
import { buildHandoff, fill, type Review } from './handoff.ts';
import {
  bestEffortNotify,
  cwdOf,
  getAgent,
  integrationStatus,
  listPanes,
  prompt,
  promptAndWait,
} from './herdr.ts';
import { findPullRequest, type PullRequest } from './pr.ts';
import { readLastReply, readTurnState } from './replies.ts';
import { AGENT_NAMES, RelayError, resolveRoles, type Role } from './roles.ts';
import { acquireLock, archive, loadReviews, needsClear, saveReviews, type ReviewRecord } from './state.ts';
import { waitUntilReady, type WaitOptions } from './wait.ts';

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const tryNotify = bestEffortNotify(log);

/** How long to wait for an agent, and what its notifications are tagged with. */
type WaitLimits = Omit<WaitOptions, 'title'>;

/** Fails before anything is sent when herdr cannot tell us an agent's session. */
async function checkIntegrations(roles: Role[]): Promise<void> {
  const statuses = await integrationStatus();
  for (const kind of new Set(roles.map((role) => role.kind))) {
    if (!statuses[kind] || statuses[kind].startsWith('not installed')) {
      throw new RelayError(`herdr's ${AGENT_NAMES[kind]} integration is not installed: herdr integration install ${kind}`);
    }
  }
}

/** Sends the text and waits until the agent has finished; see `waitUntilReady`. */
async function promptUntilReady(role: Role, text: string, limits: WaitLimits): Promise<void> {
  const id = role.pane.pane_id;
  await waitUntilReady(
    {
      send: (timeoutMs) => promptAndWait(id, text, timeoutMs),
      status: async () => (await getAgent(id)).agent_status ?? 'unknown',
      turn: async (since) => {
        const sessionId = (await getAgent(id)).agent_session?.value;
        return sessionId ? readTurnState(role.kind, sessionId, since) : null;
      },
      now: Date.now,
      sleep,
      notify: tryNotify,
      log,
    },
    { title: role.title, ...limits },
  );
}

/** /clear, then wait until a Claude Code pane reports its new session so the review lands in it. */
async function clearContext(role: Role): Promise<void> {
  const before = role.pane.agent_session?.value;
  await prompt(role.pane.pane_id, '/clear');
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500);
    if (role.kind === 'opencode') continue; // OpenCode opens its new session with the next prompt.
    if ((await getAgent(role.pane.pane_id)).agent_session?.value !== before) return;
  }
  if (role.kind === 'claude') throw new RelayError(`${role.title} did not start a new session after /clear`);
}

async function review(
  role: Role,
  pr: PullRequest,
  config: Config,
  previous: ReviewRecord | undefined,
  limits: WaitLimits,
): Promise<{ review: Review; record: ReviewRecord }> {
  if (needsClear(previous, role.pane.agent_session?.value)) {
    log(`${role.title}: /clear, it already reviewed in this session`);
    await clearContext(role);
  }
  const reviewPrompt = fill(config.reviewPrompt[role.kind], { pr: pr.number });
  const sentAt = Date.now();
  log(`${role.title}: ${reviewPrompt}`);
  await promptUntilReady(role, reviewPrompt, limits);

  const sessionId = (await getAgent(role.pane.pane_id)).agent_session?.value;
  if (!sessionId) throw new RelayError(`${role.title}: herdr reports no session for this ${AGENT_NAMES[role.kind]} pane`);
  const text = await readLastReply(role.kind, sessionId, cwdOf(role.pane), sentAt);
  if (!text) {
    throw new RelayError(`${role.title} finished without a reply to the review prompt; its pane shows why (a failed model call, a usage limit)`);
  }

  log(`${role.title}: reply has ${text.length} characters`);
  return {
    review: { title: role.title, agent: AGENT_NAMES[role.kind], text },
    record: { sessionId, pr: pr.number, at: new Date().toISOString() },
  };
}

/**
 * One review round: the QA panes review Engineering's PR, and their reviews go to Engineering in one
 * prompt, followed by `followUp`. With `dryRun`, prints the roles, PR and prompts and sends nothing.
 */
export async function run(invokingPaneId: string, dryRun: boolean): Promise<void> {
  const config = await loadConfig();
  const roles = resolveRoles(await listPanes(), invokingPaneId, {
    engineering: config.engineeringLabel,
    qaPattern: config.qaLabelPattern,
  });
  const everyone = [roles.engineering, ...roles.qa];
  const pr = await findPullRequest(roles.engineering, cwdOf(roles.engineering.pane));
  const tag = `PR #${pr.number}`;
  const records = await loadReviews();

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          pr,
          engineering: { pane: roles.engineering.pane.pane_id, agent: roles.engineering.kind },
          qa: roles.qa.map((role) => ({
            title: role.title,
            pane: role.pane.pane_id,
            agent: role.kind,
            clearFirst: needsClear(records[role.pane.pane_id], role.pane.agent_session?.value),
            prompt: fill(config.reviewPrompt[role.kind], { pr: pr.number }),
          })),
          followUp: config.followUp,
        },
        null,
        2,
      ),
    );
    return;
  }

  await checkIntegrations(everyone);
  for (const role of everyone) {
    if (role.pane.agent_status !== 'idle' && role.pane.agent_status !== 'done') {
      throw new RelayError(`${role.title} is ${role.pane.agent_status}; start the relay once it is idle`);
    }
  }

  const release = await acquireLock(roles.engineering.pane.tab_id);
  try {
    await tryNotify(`${tag}: review started`, roles.qa.map((role) => role.title).join(', '));
    const limits = (timeoutMinutes: number): WaitLimits => ({ tag, timeoutMinutes, backgroundGraceMinutes: config.backgroundGraceMinutes });
    const outcomes = await Promise.all(
      roles.qa.map((role) =>
        review(role, pr, config, records[role.pane.pane_id], limits(config.reviewTimeoutMinutes)).then(
          (done) => ({ role, ...done }),
          (error: Error) => ({ role, error }),
        ),
      ),
    );
    const done = outcomes.filter((outcome) => 'review' in outcome);
    const failures = outcomes.flatMap((outcome) => ('error' in outcome ? [`${outcome.role.title}: ${outcome.error.message}`] : []));
    await saveReviews(Object.fromEntries(done.map(({ role, record }) => [role.pane.pane_id, record])));

    const reviews = done.map((outcome) => outcome.review);
    const handoff = buildHandoff(fill(config.handoffIntro, { count: reviews.length, pr: pr.number }), reviews);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archived = await archive(`${stamp}-pr${pr.number}.md`, handoff);
    log(`handoff archived at ${archived}`);
    if (failures.length > 0) {
      throw new RelayError(`${failures.join('; ')}. Nothing was sent to Engineering; the other reviews are in ${archived}`);
    }

    const engineeringLimits = limits(config.engineeringTimeoutMinutes);
    log(`${roles.engineering.title}: handoff, ${handoff.length} characters`);
    await promptUntilReady(roles.engineering, handoff, engineeringLimits);
    if (config.followUp) {
      log(`${roles.engineering.title}: ${config.followUp}`);
      await promptUntilReady(roles.engineering, fill(config.followUp, { pr: pr.number }), engineeringLimits);
    }
    await tryNotify(`${tag} is ready for you`, 'QA feedback is worked in and the follow-up has finished.', 'done');
    log('done');
  } finally {
    await release();
  }
}
