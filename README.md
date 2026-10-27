# Herdr Review Relay

[![CI](https://img.shields.io/github/actions/workflow/status/Siregar/herdr-review-relay/ci.yml?branch=main&label=CI)](https://github.com/Siregar/herdr-review-relay/actions/workflows/ci.yml)
[![Test](https://img.shields.io/github/actions/workflow/status/Siregar/herdr-review-relay/test.yml?branch=main&label=test)](https://github.com/Siregar/herdr-review-relay/actions/workflows/test.yml)
[![Supports: Claude Code | OpenCode](https://img.shields.io/badge/supports-Claude%20Code%20%7C%20OpenCode-blue)](#setup)
[![herdr ≥ 0.9.0](https://img.shields.io/badge/herdr-%E2%89%A5%200.9.0-blue)](https://herdr.dev/docs/marketplace/)
[![Node ≥ 22.18](https://img.shields.io/badge/node-%E2%89%A5%2022.18-blue)](https://nodejs.org)
[![Platforms: macOS | Linux](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey)](herdr-plugin.toml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

![Herdr Review Relay: two QA panes on the right send their reviews back to the Engineering pane on the left](cover.jpg)

A [herdr](https://herdr.dev) plugin for one Engineering agent and any number of QA agents in one tab. One key sends Engineering's PR to every QA agent, waits for all their reviews, and hands them to Engineering in one prompt. A follow-up such as `/goal` comes after that.

Reviews are read from each agent's own records (the Claude Code transcript, `opencode session export`), never from the screen. Nothing is cut short or wrapped, however long a path is.

The relay only types into sessions that are already running. Model, effort and agent stay whatever you set in each pane.

## Flow

1. Press `prefix+a` in the tab.
2. The PR is the one `gh pr view` finds for Engineering's checkout. If gh finds none, it is the last PR link Engineering wrote in its session.
3. Each QA pane gets its review command (`reviewPrompt`). A QA pane that already reviewed in its current session gets `/clear` first.
4. The relay waits until every QA agent is done. When one stops at a question or an approval, you get a notification, and the wait goes on once you have answered; the time it waits for you does not count against the timeout, so the relay keeps the tab until you answer. For Claude Code, done needs more than herdr reporting idle. Its transcript must also show no background task still running and a closed turn, because the agent goes idle while it waits for a background task such as a CI watch or a background sub-agent. A background shell that never reports (a dev server, a watch loop) is given up once the agent has sat idle on shells alone for `backgroundGraceMinutes`; the run log names them. Background sub-agents are waited for until the timeout, since they always report.
5. Engineering gets `handoffIntro`, followed by each review in a `<review from="QA #1" agent="Claude Code">` block.
6. Once Engineering is done, it gets `followUp`. When that has finished too, you get a "ready for you" notification.

Every handoff is also kept under `$HERDR_PLUGIN_STATE_DIR/runs/`. If one QA review fails, nothing is sent to Engineering, and the reviews that did finish are in that file.

`prefix+y` copies the focused agent's last reply to the clipboard, from the same records.

## Setup

Requires Node 22.18 or later, `gh`, and herdr 0.9.0 or later. Claude Code and OpenCode are supported.

```sh
herdr integration install claude     # herdr learns each pane's session id
herdr integration install opencode   # restart running OpenCode panes afterwards
herdr plugin install Siregar/herdr-review-relay
```

The plugin has no build step and no runtime dependencies; Node runs the TypeScript sources directly. To work on a local checkout instead, use `herdr plugin link /path/to/herdr-review-relay`.

Label the panes: right-click a pane > Rename, or `herdr pane rename <pane> "QA #1"`.

- `Engineering`: optional. Without it, the pane you press the key in is Engineering.
- `QA #1`, `QA #2`, ...: one per QA agent.

Bind the actions in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "review-relay.run"

[[keys.command]]
key = "prefix+y"
type = "plugin_action"
command = "review-relay.copy"
```

## Configuration

`config.json` in `herdr plugin config-dir review-relay`. Every key is optional; these are the defaults:

```json
{
  "engineeringLabel": "Engineering",
  "qaLabelPattern": "^QA #(\\d+)$",
  "reviewPrompt": {
    "claude": "/mattpocock-skills:code-review {pr}",
    "opencode": "/code-review {pr}"
  },
  "handoffIntro": "Here is the feedback from {count} independent QA agents on PR #{pr}. Check the feedback and fix issues.",
  "followUp": "/goal green ci, no merge conflicts and mergeable",
  "reviewTimeoutMinutes": 90,
  "engineeringTimeoutMinutes": 240,
  "backgroundGraceMinutes": 30
}
```

Set `followUp` to `null` to skip it. `qaLabelPattern` needs a capture group for the QA number.

## Development

```sh
pnpm install
pnpm test        # node --test
pnpm typecheck
node src/relay.ts run --dry-run --pane <pane id>   # roles, PR and prompts, sends nothing
node src/relay.ts copy --pane <pane id> --stdout   # last reply to stdout
```

`herdr plugin log list --plugin review-relay` shows each run's output.

## License

[MIT](LICENSE)
