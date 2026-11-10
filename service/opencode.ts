import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MessageKind, SessionUsage, ToolCall, Turn } from './breakdown.ts';
import { openCodeCompaction } from './compaction.ts';

export const DATABASE_PATH = join(homedir(), '.local/share/opencode/opencode.db');
const MODELS_CATALOG_PATH = join(homedir(), '.cache/opencode/models.json');

type Database = import('node:sqlite').DatabaseSync;
type MessageTokens = { input?: number; output?: number; cache?: { read?: number; write?: number } };
type ModelsCatalog = Record<string, { models?: Record<string, { limit?: { context?: number } }> }>;
type Content = { type?: string; text?: string; name?: string; state?: { input?: Record<string, unknown>; content?: Content[]; output?: string } };
type MessageData = {
  time?: { created?: number; completed?: number };
  model?: { id?: string; providerID?: string };
  tokens?: MessageTokens;
  content?: Content[];
  text?: string;
  status?: string;
  summary?: string;
};

/** node:sqlite is missing: Node older than 22.5. */
export class OpenCodeUnavailableError extends Error {}

/** node:sqlite ships with Node 22.5+; an older runtime gets a note instead of a crash. */
export async function openDatabase(): Promise<Database | null> {
  if (!existsSync(DATABASE_PATH)) return null;
  const sqlite = await import('node:sqlite').catch(() => {
    throw new OpenCodeUnavailableError('node:sqlite needs Node 22.5 or newer');
  });
  return new sqlite.DatabaseSync(DATABASE_PATH, { readOnly: true });
}

/**
 * Reads an OpenCode session from its SQLite database, read-only: the current format
 * (`session_message`) first, then the one OpenCode wrote before 2.x (`message` and `part`).
 * Returns null when the database does not know the session.
 */
export async function readOpenCodeSession(sessionId: string): Promise<SessionUsage | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    return readCurrent(db, sessionId) ?? readLegacy(db, sessionId);
  } finally {
    db.close();
  }
}

