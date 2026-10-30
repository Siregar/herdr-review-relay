import type { AgentKind, Pane } from './herdr.ts';

/** A stop the relay explains: what caused it, and the one thing the user does next. */
export class RelayError extends Error {
  readonly title: string;
  readonly nextStep: string;
  /** Long paths, pane ids, raw gh output. */
  readonly details?: string;

  constructor(title: string, nextStep: string, details?: string) {
    super([title, nextStep, details].filter(Boolean).join('\n'));
    this.title = title;
    this.nextStep = nextStep;
    this.details = details;
  }
}

/**
 * A Review round that stopped after the relay typed into a pane; anything else it throws is a Refusal.
 * `run` draws the line at "review started", which the first prompt follows at once.
 */
export class Failure extends RelayError {}

export interface Role {
  title: string;
  kind: AgentKind;
  pane: Pane;
}

export interface Roles {
  engineering: Role;
  qa: Role[];
}

export interface RoleLabels {
  engineering: string;
  /** Matches a QA pane label; capture group 1 is the QA number. */
  qaPattern: string;
}

export const AGENT_NAMES: Record<AgentKind, string> = { claude: 'Claude Code', opencode: 'OpenCode' };

/** herdr cannot name an agent's session without its integration for that agent. */
export const integrationMissing = (kind: AgentKind): RelayError =>
  new RelayError(`herdr does not know ${AGENT_NAMES[kind]} sessions`, `Run \`herdr integration install ${kind}\`.`);

function agentKind(pane: Pane, title: string): AgentKind {
  if (pane.agent === 'claude' || pane.agent === 'opencode') return pane.agent;
  const details = `Pane ${pane.pane_id}. The relay supports Claude Code and OpenCode.`;
  if (pane.agent) throw new RelayError(`${title} runs ${pane.agent}`, 'Start Claude Code or OpenCode in it instead.', details);
  throw new RelayError(`${title} runs no agent`, 'Start Claude Code or OpenCode in it.', details);
}

function duplicateLabel(label: string, count: number): RelayError {
  const panes = count === 2 ? 'Two panes' : `${count} panes`;
  const others = count === 2 ? 'one of the two' : 'all but one of the';
  return new RelayError(`${panes} are labelled "${label}"`, `Rename ${others} "${label}" panes.`);
}

/**
 * Finds the roles in the tab of the pane the relay was started from. Engineering is the pane labelled
 * `labels.engineering`, else the invoking pane. QA panes are the ones whose label matches
 * `labels.qaPattern`, ordered by their number.
 */
export function resolveRoles(panes: Pane[], invokingPaneId: string, labels: RoleLabels): Roles {
  const invoking = panes.find((pane) => pane.pane_id === invokingPaneId);
  if (!invoking) {
    throw new RelayError('herdr does not know this pane', 'Run the review relay again from the Engineering pane.', `Pane ${invokingPaneId}`);
  }

  const tab = panes.filter((pane) => pane.tab_id === invoking.tab_id);
  const qaPattern = new RegExp(labels.qaPattern);
  const labelOf = (pane: Pane): string => pane.label?.trim() ?? '';

  const labelled = tab.filter((pane) => labelOf(pane) === labels.engineering);
  if (labelled.length > 1) throw duplicateLabel(labels.engineering, labelled.length);
  const engineeringPane = labelled[0] ?? invoking;
  if (qaPattern.test(labelOf(engineeringPane))) {
    throw new RelayError(
      'This is a QA pane',
      `Run the review relay from the Engineering pane, or label that pane "${labels.engineering}" (right-click > Rename).`,
    );
  }

  const numbered = new Map<number, Pane>();
  for (const pane of tab) {
    const match = qaPattern.exec(labelOf(pane));
    if (!match) continue;
    const number = Number(match[1]);
    if (numbered.has(number)) throw duplicateLabel(labelOf(pane), 2);
    numbered.set(number, pane);
  }
  if (numbered.size === 0) {
    const labelled = tab.map((pane) => (labelOf(pane) ? `"${labelOf(pane)}"` : '(no label)')).join(', ');
    throw new RelayError(
      'No QA panes in this tab',
      'Rename each QA pane to exactly "QA #1", "QA #2", … (right-click > Rename).',
      `Labels in this tab: ${labelled}. A QA label must match ${labels.qaPattern}.`,
    );
  }

  const qa = [...numbered.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, pane]) => ({ title: labelOf(pane), kind: agentKind(pane, labelOf(pane)), pane }));

  return {
    engineering: { title: labels.engineering, kind: agentKind(engineeringPane, labels.engineering), pane: engineeringPane },
    qa,
  };
}
