import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

// The relay as herdr starts it, against a fake herdr: a tab with one pane and no QA panes, so `run`
// refuses. FAKE_POPUP=refuse makes herdr refuse the popup, FAKE_PANE_LIST=broken makes `pane list`
// answer without panes, FAKE_AGENT=none puts no agent in the pane, and FAKE_HIDDEN=<reason> makes
// herdr answer notifications with shown: false and that reason.
const execFileAsync = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'review-relay-main-'));
const calls = join(dir, 'herdr-calls.jsonl');
await writeFile(
  join(dir, 'herdr'),
  `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const pane = { pane_id: 'p1', tab_id: 't1', label: null, agent: process.env.FAKE_AGENT === 'none' ? null : 'claude', agent_status: 'idle', cwd: '/' };
const reply = (result) => console.log(JSON.stringify({ result }));
const [group, action] = args;
if (group === 'pane' && action === 'list') reply(process.env.FAKE_PANE_LIST === 'broken' ? {} : { panes: [pane] });
else if (group === 'agent' && action === 'get') reply({ agent: pane });
else if (group === 'notification') reply({ type: 'notification_show', shown: !process.env.FAKE_HIDDEN, reason: process.env.FAKE_HIDDEN ?? 'shown' });
else if (group === 'plugin' && process.env.FAKE_POPUP === 'refuse') {
  console.log(JSON.stringify({ error: { code: 'ui_busy', message: 'a herdr modal is open' } }));
  process.exit(1);
} else if (group === 'plugin') reply({});
else {
  console.log(JSON.stringify({ error: { code: 'unknown', message: 'fake herdr cannot ' + args.join(' ') } }));
  process.exit(1);
}
`,
);
await chmod(join(dir, 'herdr'), 0o755);

interface Started {
  code: number;
  stderr: string;
  calls: string[][];
}

/** Starts `node src/relay.ts <args>` the way a keybinding does, from pane p1. */
async function relay(args: string[], env: Record<string, string> = {}): Promise<Started> {
  await rm(calls, { force: true });
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HERDR_BIN_PATH: join(dir, 'herdr'),
    HERDR_PANE_ID: 'p1',
    HERDR_PLUGIN_ID: 'review-relay',
    HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
    ...env,
  };
  delete childEnv.HERDR_PLUGIN_CONFIG_DIR;
  const outcome = await execFileAsync('node', ['src/relay.ts', ...args], { env: childEnv }).then(
    ({ stderr }) => ({ code: 0, stderr }),
    (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
  );
  const text = await readFile(calls, 'utf8').catch(() => '');
  return { ...outcome, calls: text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) };
}

const popups = (started: Started) => started.calls.filter(([group, action]) => group === 'plugin' && action === 'pane');
const notifications = (started: Started) => started.calls.filter(([group]) => group === 'notification');

/** The message the popup was opened with. */
function popupMessage(call: string[]): { title: string; nextStep: string } {
  const env = call[call.indexOf('--env') + 1];
  return JSON.parse(env.slice(env.indexOf('=') + 1));
}

test('relay: a Refusal from a keybinding opens the popup with the message, and sends no notification', async () => {
  const started = await relay(['run']);
  assert.equal(started.code, 1);
  const [popup, ...more] = popups(started);
  assert.deepEqual(more, []);
  assert.deepEqual(popup.slice(0, 7), ['plugin', 'pane', 'open', '--plugin', 'review-relay', '--entrypoint', 'message']);
  assert.equal(popupMessage(popup).title, 'No QA panes in this tab');
  assert.deepEqual(notifications(started), []);
  assert.match(started.stderr, /No QA panes in this tab/, 'the plugin log has it too');
});

test('relay: a Refusal falls back to a notification when herdr refuses the popup', async () => {
  const started = await relay(['run'], { FAKE_POPUP: 'refuse' });
  assert.equal(started.code, 1);
  const [notification] = notifications(started);
  assert.equal(notification[2], 'No QA panes in this tab');
  assert.equal(notification[4], 'Label each QA pane "QA #1", "QA #2", … (right-click > Rename).');
  assert.match(started.stderr, /ui_busy|a herdr modal is open/);
});

test('relay: a terminal run (--dry-run, --stdout) reports to the terminal only', async () => {
  for (const args of [['run', '--dry-run'], ['copy', '--stdout']]) {
    const started = await relay(args, { FAKE_AGENT: 'none' });
    assert.equal(started.code, 1);
    assert.deepEqual(popups(started), [], `${args.join(' ')} opens no popup`);
    assert.deepEqual(notifications(started), [], `${args.join(' ')} sends no notification`);
    assert.match(started.stderr, /runs no agent|No QA panes/);
  }
});

test('relay: a copy Refusal opens the popup too', async () => {
  const started = await relay(['copy'], { FAKE_AGENT: 'none' });
  const [popup] = popups(started);
  assert.deepEqual(popupMessage(popup), { title: 'This pane runs no agent', nextStep: 'Focus a Claude Code or OpenCode pane.' });
});

test('relay: an unexpected exception before anything is typed says it crashed, through the Refusal channel', async () => {
  const started = await relay(['run'], { FAKE_PANE_LIST: 'broken' });
  assert.equal(started.code, 1);
  const [popup] = popups(started);
  assert.equal(popupMessage(popup).title, 'Review relay crashed');
  assert.match(started.stderr, /TypeError/, 'the stack trace is in the plugin log');
});

test('relay: a notification herdr answers with shown: false is not taken as delivered, and its reason is logged', async () => {
  const started = await relay(['run'], { FAKE_POPUP: 'refuse', FAKE_HIDDEN: 'no_foreground_client' });
  assert.equal(notifications(started).length, 1);
  assert.match(started.stderr, /not shown: no_foreground_client/);
});
