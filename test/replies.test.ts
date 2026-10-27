import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claudeAssistantText,
  claudeTurnState,
  lastClaudeReply,
  lastOpenCodeReply,
  openCodeAssistantText,
} from '../src/replies.ts';

const SENT = Date.parse('2026-10-27T10:00:00.000Z');
const at = (seconds: number) => new Date(SENT + seconds * 1000).toISOString();

const jsonl = (...rows: object[]) => rows.map((row) => JSON.stringify(row)).join('\n');
const user = (seconds: number, content: unknown, extra: object = {}) => ({
  type: 'user',
  timestamp: at(seconds),
  message: { content },
  ...extra,
});
const assistant = (seconds: number, content: object[], extra: object = {}) => ({
  type: 'assistant',
  timestamp: at(seconds),
  message: { content },
  ...extra,
});

test('Claude: the final message is the text after the last tool call', () => {
  const transcript = jsonl(
    user(1, '<command-name>/mattpocock-skills:code-review</command-name> <command-args>230</command-args>'),
    user(1, 'skill body', { isMeta: true }),
    assistant(2, [{ type: 'text', text: 'Let me read the diff.' }, { type: 'tool_use', name: 'Bash' }]),
    user(3, [{ type: 'tool_result', content: 'diff' }]),
    assistant(4, [{ type: 'text', text: '## Standards' }]),
    assistant(4, [{ type: 'text', text: 'Path src/a/very/long/file.ts:12 is wrong.' }]),
  );
  assert.equal(lastClaudeReply(transcript, SENT), '## Standards\n\nPath src/a/very/long/file.ts:12 is wrong.');
});

test('Claude: sub-agent rows never end up in the reply', () => {
  const transcript = jsonl(
    user(1, 'review 230'),
    assistant(2, [{ type: 'text', text: 'Final review.' }]),
    assistant(3, [{ type: 'text', text: 'sub-agent chatter' }], { isSidechain: true }),
  );
  assert.equal(lastClaudeReply(transcript, SENT), 'Final review.');
});

test('Claude: output of a local command is not a prompt', () => {
  const transcript = jsonl(
    user(1, 'review 230'),
    assistant(2, [{ type: 'text', text: 'Final review.' }]),
    user(3, '<local-command-stdout>Set effort level to high</local-command-stdout>'),
  );
  assert.equal(lastClaudeReply(transcript, SENT), 'Final review.');
});

test('Claude: a prompt from before the relay sent its own yields no reply', () => {
  const transcript = jsonl(user(-60, 'an older question'), assistant(-50, [{ type: 'text', text: 'old answer' }]));
  assert.equal(lastClaudeReply(transcript, SENT), null);
});

test('Claude: a truncated last line is skipped', () => {
  const transcript = `${jsonl(user(1, 'review 230'), assistant(2, [{ type: 'text', text: 'Final review.' }]))}\n{"type":"assist`;
  assert.equal(lastClaudeReply(transcript, SENT), 'Final review.');
});

const message = (type: string, seconds: number, content: object[] = []) => ({
  type,
  time: { created: SENT + seconds * 1000 },
  content,
});

test('OpenCode: the final message is the text after the last tool part', () => {
  const exported = {
    messages: [
      message('user', 1),
      message('assistant', 2, [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'Checking.' }, { type: 'tool' }]),
      message('assistant', 3, [{ type: 'reasoning', text: 'more thinking' }, { type: 'text', text: '## Spec\n\nFinding (a).' }]),
      message('idle', 4),
    ],
  };
  assert.equal(lastOpenCodeReply(exported, SENT), '## Spec\n\nFinding (a).');
});

test('OpenCode: a prompt from before the relay sent its own yields no reply', () => {
  const exported = { messages: [message('user', -60), message('assistant', -50, [{ type: 'text', text: 'old' }])] };
  assert.equal(lastOpenCodeReply(exported, SENT), null);
});

