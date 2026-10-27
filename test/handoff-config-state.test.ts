import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, parseConfig } from '../src/config.ts';
import { buildHandoff, fill } from '../src/handoff.ts';
import { parseIntegrationStatus } from '../src/herdr.ts';
import { isNoPullRequest, sessionPullRequest } from '../src/pr.ts';
import { needsClear } from '../src/state.ts';

test('the PR is the last pull request link in the text, issue links do not count', () => {
  const reply =
    'Opened https://github.com/kigumi-ui/kigumi-cli/pull/229, superseded by ' +
    'https://github.com/kigumi-ui/kigumi-cli/pull/231. Closes https://github.com/kigumi-ui/kigumi-cli/issues/240.';
  assert.equal(sessionPullRequest(reply, 'kigumi-ui/kigumi-cli'), 'https://github.com/kigumi-ui/kigumi-cli/pull/231');
  assert.equal(sessionPullRequest('Draft-PR #231 is open', 'kigumi-ui/kigumi-cli'), null);
});

test('a session PR from another repository is refused, not looked up in this one', () => {
  const reply = 'Opened https://github.com/kigumi-ui/kigumi-cli/pull/231, it needs https://github.com/shoelace-style/webawesome/pull/12.';
  assert.throws(() => sessionPullRequest(reply, 'kigumi-ui/kigumi-cli'), /shoelace-style\/webawesome.*kigumi-ui\/kigumi-cli/);
  assert.equal(
    sessionPullRequest('See https://github.com/Kigumi-UI/Kigumi-CLI/pull/7', 'kigumi-ui/kigumi-cli'),
    'https://github.com/Kigumi-UI/Kigumi-CLI/pull/7',
    'GitHub names are not case sensitive',
  );
});

test('only "no PR for this branch" lets the PR lookup fall back to the session', () => {
  assert.equal(isNoPullRequest('no pull requests found for branch "fix/x"'), true);
  assert.equal(isNoPullRequest('could not determine current branch: failed to run git: not on any branch'), true);
  assert.equal(isNoPullRequest('HTTP 401: Bad credentials (https://api.github.com/graphql)'), false);
  assert.equal(isNoPullRequest('error connecting to api.github.com'), false);
});

test('fill replaces known placeholders and keeps unknown ones', () => {
  assert.equal(fill('/code-review {pr} {other}', { pr: 230 }), '/code-review 230 {other}');
});

test('the handoff keeps every review whole, each in its own block', () => {
  const handoff = buildHandoff('Intro.', [
    { title: 'QA #1', agent: 'Claude Code', text: '## Standards\nnone\n' },
    { title: 'QA #2', agent: 'OpenCode', text: 'Finding (a).' },
  ]);
  assert.equal(
    handoff,
    'Intro.\n\n<review from="QA #1" agent="Claude Code">\n## Standards\nnone\n</review>\n\n' +
      '<review from="QA #2" agent="OpenCode">\nFinding (a).\n</review>',
  );
});

test('config: keys left out keep their defaults', () => {
  const config = parseConfig({ reviewPrompt: { opencode: '/review {pr}' }, followUp: null });
  assert.equal(config.reviewPrompt.opencode, '/review {pr}');
  assert.equal(config.reviewPrompt.claude, DEFAULTS.reviewPrompt.claude);
  assert.equal(config.followUp, null);
  assert.equal(config.handoffIntro, DEFAULTS.handoffIntro);
  assert.equal(DEFAULTS.reviewPrompt.opencode, '/code-review {pr}', 'parseConfig must not change the defaults');
});

test('config: wrong types and invalid patterns are refused', () => {
  assert.throws(() => parseConfig({ reviewTimeoutMinutes: '90' }), /reviewTimeoutMinutes/);
  assert.throws(() => parseConfig({ engineeringLabel: '' }), /engineeringLabel/);
  assert.throws(() => parseConfig({ qaLabelPattern: '(' }), /qaLabelPattern/);
  assert.throws(() => parseConfig([]), /\(root\)/);
  assert.throws(() => parseConfig({ backgroundGraceMinutes: 0 }), /backgroundGraceMinutes/);
});

test('config: a QA label pattern needs a capture group for the QA number', () => {
  assert.throws(() => parseConfig({ qaLabelPattern: '^QA' }), /qaLabelPattern.*capture group/);
  assert.throws(() => parseConfig({ qaLabelPattern: '^QA (?:#\\d+)$' }), /qaLabelPattern.*capture group/);
  assert.equal(parseConfig({ qaLabelPattern: '^Review (\\d+)$' }).qaLabelPattern, '^Review (\\d+)$');
});

test('config: the background grace period has a default and can be set', () => {
  assert.equal(DEFAULTS.backgroundGraceMinutes, 30);
  assert.equal(parseConfig({ backgroundGraceMinutes: 45 }).backgroundGraceMinutes, 45);
});

test('/clear only for the session a pane already reviewed in', () => {
  const record = { sessionId: 's1', pr: 230, at: '2026-10-27T10:00:00.000Z' };
  assert.equal(needsClear(record, 's1'), true);
  assert.equal(needsClear(record, 's2'), false, 'the user started a new session since');
  assert.equal(needsClear(undefined, 's1'), false, 'the pane never reviewed');
  assert.equal(needsClear(record, undefined), false);
});

test('integration status lines are parsed into name and status', () => {
  const statuses = parseIntegrationStatus(
    [
      'claude: outdated (v9 < v10) (/Users/me/.claude/hooks/herdr-agent-state.sh)',
      'codex: current (v8) (/Users/me/.codex/herdr-agent-state.sh)',
      'opencode: not installed (/Users/me/.config/opencode/plugins/herdr-agent-state.js)',
      'letta (experimental): not installed (/Users/me/.letta/hooks/herdr-agent-session.sh)',
    ].join('\n'),
  );
  assert.deepEqual(statuses, {
    claude: 'outdated (v9 < v10)',
    codex: 'current (v8)',
    opencode: 'not installed',
    letta: 'not installed',
  });
});
