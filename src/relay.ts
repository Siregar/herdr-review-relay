import { execFile } from 'node:child_process';
import { bestEffortNotify, cwdOf, getAgent, HerdrError, notify } from './herdr.ts';
import { readLastReply } from './replies.ts';
import { RelayError } from './roles.ts';
import { run } from './run.ts';

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
    if (!fromTerminal) await bestEffortNotify(console.error)('Review relay failed', message, 'request');
    process.exitCode = 1;
  }
}

await main();
