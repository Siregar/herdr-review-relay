import { loadConfig, type Config } from './config.ts';
import { buildHandoff, fill, type Review } from './handoff.ts';
import { cwdOf, getAgent, HerdrError, integrationStatus, listPanes, prompt, promptAndWait } from './herdr.ts';
import { findPullRequest, type PullRequest } from './pr.ts';
import { readLastReply, readTurnState } from './replies.ts';
import { AGENT_NAMES, Failure, integrationMissing, RelayError, resolveRoles, type Role, type Roles } from './roles.ts';
import { acquireLock, archive, loadReviews, needsClear, saveReviews, type ReviewRecord, type ReviewRecords } from './state.ts';
import { herdrTellDeps, inform, isCrash, messageOf, tell, type Message } from './tell.ts';
import { waitUntilReady, type WaitOptions } from './wait.ts';

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// What does not reach the user ends on stderr, which lands in the plugin log with the run log.
const tellDeps = herdrTellDeps((line) => console.error(`${new Date().toISOString()} ${line}`));

/** How long to wait for an agent, and what its notifications are tagged with. */
type WaitLimits = Omit<WaitOptions, 'title'>;

/** Fails before anything is sent when herdr cannot tell us an agent's session. */
async function checkIntegrations(roles: Role[]): Promise<void> {
  const statuses = await integrationStatus();
  for (const kind of new Set(roles.map((role) => role.kind))) {
    if (!statuses[kind] || statuses[kind].startsWith('not installed')) {
      throw integrationMissing(kind);
    }
  }
}

/** Refuses a pane that is not idle: the relay would type into the middle of its turn. */
function checkIdle(role: Role): void {
  const status = role.pane.agent_status;
  if (status === 'idle' || status === 'done') return;
  if (status === 'blocked') {
    throw new RelayError(`${role.title} is waiting for you`, 'Answer its question or approval, then run the review relay again.');
  }
  const title = status === 'working' ? `${role.title} is still working` : `herdr cannot tell whether ${role.title} is idle`;
  throw new RelayError(title, 'Run the review relay again once it is idle.', `Pane ${role.pane.pane_id} is ${status ?? 'unknown'}.`);
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
      needsYou: async (message) => {
        await tell(tellDeps, 'needsYou', message);
      },
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
  if (role.kind === 'claude') throw new RelayError(`${role.title} did not start a new session after /clear`, 'Check its pane.');
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
  if (!sessionId) {
    throw new RelayError(`herdr lost ${role.title}'s session`, 'Check its pane.', `Pane ${role.pane.pane_id} reports no session.`);
  }
  const text = await readLastReply(role.kind, sessionId, cwdOf(role.pane), sentAt);
  if (!text) {
    throw new RelayError(
      `${role.title} ended without a review`,
      'Check its pane.',
      'Its pane shows why: a failed model call, a usage limit.',
    );
  }

  log(`${role.title}: reply has ${text.length} characters`);
  return {
    review: { title: role.title, agent: AGENT_NAMES[role.kind], text },
    record: { sessionId, pr: pr.number, at: new Date().toISOString() },
  };
}

/** What stopped a role. A herdr error names the role, so the title says who stopped. */
function stopMessage(role: Role, error: unknown): Message {
  const message = messageOf(error);
  return error instanceof HerdrError ? { ...message, title: `${role.title}: ${error.message}` } : message;
}

const detailsOf = (messages: Message[]): string =>
  messages.map((message) => [message.title, message.details].filter(Boolean).join(': ')).join('\n');

/** "QA #1 reviews again", "both QA panes review again", "every QA pane reviews again". */
function reviewsAgain(qa: Role[]): string {
  if (qa.length === 1) return `${qa[0].title} reviews again`;
  return qa.length === 2 ? 'both QA panes review again' : 'every QA pane reviews again';
}

/** The names, as "QA #1", "QA #1 and QA #2", "QA #1, QA #2 and QA #3". */
const names = (roles: Role[]): string =>
  roles.length === 1 ? roles[0].title : `${roles.slice(0, -1).map((role) => role.title).join(', ')} and ${roles.at(-1)!.title}`;

