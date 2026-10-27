import type { AgentKind, Pane } from './herdr.ts';

export class RelayError extends Error {}

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

function agentKind(pane: Pane, title: string): AgentKind {
  if (pane.agent === 'claude' || pane.agent === 'opencode') return pane.agent;
  throw new RelayError(
    pane.agent
      ? `${title} (${pane.pane_id}) runs ${pane.agent}; only Claude Code and OpenCode are supported`
      : `${title} (${pane.pane_id}) has no agent running`,
  );
}

/**
 * Finds the roles in the tab of the pane the key was pressed in. Engineering is the pane labelled
 * `labels.engineering`, else the invoking pane. QA panes are the ones whose label matches
 * `labels.qaPattern`, ordered by their number.
 */
export function resolveRoles(panes: Pane[], invokingPaneId: string, labels: RoleLabels): Roles {
  const invoking = panes.find((pane) => pane.pane_id === invokingPaneId);
  if (!invoking) throw new RelayError(`Pane ${invokingPaneId} not found`);

  const tab = panes.filter((pane) => pane.tab_id === invoking.tab_id);
  const qaPattern = new RegExp(labels.qaPattern);
  const labelOf = (pane: Pane): string => pane.label?.trim() ?? '';

  const labelled = tab.filter((pane) => labelOf(pane) === labels.engineering);
  if (labelled.length > 1) throw new RelayError(`More than one pane is labelled "${labels.engineering}" in this tab`);
  const engineeringPane = labelled[0] ?? invoking;
  if (qaPattern.test(labelOf(engineeringPane))) {
    throw new RelayError(
      `Press the key in the Engineering pane, or label that pane "${labels.engineering}" (right-click > Rename)`,
    );
  }

  const numbered = new Map<number, Pane>();
  for (const pane of tab) {
    const match = qaPattern.exec(labelOf(pane));
    if (!match) continue;
    const number = Number(match[1]);
    if (numbered.has(number)) throw new RelayError(`Two panes in this tab are labelled "${labelOf(pane)}"`);
    numbered.set(number, pane);
  }
  if (numbered.size === 0) {
    throw new RelayError('No QA panes in this tab. Label them "QA #1", "QA #2", ... (right-click > Rename)');
  }

  const qa = [...numbered.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, pane]) => ({ title: labelOf(pane), kind: agentKind(pane, labelOf(pane)), pane }));

  return {
    engineering: { title: labels.engineering, kind: agentKind(engineeringPane, labels.engineering), pane: engineeringPane },
    qa,
  };
}
