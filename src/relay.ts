import { execFile } from 'node:child_process';
import { cwdOf, getAgent } from './herdr.ts';
import { readLastReply } from './replies.ts';
import { AGENT_NAMES, Failure, RelayError } from './roles.ts';
import { run } from './run.ts';
import { herdrTellDeps, inform, messageOf, messageText, tell } from './tell.ts';

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
  throw new RelayError('No clipboard tool found', 'Install wl-copy or xclip.', `Tried ${candidates.map(([command]) => command).join(', ')}.`);
}

async function copy(paneId: string, toStdout: boolean): Promise<void> {
  const agent = await getAgent(paneId);
  if (agent.agent !== 'claude' && agent.agent !== 'opencode') {
    throw new RelayError('This pane runs no agent', 'Focus a Claude Code or OpenCode pane.');
  }
  const sessionId = agent.agent_session?.value;
  if (!sessionId) {
    throw new RelayError(`herdr does not know ${AGENT_NAMES[agent.agent]} sessions`, `Run \`herdr integration install ${agent.agent}\`.`);
  }
  const text = await readLastReply(agent.agent, sessionId, cwdOf(agent), 0);
  if (!text) throw new RelayError('No reply to copy yet', 'Ask the agent something first.');
  if (toStdout) {
    console.log(text);
    return;
  }
  await copyToClipboard(text);
  await inform(herdrTellDeps(console.error), 'Copied the last reply', `${text.length} characters`, 'none');
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const paneId = option(args, '--pane') ?? process.env.HERDR_PANE_ID;
  // Terminal runs report to the terminal; only keybinding runs need herdr to show the message.
  const fromTerminal = args.includes('--dry-run') || args.includes('--stdout');
  try {
    if (!paneId) throw new RelayError('No pane to start from', 'Start the relay from herdr, or pass --pane <id>.');
    if (command === 'run') await run(paneId, args.includes('--dry-run'));
    else if (command === 'copy') await copy(paneId, args.includes('--stdout'));
    else throw new RelayError(`Unknown command "${command ?? ''}"`, 'Use run or copy.');
  } catch (error) {
    const message = messageOf(error);
    if (fromTerminal) console.error(messageText(message));
    else await tell(herdrTellDeps(console.error), error instanceof Failure ? 'failure' : 'refusal', message);
    process.exitCode = 1;
  }
}

await main();
