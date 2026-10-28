import assert from 'node:assert/strict';
import { test } from 'node:test';

// herdr.ts reads the binary path once, on import: point it at one that does not exist.
process.env.HERDR_BIN_PATH = '/nonexistent/herdr';
const { bestEffortNotify } = await import('../src/herdr.ts');

test('a notification that fails is logged, not thrown', async () => {
  const logs: string[] = [];
  await bestEffortNotify((message) => logs.push(message))('PR #230: QA #1 needs you', 'body', 'request');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^notification failed: /);
});
