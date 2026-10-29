import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import type { RelayError, Role } from '../src/roles.ts';

// A fake gh and git on PATH and a home of its own, so findPullRequest runs against neither GitHub nor real transcripts.
const dir = await mkdtemp(join(tmpdir(), 'review-relay-pr-'));
await writeFile(
  join(dir, 'gh'),
  `#!/bin/sh
case "$1 $2" in
  "pr view")
    if [ "$3" = "--json" ]; then
      [ -n "$GH_PR_ERROR" ] && { echo "$GH_PR_ERROR" >&2; exit 1; }
      echo "{\\"number\\":1,\\"url\\":\\"https://github.com/o/r/pull/1\\",\\"state\\":\\"\${GH_STATE:-OPEN}\\"}"
    else
      echo "{\\"number\\":\${3##*/},\\"url\\":\\"$3\\",\\"state\\":\\"OPEN\\"}"
    fi ;;
  "repo view")
    [ -n "$GH_REPO_ERROR" ] && { echo "$GH_REPO_ERROR" >&2; exit 1; }
    echo "$GH_REPO" ;;
esac
`,
);
await writeFile(join(dir, 'git'), '#!/bin/sh\necho "$GIT_BRANCH"\n');
await chmod(join(dir, 'gh'), 0o755);
await chmod(join(dir, 'git'), 0o755);
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

/** Engineering's session, as a transcript with one reply. */
async function session(id: string, text: string): Promise<Role> {
  await writeFile(
    join(dir, '.claude', 'projects', 'repo', `${id}.jsonl`),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  );
  return { ...engineering, pane: { ...engineering.pane, agent_session: { value: id } } };
}

test('PR lookup: a failing gh is reported as a gh failure, not as "No PR found"', async () => {
  process.env.GH_PR_ERROR = 'HTTP 401: Bad credentials (https://api.github.com/graphql)';
  await assert.rejects(findPullRequest(engineering, dir), (error: RelayError) => {
    assert.equal(error.title, 'gh could not reach GitHub');
    assert.equal(error.nextStep, 'Check `gh auth status` and your network, then run the review relay again.');
    assert.match(error.details ?? '', /gh pr view failed .*Bad credentials/);
    return true;
  });
});

test('PR lookup: a branch without a PR, and a session without a link, is refused by the branch name', async () => {
  process.env.GH_PR_ERROR = 'no pull requests found for branch "feat/login"';
  process.env.GH_REPO = 'o/r';
  process.env.GIT_BRANCH = 'feat/login';
  const silent = await session('session-silent', 'Shall I open a PR?');
  await assert.rejects(findPullRequest(silent, dir), {
    title: 'No PR for feat/login',
    nextStep: 'Have Engineering open the PR, then run the review relay again.',
  });
  process.env.GIT_BRANCH = '';
  await assert.rejects(findPullRequest(silent, dir), { title: 'No branch checked out' });
});

test('PR lookup: a session that links only a PR in another repository is refused by that repository', async () => {
  process.env.GH_PR_ERROR = 'no pull requests found for branch "fix/x"';
  process.env.GH_REPO = 'o/r';
  const upstream = await session('session-upstream', 'Filed https://github.com/up/stream/pull/9 for the bug.');
  await assert.rejects(findPullRequest(upstream, dir), {
    title: "Engineering's last PR link is for up/stream",
    nextStep: 'Push the branch so gh finds its PR, then run the review relay again.',
  });
});

test('PR lookup: a merged PR is refused', async () => {
  delete process.env.GH_PR_ERROR;
  process.env.GH_STATE = 'MERGED';
  await assert.rejects(findPullRequest(engineering, dir), {
    title: 'PR #1 is already merged',
    nextStep: 'Check out the next branch in Engineering, or open a new PR.',
  });
  delete process.env.GH_STATE;
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
  await assert.rejects(findPullRequest(engineering, dir), { title: `${basename(dir)} is not a GitHub repository` });
});

test('PR lookup: a checkout without a GitHub remote is refused as such, not as a gh failure', async () => {
  process.env.GH_PR_ERROR = 'no pull requests found for branch "fix/x"';
  process.env.GH_REPO = '';
  process.env.GH_REPO_ERROR = 'none of the git remotes configured for this repository point to a known GitHub host';
  await assert.rejects(findPullRequest(engineering, dir), { title: `${basename(dir)} is not a GitHub repository` });
  delete process.env.GH_REPO_ERROR;
});
