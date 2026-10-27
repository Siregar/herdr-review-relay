import { execFile } from 'node:child_process';
import { loadConfig, type Config } from './config.ts';
import { buildHandoff, fill, type Review } from './handoff.ts';
import {
  getAgent,
  HerdrError,
  integrationStatus,
  listPanes,
  notify,
  prompt,
  promptAndWait,
  waitFor,
  type AgentStatus,
  type Pane,
} from './herdr.ts';
import { findPullRequest, type PullRequest } from './pr.ts';
import { readLastReply } from './replies.ts';
import { AGENT_NAMES, RelayError, resolveRoles, type Role } from './roles.ts';
import { acquireLock, archive, loadReviews, needsClear, saveReviews, type ReviewRecords } from './state.ts';

const MINUTE = 60_000;

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cwdOf = (pane: Pane): string => pane.foreground_cwd ?? pane.cwd;

/** Fails before anything is sent when herdr cannot tell us an agent's session. */
async function checkIntegrations(roles: Role[]): Promise<void> {
  const statuses = await integrationStatus();
  for (const kind of new Set(roles.map((role) => role.kind))) {
    if (!statuses[kind] || statuses[kind].startsWith('not installed')) {
      throw new RelayError(`herdr's ${AGENT_NAMES[kind]} integration is not installed: herdr integration install ${kind}`);
    }
  }
}

function deadline(minutes: number): () => number {
  const end = Date.now() + minutes * MINUTE;
  return () => {
    const left = end - Date.now();
    if (left <= 0) throw new RelayError(`Timed out after ${minutes} minutes`);
    return left;
  };
}

/**
 * Sends the text and waits until the agent is ready for input again. While it waits at a question
 * or approval, the user gets a notification; the wait goes on once they have answered.
 */
async function promptUntilReady(role: Role, text: string, remaining: () => number, tag: string): Promise<void> {
  const id = role.pane.pane_id;
  let status: AgentStatus = await promptAndWait(id, text, remaining());
  while (status === 'blocked') {
    log(`${role.title} is blocked`);
    await notify(`${tag}: ${role.title} needs you`, 'It is waiting at a question or an approval.', 'request');
    await waitFor(id, ['working', 'idle', 'done'], remaining());
    status = await waitFor(id, ['idle', 'done', 'blocked'], remaining());
  }
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
  records: ReviewRecords,
  tag: string,
): Promise<Review> {
  if (needsClear(records[role.pane.pane_id], role.pane.agent_session?.value)) {
    log(`${role.title}: /clear, it already reviewed in this session`);
    await clearContext(role);
  }
  const reviewPrompt = fill(config.reviewPrompt[role.kind], { pr: pr.number });
  const sentAt = Date.now();
  log(`${role.title}: ${reviewPrompt}`);
  await promptUntilReady(role, reviewPrompt, deadline(config.reviewTimeoutMinutes), tag);

  const sessionId = (await getAgent(role.pane.pane_id)).agent_session?.value;
  if (!sessionId) throw new RelayError(`${role.title}: herdr reports no session for this ${AGENT_NAMES[role.kind]} pane`);
  const text = await readLastReply(role.kind, sessionId, cwdOf(role.pane), sentAt);
  if (!text) {
    throw new RelayError(`${role.title} finished without a reply to the review prompt; its pane shows why (a failed model call, a usage limit)`);
  }

  records[role.pane.pane_id] = { sessionId, pr: pr.number, at: new Date().toISOString() };
  log(`${role.title}: reply has ${text.length} characters`);
  return { title: role.title, agent: AGENT_NAMES[role.kind], text };
}

async function run(invokingPaneId: string, dryRun: boolean): Promise<void> {
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
    await notify(`${tag}: review started`, roles.qa.map((role) => role.title).join(', '));
    const results = await Promise.allSettled(roles.qa.map((role) => review(role, pr, config, records, tag)));
    await saveReviews(records);

    const reviews = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected' ? [`${roles.qa[index].title}: ${(result.reason as Error).message}`] : [],
    );
    const handoff = buildHandoff(fill(config.handoffIntro, { count: reviews.length, pr: pr.number }), reviews);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archived = await archive(`${stamp}-pr${pr.number}.md`, handoff);
    log(`handoff archived at ${archived}`);
    if (failures.length > 0) {
      throw new RelayError(`${failures.join('; ')}. Nothing was sent to Engineering; the other reviews are in ${archived}`);
    }

    log(`${roles.engineering.title}: handoff, ${handoff.length} characters`);
    await promptUntilReady(roles.engineering, handoff, deadline(config.engineeringTimeoutMinutes), tag);
    if (config.followUp) {
      log(`${roles.engineering.title}: ${config.followUp}`);
      await promptUntilReady(roles.engineering, fill(config.followUp, { pr: pr.number }), deadline(config.engineeringTimeoutMinutes), tag);
    }
    await notify(`${tag} is ready for you`, 'QA feedback is worked in and the follow-up has finished.', 'done');
    log('done');
  } finally {
    await release();
  }
}

async function copyToClipboard(text: string): Promise<void> {
  const candidates: [string, string[]][] =
    process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
  for (const [command, args] of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile(command, args, (error) => (error ? reject(error) : resolve()));
        child.stdin?.end(text);
      });
      return;
    } catch (_error) {
      // Try the next clipboard tool.
    }
  }
  throw new RelayError('No clipboard tool found (pbcopy, wl-copy or xclip)');
}

async function copy(paneId: string, toStdout: boolean): Promise<void> {
  const agent = await getAgent(paneId);
  if (agent.agent !== 'claude' && agent.agent !== 'opencode') {
    throw new RelayError('The focused pane runs no Claude Code or OpenCode agent');
  }
  const sessionId = agent.agent_session?.value;
  if (!sessionId) throw new RelayError(`herdr reports no session for this pane: herdr integration install ${agent.agent}`);
  const text = await readLastReply(agent.agent, sessionId, cwdOf(agent), 0);
  if (!text) throw new RelayError('This agent has no reply yet');
  if (toStdout) {
    console.log(text);
    return;
  }
  await copyToClipboard(text);
  await notify('Copied the last reply', `${text.length} characters`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const paneId = option(args, '--pane') ?? process.env.HERDR_PANE_ID;
  // Terminal runs report to the terminal; only keybinding runs need a herdr notification.
  const fromTerminal = args.includes('--dry-run') || args.includes('--stdout');
  try {
    if (!paneId) throw new RelayError('No pane: run this from a herdr keybinding, or pass --pane <id>');
    if (command === 'run') await run(paneId, args.includes('--dry-run'));
    else if (command === 'copy') await copy(paneId, args.includes('--stdout'));
    else throw new RelayError(`Unknown command "${command ?? ''}": use run or copy`);
  } catch (error) {
    const message = error instanceof RelayError || error instanceof HerdrError ? error.message : String(error);
    console.error(message);
    if (!fromTerminal) await notify('Review relay failed', message, 'request').catch(() => undefined);
    process.exitCode = 1;
  }
}

await main();
