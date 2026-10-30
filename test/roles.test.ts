import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pane } from '../src/herdr.ts';
import { resolveRoles } from '../src/roles.ts';

const LABELS = { engineering: 'Engineering', qaPattern: '^QA #(\\d+)$' };

function pane(id: string, label: string | null, agent: string | null = 'claude', tab = 't1'): Pane {
  return { pane_id: id, tab_id: tab, label, agent, cwd: '/repo' };
}

test('the invoking pane is Engineering when no pane carries the label', () => {
  const roles = resolveRoles([pane('p1', null), pane('p2', 'QA #1', 'opencode')], 'p1', LABELS);
  assert.equal(roles.engineering.pane.pane_id, 'p1');
  assert.deepEqual(
    roles.qa.map((role) => [role.title, role.kind]),
    [['QA #1', 'opencode']],
  );
});

test('a pane labelled Engineering wins, wherever the key was pressed', () => {
  const panes = [pane('p1', 'Engineering'), pane('p2', null), pane('p3', 'QA #1')];
  assert.equal(resolveRoles(panes, 'p2', LABELS).engineering.pane.pane_id, 'p1');
});

test('QA panes are ordered by their number, not their position', () => {
  const panes = [pane('p1', null), pane('p2', 'QA #10'), pane('p3', 'QA #2'), pane('p4', 'QA #1')];
  assert.deepEqual(
    resolveRoles(panes, 'p1', LABELS).qa.map((role) => role.title),
    ['QA #1', 'QA #2', 'QA #10'],
  );
});

test('panes in other tabs are never roles', () => {
  const panes = [pane('p1', null), pane('p2', 'QA #1'), pane('x1', 'QA #2', 'claude', 't2'), pane('x2', 'Engineering', 'claude', 't2')];
  const roles = resolveRoles(panes, 'p1', LABELS);
  assert.equal(roles.engineering.pane.pane_id, 'p1');
  assert.deepEqual(roles.qa.map((role) => role.pane.pane_id), ['p2']);
});

test('starting the relay in a QA pane without an Engineering label is refused', () => {
  assert.throws(() => resolveRoles([pane('p1', null), pane('p2', 'QA #1')], 'p2', LABELS), { title: 'This is a QA pane' });
});

test('a tab without QA panes is refused, with the exact labels it needs and the ones it has', () => {
  const panes = [pane('p1', 'Engineering'), pane('p2', 'QA1'), pane('p3', null), pane('x1', 'QA #1', 'claude', 't2')];
  assert.throws(() => resolveRoles(panes, 'p1', LABELS), {
    title: 'No QA panes in this tab',
    nextStep: 'Rename each QA pane to exactly "QA #1", "QA #2", … (right-click > Rename).',
    details: 'Labels in this tab: "Engineering", "QA1", (no label). A QA label must match ^QA #(\\d+)$.',
  });
});

test('two panes with the same QA number are refused', () => {
  assert.throws(() => resolveRoles([pane('p1', null), pane('p2', 'QA #1'), pane('p3', 'QA #1')], 'p1', LABELS), {
    title: 'Two panes are labelled "QA #1"',
    nextStep: 'Rename one of the two "QA #1" panes.',
  });
});

test('two panes labelled Engineering are refused', () => {
  assert.throws(() => resolveRoles([pane('p1', 'Engineering'), pane('p2', 'Engineering'), pane('p3', 'QA #1')], 'p1', LABELS), {
    title: 'Two panes are labelled "Engineering"',
  });
});

test('a QA pane without a supported agent is refused', () => {
  assert.throws(() => resolveRoles([pane('p1', null), pane('p2', 'QA #1', 'codex')], 'p1', LABELS), { title: 'QA #1 runs codex' });
  assert.throws(() => resolveRoles([pane('p1', null), pane('p2', 'QA #1', null)], 'p1', LABELS), {
    title: 'QA #1 runs no agent',
    nextStep: 'Start Claude Code or OpenCode in it.',
  });
});
