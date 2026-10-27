import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Role } from '../src/roles.ts';

// A fake gh on PATH and a home of its own, so findPullRequest runs against neither GitHub nor real transcripts.
const dir = await mkdtemp(join(tmpdir(), 'review-relay-pr-'));
await writeFile(
  join(dir, 'gh'),
  `#!/bin/sh
case "$1 $2" in
  "pr view")
    if [ "$3" = "--json" ]; then
      [ -n "$GH_PR_ERROR" ] && { echo "$GH_PR_ERROR" >&2; exit 1; }
      echo '{"number":1,"url":"https://github.com/o/r/pull/1","state":"OPEN"}'
    else
      echo "{\\"number\\":\${3##*/},\\"url\\":\\"$3\\",\\"state\\":\\"OPEN\\"}"
    fi ;;
  "repo view") echo "$GH_REPO" ;;
esac
`,
);
await chmod(join(dir, 'gh'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.HOME = dir;
process.env.CLAUDE_CONFIG_DIR = join(dir, '.claude');
await mkdir(join(dir, '.claude', 'projects', 'repo'), { recursive: true });
await writeFile(
  join(dir, '.claude', 'projects', 'repo', 'session-1.jsonl'),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Opened https://github.com/o/r/pull/231; it needs https://github.com/up/stream/pull/9.' }] },
  }),
);
const { findPullRequest } = await import('../src/pr.ts');

const engineering: Role = {
  title: 'Engineering',
  kind: 'claude',
  pane: { pane_id: 'p1', tab_id: 't1', cwd: dir, agent_session: { value: 'session-1' } },
};

test('PR lookup: a failing gh is reported as a gh failure, not as "No PR found"', async () => {
  process.env.GH_PR_ERROR = 'HTTP 401: Bad credentials (https://api.github.com/graphql)';
  await assert.rejects(findPullRequest(engineering, dir), /gh pr view failed .*Bad credentials/);
});

test('PR lookup: a branch without a PR falls back to the session link in this repository, by URL', async () => {
  process.env.GH_PR_ERROR = 'no pull requests found for branch "fix/x"';
  process.env.GH_REPO = 'o/r';
  assert.deepEqual(await findPullRequest(engineering, dir), {
    number: 231,
    url: 'https://github.com/o/r/pull/231',
    state: 'OPEN',
  });
});

test('PR lookup: a checkout gh cannot name a repository for is refused as such', async () => {
  process.env.GH_PR_ERROR = 'no pull requests found for branch "fix/x"';
  process.env.GH_REPO = '';
  await assert.rejects(findPullRequest(engineering, dir), /gh cannot tell which repository/);
});
