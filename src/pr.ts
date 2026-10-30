import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { readAssistantText } from './replies.ts';
import { RelayError, type Role } from './roles.ts';

const execFileAsync = promisify(execFile);

export interface PullRequest {
  number: number;
  url: string;
  state: string;
}

/**
 * The last GitHub pull request URL in the text that belongs to `repo`. Links to other repositories
 * (an upstream fix, a dependency) are passed over; when the text links only those, it is refused, so
 * QA never reviews the wrong change.
 */
export function sessionPullRequest(text: string, repo: string): string | null {
  const links = [...text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/g)];
  const own = links.findLast((link) => link[1].toLowerCase() === repo.toLowerCase());
  if (own) return own[0];
  const foreign = links.at(-1);
  if (foreign) {
    throw new RelayError(
      `Engineering's last PR link is for ${foreign[1]}`,
      'Push the branch so gh finds its PR, then run the review relay again.',
      `Engineering's session last links ${foreign[0]}; this checkout is ${repo}.`,
    );
  }
  return null;
}

/** gh's message when the branch has no PR, or there is no branch to look one up for. */
export function isNoPullRequest(stderr: string): boolean {
  return /no pull requests found|could not determine current branch/i.test(stderr);
}

/** gh's message when the checkout is not a git repository or has no GitHub remote. */
function isNotGitHubRepository(stderr: string): boolean {
  return /not a git repository|no git remotes|none of the git remotes/i.test(stderr);
}

const notGitHubRepository = (cwd: string, why: string): RelayError =>
  new RelayError(`${basename(cwd)} is not a GitHub repository`, 'Run the relay from a checkout gh knows.', `${cwd}: ${why}`);

/** gh's output; null when gh reports that the branch has no PR. Any other failure is reported as such. */
async function gh(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync('gh', args, { cwd })).stdout;
  } catch (error) {
    const stderr = ((error as { stderr?: string }).stderr ?? '').trim();
    if (isNoPullRequest(stderr)) return null;
    if (isNotGitHubRepository(stderr)) throw notGitHubRepository(cwd, stderr);
    throw new RelayError(
      'gh could not reach GitHub',
      'Check `gh auth status` and your network, then run the review relay again.',
      `gh ${args.slice(0, 2).join(' ')} failed in ${cwd}: ${stderr || (error as Error).message}`,
    );
  }
}

/** The branch checked out in `cwd`; empty on a detached HEAD or when git cannot tell. */
async function currentBranch(cwd: string): Promise<string> {
  try {
    return (await execFileAsync('git', ['branch', '--show-current'], { cwd })).stdout.trim();
  } catch (_error) {
    return '';
  }
}

function notOpen(pr: PullRequest): RelayError {
  if (pr.state === 'MERGED') {
    return new RelayError(`PR #${pr.number} is already merged`, 'Check out the next branch in Engineering, or open a new PR.', pr.url);
  }
  return new RelayError(`PR #${pr.number} is ${pr.state.toLowerCase()}`, 'Reopen it, or have Engineering open a new PR.', pr.url);
}

/** The PR of the checkout's branch, or `target` (a PR URL). */
async function view(cwd: string, target?: string): Promise<PullRequest | null> {
  const stdout = await gh(cwd, ['pr', 'view', ...(target === undefined ? [] : [target]), '--json', 'number,url,state']);
  return stdout === null ? null : (JSON.parse(stdout) as PullRequest);
}

/**
 * The PR of the branch Engineering has checked out. A branch gh cannot map to a PR (no upstream,
 * a renamed local branch) falls back to the last PR link Engineering wrote in its session: after a
 * review round its last reply is about the fixes and often links no PR. A failing gh (auth, network)
 * is reported as such.
 */
export async function findPullRequest(engineering: Role, cwd: string): Promise<PullRequest> {
  let pr = await view(cwd);
  if (!pr) {
    const sessionId = engineering.pane.agent_session?.value;
    const written = sessionId ? await readAssistantText(engineering.kind, sessionId, cwd) : '';
    const repo = (await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']))?.trim();
    if (!repo) throw notGitHubRepository(cwd, 'gh names no repository for it');
    const url = sessionPullRequest(written, repo);
    if (url === null) {
      const branch = await currentBranch(cwd);
      throw new RelayError(
        branch ? `No PR for ${branch}` : 'No branch checked out',
        'Have Engineering open the PR, then run the review relay again.',
        `gh knows no PR for the branch in ${cwd}, and Engineering's session links none.`,
      );
    }
    pr = await view(cwd, url);
    if (!pr) {
      throw new RelayError(
        "gh cannot read Engineering's last PR link",
        'Check `gh auth status`, then run the review relay again.',
        `Engineering's session links ${url}; gh cannot read it from ${cwd}.`,
      );
    }
  }
  if (pr.state !== 'OPEN') throw notOpen(pr);
  return pr;
}
