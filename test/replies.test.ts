import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeAssistantText, lastClaudeReply, lastOpenCodeReply, openCodeAssistantText } from '../src/replies.ts';

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