test('OpenCode: no assistant text yields no reply', () => {
  assert.equal(lastOpenCodeReply({ messages: [message('user', 1), message('assistant', 2, [{ type: 'tool' }])] }, SENT), null);
});

test('assistant text spans the whole session, without prompts or sub-agents', () => {
  const transcript = jsonl(
    user(1, 'open the PR at https://github.com/o/r/pull/1'),
    assistant(2, [{ type: 'text', text: 'Opened https://github.com/o/r/pull/231' }, { type: 'tool_use', name: 'Bash' }]),
    assistant(3, [{ type: 'text', text: 'sub-agent' }], { isSidechain: true }),
    user(4, 'here is the feedback'),
    assistant(5, [{ type: 'text', text: 'Fixed both findings.' }]),
  );
  assert.equal(claudeAssistantText(transcript), 'Opened https://github.com/o/r/pull/231\n\nFixed both findings.');

  const exported = {
    messages: [
      message('user', 1),
      message('assistant', 2, [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'PR 231' }, { type: 'tool' }]),
      message('assistant', 3, [{ type: 'text', text: 'done' }]),
    ],
  };
  assert.equal(openCodeAssistantText(exported), 'PR 231\n\ndone');
});

const turnEnd = (seconds: number) => ({ type: 'system', subtype: 'turn_duration', timestamp: at(seconds) });
const background = (seconds: number, id: string) =>
  assistant(seconds, [{ type: 'tool_use', id, name: 'Bash', input: { run_in_background: true } }]);
const notice = (seconds: number, id: string) =>
  user(seconds, `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n</task-notification>`);

test('turn: idle while a background task runs is not finished', () => {
  const transcript = jsonl(user(1, '/goal green ci'), background(2, 'toolu_ci'), assistant(3, [{ type: 'text', text: 'Waiting for CI.' }]), turnEnd(4));
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: ['toolu_ci'], turnOpen: false });
});

test('turn: a notice that has arrived but not been handled keeps the turn open', () => {
  const transcript = jsonl(user(1, '/goal green ci'), background(2, 'toolu_ci'), turnEnd(4), notice(90, 'toolu_ci'));
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: true });
});

test('turn: finished once the notice is handled and the turn has ended', () => {
  const transcript = jsonl(
    user(1, '/goal green ci'),
    background(2, 'toolu_ci'),
    turnEnd(4),
    notice(90, 'toolu_ci'),
    assistant(95, [{ type: 'text', text: 'CI is green.' }]),
    turnEnd(96),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: false });
});

test('turn: background tasks from before the prompt and from sub-agents do not count', () => {
  const transcript = jsonl(
    background(-600, 'toolu_dev_server'),
    user(1, 'here is the feedback'),
    { ...background(2, 'toolu_sub'), isSidechain: true },
    assistant(3, [{ type: 'text', text: 'Fixed.' }]),
    turnEnd(4),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: false });
});

// Shapes as Claude Code writes them: the async launch shows only in the tool result's `toolUseResult`.
const launch = (seconds: number, id: string, name = 'Agent') =>
  assistant(seconds, [{ type: 'tool_use', id, name, input: { description: 'review', prompt: 'review the diff' } }]);
const launched = (seconds: number, id: string, toolUseResult: object, extra: object = {}) =>
  user(seconds, [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched' }], { toolUseResult, ...extra });
const asyncAgent = (agentId: string) => ({ isAsync: true, status: 'async_launched', agentId });
const backgroundShell = (backgroundTaskId: string) => ({ backgroundTaskId, stdout: '', stderr: '' });
const taskNotice = (seconds: number, taskId: string) =>
  user(seconds, `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`);
const stop = (seconds: number, name: string, input: object) => assistant(seconds, [{ type: 'tool_use', id: `toolu_${name}`, name, input }]);

test('turn: background sub-agents count, though their tool call has no run_in_background', () => {
  const transcript = jsonl(
    user(1, '/mattpocock-skills:code-review 230'),
    launch(2, 'toolu_standards'),
    launch(2, 'toolu_spec'),
    launched(3, 'toolu_standards', asyncAgent('a1')),
    launched(3, 'toolu_spec', asyncAgent('a2')),
    assistant(4, [{ type: 'text', text: 'I launched two reviewers.' }]),
    turnEnd(5),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: ['a1', 'a2'], turnOpen: false });
});

test('turn: a foreground command moved to the background counts', () => {
  const transcript = jsonl(
    user(1, '/goal green ci'),
    launch(2, 'toolu_watch', 'Bash'),
    launched(120, 'toolu_watch', { ...backgroundShell('b7'), timedOutAfterMs: 120_000 }),
    turnEnd(121),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: ['b7'], turnOpen: false });
});

