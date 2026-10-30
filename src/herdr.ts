import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERDR = process.env.HERDR_BIN_PATH ?? 'herdr';

export type AgentKind = 'claude' | 'opencode';
export type AgentStatus = 'idle' | 'done' | 'working' | 'blocked' | 'unknown';
export type Sound = 'none' | 'done' | 'request';

export interface Pane {
  pane_id: string;
  tab_id: string;
  label?: string | null;
  agent?: string | null;
  agent_status?: AgentStatus;
  agent_session?: { value: string } | null;
  cwd: string;
  foreground_cwd?: string | null;
}

/** The directory the pane's foreground process works in. */
export const cwdOf = (pane: Pane): string => pane.foreground_cwd ?? pane.cwd;

export class HerdrError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function herdr(args: string[]): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(HERDR, args, { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    // herdr exits 1 on failure but still prints a JSON error on stdout.
    stdout = (error as { stdout?: string }).stdout ?? '';
    if (!stdout.trim()) throw error;
  }
  const reply = JSON.parse(stdout) as {
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  if (reply.error) throw new HerdrError(reply.error.code, reply.error.message);
  return reply.result ?? {};
}

export async function listPanes(): Promise<Pane[]> {
  return (await herdr(['pane', 'list'])).panes as Pane[];
}

export async function getAgent(target: string): Promise<Pane> {
  return (await herdr(['agent', 'get', target])).agent as Pane;
}

/** Types the text into the agent and presses Enter, without waiting for a turn. */
export async function prompt(target: string, text: string): Promise<void> {
  await herdr(['agent', 'prompt', target, text]);
}

/**
 * Submits a prompt and waits for the turn it starts to settle on idle, done or blocked.
 * herdr fails with `agent_prompt_stalled` when no turn starts within five seconds.
 */
export async function promptAndWait(target: string, text: string, timeoutMs: number): Promise<AgentStatus> {
  const result = await herdr(['agent', 'prompt', target, text, '--wait', '--timeout', String(timeoutMs)]);
  return (result.agent as Pane).agent_status ?? 'unknown';
}

/** herdr's answer to a notification. `ok` alone does not mean the user saw it; only `shown` does. */
export interface Notified {
  shown: boolean;
  /** `shown`, `disabled`, `rate_limited`, `no_foreground_client` or `busy`. */
  reason: string;
}

/** Shows a notification through the user's `[ui.toast] delivery`, which may drop it; see `Notified`. */
export async function notify(title: string, body: string, sound: Sound = 'none'): Promise<Notified> {
  const result = await herdr(['notification', 'show', title, '--body', body, '--sound', sound]);
  return { shown: result.shown === true, reason: typeof result.reason === 'string' ? result.reason : 'no reason given' };
}

/** A popup's outer size in terminal cells, frame included. */
export interface PopupSize {
  width: number;
  height: number;
}

/**
 * Opens one of this plugin's `[[panes]]` entrypoints as a popup of `size`, with `env` for its process.
 * herdr refuses a popup while one of its own modals is open (`ui_busy`) or no client is attached.
 */
export async function openPopup(entrypoint: string, size: PopupSize, env: Record<string, string>): Promise<void> {
  const plugin = process.env.HERDR_PLUGIN_ID ?? 'review-relay';
  const sizeArgs = ['--width', String(size.width), '--height', String(size.height)];
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  await herdr(['plugin', 'pane', 'open', '--plugin', plugin, '--entrypoint', entrypoint, ...sizeArgs, ...envArgs]);
}

/** `herdr integration status` as `{ claude: 'current (v10)', opencode: 'not installed', ... }`. */
export async function integrationStatus(): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync(HERDR, ['integration', 'status']);
  return parseIntegrationStatus(stdout);
}

export function parseIntegrationStatus(text: string): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([\w-]+)(?: \([^)]*\))?: (.+?)(?: \(\/.*\))?$/.exec(line.trim());
    if (match) statuses[match[1]] = match[2];
  }
  return statuses;
}
