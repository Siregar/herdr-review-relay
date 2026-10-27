import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentKind } from './herdr.ts';

const execFileAsync = promisify(execFile);

/** Clock skew tolerated between sending a prompt and the agent recording it. */
const SKEW_MS = 5_000;

interface ClaudeBlock {
  type: string;
  text?: string;
  id?: string;
  input?: { run_in_background?: boolean };
}

interface ClaudeRow {
  type?: string;
  subtype?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: string | ClaudeBlock[] };
}

function parseClaudeRows(jsonl: string): ClaudeRow[] {
  const rows: ClaudeRow[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as ClaudeRow);
    } catch (_error) {
      // A line being written while we read is incomplete; the rows before it are enough.
    }
  }
  return rows;
}

function isClaudePrompt(row: ClaudeRow): boolean {
  if (row.type !== 'user' || row.isMeta || row.isSidechain) return false;
  const content = row.message?.content;
  if (typeof content === 'string') {
    // Output of local commands such as /clear is stored as a user row too.
    return !content.startsWith('<local-command-') && !content.startsWith('<bash-');
  }
  return Array.isArray(content) && content.some((block) => block.type === 'text');
}

/**
 * The text of the agent's final message: the text blocks after the last tool call that follows the
 * last prompt. Returns null when that prompt is older than `since`, so a reply to an earlier prompt
 * is never mistaken for the current one.
 */
export function lastClaudeReply(jsonl: string, since: number): string | null {
  const rows = parseClaudeRows(jsonl);
  const promptIndex = rows.findLastIndex(isClaudePrompt);
  if (promptIndex === -1) return null;
  if (Date.parse(rows[promptIndex].timestamp ?? '') < since - SKEW_MS) return null;

  let texts: string[] = [];
  for (const row of rows.slice(promptIndex + 1)) {
    if (row.type !== 'assistant' || row.isSidechain) continue;
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use') texts = [];
      else if (block.type === 'text' && block.text) texts.push(block.text);
    }
  }
  return texts.join('\n\n').trim() || null;
}

export interface TurnState {
  /** Background tasks started since the prompt whose completion notice has not arrived yet. */
  pendingBackground: string[];
  /** Rows were written after the last turn ended: a turn is running, or a notice waits to be handled. */
  turnOpen: boolean;
}

/**
 * Whether a Claude Code agent that looks idle has really finished. It goes idle while a background
 * task runs (a CI wait, a background sub-agent) and wakes up when the task's
 * `<task-notification>` arrives, so idle alone ends a wait too early.
 */
export function claudeTurnState(jsonl: string, since: number): TurnState {
  const rows = parseClaudeRows(jsonl).filter((row) => !row.isSidechain);
  const started: string[] = [];
  const notified = new Set<string>();
  for (const row of rows) {
    const content = row.message?.content;
    if (row.type === 'assistant' && Array.isArray(content) && Date.parse(row.timestamp ?? '') >= since - SKEW_MS) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.input?.run_in_background === true && block.id) started.push(block.id);
      }
    }
    if (row.type === 'user' && typeof content === 'string' && content.includes('<task-notification>')) {
      for (const match of content.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) notified.add(match[1]);
    }
  }
  const lastEnd = rows.findLastIndex((row) => row.type === 'system' && row.subtype === 'turn_duration');
  const lastActivity = rows.findLastIndex((row) => row.type === 'user' || row.type === 'assistant');
  return {
    pendingBackground: started.filter((id) => !notified.has(id)),
    turnOpen: lastActivity > lastEnd,
  };
}

/** Everything the agent itself wrote in the session, oldest first, sub-agents left out. */
export function claudeAssistantText(jsonl: string): string {
  return parseClaudeRows(jsonl)
    .filter((row) => row.type === 'assistant' && !row.isSidechain && Array.isArray(row.message?.content))
    .flatMap((row) => (row.message?.content as ClaudeBlock[]).filter((block) => block.type === 'text'))
    .map((block) => block.text ?? '')
    .join('\n\n');
}

interface OpenCodeMessage {
  type?: string;
  time?: { created?: number };
  content?: { type: string; text?: string }[];
}

/** Same rule as `lastClaudeReply`, for the JSON `opencode session export` prints. */
export function lastOpenCodeReply(exported: unknown, since: number): string | null {
  const messages = (exported as { messages?: OpenCodeMessage[] }).messages ?? [];
  const promptIndex = messages.findLastIndex((message) => message.type === 'user');
  if (promptIndex === -1) return null;
  if ((messages[promptIndex].time?.created ?? 0) < since - SKEW_MS) return null;

  let texts: string[] = [];
  for (const message of messages.slice(promptIndex + 1)) {
    if (message.type !== 'assistant') continue;
    for (const part of message.content ?? []) {
      if (part.type === 'tool') texts = [];
      else if (part.type === 'text' && part.text) texts.push(part.text);
    }
  }
  return texts.join('\n\n').trim() || null;
}

/** Same as `claudeAssistantText`, for the JSON `opencode session export` prints. */
export function openCodeAssistantText(exported: unknown): string {
  return ((exported as { messages?: OpenCodeMessage[] }).messages ?? [])
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');
}

/** Claude Code keeps transcripts under `<config dir>/projects/<project>/<session id>.jsonl`. */
async function findClaudeTranscript(sessionId: string): Promise<string | null> {
  const home = homedir();
  const configDirs = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) configDirs.add(process.env.CLAUDE_CONFIG_DIR);
  for (const entry of await readdir(home)) {
    if (entry === '.claude' || entry.startsWith('.claude-')) configDirs.add(join(home, entry));
  }

  let newest: { path: string; mtime: number } | null = null;
  for (const dir of configDirs) {
    let projects: string[];
    try {
      projects = await readdir(join(dir, 'projects'));
    } catch (_error) {
      continue; // Not a Claude config directory.
    }
    for (const project of projects) {
      const path = join(dir, 'projects', project, `${sessionId}.jsonl`);
      try {
        const { mtimeMs } = await stat(path);
        if (!newest || mtimeMs > newest.mtime) newest = { path, mtime: mtimeMs };
      } catch (_error) {
        // The session is not in this project.
      }
    }
  }
  return newest?.path ?? null;
}

/** The session as the agent recorded it: a Claude Code transcript, or an OpenCode export. */
async function readSession(kind: AgentKind, sessionId: string, cwd: string): Promise<string> {
  if (kind === 'claude') {
    const path = await findClaudeTranscript(sessionId);
    if (!path) throw new Error(`No Claude Code transcript found for session ${sessionId}`);
    return readFile(path, 'utf8');
  }
  const { stdout } = await execFileAsync('opencode', ['session', 'export', sessionId], {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

/** Reads the agent's last reply from its own records, never from the terminal screen. */
export async function readLastReply(
  kind: AgentKind,
  sessionId: string,
  cwd: string,
  since: number,
): Promise<string | null> {
  const session = await readSession(kind, sessionId, cwd);
  return kind === 'claude' ? lastClaudeReply(session, since) : lastOpenCodeReply(JSON.parse(session), since);
}

/** Null for agents that record no background work: their idle status is final. */
export async function readTurnState(kind: AgentKind, sessionId: string, since: number): Promise<TurnState | null> {
  if (kind !== 'claude') return null;
  return claudeTurnState(await readSession(kind, sessionId, ''), since);
}

export async function readAssistantText(kind: AgentKind, sessionId: string, cwd: string): Promise<string> {
  const session = await readSession(kind, sessionId, cwd);
  return kind === 'claude' ? claudeAssistantText(session) : openCodeAssistantText(JSON.parse(session));
}
