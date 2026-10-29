# Refusals open a popup pane, not a notification

A Refusal comes seconds after the user starts the relay, while they look at herdr, so it has to show there. `herdr notification show` cannot do that reliably: it always uses the user's global `[ui.toast] delivery` setting with no per-call override, and with `system` or `terminal` delivery it is best effort. It answers `ok` even when nothing was shown, and a user with `system` delivery started the relay three times without seeing why it refused. So a Refusal opens a plugin popup pane (overlay placement), which shows whatever the delivery setting, and falls back to a notification only when herdr refuses the popup (`ui_busy`, no client). Failures and "needs you" go the other way round: they arrive while the user is likely away, so they start with a notification and fall back to the popup when herdr reports `shown: false`.

## Considered Options

- **Recommend `delivery = "herdr"` in the README.** Rejected: it changes how every herdr notification is delivered, so "ready" and "needs you" would no longer reach a user who is away from herdr.
- **Notification only, with better text.** Rejected: better text does not help when the notification is never seen.

## Consequences

A popup takes all keyboard input until it closes. That is why only messages that need the user to act fall back to it. "review started", "ready" and "Copied" never open one.
