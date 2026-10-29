import { closesPopup, POPUP_MESSAGE_ENV, renderPopup, type Message } from './tell.ts';

// The `message` popup: shows what the relay told it in REVIEW_RELAY_MESSAGE until Enter or Esc.
// herdr closes the popup when this process exits. The popup takes all input, so Ctrl-C closes it too.

const message = JSON.parse(process.env[POPUP_MESSAGE_ENV] ?? 'null') as Message | null;
process.stdout.write(renderPopup(message ?? { title: 'Review relay', nextStep: 'No message to show.' }));

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (keys: string) => {
  if (closesPopup(keys)) process.exit(0);
});
process.stdin.on('end', () => process.exit(0));
