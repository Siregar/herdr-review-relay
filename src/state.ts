import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RelayError } from './roles.ts';

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? join(homedir(), '.local', 'state', 'herdr-review-relay');
const REVIEWS_FILE = join(STATE_DIR, 'reviews.json');

/** The session a QA pane last reviewed in, so the next round can start that pane from a clean context. */
export interface ReviewRecord {
  sessionId: string;
  pr: number;
  at: string;
}

export type ReviewRecords = Record<string, ReviewRecord>;

/**
 * A QA pane needs /clear when its current session is the one it already reviewed in: the earlier
 * review is still in its context. A session the user started since then is clean.
 */
export function needsClear(record: ReviewRecord | undefined, currentSessionId: string | undefined): boolean {
  return record !== undefined && currentSessionId !== undefined && record.sessionId === currentSessionId;
}

export async function loadReviews(): Promise<ReviewRecords> {
  try {
    return JSON.parse(await readFile(REVIEWS_FILE, 'utf8')) as ReviewRecords;
  } catch (_error) {
    return {}; // First run, or an unreadable file: no pane counts as reviewed.
  }
}

/**
 * Records this run's panes. Relays in other tabs save too, so the file is read again and only
 * `updates` are merged in; the write goes through a temporary file so no reader sees half of it.
 */
export async function saveReviews(updates: ReviewRecords): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  const records = { ...(await loadReviews()), ...updates };
  const temporary = `${REVIEWS_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`);
  await rename(temporary, REVIEWS_FILE);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false; // ESRCH: the process is gone, its lock is stale.
  }
}

/** One relay per tab at a time. Returns the release function. */
export async function acquireLock(tabId: string): Promise<() => Promise<void>> {
  const dir = join(STATE_DIR, 'locks');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tabId.replace(/[^\w-]/g, '_')}.pid`);
  try {
    const pid = Number((await readFile(path, 'utf8')).trim());
    // An empty file is a relay that died between creating the lock and writing its pid; pid 0 would
    // pass the liveness check, as the caller's own process group.
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
      throw new RelayError(`A review relay is already running in this tab (pid ${pid})`);
    }
    await rm(path, { force: true });
  } catch (error) {
    if (error instanceof RelayError) throw error;
    // No lock file: nothing to clear.
  }
  let handle: FileHandle;
  try {
    handle = await open(path, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new RelayError('A review relay started in this tab at the same moment');
  }
  await handle.writeFile(String(process.pid));
  await handle.close();
  return () => rm(path, { force: true });
}

/** Keeps every handoff, so a failed or surprising run can be read back. */
export async function archive(name: string, text: string): Promise<string> {
  const dir = join(STATE_DIR, 'runs');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, text);
  return path;
}
