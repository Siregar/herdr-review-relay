import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readAssistantText } from './replies.ts';
import { RelayError, type Role } from './roles.ts';

const execFileAsync = promisify(execFile);

export interface PullRequest {
  number: number;
  url: string;
  state: string;
}

/** The number of the last GitHub pull request URL in the text. */
export function lastPullRequestNumber(text: string): number | null {
  const numbers = [...text.matchAll(/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g)].map((match) => Number(match[1]));
  return numbers.at(-1) ?? null;
}

async function view(cwd: string, number?: number): Promise<PullRequest | null> {
  const args = ['pr', 'view', ...(number === undefined ? [] : [String(number)]), '--json', 'number,url,state'];
  try {
    const { stdout } = await execFileAsync('gh', args, { cwd });
    return JSON.parse(stdout) as PullRequest;
  } catch (_error) {
    return null; // gh found no such PR for this checkout.
  }
}

/**
 * The PR of the branch Engineering has checked out. A branch gh cannot map to a PR (no upstream,
 * a renamed local branch) falls back to the last PR link Engineering wrote in its session: after a
 * review round its last reply is about the fixes and often links no PR.
 */
export async function findPullRequest(engineering: Role, cwd: string): Promise<PullRequest> {
  let pr = await view(cwd);
  if (!pr) {
    const sessionId = engineering.pane.agent_session?.value;
    const written = sessionId ? await readAssistantText(engineering.kind, sessionId, cwd) : '';
    const number = lastPullRequestNumber(written);
    if (number === null) {
      throw new RelayError(`No PR found: gh knows none for the branch in ${cwd}, and Engineering's session links none`);
    }
    pr = await view(cwd, number);
    if (!pr) throw new RelayError(`Engineering's session links PR #${number}, but gh cannot read it from ${cwd}`);
  }
  if (pr.state !== 'OPEN') throw new RelayError(`PR #${pr.number} is ${pr.state.toLowerCase()}, not open`);
  return pr;
}
