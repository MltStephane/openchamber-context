import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The free room kept before automatic compaction: a share of the window, or a token count. */
export type CompactionRule = { share: number; min: number } | { tokens: number };

/** OpenCode's default (https://opencode.ai/docs/compaction/): 15 % of the window, at least 16k. */
const OPENCODE_DEFAULT: CompactionRule = { share: 0.15, min: 16_000 };

/**
 * Claude Code shows a 33k "Autocompact buffer" in /context; the user saw it on a 1M window on
 * 2026-11-09. Not documented, so the page calls it an estimate.
 */
export const CLAUDE_CODE_COMPACTION: CompactionRule = { tokens: 33_000 };

export function bufferTokens(rule: CompactionRule, limit: number): number {
  if ('tokens' in rule) return rule.tokens < limit ? rule.tokens : bufferTokens(OPENCODE_DEFAULT, limit);
  return Math.max(Math.round(limit * rule.share), rule.min);
}

/**
 * `compaction.buffer` from OpenCode's config files, the closest one winning: global, then the
 * project's `opencode.json(c)`, then its `.opencode/` folder. Without one, the default.
 */
export function openCodeCompaction(directory: string | null): CompactionRule {
  const files = [join(homedir(), '.config/opencode/opencode.json'), join(homedir(), '.config/opencode/opencode.jsonc')];
  if (directory) {
    for (const folder of [directory, join(directory, '.opencode')]) files.push(join(folder, 'opencode.json'), join(folder, 'opencode.jsonc'));
  }
  let rule = OPENCODE_DEFAULT;
  for (const file of files) {
    const buffer = readBuffer(file);
    if (buffer !== null) rule = buffer;
  }
  return rule;
}

function readBuffer(file: string): CompactionRule | null {
  if (!existsSync(file)) return null;
  try {
    // JSONC: drop comments and trailing commas, enough for a config file.
    const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1');
    const config = JSON.parse(text) as { compaction?: { buffer?: unknown; reserved?: unknown } };
    const value = config.compaction?.buffer ?? config.compaction?.reserved;
    if (typeof value === 'number' && value > 0) return { tokens: value };
    if (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value)) return { share: Number.parseFloat(value) / 100, min: 0 };
    return null;
  } catch {
    return null;
  }
}
