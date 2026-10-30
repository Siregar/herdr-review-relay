import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { RelayError } from '../src/roles.ts';

// state.ts reads its directory once, on import.
const dir = await mkdtemp(join(tmpdir(), 'review-relay-state-'));
process.env.HERDR_PLUGIN_STATE_DIR = dir;
const { acquireLock, loadReviews, saveReviews } = await import('../src/state.ts');

const record = (sessionId: string) => ({ sessionId, pr: 230, at: '2026-10-27T10:00:00.000Z' });

test('reviews: two relays saving at once both keep their panes', async () => {
  await saveReviews({ p_old: record('s0') });
  // Both relays loaded the file before either saved.
  const tabA = await loadReviews();
  const tabB = await loadReviews();
  tabA.p1 = record('s1');
  tabB.p2 = record('s2');
  await saveReviews({ p1: tabA.p1 });
  await saveReviews({ p2: tabB.p2 });
  assert.deepEqual(Object.keys(await loadReviews()).sort(), ['p1', 'p2', 'p_old']);
  assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('reviews')), ['reviews.json'], 'no temporary file is left behind');
});

test('reviews: a pane that reviewed again keeps its new session, not the one on file', async () => {
  await saveReviews({ p3: record('old') });
  await saveReviews({ p3: record('new') });
  assert.equal((await loadReviews()).p3.sessionId, 'new');
});

test('lock: an empty lock file, left by a relay that died while taking it, is stale', async () => {
  await mkdir(join(dir, 'locks'), { recursive: true });
  await writeFile(join(dir, 'locks', 'tab_empty.pid'), '');
  const release = await acquireLock('tab_empty');
  assert.equal(await readFile(join(dir, 'locks', 'tab_empty.pid'), 'utf8'), String(process.pid));
  await release();
});

test('lock: a live relay holds the tab', async () => {
  const release = await acquireLock('tab_live');
  await assert.rejects(acquireLock('tab_live'), (error: RelayError) => {
    assert.equal(error.title, 'A review round is already running here');
    assert.match(error.details ?? '', /pid \d+/);
    return true;
  });
  await release();
});

test('lock: a pid that is not a positive integer is stale', async () => {
  for (const content of ['-1', '12.5', 'not a pid']) {
    await writeFile(join(dir, 'locks', 'tab_junk.pid'), content);
    const release = await acquireLock('tab_junk');
    await release();
  }
});

test('lock: of relays starting at the same moment, one wins and the others are told why', async () => {
  for (let round = 0; round < 5; round++) {
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => acquireLock(`tab_race_${round}`)));
    const winners = results.filter((result) => result.status === 'fulfilled');
    assert.equal(winners.length, 1);
    for (const result of results) {
      if (result.status === 'rejected') assert.match(result.reason.message, /^A review round is already running here\n/);
    }
    await (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  }
  assert.deepEqual((await readdir(join(dir, 'locks'))).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left behind');
});

test('lock: another relay never finds the lock empty while it is being taken', async (t) => {
  // An empty lock is stale: a relay that died while taking it. So a live relay's lock must never be
  // empty, not even between creating the file and writing the pid. After every file operation of
  // acquireLock, read the lock the way a relay starting at that moment would.
  const lock = join(dir, 'locks', 'tab_watched.pid');
  const seen: string[] = [];
  for (const name of ['open', 'writeFile', 'link', 'rename', 'rm'] as const) {
    const original = fsPromises[name] as (...args: unknown[]) => Promise<unknown>;
    mock.method(fsPromises, name, async (...args: unknown[]) => {
      const result = await original(...args);
      seen.push(await readFile(lock, 'utf8').catch(() => '(none)'));
      return result;
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  const release = await acquireLock('tab_watched');
  assert.ok(!seen.includes(''), `the lock was seen empty: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes(String(process.pid)), `the watch saw the lock taken: ${JSON.stringify(seen)}`);
  await release();
});
