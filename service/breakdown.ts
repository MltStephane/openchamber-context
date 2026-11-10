import { bufferTokens } from './compaction.ts';
import type { CompactionRule } from './compaction.ts';
import { contextLimit } from './limits.ts';

export type Source = 'opencode' | 'claude-code';

/** One assistant call: what it sent as context, and what it wrote back. */
export type Turn = { context: number; output: number; cacheRead: number };

/** A measured piece of the system prompt. `key` is what a call names it by (a skill id, an MCP server). */
export type PromptPartId = 'agent' | 'instructions' | 'skills' | 'mcp' | 'codemode' | 'openchamber' | 'environment' | 'other';
export type PromptItem = { label: string; translate?: true; key: string; chars: number };
export type PromptPart = { id: PromptPartId; items: PromptItem[] };

/** What the conversation itself is made of, in characters. */
export type MessageKind = 'user' | 'notices' | 'text' | 'reasoning' | 'toolCalls';

/** One tool call still in the context. `input` is the raw arguments, to see what it touched. */
export type ToolCall = { tool: string; input: Record<string, unknown>; outputChars: number };

/** What a source read from disk for one session. */
export type SessionUsage = {
  source: Source;
  model: string | null;
  /** Window size from the source's model catalog, when it has one. */
  catalogLimit: number | null;
  turns: Turn[];
  firstUserMessageChars: number;
  toolCalls: ToolCall[];
  messageChars: Record<MessageKind, number>;
  /** When the last answer finished, in ms. */
  lastTurnAt: number | null;
  /** How long the provider keeps the prompt cache, when the source says it. */
  cacheTtlMs: number | null;
  /** Free room the harness keeps before compacting, from its settings. */
  compaction: CompactionRule;
};

export type CategoryId = 'system' | PromptPartId | 'tools' | 'messages' | 'free';
/**
 * `label` is a name to show as is (a skill, a tool), or with `translate` a key the page translates
 * (a message kind, an environment block). `calls` is set where a call can use the item: 0 means
 * it sits in the prompt for nothing.
 */
export type CategoryItem = { label: string; translate?: true; tokens: number; calls?: number };
export type Category = { id: CategoryId; tokens: number; items?: CategoryItem[] };

/** `detail` is what the call touched; empty for a prompt item, which the page names by its category. */
export type Contributor = { label: string; translate?: true; detail: string; category: CategoryId; tokens: number };

/** Why a session could not be read; the page words it. */
export type NotFoundReason = 'bad-request' | 'no-session' | 'no-data' | 'node-too-old' | 'database-unreadable' | 'transcript-unreadable' | 'failed';
export type Subagent = { id: string; title: string; agent: string | null; model: string | null; processed: number; context: number };

export type ContextReport =
  | {
      status: 'ok';
      source: Source;
      model: string | null;
      limit: number;
      total: number;
      output: number;
      cacheRead: number;
      categories: Category[];
      history: number[];
      compaction: { threshold: number; buffer: number; growth: number | null };
      cache: { lastTurnAt: number | null; ttlMs: number; ttlKnown: boolean };
      compactionEstimated: boolean;
      contributors: Contributor[];
      unused: { category: CategoryId; label: string; tokens: number }[];
      subagents: Subagent[];
    }
  | { status: 'no-turn'; source: Source }
  | { status: 'not-found'; reason: NotFoundReason };

const CHARS_PER_TOKEN = 4;
const HISTORY_POINTS = 40;
const TOP_CONTRIBUTORS = 5;
/** Growth is averaged over the last calls: the start of a session says little about now. */
const GROWTH_WINDOW = 10;
/** Anthropic's default prompt cache lifetime, used when the source does not say. */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

const MESSAGE_KINDS: MessageKind[] = ['user', 'notices', 'text', 'reasoning', 'toolCalls'];

/** Same order as Claude Code's /context: what the prompt carries, then the conversation. */
const PART_ORDER: PromptPartId[] = ['agent', 'instructions', 'skills', 'mcp', 'codemode', 'openchamber', 'environment', 'other'];

/** Parts whose items a call names, so an item no call names is loaded for nothing. */
const USABLE_PARTS: PromptPartId[] = ['skills', 'mcp', 'codemode'];

export const estimateTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

type Entry = { label: string; translate?: true; chars: number; calls?: number };

