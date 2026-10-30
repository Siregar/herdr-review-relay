# Multi-harness support: Codex CLI, Gemini CLI, Antigravity CLI

Research for extending the review relay (`src/herdr.ts`, `src/replies.ts`, `src/run.ts`, `src/wait.ts`, `src/roles.ts`, `src/config.ts`) beyond Claude Code and OpenCode. Researched 2026-10-28. No code was changed.

Labels: **verified** = seen in source, docs or local command output; **unverified/inferred** = not settled by a primary source.

Versions looked at:

- herdr docs and source at tag `v0.9.5` (current stable per https://herdr.dev/llms.txt). The binary on this machine is `herdr 0.9.1`; behaviour of 0.9.1 was not separately checked.
- openai/codex at tag `rust-v0.165.0` (released 2026-10-27).
- google-gemini/gemini-cli at tag `v0.66.0` (released 2026-10-27).
- Neither `codex`, `gemini` nor `agy` is on `PATH` on this machine, so no `--help` output was available. `~/.codex/` exists with 777 rollout files (cli_version 0.98.0, 0.144.1, 0.159.2); only their structure was inspected. `~/.gemini/` holds only `settings.json` (key `mcpServers`).

## Finding that changes the question: "Gemini CLI" is two products

- **Gemini CLI** (`gemini`, github.com/google-gemini/gemini-cli) is still released (v0.66.0) but, per its own README, is now for Gemini Code Assist Standard/Enterprise and legacy paid API/Vertex keys. Free and Google AI Pro/Ultra access moved to Antigravity CLI on 2026-06-18. (verified: README banner, https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- **Antigravity CLI** (`agy`) is a **different product**, not a rename or fork. Google's post calls it "a brand-new terminal experience", "Built in Go", sharing a backend with the Antigravity 2.0 desktop app, with "no 1:1 feature parity"; Agent Skills, Hooks, Subagents and extensions (now "plugins") carry over. It reuses the `~/.gemini` directory but stores data in `~/.gemini/antigravity-cli/`. Whether it is open source is not stated by Google's post (secondary sources claim closed source; unverified). (verified: Google post; https://antigravity.google/docs/cli/gcli-migration)
- herdr treats them as two separate agents: `Agent::Gemini` (label `gemini`) and `Agent::Antigravity` (label `agy`, aliases `antigravity`, `antigravity-cli`). (verified: herdr `src/detect/mod.rs` @ v0.9.5)

So "support Gemini" means one of: `gemini` (enterprise-only, no herdr session id) or `agy` (the product most Gemini users now run, has a herdr integration). Both are covered below.

## Summary table

Verdicts: works / works with caveat / blocker.

| # | Requirement | Codex CLI | Gemini CLI (`gemini`) | Antigravity CLI (`agy`) |
|---|---|---|---|---|
| 1 | herdr detection and session id | `agent: "codex"`; `agent_session.value` = Codex session UUID via the `codex` integration (SessionStart hook). The id appears only once the first turn starts, not at launch. **Works with caveat.** | `agent: "gemini"` detected from the screen, state only ("less tested"). **No integration, no `agent_session`**, and a user hook cannot add one. **Blocker.** | `agent: "agy"`; `agent_session.value` = `conversationId` via `antigravity-cli` integration (PreInvocation hook, so after the first prompt). **Works with caveat.** |
| 2 | Session record | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`, documented in source; two on-disk modes (legacy, paginated) must both be read. Written incrementally. **Works.** | `~/.gemini/tmp/<project>/chats/session-<ts>-<id8>.jsonl`; typed records (`user`, `gemini`, tool calls); written incrementally; no turn-end marker. **Works with caveat** (only if the session id were known). | `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (path documented); **record format undocumented** by Google. No export command. **Blocker until a hands-on capture.** |
| 3 | Done detection | herdr `idle` is screen-detected. Rollout has `task_started` / `task_complete` / `turn_aborted` markers, so a turn-closed check is possible. Background terminals and sub-agents can outlive a turn. **Works with caveat.** | Screen-detected, "less tested". No end-of-turn record. `run_shell_command` has `is_background`. **Caveat, partly unverified.** | herdr docs state `agy` counts as idle at the prompt "even if background tasks, monitors, or subagents are still running". Transcript markers for background work unknown. **Blocker until transcript is captured.** |
| 4 | Prompt mechanics | `/clear` starts a new thread directly (SessionStart source `clear`); `/new` may open a worktree picker first. Custom prompts were **removed** (PR #16115); skills (`SKILL.md`) are invoked `$name` with **no argument substitution**; `/goal` exists. **Works with caveat.** | `/clear` (alias `/new`) makes a new session UUID. TOML custom commands with `{{args}}` give `/code-review 123`. SKILL.md supported but model-activated with a consent prompt. **Works** (given a session id). | `/clear` (alias `/new`) "reset active conversation contexts"; whether the conversation id changes is undocumented. Skills become `/skill-name` slash commands; argument passing undocumented. **Caveat, unverified.** |
| 5 | Other breakers | Approval dialogs shown as `blocked` only when a manifest rule matches; unknown prompts fall back to `idle`. **Caveat.** | Approval, folder-trust and skill-consent prompts; thin manifest. **Caveat.** | Permission/question/trust dialogs matched by manifest. **Caveat.** |

## Codex CLI

### 1. herdr detection and session id

- `agent` is `codex` (`agent_label`, herdr `src/detect/mod.rs`). The integration target is `codex`. Local `herdr integration status`: `codex: current (v8) (~/.codex/herdr-agent-state.sh)`. (verified)
- Installed script `~/.codex/herdr-agent-state.sh` (read locally) handles only the `session` action: on a `SessionStart` hook event it sends `pane.report_agent_session` with `source: "herdr:codex"`, `agent: "codex"`, `agent_session_id` = hook `session_id`. It requires `transcript_path` in the hook input but does not forward it. It skips the report if `CODEX_THREAD_ID` is set and differs from `session_id`. (verified)
- herdr stores only an id for Codex: `session_ref_from_report` keeps a path only for `pi` and `omp`. The pane field is `agent_session: { source: "herdr:codex", agent: "codex", kind: "id", value: <uuid> }`. (verified: herdr `src/agent_resume.rs`; https://raw.githubusercontent.com/herdrdev/herdr/v0.9.5/docs/next/website/src/content/docs/socket-api.mdx)
- Integration writes `hooks.json` and sets `[features] hooks = true` in `config.toml`; honours `CODEX_HOME`. State is **not** reported by the hook: "Codex state comes from Herdr's screen manifest detection". (verified: integrations.mdx)
- **Timing caveat, verified in source:** the `SessionStart` hook is queued as a pending source and run by `run_pending_session_start_hooks` at the start of the first turn of a thread (`codex-rs/core/src/session/turn.rs`, `codex-rs/core/src/hook_runtime.rs` @ rust-v0.165.0). A freshly launched or freshly cleared Codex pane keeps its old or empty `agent_session` until the next prompt starts a turn. The relay already reads the session id after the turn (`run.ts:review`), so reviews are fine; only the `/clear` wait loop in `run.ts:clearContext` (which waits for a changed id for Claude) cannot work as is. This is the same situation as OpenCode there.
- Session id to file: `SessionMeta.session_id` "is equal to the root thread's ID" and rollout file names embed the thread id (below). Sub-agent threads have their own files with `parent_thread_id`. (verified: `codex-rs/protocol/src/protocol.rs`)

### 2. Session record

- Location: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-uuid>.jsonl`; the parser also accepts `rollout-<ts>-<thread>_<rollout>.jsonl` for reverted threads and a `.zst` suffix for compressed rollouts. (verified: `codex-rs/rollout/src/rollout_file_name.rs`, `compression.rs`; local file `~/.codex/sessions/2026/10/13/rollout-2026-10-13T07-51-58-<uuid>.jsonl` matches). No `.zst` files exist locally; when the writer compresses rollouts was not determined (unverified), so a reader should tolerate it.
- Line shape: `{timestamp, ordinal, type, payload}` (local `jq 'keys'`; `ordinal` absent in older files). `type` values seen locally: `session_meta`, `turn_context`, `response_item`, `event_msg`, `world_state`. Source adds `compacted`, `inter_agent_communication` etc. (verified: `codex-rs/rollout/src/policy.rs`)
- `session_meta.payload` keys (local): `id`, `session_id`, `cwd`, `cli_version`, `history_mode`, `source`, `originator`, `model_provider`, `base_instructions`, `timestamp`, ... (verified)
- **Two history modes** (`session_meta.payload.history_mode`: `legacy` default, `paginated`; local: 0.144.1 `legacy`, 0.159.2 `paginated`, 0.98.0 field absent). In `policy.rs`:
  - Always persisted: `response_item` (all `ResponseItem` kinds incl. `message`, `function_call`, `function_call_output`, `reasoning`), `turn_context`, `session_meta`, and `event_msg` of type `task_started`, `task_complete`, `turn_aborted`, `token_count`.
  - Legacy only: `event_msg` `user_message`, `agent_message`, `agent_reasoning`, ...
  - Paginated only: `event_msg` `item_completed` carrying a `TurnItem` (local: `payload.item.type == "UserMessage"`, keys `thread_id, turn_id, item, started_at_ms, completed_at_ms`).
  - Transient, never persisted: `exec_approval_request`, `request_user_input`, `exec_command_begin/end`, `error`, `warning`, hook events. (verified)
- Fields for the relay:
  - **User prompt:** `event_msg/user_message` (legacy; local keys `message, images, local_images, text_elements`) or `event_msg/item_completed` with `item.type == "UserMessage"` (paginated). `response_item/message` with `role: "user"` also holds injected context (AGENTS.md, environment), so it is not a safe prompt marker. (verified locally and in source)
  - **Assistant text:** `response_item` with `payload.type == "message"`, `payload.role == "assistant"`, `content[].type == "output_text"`, optional `phase` of `commentary` | `partial_answer` | `final_answer`. (verified: `codex-rs/protocol/src/models.rs`; **no assistant message exists in the local sample**, so this is from source only)
  - **Tool calls:** `response_item` of `function_call` / `local_shell_call` / `custom_tool_call` and their `*_output`. (verified: policy.rs)
  - **Turn end:** `event_msg/task_complete` (keys `turn_id, completed_at, duration_ms, last_agent_message, error`); `event_msg/task_started` opens; `event_msg/turn_aborted` on interrupt. `last_agent_message` is the turn's final assistant text. (verified: source and local key listing)
- Incremental: items are appended as they happen (the recorder appends live; `persisted_rollout_items` is "for a live append"). (verified)
- No CLI export. There is a TUI `/export` ("export the conversation as markdown") and an `app-server` crate; neither was evaluated. (`/export` verified in `slash_command.rs`; app-server unverified for this use.)

### 3. Done detection

- herdr state for Codex is screen-detected from a manifest (herdr `src/detect/manifests/codex.toml`, version 2026.10.11.1): `working` from the OSC title spinner or a `(Ns • esc to interrupt)` status line, `blocked` from "Action Required" in the OSC title and several dialog strings, `idle` from OSC title otherwise. Codex is **not** in herdr's list of "full lifecycle hook authority" integrations (that list is pi, omp, mastracode, opencode, kilo, kimi). (verified)
- herdr's docs name only Antigravity and Grok as agents that "count as idle once they return to their prompt, even if background tasks, monitors, or subagents are still running"; Codex is not named. (verified: agents.mdx)
- Codex itself has work that outlives a turn: `/ps` "list background terminals" and `/stop` "stop all background terminals" (verified: `slash_command.rs`); `InterAgentCommunication` has a `trigger_turn: bool` so a sub-agent message can start a new parent turn (verified field: `protocol.rs`). Whether a finished background terminal wakes an idle agent was not established (unverified/inferred).
- Consequence: herdr `idle` alone should not be trusted. The rollout allows the same style of check the relay does for Claude: the latest `task_started` has no later `task_complete`/`turn_aborted` means a turn is open. Detecting "background terminal still running" from the rollout was not established (unverified).
- `/goal` exists in Codex (`SlashCommand::Goal`), so the relay's `followUp` default works there; how `/goal` continuation looks to herdr between turns is untested (open question).

### 4. Prompt mechanics

- New session: `/clear` ("clear the terminal and start a new chat") dispatches `AppEvent::ClearUi` → `start_fresh_session(... ThreadStartSource::Clear)`, and the next SessionStart hook reports source `clear`. `/new` ("start a new chat during a conversation") calls `show_session_checkout_picker`, which sends `NewSession` directly only when `managed_worktree_available()` is false, otherwise opens a "Where should the new conversation run?" popup. So `/clear` is the equivalent for the relay; `/new` can stall on a popup. (verified: `codex-rs/tui/src/slash_command.rs`, `chatwidget/slash_dispatch.rs`, `chatwidget/worktree_picker.rs`, `app/event_dispatch.rs`)
- The session id changes (new thread), but herdr learns it only at the next turn start (see 1).
- User-defined prompts: **custom prompts (`~/.codex/prompts/*.md`) were removed** by PR #16115 "Remove remaining custom prompt support" (merged 2026-03-28); an OpenAI maintainer in issue #14459 says they were deprecated in favour of skills and that there are "no plans to add positional argument substitution to skills". There is no `{pr}`-style substitution; the reviewing agent must read the PR number from natural language. (verified: https://github.com/openai/codex/pull/16115, https://github.com/openai/codex/issues/14459)
- A newer `/presets` ("run or save reusable prompts and slash commands", config key `[tui.presets.<n>]` with `input`, `label`) exists; it is a numbered TUI quick-dial, not obviously scriptable by text. (verified: `slash_command.rs`, `tui/src/app/quick_dials.rs`; behaviour with `herdr agent prompt` untested)
- Skills: `SKILL.md` directories with `name` and `description` frontmatter, searched in `$CWD/.agents/skills` up to the repo root, `~/.agents/skills`, `/etc/codex/skills`, bundled; invoked explicitly with `$skill-name` or `/skills`, or implicitly by description. Agent Skills / SKILL.md: **yes**. (verified: https://learn.chatgpt.com/docs/build-skills, which redirects from developers.openai.com/codex/skills)
- So a Codex `reviewPrompt` default cannot be `/code-review {pr}`. Candidates: plain English ("Review PR #{pr} ...") or `$code-review {pr}`. Whether typing `$name` followed by Enter through `herdr agent prompt` submits, rather than selecting an item in the `$` popup, is untested (open question). `/review` is a built-in ("review my current changes") that opens a preset popup, so it is not a drop-in.

### 5. Other breakers

- Approvals/questions: transient events are not in the rollout, so `blocked` can only come from herdr's screen rules (`allow command?`, `press enter to confirm or esc to cancel`, "Action Required" OSC title, trust-directory, update prompt). herdr: "If no manifest rule matches for a known agent, Herdr falls back to idle", so an unusual prompt can read as `idle`. (verified: agents.mdx "Blocked state", manifest)
- Trust-directory and "Update available" screens block at start (manifest rules exist). (verified)
- `herdr agent prompt` returns `agent_blocked` without sending if the pane is already `blocked`. (verified: cli-reference.mdx)
- `[features] hooks = true` must be set (installer does it; local `~/.codex/config.toml` has a `[features]` table with `hooks`). (verified)

## Gemini CLI (`gemini`)

### 1. herdr detection and session id

- herdr docs table: "Gemini CLI | none | state only, less tested". No integration target exists (`herdr integration status` lists none). Pane `agent` string is `gemini`. (verified: agents.mdx; local `herdr integration status`; `src/detect/mod.rs`)
- Manifest `gemini.toml` (version 2026.06.10.1, 25 lines) has two rules: `blocked` on "│ Apply this change" / "│ Allow execution" / "Do you want to proceed" style dialogs, and `working` on "esc to cancel". (verified)
- **No `agent_session` can be produced for `gemini`.** `is_official_agent_source` is a closed list of `(source, agent)` pairs with no gemini entry, and `session_ref_from_report` returns nothing for other sources. The "Add Herdr support to your agent" path (custom `--source`, `--agent`) changes the displayed agent name and holds the pane, but session-reference storage is gated on the official list. (verified: `src/agent_resume.rs`; whether a custom source's `--agent-session-id` surfaces in `agent_session` is **unverified**, and a custom `--agent` would replace the `gemini` pane value anyway.)
- Gemini CLI's own hooks do expose `session_id` and `transcript_path` in the base input schema, plus `SessionStart` with a source. (verified: docs/hooks/reference.md @ v0.66.0). They could feed a mapping outside herdr (for example the plugin installing its own hook that writes `HERDR_PANE_ID` → session id), but that is new design, not a herdr feature.

### 2. Session record

- Location: `~/.gemini/tmp/<project>/chats/`. The docs say `<project_hash>`; the code (`Storage.getProjectTempDir()` → `getProjectIdentifier()`, with a "migration of legacy hash-based directories to the new slug-based format") uses a slug. **Docs and source disagree**; trust source. (verified: docs/cli/session-management.md vs `packages/core/src/config/storage.ts`)
- File name: `session-<YYYY-MM-DDTHH-MM>-<first 8 chars of sessionId>.jsonl` (collision index inserted when needed); sub-agent sessions are `<sessionId>.jsonl` under `chats/<parentSessionId>/`. Legacy `.json` is normalised to `.jsonl`. The full id is in the file's metadata record, so lookup needs a glob on the 8-char suffix plus a check of the header. (verified: `chatRecordingService.ts`)
- Records (JSONL, one per line, `chatRecordingTypes.ts`): a metadata record `{sessionId, projectHash, startTime, lastUpdated, kind}`; message records `{id, timestamp, type, content}` with `type` of `user` | `info` | `error` | `warning` | `gemini`; `gemini` records add `toolCalls[] {id, name, args, result, status, timestamp}`, `thoughts[]`, `tokens`, `model`; edit records `{$patch}`, `{$set}`, `{$rewindTo}`. A reader must apply `$patch`/`$rewindTo` to get the current state. (verified)
- Incremental: each message is recorded as it occurs; the service also rewrites the file via a temp file (`.tmp-<pid>`) on some updates. (verified)
- **No end-of-turn marker** in the record. The final reply is the last `gemini` message with no pending tool call, but where a turn ends is inferred (unverified).
- No export command found; `--list-sessions`, `--resume <index|uuid>` exist. Headless mode (`gemini -p`) is a separate process (not run here).

### 3. Done detection

- State is screen-detected (two-rule manifest, "less tested"). `idle` is the fallback when no rule matches. (verified)
- Background work exists: `run_shell_command` has `is_background` ("move the process to the background immediately"), and sub-agents record their own sessions. Whether a finished background shell wakes an idle agent, and how the record shows it, was not established (unverified).

### 4. Prompt mechanics

- `/clear` (alt name `/new`): "Clear the screen and start a new session". It fires `SessionEnd(clear)`, generates `newSessionId = randomUUID()`, calls `config.resetNewSessionState(newSessionId)`, `geminiClient.resetChat()`, then fires `SessionStart(clear)`. So the session id changes. (verified: `packages/cli/src/ui/commands/clearCommand.ts` @ v0.66.0) Without a herdr-reported id the relay cannot observe it.
- Custom commands: TOML files in `~/.gemini/commands/` or `<project>/.gemini/commands/`; `prompt` required, `description` optional; `{{args}}` is replaced by the text after the command; subdirectories namespace as `/git:commit`; `/commands reload`. This gives `/code-review {pr}` semantics directly. (verified: docs/cli/custom-commands.md)
- Skills: `SKILL.md` supported (`~/.gemini/skills/`, `~/.agents/skills/`, workspace equivalents); the model calls `activate_skill` and the user sees a confirmation prompt, so a skill-based review prompt would sit at a consent dialog. Not directly slash-invoked. (verified: docs/cli/skills.md)

### 5. Other breakers

- Tool approvals ("Allow execution", "Apply this change"), folder trust, and skill-activation consent block a turn until answered; only the first two are in herdr's gemini manifest. (verified: manifest; docs)
- Product status: enterprise-only and no longer tuned for current Gemini models per its README; the same README points consumers to `agy`. (verified)

## Antigravity CLI (`agy`)

### 1. herdr detection and session id

- Integration target `antigravity-cli` (**not** `agy`; the pane `agent` is `agy`). Hook path `~/.gemini/config/hooks/herdr-agent-state.sh` (not installed here). `ANTIGRAVITY_CLI_CONFIG_DIR` overrides `~/.gemini/config/`. (verified: integrations.mdx; local status)
- Script (herdr `src/integration/assets/antigravity_cli/herdr-agent-state.sh`, version 4): reads stdin JSON, takes `conversationId`, and sends `pane.report_agent_session` with `source: "herdr:antigravity_cli"`, `agent: "agy"`, `agent_session_id: conversationId`, and `agent_session_path: transcriptPath` if present. herdr discards the path for non-pi/omp agents, so the pane carries only the id. (verified)
- Session-only: "reports the pane's current conversation, but not agent state"; the hook runs on `PreInvocation`, so herdr learns the id once the first prompt is sent. (verified: integrations.mdx; `session_identity_only_integration` in `detect/mod.rs`)

### 2. Session record

- Path (official hooks page): `transcriptPath` is "the absolute path to the persistent `transcript.jsonl`"; on the CLI `<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` with `<app_data_dir>` = `~/.gemini/antigravity-cli`. (verified: https://antigravity.google/docs/hooks?tab=cli)
- **Format is not documented by Google.** Secondary sources (unverified) mention record fields `source`, `status`, `type` (for example `PLANNER_RESPONSE`), `step_index`, `CHECKPOINT`, `INVOKE_SUBAGENT`, and a richer `transcript_full.jsonl` beside it. Conversation metadata is said to live in a separate SQLite file. Needs a hands-on capture.
- No export command in the CLI reference. Headless mode (`agy -p`, `--output-format json|stream-json`) prints `conversation_id`, `status`, `response` for that run, but that is a new process, not a read of the interactive pane. (verified: https://antigravity.google/docs/cli/headless/, https://antigravity.google/docs/cli/reference)

### 3. Done detection

- herdr docs: Antigravity (and Grok) "count as idle once they return to their prompt, even if background tasks, monitors, or subagents are still running. `agent wait` and `agent prompt --wait` observe the agent's state, not completion of those jobs." The manifest comment says the same ("Background tasks and subagents show '· N task(s)' in the footer ... they do not count as working"). (verified)
- agy's own `Stop` hook input has `executionNum`, `terminationReason`, `error`, `fullyIdle`; so the product itself distinguishes "stopped" from "fully idle", but that is a hook payload, and no known file records it. (verified: hooks page; location in transcript unverified)

### 4. Prompt mechanics

- Slash commands (official reference): `/clear` (alias `/new`) "Clear the terminal and reset active conversation contexts"; `/resume` (aliases `/switch`, `/conversation`) opens the picker; `/fork`, `/rewind`, `/rename`; `--conversation <id>`, `-c/--continue`. Whether `/clear` allocates a new `conversationId`, and when herdr hears it (PreInvocation), is not documented. (verified: https://antigravity.google/docs/cli/reference)
- Skills: folder with `SKILL.md` (`name` optional, `description` required); per the skills page "automatically converts it into a slash command" (`deploy-staging` → `/deploy-staging`); dirs `.agents/skills/` (workspace), `~/.gemini/antigravity-cli/skills/` (global). Agent Skills open standard: yes. Whether slash commands take arguments is not stated; built-ins such as `/btw <text>` do. Gemini TOML commands are converted to skills by `agy plugin import gemini`. (verified: https://antigravity.google/docs/skills/, migration page)
- `/goal` is listed among agy slash commands. (verified: getting-started page)

### 5. Other breakers

- Permission, question and trust dialogs are matched by manifest rules (`permission_prompt` etc., version 2026.10.05.1). Hook config location sources disagree: official docs say global `~/.gemini/config/hooks.json`, a Medium guide says `~/.gemini/antigravity-cli/hooks.json`; herdr uses the former. (verified: docs; herdr docs)
- Docs are partial (several URLs 404 or redirect); a hands-on install is needed to settle format questions.

## Is herdr's integration mechanism uniform?

Mostly yes, with five exceptions the plugin must handle.

Uniform (verified: socket-api.mdx, `src/api/schema/panes.rs`, `src/agent_resume.rs`, `src/detect/mod.rs` @ v0.9.5):

- Every integration reports through the same two socket methods, `pane.report_agent` (state, optionally session) and `pane.report_agent_session` (session only). Every pane read (`pane.get/list`, `agent.get/list`) exposes the same optional field `agent_session: { source, agent, kind, value }`; for all agents the plugin could target, `kind` is `"id"`. `kind: "path"` exists only for `pi` and `omp`. The shape the relay already consumes (`Pane.agent_session.value`) is therefore the same for Codex and `agy`.
- `Pane.agent` is the detected label: `claude`, `codex`, `gemini`, `agy`, `opencode`, ... The same value appears in `agent_session.agent`.

Not uniform:

1. **Coverage.** Some detected agents have no integration at all (`gemini`, `amp`, `kiro`, `cline`, `maki`: "none, state only"), so no `agent_session`. Official session sources are a closed list; a user cannot add one.
2. **Names differ.** For `agy` the pane `agent` is `agy` but the integration target (and key in `herdr integration status`) is `antigravity-cli`. The relay's `checkIntegrations` looks up `statuses[kind]` and its `AgentKind` doubles as pane value and target, so it needs a separate target name. For `codex` all three coincide.
3. **State authority.** Only pi, omp, mastracode, opencode, kilo and kimi report state; Claude, Codex, `agy` and the rest are screen-detected, so `idle` is a heuristic for them. The relay's per-harness turn check (`readTurnState`, currently Claude only) is what makes idle trustworthy.
4. **When the id arrives.** Claude: at session start (and `/clear`); Codex: first turn after start/clear; `agy`: first prompt (PreInvocation). The `/clear` wait in `run.ts:clearContext` assumes the Claude behaviour.
5. **What the id means and how it maps to a record.** Claude: file name; OpenCode: CLI export; Codex: thread UUID inside a dated path; `agy`: directory name; Gemini: 8-char file suffix plus header.

Conclusion: a new harness needs a session-record reader (id to record, last reply, turn state), but also a default `reviewPrompt`, a clear strategy, an integration-target name, and a trust decision for `idle`. The "only a reader" framing holds for harnesses that report like Claude Code or OpenCode, not for these.

## Open questions

Needs a human decision:

1. Scope for Google: `agy` (has a herdr session id, undocumented transcript), `gemini` (documented record, no herdr session id; enterprise-only), or both. Supporting `gemini` needs either an upstream herdr integration or a plugin-owned mapping (own hook, or cwd + newest-file heuristics, which break with two panes in one directory).
2. Whether `reviewPrompt` for Codex should be a plain-English prompt or a `$skill` the user installs, since custom prompts and argument substitution are gone.
3. Minimum herdr version to require (docs checked at 0.9.5, local binary is 0.9.1; Codex integration v8 is installed here).

Needs a hands-on test:

1. Codex: assistant-message records in a paginated rollout (none in the local sample); `phase` values in practice; `task_complete` on tool-heavy turns; whether `.zst` compression ever touches a live or just-finished rollout.
2. Codex: does `herdr agent prompt` with `$name`, `/clear` and `/goal` submit as intended (popups can intercept Enter)?
3. Codex: does a finished background terminal wake an idle agent, and what does the rollout show while one runs?
4. Codex: how a `/goal` run looks to herdr between continuation turns.
5. `agy`: capture a real `transcript.jsonl` (and whether `transcript_full.jsonl` exists): prompt/response/tool step types, end-of-turn and background-task markers. Also whether `/clear` changes `conversationId`, and when herdr updates it.
6. `agy`: slash-invoked skill with arguments (for `/code-review 123`).
7. Gemini: how a turn end and a running `is_background` shell appear in the chat record; actual directory name (slug vs hash) on a real install.
8. herdr 0.9.1 versus 0.9.5 differences in session reporting for Codex and `agy`.

## Sources

herdr (tag v0.9.5, https://github.com/herdrdev/herdr):

- https://herdr.dev/llms.txt (stable index; links below are its raw `docs/next/website/src/content/docs/*.mdx` files at v0.9.5): `integrations.mdx`, `agents.mdx`, `add-herdr-support.mdx`, `socket-api.mdx`, `cli-reference.mdx`
- `src/detect/mod.rs`, `src/detect/manifests/{codex,gemini,antigravity}.toml`, `src/agent_resume.rs`, `src/api/schema/panes.rs`, `src/integration/assets/antigravity_cli/herdr-agent-state.sh`
- Local: `herdr --version`, `herdr integration status`, `~/.codex/herdr-agent-state.sh`, `~/.codex/hooks.json`

OpenAI Codex (tag rust-v0.165.0, https://github.com/openai/codex):

- `codex-rs/protocol/src/protocol.rs`, `codex-rs/protocol/src/models.rs`
- `codex-rs/rollout/src/{policy,rollout_file_name,compression}.rs`
- `codex-rs/tui/src/slash_command.rs`, `chatwidget/slash_dispatch.rs`, `chatwidget/worktree_picker.rs`, `app/event_dispatch.rs`, `app/quick_dials.rs`
- `codex-rs/core/src/session/turn.rs`, `core/src/hook_runtime.rs`, `core/src/session/session.rs`
- `codex-rs/hooks/schema/generated/{session-start,stop}.command.input.schema.json`
- https://github.com/openai/codex/pull/16115, https://github.com/openai/codex/issues/14459
- https://learn.chatgpt.com/docs/build-skills, https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Local: structure only (`jq 'keys'`, type counts) of `~/.codex/sessions/**/*.jsonl`

Google Gemini CLI (tag v0.66.0, https://github.com/google-gemini/gemini-cli):

- README.md (status banner); `docs/cli/session-management.md`, `docs/cli/custom-commands.md`, `docs/cli/skills.md`, `docs/tools/shell.md`, `docs/hooks/reference.md`
- `packages/core/src/services/chatRecordingService.ts`, `chatRecordingTypes.ts`, `packages/core/src/config/storage.ts`, `packages/cli/src/ui/commands/clearCommand.ts`

Google Antigravity CLI:

- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- https://antigravity.google/docs/cli/gcli-migration, https://antigravity.google/docs/cli/reference, https://antigravity.google/docs/cli/headless/, https://antigravity.google/docs/cli/conversations/, https://antigravity.google/docs/hooks?tab=cli, https://antigravity.google/docs/skills/, https://antigravity.google/docs/slash-commands/, https://antigravity.google/docs/getting-started?tab=cli
- Secondary, used only to mark unverified transcript fields: https://www.codeagentswarm.com/en/guides/antigravity-cli-conversation-history and similar search results