test('turn: a notice with only a task id ends the task', () => {
  const transcript = jsonl(
    user(1, '/mattpocock-skills:code-review 230'),
    launch(2, 'toolu_standards'),
    launched(3, 'toolu_standards', asyncAgent('a1')),
    turnEnd(4),
    taskNotice(60, 'a1'),
    assistant(61, [{ type: 'text', text: '## Standards' }]),
    turnEnd(62),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: false });
});

test('turn: a notice with only a tool use id ends a task the result named', () => {
  const transcript = jsonl(
    user(1, '/goal green ci'),
    background(2, 'toolu_ci'),
    launched(3, 'toolu_ci', backgroundShell('b1')),
    turnEnd(4),
    user(90, '<task-notification>\n<tool-use-id>toolu_ci</tool-use-id>\n</task-notification>'),
    turnEnd(91),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: false });
});

test('turn: a stopped task is over, though no notice arrives', () => {
  const transcript = jsonl(
    user(1, 'check the UI'),
    background(2, 'toolu_dev'),
    launched(3, 'toolu_dev', backgroundShell('b_dev')),
    launch(4, 'toolu_old', 'Bash'),
    launched(5, 'toolu_old', backgroundShell('b_old')),
    launch(6, 'toolu_agent'),
    launched(7, 'toolu_agent', asyncAgent('a9')),
    stop(8, 'TaskStop', { task_id: 'b_dev' }),
    stop(9, 'KillShell', { shell_id: 'b_old' }),
    stop(10, 'KillBash', { shell_id: 'a9' }),
    turnEnd(11),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: false });
});

test('turn: launches by sub-agents and from before the prompt do not count', () => {
  const transcript = jsonl(
    launch(-600, 'toolu_dev', 'Bash'),
    launched(-599, 'toolu_dev', backgroundShell('b_dev')),
    user(1, 'here is the feedback'),
    launch(2, 'toolu_sub', 'Bash'),
    launched(3, 'toolu_sub', asyncAgent('a_sub'), { isSidechain: true }),
    turnEnd(4),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: false });
});

test('turn: a notice that arrives mid-turn, as a queued command, ends the task too', () => {
  const notification = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>';
  const transcript = jsonl(
    user(1, '/mattpocock-skills:code-review 230'),
    launch(2, 'toolu_standards'),
    launched(3, 'toolu_standards', asyncAgent('a1')),
    // Queued is not delivered: only the attachment puts the notice in front of the agent.
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(50), content: notification },
    { type: 'attachment', timestamp: at(51), attachment: { type: 'queued_command', prompt: notification } },
    assistant(52, [{ type: 'text', text: '## Standards' }]),
    turnEnd(53),
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: [], turnOpen: false });
});

test('turn: a notice that is only queued has not reached the agent yet', () => {
  const notification = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>';
  const transcript = jsonl(
    user(1, '/mattpocock-skills:code-review 230'),
    launch(2, 'toolu_standards'),
    launched(3, 'toolu_standards', asyncAgent('a1')),
    turnEnd(4),
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(50), content: notification },
  );
  assert.deepEqual(claudeTurnState(transcript, SENT), { pendingBackground: ['a1'], turnOpen: false });
});
