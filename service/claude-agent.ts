type Database = import('node:sqlite').DatabaseSync;

/** OpenChamber's Claude provider, as OpenCode names it in a message's model. */
export const CLAUDE_AGENT_PROVIDER = 'claude-agent';

/**
 * The provider keeps its state in OpenCode's `kv` table, under keys prefixed with its plugin id
 * written as UTF-16 hex: `sessions/<ses_…>` links a session to its Claude Code transcript,
 * `models` lists its models with their window.
 */
const KEY_PREFIX = `plugin:${[...'opencode.provider.claude-agent'].map((char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')}:`;

type CatalogEntry = { id?: string; resolvedModel?: string; contextWindow?: number };

function readValue<T>(db: Database, key: string): T | null {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(KEY_PREFIX + key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

/** The Claude Code transcript id behind an OpenChamber session, if the provider linked one. */
export function claudeAgentTranscriptId(db: Database, sessionId: string): string | null {
  return readValue<{ claudeSessionID?: string }>(db, `sessions/${sessionId}`)?.claudeSessionID ?? null;
}

/** The window the provider gives for a model, by its alias (`opus`) or its full id (`claude-opus-5-5`). */
export function claudeAgentWindow(db: Database, model: string): number | null {
  const models = readValue<{ models?: CatalogEntry[] }>(db, 'models')?.models ?? [];
  return models.find((entry) => entry.id === model || entry.resolvedModel === model)?.contextWindow ?? null;
}
