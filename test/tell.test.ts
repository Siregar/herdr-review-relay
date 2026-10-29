import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HerdrError, type Notified } from '../src/herdr.ts';
import { RelayError } from '../src/roles.ts';
import { closesPopup, inform, messageOf, renderPopup, tell, type Message, type TellDeps } from '../src/tell.ts';

const MESSAGE: Message = {
  title: 'No PR for feat/login',
  nextStep: 'Have Engineering open the PR, then run the review relay again.',
  details: 'gh knows no PR for the branch in /work/repo.',
};

interface Herdr {
  /** herdr's answer to a notification; an Error is a notification herdr failed outright. */
  notification?: Notified | Error;
  /** An Error is a popup herdr refused. */
  popup?: Error;
}

/** Fake herdr deps that record what reached each channel. */
function fakeHerdr(herdr: Herdr) {
  const notifications: string[] = [];
  const popups: string[] = [];
  const logs: string[] = [];
  const deps: TellDeps = {
    notify: async (title) => {
      notifications.push(title);
      const answer = herdr.notification ?? { shown: true, reason: 'shown' };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    popup: async (shown) => {
      popups.push(shown.title);
      if (herdr.popup) throw herdr.popup;
    },
    log: (line) => logs.push(line),
  };
  return { deps, notifications, popups, logs };
}

async function told(kind: Parameters<typeof tell>[1], herdr: Herdr = {}, message = MESSAGE) {
  const fake = fakeHerdr(herdr);
  return { channel: await tell(fake.deps, kind, message), ...fake };
}

test('tell: a Refusal opens the popup and sends no notification', async () => {
  const result = await told('refusal');
  assert.equal(result.channel, 'popup');
  assert.deepEqual(result.popups, ['No PR for feat/login']);
  assert.deepEqual(result.notifications, []);
});

test('tell: a Refusal falls back to a notification when herdr refuses the popup', async () => {
  const result = await told('refusal', { popup: new Error('ui_busy') });
  assert.equal(result.channel, 'notification');
  assert.deepEqual(result.notifications, ['No PR for feat/login']);
  assert.ok(result.logs.some((line) => line.includes('ui_busy')), `the refused popup is logged: ${result.logs.join(' | ')}`);
});

test('tell: a Refusal neither popup nor notification showed is left in the log, with the reason', async () => {
  const result = await told('refusal', { popup: new Error('ui_busy'), notification: { shown: false, reason: 'rate_limited' } });
  assert.equal(result.channel, 'log');
  assert.ok(result.logs.some((line) => line.includes('rate_limited')), `the reason is logged: ${result.logs.join(' | ')}`);
});

test('tell: a Failure goes to a notification and opens no popup when herdr shows it', async () => {
  const result = await told('failure');
  assert.equal(result.channel, 'notification');
  assert.deepEqual(result.popups, []);
});

for (const kind of ['failure', 'needsYou'] as const) {
  test(`tell: ${kind} falls back to the popup when herdr answers shown: false, and logs the reason`, async () => {
    const result = await told(kind, { notification: { shown: false, reason: 'no_foreground_client' } });
    assert.equal(result.channel, 'popup');
    assert.deepEqual(result.notifications, ['No PR for feat/login']);
    assert.ok(result.logs.some((line) => line.includes('no_foreground_client')), `the reason is logged: ${result.logs.join(' | ')}`);
  });
}

test('tell: a Failure falls back to the popup when the notification fails outright', async () => {
  const result = await told('failure', { notification: new Error('notifications are down') });
  assert.equal(result.channel, 'popup');
});

test('tell: a Failure that reaches neither channel is left in the log', async () => {
  const result = await told('failure', { notification: { shown: false, reason: 'disabled' }, popup: new Error('no client') });
  assert.equal(result.channel, 'log');
  assert.ok(result.logs.some((line) => line.includes(MESSAGE.details!)), `the details are logged: ${result.logs.join(' | ')}`);
});

test('inform: "review started" that herdr does not show is logged, and opens no popup', async () => {
  const fake = fakeHerdr({ notification: { shown: false, reason: 'busy' } });
  await inform(fake.deps, 'PR #231: review started', 'QA #1, QA #2', 'none');
  assert.deepEqual(fake.notifications, ['PR #231: review started']);
  assert.deepEqual(fake.popups, []);
  assert.ok(fake.logs.some((line) => line.includes('PR #231: review started') && line.includes('busy')), fake.logs.join(' | '));
});

test('inform: a notification that fails outright is logged, not thrown', async () => {
  const fake = fakeHerdr({ notification: new Error('notifications are down') });
  await inform(fake.deps, 'PR #231 is ready for you', 'QA feedback is worked in.', 'done');
  assert.deepEqual(fake.popups, []);
  assert.ok(fake.logs.some((line) => line.includes('notifications are down')), fake.logs.join(' | '));
});

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

test('popup: the cause as heading, the next step, a separate Details block, and how to close', () => {
  assert.equal(
    renderPopup(MESSAGE),
    [
      `${BOLD}No PR for feat/login${RESET}`,
      '',
      'Have Engineering open the PR, then run the review relay again.',
      '',
      `${BOLD}Details${RESET}`,
      'gh knows no PR for the branch in /work/repo.',
      '',
      `${DIM}Enter or Esc to close${RESET}`,
      '',
    ].join('\n'),
  );
});

test('popup: a message without details has no Details block', () => {
  const text = renderPopup({ title: 'No QA panes in this tab', nextStep: 'Label each QA pane.' });
  assert.doesNotMatch(text, /Details/);
  assert.match(text, /Label each QA pane\.\n\n.*Enter or Esc to close/);
});

test('messageOf: a RelayError keeps its title, next step and details', () => {
  const error = new RelayError(MESSAGE.title, MESSAGE.nextStep, MESSAGE.details);
  assert.deepEqual(messageOf(error), MESSAGE);
});

test('messageOf: an unexpected exception is a crash, with the stack under Details', () => {
  const error = new TypeError("Cannot read properties of undefined (reading 'pane_id')");
  const message = messageOf(error);
  assert.equal(message.title, 'Review relay crashed');
  assert.equal(message.nextStep, 'This is a bug. The stack trace is in `herdr plugin log list --plugin review-relay`.');
  assert.match(message.details ?? '', /TypeError: Cannot read properties of undefined[\s\S]*\n\s+at /);
});

test('messageOf: a herdr error names herdr and keeps its code under Details', () => {
  const message = messageOf(new HerdrError('pane_not_found', 'pane w1:p9 not found'));
  assert.equal(message.title, 'herdr: pane w1:p9 not found');
  assert.match(message.details ?? '', /pane_not_found/);
});

test('no message names a key: keybindings are the user\'s own', async () => {
  const src = join(import.meta.dirname, '..', 'src');
  for (const file of await readdir(src)) {
    const code = (await readFile(join(src, file), 'utf8'))
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)) // Comments may say how a keybinding starts the relay.
      .join('\n');
    assert.doesNotMatch(code, /prefix\+|\bpress(es)? (the |a )?key|\bctrl\+/i, `${file} names a key`);
  }
});

test('popup: Enter, Esc and Ctrl-C close it; an arrow key, which starts with Esc too, does not', () => {
  for (const keys of ['\r', '\n', '\x1b', '\x03']) assert.equal(closesPopup(keys), true, JSON.stringify(keys));
  for (const keys of ['\x1b[A', 'q', ' ']) assert.equal(closesPopup(keys), false, JSON.stringify(keys));
});
