import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { PromptItem, PromptPart, PromptPartId } from './breakdown.ts';

const DATABASE_PATH = join(homedir(), '.local/share/opencode/opencode.db');
const GLOBAL_AGENT_FOLDERS = ['agents', 'agent'].map((folder) => join(homedir(), '.config/opencode', folder));

/** Where each instruction block OpenCode injects into the system prompt goes. */
function partOf(key: string): PromptPartId {
  if (key === 'core/skill-guidance') return 'skills';
  if (key === 'core/instructions') return 'instructions';
  if (key === 'core/mcp-guidance') return 'mcp';
  if (key === 'core/codemode') return 'codemode';
  if (key === 'core/environment' || key === 'core/date') return 'environment';
  if (key.startsWith('api/')) return 'openchamber';
  return 'other';
}

/**
 * The measured pieces of a session's system prompt: the agent's own prompt, and the
 * instruction blocks OpenCode stores per session (for its own sessions and Claude Code ones).
 * Returns an empty list when the database does not know the session.
 */
export async function readPromptParts(sessionId: string): Promise<PromptPart[]> {
  if (!existsSync(DATABASE_PATH)) return [];
  const sqlite = await import('node:sqlite').catch(() => null);
  if (!sqlite) return [];
  const db = new sqlite.DatabaseSync(DATABASE_PATH, { readOnly: true });
  try {
    const parts = new Map<PromptPartId, Map<string, PromptItem>>();
    const add = (id: PromptPartId, { label, key, chars, ...rest }: PromptItem) => {
      const items = parts.get(id) ?? new Map<string, PromptItem>();
      const known = items.get(key);
      items.set(key, { ...(known ?? { label, key, ...rest }), chars: (known?.chars ?? 0) + chars });
      parts.set(id, items);
    };

    const state = db.prepare('SELECT current_values FROM instruction_state WHERE session_id = ?').get(sessionId) as
      | { current_values: string }
      | undefined;
    const hashes = state ? (JSON.parse(state.current_values) as Record<string, string>) : {};
    const blob = db.prepare('SELECT value FROM instruction_blob WHERE hash = ?');
    for (const [key, hash] of Object.entries(hashes)) {
      const row = blob.get(hash) as { value: string | null } | undefined;
      if (row?.value) for (const item of blockItems(key, row.value)) add(partOf(key), item);
    }

    const session = db.prepare('SELECT agent, directory FROM session_v2 WHERE id = ?').get(sessionId) as
      | { agent: string | null; directory: string | null }
      | undefined;
    if (session?.agent) add('agent', { label: session.agent, key: session.agent, chars: agentPromptChars(session.agent, session.directory) });

    return [...parts].map(([id, items]) => ({
      id,
      items: [...items.values()].filter((item) => item.chars > 0),
    })).filter((part) => part.items.length > 0);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Blocks that are one item each, named by a key the page translates. */
const BLOCK_KEYS: Record<string, string> = { 'core/environment': 'environment', 'core/date': 'date' };

/**
 * A block split into what it lists: one skill, MCP server, instruction file or tool namespace each.
 * Blocks are stored as JSON: count the text in them, not the quotes and keys around it.
 */
function blockItems(key: string, value: string): PromptItem[] {
  const whole = (chars: number): PromptItem[] => [
    BLOCK_KEYS[key] ? { label: BLOCK_KEYS[key], translate: true, key, chars } : { label: blockLabel(key), key, chars },
  ];
  let data: unknown;
  try {
    data = JSON.parse(value);
  } catch {
    return whole(value.length);
  }
  const list = Array.isArray(data) ? data : key === 'core/codemode' ? (data as { namespaces?: unknown[] }).namespaces : null;
  if (!Array.isArray(list)) return whole(stringChars(data));
  return list.map((item, index) => {
    const label = itemLabel(item) ?? `${blockLabel(key)} ${index + 1}`;
    return { label, key: itemKey(item) ?? label, chars: stringChars(item) };
  });
}

/** The name a call uses for the item: a skill's id, an MCP server, a tool namespace. */
function itemKey(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const { id, server, name } = item as Record<string, unknown>;
  const key = [id, server, name].find((candidate) => typeof candidate === 'string');
  return typeof key === 'string' ? key : null;
}

function blockLabel(key: string): string {
  return key.replace(/^(api|core)\//, '');
}

function itemLabel(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const { name, server, path, id } = item as Record<string, unknown>;
  const label = [name, server, path, id].find((candidate) => typeof candidate === 'string');
  return typeof label === 'string' ? label.replace(homedir(), '~') : null;
}

function stringChars(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + stringChars(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((sum: number, item) => sum + stringChars(item), 0);
  return 0;
}

/** The body of the agent's Markdown file, project folder first, without its front matter. */
function agentPromptChars(agent: string, directory: string | null): number {
  if (!/^[\w.-]+$/.test(agent)) return 0;
  const folders = [
    ...(directory ? ['agents', 'agent'].map((folder) => join(directory, '.opencode', folder)) : []),
    ...GLOBAL_AGENT_FOLDERS,
  ];
  for (const folder of folders) {
    const file = join(folder, `${agent}.md`);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim().length;
  }
  return 0;
}