function readCurrent(db: Database, sessionId: string): SessionUsage | null {
  const rows = db
    .prepare('SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as { type: string; data: string }[];
  if (rows.length === 0) return null;

  const turns: Turn[] = [];
  let toolCalls: ToolCall[] = [];
  let messageChars = emptyMessageChars();
  let firstUserMessageChars: number | null = null;
  let last: MessageData | null = null;

  for (const row of rows) {
    const data = JSON.parse(row.data) as MessageData;
    if (row.type === 'compaction' && data.status === 'completed') {
      // What came before is now a summary: its tool outputs and messages are gone.
      toolCalls = [];
      messageChars = emptyMessageChars();
      messageChars.text += data.summary?.length ?? 0;
      continue;
    }
    if (row.type === 'user') {
      const chars = data.text?.length ?? 0;
      messageChars.user += chars;
      firstUserMessageChars ??= chars;
      continue;
    }
    if (row.type === 'system' || row.type === 'synthetic') {
      messageChars.notices += data.text?.length ?? 0;
      continue;
    }
    if (row.type !== 'assistant') continue;

    for (const content of data.content ?? []) {
      if (content.type === 'text') messageChars.text += content.text?.length ?? 0;
      else if (content.type === 'reasoning') messageChars.reasoning += content.text?.length ?? 0;
      else if (content.type === 'tool') {
        const input = content.state?.input ?? {};
        messageChars.toolCalls += JSON.stringify(input).length;
        const outputChars = (content.state?.content ?? []).reduce((total, part) => total + (part.text?.length ?? 0), 0);
        toolCalls.push({ tool: content.name ?? 'tool', input, outputChars });
      }
    }
    if (!data.tokens) continue;
    const turn = toTurn(data.tokens);
    if (turn.context === 0) continue;
    turns.push(turn);
    last = data;
  }

  const providerID = last?.model?.providerID ?? null;
  const modelID = last?.model?.id ?? null;
  return {
    source: 'opencode',
    model: modelID ? `${providerID}/${modelID}` : null,
    catalogLimit: catalogLimit(providerID, modelID),
    turns,
    firstUserMessageChars: firstUserMessageChars ?? 0,
    toolCalls,
    messageChars,
    lastTurnAt: last?.time?.completed ?? last?.time?.created ?? null,
    cacheTtlMs: null,
    compaction: openCodeCompaction(sessionDirectory(db, sessionId)),
  };
}

type LegacyRow = { id: string; role: string | null; tokens: string | null; modelID: string | null; providerID: string | null; completed: number | null };

function readLegacy(db: Database, sessionId: string): SessionUsage | null {
  const rows = db
    .prepare(
      `SELECT id,
              json_extract(data, '$.role') AS role,
              json_extract(data, '$.tokens') AS tokens,
              json_extract(data, '$.modelID') AS modelID,
              json_extract(data, '$.providerID') AS providerID,
              json_extract(data, '$.time.completed') AS completed
         FROM message WHERE session_id = ? ORDER BY time_created, id`,
    )
    .all(sessionId) as LegacyRow[];
  if (rows.length === 0) return null;

  const turns: Turn[] = [];
  let last: LegacyRow | null = null;
  for (const row of rows) {
    if (row.role !== 'assistant' || !row.tokens) continue;
    const turn = toTurn(JSON.parse(row.tokens) as MessageTokens);
    if (turn.context === 0) continue;
    turns.push(turn);
    last = row;
  }

  const firstUser = rows.find((row) => row.role === 'user');
  const firstUserMessageChars = firstUser
    ? ((db
        .prepare(`SELECT coalesce(sum(length(json_extract(data, '$.text'))), 0) AS chars
                    FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text'`)
        .get(firstUser.id) as { chars: number } | undefined)?.chars ?? 0)
    : 0;

  // Outputs OpenCode pruned from the context carry a `compacted` time.
  const toolRows = db
    .prepare(
      `SELECT json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.input') AS input,
              coalesce(length(json_extract(data, '$.state.output')), 0) AS chars
         FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
          AND json_extract(data, '$.state.time.compacted') IS NULL`,
    )
    .all(sessionId) as { tool: string | null; input: string | null; chars: number }[];
  const toolCalls = toolRows.map((row) => ({ tool: row.tool ?? 'tool', input: parseInput(row.input), outputChars: row.chars }));

  const kindRows = db
    .prepare(
      `SELECT json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.type') AS type,
              coalesce(sum(CASE json_extract(p.data, '$.type')
                             WHEN 'tool' THEN length(json_extract(p.data, '$.state.input'))
                             ELSE length(json_extract(p.data, '$.text')) END), 0) AS chars
         FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ? AND json_extract(p.data, '$.type') IN ('text', 'reasoning', 'tool')
        GROUP BY role, type`,
    )
    .all(sessionId) as { role: string | null; type: string; chars: number }[];
  const messageChars = emptyMessageChars();
  for (const row of kindRows) {
    if (row.type === 'tool') messageChars.toolCalls += row.chars;
    else if (row.type === 'reasoning') messageChars.reasoning += row.chars;
    else messageChars[row.role === 'user' ? 'user' : 'text'] += row.chars;
  }

  return {
    source: 'opencode',
    model: last?.modelID ? `${last.providerID}/${last.modelID}` : null,
    catalogLimit: last ? catalogLimit(last.providerID, last.modelID) : null,
    turns,
    firstUserMessageChars,
    toolCalls,
    messageChars,
    lastTurnAt: last?.completed ?? null,
    cacheTtlMs: null,
    compaction: openCodeCompaction(sessionDirectory(db, sessionId)),
  };
}

export const emptyMessageChars = (): Record<MessageKind, number> => ({ user: 0, notices: 0, text: 0, reasoning: 0, toolCalls: 0 });

function sessionDirectory(db: Database, sessionId: string): string | null {
  const row = db.prepare('SELECT directory FROM session_v2 WHERE id = ?').get(sessionId) as { directory: string | null } | undefined;
  return row?.directory ?? null;
}

function parseInput(raw: string | null): Record<string, unknown> {
  try {
    const input = raw ? (JSON.parse(raw) as unknown) : {};
    return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toTurn(tokens: MessageTokens): Turn {
  const cacheRead = tokens.cache?.read ?? 0;
  return {
    context: (tokens.input ?? 0) + cacheRead + (tokens.cache?.write ?? 0),
    output: tokens.output ?? 0,
    cacheRead,
  };
}

// The service stops after ten quiet minutes, so a catalog read once stays fresh enough.
let catalog: ModelsCatalog | null = null;

/** The window OpenCode's models.dev cache gives for this model, if any. */
function catalogLimit(providerID: string | null, modelID: string | null): number | null {
  if (!providerID || !modelID) return null;
  try {
    catalog ??= JSON.parse(readFileSync(MODELS_CATALOG_PATH, 'utf8')) as ModelsCatalog;
  } catch {
    return null;
  }
  return catalog[providerID]?.models?.[modelID]?.limit?.context ?? null;
}
