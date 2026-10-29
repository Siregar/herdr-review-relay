# Review Relay

A herdr plugin that has QA agents review the Engineering agent's pull request and hands their reviews back to Engineering in one prompt.

## Language

### Roles and rounds

**Engineering**:
The agent whose pull request is reviewed, and who gets the QA feedback to work in.
_Avoid_: Dev, author, main pane

**QA**:
An agent that reviews Engineering's pull request; a tab has one or more, numbered "QA #1", "QA #2", ...
_Avoid_: Reviewer, checker

**Review Command**:
The slash command a QA agent receives to start its review of the pull request, such as `/code-review 231`. In Claude Code it names a skill, in OpenCode a custom command.
_Avoid_: review skill, review prompt

**Review round**:
One start of the relay that gets that far: every QA reviews, Engineering gets the **Handoff**, then the **Follow-up**.
_Avoid_: Run, cycle

**Handoff**:
The single prompt that carries every QA review to Engineering.
_Avoid_: Bundle, summary

**Follow-up**:
The prompt Engineering gets once it has worked in the Handoff, such as `/goal`.

### Telling the user

**Refusal**:
The relay declining to start before it has typed anything into any pane, whatever the cause (no pull request, no QA panes, a busy pane, gh unreachable).
_Avoid_: Error, failure, validation error

**Failure**:
A Review round that stops after the relay has typed into a pane, so part of the round has happened.
_Avoid_: Error, crash, refusal

**Crash**:
An exception the relay cannot explain, which is a bug. It reaches the user as "Review relay crashed", as a Refusal or a Failure depending on when it happens; it is not another word for either.
_Avoid_: Failure
