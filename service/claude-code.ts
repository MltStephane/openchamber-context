import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { MessageKind, SessionUsage, ToolCall, Turn } from './breakdown.ts';
import { CLAUDE_CODE_COMPACTION } from './compaction.ts';
import { emptyMessageChars } from './opencode.ts';

const PROJECTS_PATH = join(homedir(), '.claude/projects');
/** OpenChamber's Claude provider keeps here which transcript backs each of its sessions. */
const SESSIONS_MAP_PATH = join(homedir(), '.local/share/opencode-claude/sessions.json');
const MODELS_CATALOG_PATH = join(homedir(), '.local/share/opencode-claude/models.json');

type SessionLink = { foreignSessionId?: string; cwd?: string; modelId?: string };
type Usage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
};
type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
};
type TranscriptLine = {
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: { id?: string; model?: string; usage?: Usage; content?: string | ContentBlock[] };
};

/** Model Claude Code writes for messages it made up itself, with no API call. */
const SYNTHETIC_MODEL = '<synthetic>';

/** Reads the Claude Code transcript behind an OpenChamber session. Returns null when none is found. */
export function readClaudeCodeSession(sessionId: string): SessionUsage | null {
  const link = readSessionLink(sessionId);
  const transcript = findTranscript(link?.foreignSessionId ?? sessionId, link?.cwd);
  if (!transcript) return null;

  const turnsByMessage = new Map<string, Turn>();
  let model: string | null = null;
  let firstUserMessageChars: number | null = null;
  let toolCalls: ToolCall[] = [];
  let messageChars: Record<MessageKind, number> = emptyMessageChars();
  const callsById = new Map<string, ToolCall>();
  let lastTurnAt: number | null = null;
  let cacheTtlMs: number | null = null;

  for (const raw of readFileSync(transcript, 'utf8').split('\n')) {
    const line = parseLine(raw);
    if (!line || line.isSidechain) continue;
    // After a compaction the earlier tool outputs are no longer in the context.
    if (line.type === 'system' && line.subtype === 'compact_boundary') {
      toolCalls = [];
      messageChars = emptyMessageChars();
    }
    const message = line.message;
    if (!message) continue;

    if (line.type === 'assistant' && message.usage && message.id && message.model !== SYNTHETIC_MODEL) {
      // One API answer is written as one line per content block, each with the same usage.
      turnsByMessage.set(message.id, toTurn(message.usage));
      model = message.model ?? model;
      if (line.timestamp) lastTurnAt = Date.parse(line.timestamp) || lastTurnAt;
      // The cache write says how long the provider keeps it: 5 minutes or 1 hour.
      const written = message.usage.cache_creation;
      if (written?.ephemeral_1h_input_tokens) cacheTtlMs = 60 * 60_000;
      else if (written?.ephemeral_5m_input_tokens) cacheTtlMs = 5 * 60_000;
      for (const block of typeof message.content === 'string' ? [] : (message.content ?? [])) {
        if (block.type === 'text') messageChars.text += block.text?.length ?? 0;
        else if (block.type === 'thinking') messageChars.reasoning += block.thinking?.length ?? 0;
        else if (block.type === 'tool_use') {
          messageChars.toolCalls += JSON.stringify(block.input ?? {}).length;
          // OpenChamber's own tools reach Claude Code as `mcp__openchamber__<tool>`: keep the tool's name.
          const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
          const call = { tool: (block.name ?? 'tool').replace(/^mcp__openchamber__/, ''), input, outputChars: 0 };
          if (block.id && !callsById.has(block.id)) {
            callsById.set(block.id, call);
            toolCalls.push(call);
          }
        }
      }
    } else if (line.type === 'user' && !line.isMeta) {
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content ?? []);
      const toolResults = blocks.filter((block) => block.type === 'tool_result');
      for (const block of toolResults) {
        const call = block.tool_use_id ? callsById.get(block.tool_use_id) : undefined;
        if (call) call.outputChars += contentChars(block.content);
        else toolCalls.push({ tool: 'tool', input: {}, outputChars: contentChars(block.content) });
      }
      if (toolResults.length === 0) {
        const chars = contentChars(blocks);
        messageChars.user += chars;
        if (firstUserMessageChars === null) firstUserMessageChars = chars;
      }
    }
  }

  const fullModel = link?.modelId ?? model;
  return {
    source: 'claude-code',
    // The link keeps the `[1m]` suffix the transcript drops.
    model: fullModel,
    catalogLimit: catalogLimit(fullModel),
    turns: [...turnsByMessage.values()].filter((turn) => turn.context > 0),
    firstUserMessageChars: firstUserMessageChars ?? 0,
    toolCalls,
    messageChars,
    lastTurnAt,
    cacheTtlMs,
    compaction: CLAUDE_CODE_COMPACTION,
  };
}

function readSessionLink(sessionId: string): SessionLink | null {
  try {
    const links = JSON.parse(readFileSync(SESSIONS_MAP_PATH, 'utf8')) as Record<string, SessionLink>;
    return links[sessionId] ?? null;
  } catch {
    return null;
  }
}

/** Claude Code names a project folder after its path, every other character turned into `-`. */
const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

function findTranscript(transcriptId: string, cwd: string | undefined): string | null {
  if (!/^[\w-]+$/.test(transcriptId) || !existsSync(PROJECTS_PATH)) return null;
  const fileName = `${transcriptId}.jsonl`;
  if (cwd) {
    const direct = join(PROJECTS_PATH, projectFolder(cwd), fileName);
    if (existsSync(direct)) return direct;
  }
  for (const folder of readdirSync(PROJECTS_PATH)) {
    const candidate = join(PROJECTS_PATH, folder, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseLine(raw: string): TranscriptLine | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TranscriptLine;
  } catch {
    return null;
  }
}

function toTurn(usage: Usage): Turn {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    context: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cacheRead,
    output: usage.output_tokens ?? 0,
    cacheRead,
  };
}

function contentChars(content: string | ContentBlock[] | undefined): number {
  if (!content) return 0;
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, block) => sum + (block.text?.length ?? 0) + contentChars(block.content), 0);
}

function catalogLimit(model: string | null): number | null {
  if (!model) return null;
  try {
    const models = JSON.parse(readFileSync(MODELS_CATALOG_PATH, 'utf8')) as { id?: string; contextWindow?: number }[];
    return models.find((entry) => entry.id === model)?.contextWindow ?? null;
  } catch {
    return null;
  }
}
