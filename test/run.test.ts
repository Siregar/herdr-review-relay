import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A whole review round against fake herdr and gh binaries, in a home and state directory of its own.
// The fake herdr plays both agents: a prompt writes the prompt, a reply and a turn end into the pane's
// transcript, and /clear starts a new session, the way Claude Code does. Every notification fails.
const dir = await mkdtemp(join(tmpdir(), 'review-relay-run-'));
const projects = join(dir, '.claude', 'projects', 'repo');
const calls = join(dir, 'herdr-calls.jsonl');
const sessions = join(dir, 'sessions.json'); // The session each pane is in now.
await mkdir(projects, { recursive: true });

const panes = [
  { pane_id: 'p_eng', tab_id: 't1', label: 'Engineering', agent: 'claude', agent_status: 'idle', cwd: dir },
  { pane_id: 'p_qa1', tab_id: 't1', label: 'QA #1', agent: 'claude', agent_status: 'idle', cwd: dir },
];

await writeFile(sessions, JSON.stringify({ p_eng: 's_eng', p_qa1: 's_qa1' }));
await writeFile(
  join(dir, 'herdr'),
  `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const sessions = JSON.parse(readFileSync(${JSON.stringify(sessions)}, 'utf8'));
const panes = ${JSON.stringify(panes)}.map((pane) => ({ ...pane, agent_session: { value: sessions[pane.pane_id] } }));
const reply = (result) => console.log(JSON.stringify({ result }));
const [group, action, target, text] = args;
const pane = panes.find((candidate) => candidate.pane_id === target);
if (group === 'integration') {
  console.log('claude: current (v10) (/home/fake/.claude/hooks/herdr-agent-state.sh)');
} else if (group === 'pane' && action === 'list') {
  reply({ panes });
} else if (group === 'agent' && action === 'get') {
  reply({ agent: pane });
} else if (group === 'agent' && action === 'prompt' && text === '/clear') {
  sessions[target] = sessions[target] + '+';
  writeFileSync(${JSON.stringify(sessions)}, JSON.stringify(sessions));
  reply({});
} else if (group === 'agent' && action === 'prompt') {
  const at = (offset) => new Date(Date.now() + offset).toISOString();
  const qa = pane.label.startsWith('QA');
  const answer = qa ? (process.env.FAKE_QA_SILENT ? null : '## Review\\nOne finding in src/a.ts:12.') : 'Worked in.';
  const rows = [
    { type: 'user', timestamp: at(0), message: { content: text } },
    ...(answer ? [{ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'text', text: answer }] } }] : []),
    { type: 'system', subtype: 'turn_duration', timestamp: at(2) },
  ];
  appendFileSync(join(${JSON.stringify(projects)}, pane.agent_session.value + '.jsonl'), rows.map((row) => JSON.stringify(row) + '\\n').join(''));
  const blocked = qa && process.env.FAKE_QA_BLOCKED;
  reply({ agent: { ...pane, agent_status: blocked ? 'blocked' : 'idle' } });
} else if (group === 'notification') {
  console.log(JSON.stringify({ error: { code: 'notification_failed', message: 'notifications are down' } }));
  process.exit(1);
} else {
  console.log(JSON.stringify({ error: { code: 'unknown', message: 'fake herdr cannot ' + args.join(' ') } }));
  process.exit(1);
}
`,
);
await writeFile(
  join(dir, 'gh'),
  `#!/bin/sh
echo '{"number":231,"url":"https://github.com/o/r/pull/231","state":"OPEN"}'
`,
);
await chmod(join(dir, 'herdr'), 0o755);
await chmod(join(dir, 'gh'), 0o755);

process.env.HERDR_BIN_PATH = join(dir, 'herdr');
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.HOME = dir;
process.env.CLAUDE_CONFIG_DIR = join(dir, '.claude');
process.env.HERDR_PLUGIN_STATE_DIR = join(dir, 'state');
delete process.env.HERDR_PLUGIN_CONFIG_DIR; // The defaults apply.
const { run } = await import('../src/run.ts');

// These rounds wait on the real clock: a regression in the wait fails them instead of stalling the suite.
const ROUND = { timeout: 60_000 };
const { DEFAULTS } = await import('../src/config.ts');

async function herdrCalls(): Promise<string[][]> {
  const text = await readFile(calls, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}
const promptsTo = (all: string[][], paneId: string) =>
  all.filter(([group, action, target]) => group === 'agent' && action === 'prompt' && target === paneId).map((call) => call[3]);

async function freshRound(): Promise<void> {
  await rm(calls, { force: true });
  delete process.env.FAKE_QA_SILENT;
  delete process.env.FAKE_QA_BLOCKED;
}

test('run: failing notifications, also while a QA agent is blocked, do not stop the round', ROUND, async () => {
  await freshRound();
  process.env.FAKE_QA_BLOCKED = '1';
  await run('p_eng', false);

  const all = await herdrCalls();
  const notifications = all.filter(([group]) => group === 'notification').map((call) => call[2]);
  assert.deepEqual(notifications, ['PR #231: review started', 'PR #231: QA #1 needs you', 'PR #231 is ready for you']);
  assert.equal(promptsTo(all, 'p_qa1').at(-1), '/mattpocock-skills:code-review 231');
  const [handoff, followUp] = promptsTo(all, 'p_eng');
  assert.match(handoff, /<review from="QA #1" agent="Claude Code">\n## Review\nOne finding in src\/a\.ts:12\.\n<\/review>/);
  assert.equal(followUp, DEFAULTS.followUp);
});

const currentSession = async (paneId: string): Promise<string> => JSON.parse(await readFile(sessions, 'utf8'))[paneId];
const recorded = async () => JSON.parse(await readFile(join(dir, 'state', 'reviews.json'), 'utf8'));

test('run: a QA pane is recorded with the session it reviewed in, so the next round starts it with /clear', ROUND, async () => {
  await freshRound();
  await run('p_eng', false);
  const reviewedIn = await currentSession('p_qa1');
  assert.deepEqual((await recorded()).p_qa1.sessionId, reviewedIn);
  assert.equal((await recorded()).p_eng, undefined, 'Engineering is not a reviewer');

  await freshRound();
  await run('p_eng', false);
  assert.deepEqual(promptsTo(await herdrCalls(), 'p_qa1'), ['/clear', '/mattpocock-skills:code-review 231']);
  assert.notEqual(await currentSession('p_qa1'), reviewedIn);
  assert.equal((await recorded()).p_qa1.sessionId, await currentSession('p_qa1'));
});

test('run: a QA agent without a reply sends nothing to Engineering, and the round is archived', ROUND, async () => {
  await freshRound();
  process.env.FAKE_QA_SILENT = '1';
  const archivedBefore = (await readdir(join(dir, 'state', 'runs'))).length;
  await assert.rejects(run('p_eng', false), /QA #1 finished without a reply.*Nothing was sent to Engineering/);
  assert.deepEqual(promptsTo(await herdrCalls(), 'p_eng'), []);
  assert.equal((await readdir(join(dir, 'state', 'runs'))).length, archivedBefore + 1);
});
