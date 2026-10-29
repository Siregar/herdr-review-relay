import { POPUP_MESSAGE_ENV, renderPopup, type Message } from './tell.ts';

// The `message` popup: shows what the relay told it in REVIEW_RELAY_MESSAGE until Enter or Esc.
// herdr closes the popup when this process exits.
const ENTER = ['\r', '\n'];
const ESC = '\x1b';
const CTRL_C = '\x03';

const message = JSON.parse(process.env[POPUP_MESSAGE_ENV] ?? 'null') as Message | null;
process.stdout.write(renderPopup(message ?? { title: 'Review relay', nextStep: 'No message to show.' }));

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (keys: string) => {
  // An arrow key starts with Esc too; only Esc on its own closes.
  if (keys === ESC || keys === CTRL_C || ENTER.some((enter) => keys.includes(enter))) process.exit(0);
});
process.stdin.on('end', () => process.exit(0));