export function buildReport(usage: SessionUsage, promptParts: PromptPart[], subagents: Subagent[], requestedModel: string | null): ContextReport {
  const [first] = usage.turns;
  const last = usage.turns.at(-1);
  if (!first || !last) {
    return { status: 'no-turn', source: usage.source };
  }

  const model = usage.model ?? requestedModel;
  const limit = contextLimit(model, usage.catalogLimit);
  const total = last.context;
  const used = usedNames(usage.toolCalls);
  // The first call carries the whole system prompt and the first message, nothing else.
  const systemUsed = clamp(first.context - estimateTokens(usage.firstUserMessageChars), total);
  let prompt = systemUsed;

  const parts: Category[] = [];
  for (const id of PART_ORDER) {
    const part = promptParts.find((candidate) => candidate.id === id);
    if (!part) continue;
    const entries: Entry[] = part.items.map(({ label, translate, key, chars }) => ({
      label,
      ...(translate ? { translate } : {}),
      chars,
      ...(USABLE_PARTS.includes(id) ? { calls: callsFor(id, key, used) } : {}),
    }));
    const tokens = clamp(estimateTokens(sum(entries)), prompt);
    if (tokens === 0) continue;
    parts.push({ id, tokens, items: split(tokens, entries, USABLE_PARTS.includes(id)) });
    prompt -= tokens;
  }

  const toolsByName = new Map<string, number>();
  for (const call of usage.toolCalls) toolsByName.set(call.tool, (toolsByName.get(call.tool) ?? 0) + call.outputChars);
  const toolEntries = [...toolsByName].map(([label, chars]) => ({ label, chars }));
  const tools = clamp(estimateTokens(sum(toolEntries)), total - systemUsed);
  const messageEntries: Entry[] = MESSAGE_KINDS.map((kind) => ({ label: kind, translate: true, chars: usage.messageChars[kind] }));
  const messages = Math.max(0, total - systemUsed - tools);

  const unused = parts.flatMap((part) =>
    (part.items ?? []).filter((item) => item.calls === 0).map((item) => ({ category: part.id, label: item.label, tokens: item.tokens })),
  );

  // The largest single things in the context: one tool output, one prompt item.
  const contributors: Contributor[] = [
    ...usage.toolCalls.map((call) => ({ label: call.tool, detail: describe(call.input), category: 'tools' as const, tokens: estimateTokens(call.outputChars) })),
    ...parts.flatMap((part) =>
      (part.items ?? []).map((item) => ({ label: item.label, ...(item.translate ? { translate: item.translate } : {}), detail: '', category: part.id, tokens: item.tokens })),
    ),
  ]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, TOP_CONTRIBUTORS);

  const buffer = bufferTokens(usage.compaction, limit);
  const threshold = limit - buffer;
  const growth = averageGrowth(usage.turns);

  return {
    status: 'ok',
    source: usage.source,
    model,
    limit,
    total,
    output: last.output,
    cacheRead: last.cacheRead,
    categories: [
      // What is left of the first call once the measured parts are out: the harness's own prompt and tool schemas.
      { id: 'system', tokens: prompt },
      ...parts,
      { id: 'tools', tokens: tools, items: split(tools, toolEntries) },
      { id: 'messages', tokens: messages, items: split(messages, messageEntries) },
      { id: 'free', tokens: Math.max(0, limit - total) },
    ],
    history: usage.turns.slice(-HISTORY_POINTS).map((turn) => turn.context),
    compaction: { threshold, buffer, growth },
    cache: { lastTurnAt: usage.lastTurnAt, ttlMs: usage.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, ttlKnown: usage.cacheTtlMs !== null },
    compactionEstimated: usage.source === 'claude-code',
    contributors,
    unused,
    subagents,
  };
}

/** Mean growth per model call over the last calls, ignoring the drops a compaction makes. */
function averageGrowth(turns: Turn[]): number | null {
  const recent = turns.slice(-(GROWTH_WINDOW + 1));
  const deltas = recent.slice(1).map((turn, index) => turn.context - recent[index]!.context).filter((delta) => delta > 0);
  if (deltas.length === 0) return null;
  return Math.round(deltas.reduce((total, delta) => total + delta, 0) / deltas.length);
}

/** Skills read and tool namespaces reached in the session, from the calls themselves. */
function usedNames(calls: ToolCall[]) {
  const skills = new Set<string>();
  const tools: string[] = [];
  const code: string[] = [];
  for (const call of calls) {
    tools.push(call.tool);
    if (call.tool === 'skill') {
      for (const key of ['name', 'id']) if (typeof call.input[key] === 'string') skills.add(call.input[key] as string);
    }
    // Code Mode reaches MCP servers from a script: tools.fastmail.x() or tools["laravel-boost"].x().
    if (typeof call.input.code === 'string') code.push(call.input.code);
  }
  return { skills, tools, code: code.join('\n') };
}

function callsFor(part: PromptPartId, key: string, used: ReturnType<typeof usedNames>): number {
  if (part === 'skills') return used.skills.has(key) ? 1 : 0;
  // OpenCode names an MCP tool `<server>_<tool>`, Claude Code `mcp__<server>__<tool>`.
  const direct = used.tools.filter((tool) => tool === key || tool.startsWith(`${key}_`) || tool.startsWith(`mcp__${key}__`)).length;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scripted = used.code.match(new RegExp(`tools(?:\\.${escaped}\\b|\\[["']${escaped}["']\\])`, 'g'))?.length ?? 0;
  return direct + scripted;
}

/** What a call touched, in a few words: a path, a command, an address. */
function describe(input: Record<string, unknown>): string {
  for (const key of ['filePath', 'file_path', 'path', 'command', 'url', 'pattern', 'query', 'name', 'id', 'description', 'code']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      const line = value.trim().split('\n')[0]!;
      return line.length > 80 ? `${line.slice(0, 79)}…` : line;
    }
  }
  return '';
}

const sum = (entries: Entry[]) => entries.reduce((total, entry) => total + entry.chars, 0);

/** Shares a category's tokens among its items by their size, largest first. */
function split(tokens: number, entries: Entry[], keepSingle = false): CategoryItem[] {
  const chars = sum(entries);
  if (chars === 0 || (entries.length < 2 && !keepSingle)) return [];
  return entries
    .map(({ label, translate, chars: size, calls }) => ({
      label,
      ...(translate ? { translate } : {}),
      tokens: Math.round((tokens * size) / chars),
      ...(calls === undefined ? {} : { calls }),
    }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max));
