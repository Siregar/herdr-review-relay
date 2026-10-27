import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentStatus } from '../src/herdr.ts';
import type { TurnState } from '../src/replies.ts';
import { waitUntilReady, type WaitDeps } from '../src/wait.ts';

const MINUTE = 60_000;
const OPTIONS = { title: 'QA #1', tag: 'PR #230', timeoutMinutes: 90, backgroundGraceMinutes: 30 };

interface Script {
  /** Status at a minute since the prompt was sent. */
  status: (minute: number) => AgentStatus;
  /** Turn state at a minute since the prompt was sent; null for an agent that records none. */
  turn?: (minute: number) => TurnState | null;
  notify?: () => Promise<void>;
}

/** Runs the wait against a fake clock; every sleep moves it on. Returns how long the wait took. */
async function wait(script: Script, options = OPTIONS) {
  let now = 0;
  const minute = () => now / MINUTE;
  const notices: string[] = [];
  const logs: string[] = [];
  const deps: WaitDeps = {
    send: async () => script.status(minute()),
    status: async () => script.status(minute()),
    turn: async () => (script.turn ? script.turn(minute()) : null),
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      // A wait that never ends would hang the suite instead of failing it.
      if (now > 24 * 60 * MINUTE) throw new Error('the wait never ended');
    },
    notify: async (title) => {
      notices.push(title);
      await script.notify?.();
    },
    log: (message) => logs.push(message),
  };
  const outcome = await waitUntilReady(deps, options).then(
    () => 'ready',
    (error: Error) => error.message,
  );
  return { outcome, minutes: minute(), notices, logs };
}

const closed = (...pendingBackground: string[]): TurnState => ({ pendingBackground, turnOpen: false });

test('wait: an idle agent with a closed turn and nothing pending is ready at once', async () => {
  const result = await wait({ status: () => 'idle', turn: () => closed() });
  assert.equal(result.outcome, 'ready');
  assert.equal(result.minutes, 0);
});

test('wait: idle with a background task running keeps waiting until it reports', async () => {
  const result = await wait({ status: () => 'idle', turn: (minute) => (minute < 12 ? closed('a1') : closed()) });
  assert.equal(result.outcome, 'ready');
  assert.ok(result.minutes >= 12 && result.minutes < 13, `ended after ${result.minutes} minutes`);
});

test('wait: a background task that never reports is given up after the grace period', async () => {
  const result = await wait({ status: () => 'idle', turn: () => closed('b_dev', 'a1') });
  assert.equal(result.outcome, 'ready');
  assert.ok(result.minutes >= 30 && result.minutes < 31, `ended after ${result.minutes} minutes`);
  assert.ok(
    result.logs.some((line) => line.includes('b_dev, a1')),
    `the abandoned tasks are logged: ${result.logs.join(' | ')}`,
  );
});

test('wait: the grace period only runs while the agent is idle with a closed turn', async () => {
  // The agent works from minute 20 to 40, so the grace period starts over at minute 40.
  const result = await wait({
    status: (minute) => (minute >= 20 && minute < 40 ? 'working' : 'idle'),
    turn: () => closed('a1'),
  });
  assert.equal(result.outcome, 'ready');
  assert.ok(result.minutes >= 70 && result.minutes < 71, `ended after ${result.minutes} minutes`);
});

test('wait: a blocked agent notifies once per stop, and the wait goes on after the answer', async () => {
  const result = await wait({
    status: (minute) => (minute < 5 || (minute >= 10 && minute < 15) ? 'blocked' : minute < 20 ? 'working' : 'idle'),
    turn: () => closed(),
  });
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.notices, ['PR #230: QA #1 needs you', 'PR #230: QA #1 needs you']);
});

test('wait: the deadline throws when the agent is still working', async () => {
  const result = await wait({ status: () => 'working' });
  assert.equal(result.outcome, 'Timed out after 90 minutes');
  assert.ok(result.minutes >= 90 && result.minutes < 91, `ended after ${result.minutes} minutes`);
});

test('wait: time spent blocked does not count against the deadline', async () => {
  const result = await wait({
    status: (minute) => (minute < 60 ? 'blocked' : minute < 120 ? 'working' : 'idle'),
    turn: () => closed(),
  });
  assert.equal(result.outcome, 'ready');
  assert.ok(result.minutes >= 120, `ended after ${result.minutes} minutes`);
});

test('wait: a failing notification does not end the wait', async () => {
  const result = await wait({
    status: (minute) => (minute < 5 ? 'blocked' : 'idle'),
    turn: () => closed(),
    notify: () => Promise.reject(new Error('herdr is gone')),
  });
  assert.equal(result.outcome, 'ready');
  assert.ok(result.logs.some((line) => line.includes('herdr is gone')));
});

test('wait: an agent that records no turns is ready when idle', async () => {
  const result = await wait({ status: (minute) => (minute < 3 ? 'working' : 'idle') });
  assert.equal(result.outcome, 'ready');
});

test('wait: an open turn without an end marker is taken as finished after two idle minutes', async () => {
  const result = await wait({ status: () => 'idle', turn: () => ({ pendingBackground: [], turnOpen: true }) });
  assert.equal(result.outcome, 'ready');
  assert.ok(result.minutes >= 2 && result.minutes < 3, `ended after ${result.minutes} minutes`);
});
