import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentKind } from './herdr.ts';
import { RelayError } from './roles.ts';

export interface Config {
  engineeringLabel: string;
  /** Capture group 1 is the QA number. */
  qaLabelPattern: string;
  /** The command each QA agent gets, by agent kind. `{pr}` is the PR number. */
  reviewPrompt: Record<AgentKind, string>;
  /** First line of the handoff. `{count}` is the number of reviews, `{pr}` the PR number. */
  handoffIntro: string;
  /** Sent to Engineering after it has worked through the feedback; null skips it. */
  followUp: string | null;
  reviewTimeoutMinutes: number;
  engineeringTimeoutMinutes: number;
}

export const DEFAULTS: Config = {
  engineeringLabel: 'Engineering',
  qaLabelPattern: '^QA #(\\d+)$',
  reviewPrompt: {
    claude: '/mattpocock-skills:code-review {pr}',
    opencode: '/code-review {pr}',
  },
  handoffIntro: 'Here is the feedback from {count} independent QA agents on PR #{pr}. Check the feedback and fix issues.',
  followUp: '/goal green ci, no merge conflicts and mergeable',
  reviewTimeoutMinutes: 90,
  engineeringTimeoutMinutes: 240,
};

function expect(ok: boolean, key: string, wanted: string): void {
  if (!ok) throw new RelayError(`config.json: "${key}" must be ${wanted}`);
}

/** Overlays a parsed config.json on the defaults. Keys it does not set keep their default. */
export function parseConfig(raw: unknown): Config {
  expect(typeof raw === 'object' && raw !== null && !Array.isArray(raw), '(root)', 'an object');
  const input = raw as Record<string, unknown>;
  const config: Config = { ...DEFAULTS, reviewPrompt: { ...DEFAULTS.reviewPrompt } };

  for (const key of ['engineeringLabel', 'qaLabelPattern', 'handoffIntro'] as const) {
    if (input[key] === undefined) continue;
    expect(typeof input[key] === 'string' && input[key] !== '', key, 'a non-empty string');
    config[key] = input[key] as string;
  }
  if (input.followUp !== undefined) {
    expect(input.followUp === null || typeof input.followUp === 'string', 'followUp', 'a string or null');
    config.followUp = (input.followUp as string | null) || null;
  }
  for (const key of ['reviewTimeoutMinutes', 'engineeringTimeoutMinutes'] as const) {
    if (input[key] === undefined) continue;
    expect(typeof input[key] === 'number' && input[key] > 0, key, 'a positive number');
    config[key] = input[key] as number;
  }
  if (input.reviewPrompt !== undefined) {
    const prompts = input.reviewPrompt as Record<string, unknown>;
    expect(typeof prompts === 'object' && prompts !== null, 'reviewPrompt', 'an object');
    for (const kind of ['claude', 'opencode'] as const) {
      if (prompts[kind] === undefined) continue;
      expect(typeof prompts[kind] === 'string' && prompts[kind] !== '', `reviewPrompt.${kind}`, 'a non-empty string');
      config.reviewPrompt[kind] = prompts[kind] as string;
    }
  }
  try {
    new RegExp(config.qaLabelPattern);
  } catch (_error) {
    expect(false, 'qaLabelPattern', 'a valid regular expression');
  }
  return config;
}

export async function loadConfig(dir = process.env.HERDR_PLUGIN_CONFIG_DIR): Promise<Config> {
  if (!dir) return DEFAULTS;
  let text: string;
  try {
    text = await readFile(join(dir, 'config.json'), 'utf8');
  } catch (_error) {
    return DEFAULTS; // No config.json: the defaults apply.
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(`config.json is not valid JSON: ${(error as Error).message}`);
  }
}