/**
 * One review round: the QA panes review Engineering's PR, and their reviews go to Engineering in one
 * prompt, followed by `followUp`. With `dryRun`, prints the roles, PR and prompts and sends nothing.
 * Everything it throws before "review started" is a Refusal. After that it types into the panes right
 * away, so everything it throws is a `Failure`: the user has been told the round started, and a
 * prompt herdr rejects may still have reached the pane.
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
  everyone.forEach(checkIdle);

  const release = await acquireLock(roles.engineering.pane.tab_id);
  try {
    // The first prompt follows "review started" at once, so whatever stops the round from here is a Failure.
    await inform(tellDeps, `${tag}: review started`, roles.qa.map((role) => role.title).join(', '), 'none');
    await reviewRound(roles, pr, config, records);
  } catch (error) {
    if (error instanceof Failure) throw error;
    const message = messageOf(error);
    throw new Failure(message.title, message.nextStep, message.details);
  } finally {
    await release();
  }
}

/** The part of `run` that types into panes: every QA reviews, then Engineering gets the Handoff and the Follow-up. */
async function reviewRound(roles: Roles, pr: PullRequest, config: Config, records: ReviewRecords): Promise<void> {
  const tag = `PR #${pr.number}`;
  const startOver = `Running the review relay again starts the round over: ${reviewsAgain(roles.qa)}.`;
  const limits = (timeoutMinutes: number): WaitLimits => ({ tag, timeoutMinutes, backgroundGraceMinutes: config.backgroundGraceMinutes });
  const outcomes = await Promise.all(
    roles.qa.map((role) =>
      review(role, pr, config, records[role.pane.pane_id], limits(config.reviewTimeoutMinutes)).then(
        (done) => ({ role, ...done }),
        (error: unknown) => ({ role, error, stop: stopMessage(role, error) }),
      ),
    ),
  );
  const done = outcomes.filter((outcome) => 'review' in outcome);
  const failed = outcomes.filter((outcome) => 'stop' in outcome);
  await saveReviews(Object.fromEntries(done.map(({ role, record }) => [role.pane.pane_id, record])));

  const reviews = done.map((outcome) => outcome.review);
  const handoff = buildHandoff(fill(config.handoffIntro, { count: reviews.length, pr: pr.number }), reviews);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = await archive(`${stamp}-pr${pr.number}.md`, handoff);
  log(`handoff archived at ${archived}`);
  const crash = failed.find((outcome) => isCrash(outcome.error));
  if (crash) throw crash.error; // run() reports it as a crash, with its stack.
  if (failed.length > 0) {
    const finishedQa = done.map((outcome) => outcome.role);
    const saved =
      finishedQa.length === 0
        ? 'No review is saved, and nothing went to Engineering.'
        : `${names(finishedQa)}'s ${finishedQa.length === 1 ? 'review is' : 'reviews are'} saved; nothing went to Engineering.`;
    throw new Failure(
      failed.length === 1 ? failed[0].stop.title : `${names(failed.map((outcome) => outcome.role))} did not finish their reviews`,
      `${saved} ${startOver}`,
      [detailsOf(failed.map((outcome) => outcome.stop)), ...(done.length > 0 ? [`The reviews that finished are in ${archived}`] : [])].join('\n'),
    );
  }

  const engineering = roles.engineering;
  const engineeringLimits = limits(config.engineeringTimeoutMinutes);
  /** Sends Engineering a prompt; when that stops, `title` and `nextStep` say what the user does about it. */
  const promptEngineering = async (text: string, title: (stop: string) => string, nextStep: string): Promise<void> => {
    try {
      await promptUntilReady(engineering, text, engineeringLimits);
    } catch (error) {
      if (isCrash(error)) throw error;
      const message = stopMessage(engineering, error);
      throw new Failure(title(message.title), nextStep, `${detailsOf([message])}\nThe Handoff is in ${archived}`);
    }
  };
  log(`${engineering.title}: handoff, ${handoff.length} characters`);
  await promptEngineering(handoff, (stop) => stop, `Check ${engineering.title}'s pane; the Handoff is saved in the run archive. ${startOver}`);
  if (config.followUp) {
    log(`${engineering.title}: ${config.followUp}`);
    await promptEngineering(
      fill(config.followUp, { pr: pr.number }),
      (stop) => `${engineering.title}'s follow-up stopped: ${stop}`,
      `${engineering.title} has worked in the QA feedback; check its pane before you run the review relay again.`,
    );
  }
  await inform(tellDeps, `${tag} is ready for you`, 'QA feedback is worked in and the follow-up has finished.', 'done');
  log('done');
}
