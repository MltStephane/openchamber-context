import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// service/main.ts
import http from "node:http";

// service/compaction.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var OPENCODE_DEFAULT = { share: 0.15, min: 16000 };
var CLAUDE_CODE_COMPACTION = { tokens: 33000 };
function bufferTokens(rule, limit) {
  if ("tokens" in rule)
    return rule.tokens < limit ? rule.tokens : bufferTokens(OPENCODE_DEFAULT, limit);
  return Math.max(Math.round(limit * rule.share), rule.min);
}
function openCodeCompaction(directory) {
  const files = [join(homedir(), ".config/opencode/opencode.json"), join(homedir(), ".config/opencode/opencode.jsonc")];
  if (directory) {
    for (const folder of [directory, join(directory, ".opencode")])
      files.push(join(folder, "opencode.json"), join(folder, "opencode.jsonc"));
  }
  let rule = OPENCODE_DEFAULT;
  for (const file of files) {
    const buffer = readBuffer(file);
    if (buffer !== null)
      rule = buffer;
  }
  return rule;
}
function readBuffer(file) {
  if (!existsSync(file))
    return null;
  try {
    const text = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/,(\s*[}\]])/g, "$1");
    const config = JSON.parse(text);
    const value = config.compaction?.buffer ?? config.compaction?.reserved;
    if (typeof value === "number" && value > 0)
      return { tokens: value };
    if (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value))
      return { share: Number.parseFloat(value) / 100, min: 0 };
    return null;
  } catch {
    return null;
  }
}

// service/limits.ts
var DEFAULT_LIMIT = 200000;
var ONE_MILLION = 1e6;
var KNOWN_LIMITS = {
  "claude-sonnet-5-5": ONE_MILLION,
  "claude-haiku-5-5": ONE_MILLION,
  "claude-sonnet-5": ONE_MILLION,
  "claude-opus-4-8": ONE_MILLION,
  "claude-opus-4-7": ONE_MILLION
};
function contextLimit(model, catalogLimit) {
  if (catalogLimit && catalogLimit > 0)
    return catalogLimit;
  if (!model)
    return DEFAULT_LIMIT;
  const id = model.toLowerCase();
  if (id.includes("1m"))
    return ONE_MILLION;
  const bareId = id.slice(id.lastIndexOf("/") + 1);
  return KNOWN_LIMITS[bareId] ?? DEFAULT_LIMIT;
}

// service/breakdown.ts
var CHARS_PER_TOKEN = 4;
var HISTORY_POINTS = 40;
var TOP_CONTRIBUTORS = 5;
var GROWTH_WINDOW = 10;
var DEFAULT_CACHE_TTL_MS = 5 * 60000;
var MESSAGE_KINDS = ["user", "notices", "text", "reasoning", "toolCalls"];
var PART_ORDER = ["agent", "instructions", "skills", "mcp", "codemode", "openchamber", "environment", "other"];
var USABLE_PARTS = ["skills", "mcp", "codemode"];
var estimateTokens = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
function buildReport(usage, promptParts, subagents, requestedModel) {
  const [first] = usage.turns;
  const last = usage.turns.at(-1);
  if (!first || !last) {
    return { status: "no-turn", source: usage.source };
  }
  const model = usage.model ?? requestedModel;
  const limit = contextLimit(model, usage.catalogLimit);
  const total = last.context;
  const used = usedNames(usage.toolCalls);
  const systemUsed = clamp(first.context - estimateTokens(usage.firstUserMessageChars), total);
  let prompt = systemUsed;
  const parts = [];
  for (const id of PART_ORDER) {
    const part = promptParts.find((candidate) => candidate.id === id);
    if (!part)
      continue;
    const entries = part.items.map(({ label, translate, key, chars }) => ({
      label,
      ...translate ? { translate } : {},
      chars,
      ...USABLE_PARTS.includes(id) ? { calls: callsFor(id, key, used) } : {}
    }));
    const tokens = clamp(estimateTokens(sum(entries)), prompt);
    if (tokens === 0)
      continue;
    parts.push({ id, tokens, items: split(tokens, entries, USABLE_PARTS.includes(id)) });
    prompt -= tokens;
  }
  const toolsByName = new Map;
  for (const call of usage.toolCalls)
    toolsByName.set(call.tool, (toolsByName.get(call.tool) ?? 0) + call.outputChars);
  const toolEntries = [...toolsByName].map(([label, chars]) => ({ label, chars }));
  const tools = clamp(estimateTokens(sum(toolEntries)), total - systemUsed);
  const messageEntries = MESSAGE_KINDS.map((kind) => ({ label: kind, translate: true, chars: usage.messageChars[kind] }));
  const messages = Math.max(0, total - systemUsed - tools);
  const unused = parts.flatMap((part) => (part.items ?? []).filter((item) => item.calls === 0).map((item) => ({ category: part.id, label: item.label, tokens: item.tokens })));
  const contributors = [
    ...usage.toolCalls.map((call) => ({ label: call.tool, detail: describe(call.input), category: "tools", tokens: estimateTokens(call.outputChars) })),
    ...parts.flatMap((part) => (part.items ?? []).map((item) => ({ label: item.label, ...item.translate ? { translate: item.translate } : {}, detail: "", category: part.id, tokens: item.tokens })))
  ].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_CONTRIBUTORS);
  const buffer = bufferTokens(usage.compaction, limit);
  const threshold = limit - buffer;
  const growth = averageGrowth(usage.turns);
  return {
    status: "ok",
    source: usage.source,
    model,
    limit,
    total,
    output: last.output,
    cacheRead: last.cacheRead,
    categories: [
      { id: "system", tokens: prompt },
      ...parts,
      { id: "tools", tokens: tools, items: split(tools, toolEntries) },
      { id: "messages", tokens: messages, items: split(messages, messageEntries) },
      { id: "free", tokens: Math.max(0, limit - total) }
    ],
    history: usage.turns.slice(-HISTORY_POINTS).map((turn) => turn.context),
    compaction: { threshold, buffer, growth },
    cache: { lastTurnAt: usage.lastTurnAt, ttlMs: usage.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, ttlKnown: usage.cacheTtlMs !== null },
    compactionEstimated: usage.source === "claude-code",
    contributors,
    unused,
    subagents
  };
}
function averageGrowth(turns) {
  const recent = turns.slice(-(GROWTH_WINDOW + 1));
  const deltas = recent.slice(1).map((turn, index) => turn.context - recent[index].context).filter((delta) => delta > 0);
  if (deltas.length === 0)
    return null;
  return Math.round(deltas.reduce((total, delta) => total + delta, 0) / deltas.length);
}
function usedNames(calls) {
  const skills = new Set;
  const tools = [];
  const code = [];
  for (const call of calls) {
    tools.push(call.tool);
    if (call.tool === "skill") {
      for (const key of ["name", "id"])
        if (typeof call.input[key] === "string")
          skills.add(call.input[key]);
    }
    if (typeof call.input.code === "string")
      code.push(call.input.code);
  }
  return { skills, tools, code: code.join(`
`) };
}
function callsFor(part, key, used) {
  if (part === "skills")
    return used.skills.has(key) ? 1 : 0;
  const direct = used.tools.filter((tool) => tool === key || tool.startsWith(`${key}_`) || tool.startsWith(`mcp__${key}__`)).length;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scripted = used.code.match(new RegExp(`tools(?:\\.${escaped}\\b|\\[["']${escaped}["']\\])`, "g"))?.length ?? 0;
  return direct + scripted;
}
function describe(input) {
  for (const key of ["filePath", "file_path", "path", "command", "url", "pattern", "query", "name", "id", "description", "code"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.trim().split(`
`)[0];
      return line.length > 80 ? `${line.slice(0, 79)}…` : line;
    }
  }
  return "";
}
var sum = (entries) => entries.reduce((total, entry) => total + entry.chars, 0);
function split(tokens, entries, keepSingle = false) {
  const chars = sum(entries);
  if (chars === 0 || entries.length < 2 && !keepSingle)
    return [];
  return entries.map(({ label, translate, chars: size, calls }) => ({
    label,
    ...translate ? { translate } : {},
    tokens: Math.round(tokens * size / chars),
    ...calls === undefined ? {} : { calls }
  })).filter((item) => item.tokens > 0).sort((a, b) => b.tokens - a.tokens);
}
var clamp = (value, max) => Math.max(0, Math.min(value, max));

// service/claude-code.ts
import { existsSync as existsSync3, readdirSync, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";

// service/opencode.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var DATABASE_PATH = join2(homedir2(), ".local/share/opencode/opencode.db");
var MODELS_CATALOG_PATH = join2(homedir2(), ".cache/opencode/models.json");

class OpenCodeUnavailableError extends Error {
}
async function openDatabase() {
  if (!existsSync2(DATABASE_PATH))
    return null;
  const sqlite = await import("node:sqlite").catch(() => {
    throw new OpenCodeUnavailableError("node:sqlite needs Node 22.5 or newer");
  });
  return new sqlite.DatabaseSync(DATABASE_PATH, { readOnly: true });
}
async function readOpenCodeSession(sessionId) {
  const db = await openDatabase();
  if (!db)
    return null;
  try {
    return readCurrent(db, sessionId) ?? readLegacy(db, sessionId);
  } finally {
    db.close();
  }
}
function readCurrent(db, sessionId) {
  const rows = db.prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq").all(sessionId);
  if (rows.length === 0)
    return null;
  const turns = [];
  let toolCalls = [];
  let messageChars = emptyMessageChars();
  let firstUserMessageChars = null;
  let last = null;
  for (const row of rows) {
    const data = JSON.parse(row.data);
    if (row.type === "compaction" && data.status === "completed") {
      toolCalls = [];
      messageChars = emptyMessageChars();
      messageChars.text += data.summary?.length ?? 0;
      continue;
    }
    if (row.type === "user") {
      const chars = data.text?.length ?? 0;
      messageChars.user += chars;
      firstUserMessageChars ??= chars;
      continue;
    }
    if (row.type === "system" || row.type === "synthetic") {
      messageChars.notices += data.text?.length ?? 0;
      continue;
    }
    if (row.type !== "assistant")
      continue;
    for (const content of data.content ?? []) {
      if (content.type === "text")
        messageChars.text += content.text?.length ?? 0;
      else if (content.type === "reasoning")
        messageChars.reasoning += content.text?.length ?? 0;
      else if (content.type === "tool") {
        const input = content.state?.input ?? {};
        messageChars.toolCalls += JSON.stringify(input).length;
        const outputChars = (content.state?.content ?? []).reduce((total, part) => total + (part.text?.length ?? 0), 0);
        toolCalls.push({ tool: content.name ?? "tool", input, outputChars });
      }
    }
    if (!data.tokens)
      continue;
    const turn = toTurn(data.tokens);
    if (turn.context === 0)
      continue;
    turns.push(turn);
    last = data;
  }
  const providerID = last?.model?.providerID ?? null;
  const modelID = last?.model?.id ?? null;
  return {
    source: "opencode",
    model: modelID ? `${providerID}/${modelID}` : null,
    catalogLimit: catalogLimit(providerID, modelID),
    turns,
    firstUserMessageChars: firstUserMessageChars ?? 0,
    toolCalls,
    messageChars,
    lastTurnAt: last?.time?.completed ?? last?.time?.created ?? null,
    cacheTtlMs: null,
    compaction: openCodeCompaction(sessionDirectory(db, sessionId))
  };
}
function readLegacy(db, sessionId) {
  const rows = db.prepare(`SELECT id,
              json_extract(data, '$.role') AS role,
              json_extract(data, '$.tokens') AS tokens,
              json_extract(data, '$.modelID') AS modelID,
              json_extract(data, '$.providerID') AS providerID,
              json_extract(data, '$.time.completed') AS completed
         FROM message WHERE session_id = ? ORDER BY time_created, id`).all(sessionId);
  if (rows.length === 0)
    return null;
  const turns = [];
  let last = null;
  for (const row of rows) {
    if (row.role !== "assistant" || !row.tokens)
      continue;
    const turn = toTurn(JSON.parse(row.tokens));
    if (turn.context === 0)
      continue;
    turns.push(turn);
    last = row;
  }
  const firstUser = rows.find((row) => row.role === "user");
  const firstUserMessageChars = firstUser ? db.prepare(`SELECT coalesce(sum(length(json_extract(data, '$.text'))), 0) AS chars
                    FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'text'`).get(firstUser.id)?.chars ?? 0 : 0;
  const toolRows = db.prepare(`SELECT json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.input') AS input,
              coalesce(length(json_extract(data, '$.state.output')), 0) AS chars
         FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool'
          AND json_extract(data, '$.state.time.compacted') IS NULL`).all(sessionId);
  const toolCalls = toolRows.map((row) => ({ tool: row.tool ?? "tool", input: parseInput(row.input), outputChars: row.chars }));
  const kindRows = db.prepare(`SELECT json_extract(m.data, '$.role') AS role, json_extract(p.data, '$.type') AS type,
              coalesce(sum(CASE json_extract(p.data, '$.type')
                             WHEN 'tool' THEN length(json_extract(p.data, '$.state.input'))
                             ELSE length(json_extract(p.data, '$.text')) END), 0) AS chars
         FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ? AND json_extract(p.data, '$.type') IN ('text', 'reasoning', 'tool')
        GROUP BY role, type`).all(sessionId);
  const messageChars = emptyMessageChars();
  for (const row of kindRows) {
    if (row.type === "tool")
      messageChars.toolCalls += row.chars;
    else if (row.type === "reasoning")
      messageChars.reasoning += row.chars;
    else
      messageChars[row.role === "user" ? "user" : "text"] += row.chars;
  }
  return {
    source: "opencode",
    model: last?.modelID ? `${last.providerID}/${last.modelID}` : null,
    catalogLimit: last ? catalogLimit(last.providerID, last.modelID) : null,
    turns,
    firstUserMessageChars,
    toolCalls,
    messageChars,
    lastTurnAt: last?.completed ?? null,
    cacheTtlMs: null,
    compaction: openCodeCompaction(sessionDirectory(db, sessionId))
  };
}
var emptyMessageChars = () => ({ user: 0, notices: 0, text: 0, reasoning: 0, toolCalls: 0 });
function sessionDirectory(db, sessionId) {
  const row = db.prepare("SELECT directory FROM session_v2 WHERE id = ?").get(sessionId);
  return row?.directory ?? null;
}
function parseInput(raw) {
  try {
    const input = raw ? JSON.parse(raw) : {};
    return input && typeof input === "object" ? input : {};
  } catch {
    return {};
  }
}
function toTurn(tokens) {
  const cacheRead = tokens.cache?.read ?? 0;
  return {
    context: (tokens.input ?? 0) + cacheRead + (tokens.cache?.write ?? 0),
    output: tokens.output ?? 0,
    cacheRead
  };
}
var catalog = null;
function catalogLimit(providerID, modelID) {
  if (!providerID || !modelID)
    return null;
  try {
    catalog ??= JSON.parse(readFileSync2(MODELS_CATALOG_PATH, "utf8"));
  } catch {
    return null;
  }
  return catalog[providerID]?.models?.[modelID]?.limit?.context ?? null;
}

// service/claude-code.ts
var PROJECTS_PATH = join3(homedir3(), ".claude/projects");
var SESSIONS_MAP_PATH = join3(homedir3(), ".local/share/opencode-claude/sessions.json");
var MODELS_CATALOG_PATH2 = join3(homedir3(), ".local/share/opencode-claude/models.json");
var SYNTHETIC_MODEL = "<synthetic>";
function readClaudeCodeSession(sessionId) {
  const link = readSessionLink(sessionId);
  const transcript = findTranscript(link?.foreignSessionId ?? sessionId, link?.cwd);
  if (!transcript)
    return null;
  const turnsByMessage = new Map;
  let model = null;
  let firstUserMessageChars = null;
  let toolCalls = [];
  let messageChars = emptyMessageChars();
  const callsById = new Map;
  let lastTurnAt = null;
  let cacheTtlMs = null;
  for (const raw of readFileSync3(transcript, "utf8").split(`
`)) {
    const line = parseLine(raw);
    if (!line || line.isSidechain)
      continue;
    if (line.type === "system" && line.subtype === "compact_boundary") {
      toolCalls = [];
      messageChars = emptyMessageChars();
    }
    const message = line.message;
    if (!message)
      continue;
    if (line.type === "assistant" && message.usage && message.id && message.model !== SYNTHETIC_MODEL) {
      turnsByMessage.set(message.id, toTurn2(message.usage));
      model = message.model ?? model;
      if (line.timestamp)
        lastTurnAt = Date.parse(line.timestamp) || lastTurnAt;
      const written = message.usage.cache_creation;
      if (written?.ephemeral_1h_input_tokens)
        cacheTtlMs = 60 * 60000;
      else if (written?.ephemeral_5m_input_tokens)
        cacheTtlMs = 5 * 60000;
      for (const block of typeof message.content === "string" ? [] : message.content ?? []) {
        if (block.type === "text")
          messageChars.text += block.text?.length ?? 0;
        else if (block.type === "thinking")
          messageChars.reasoning += block.thinking?.length ?? 0;
        else if (block.type === "tool_use") {
          messageChars.toolCalls += JSON.stringify(block.input ?? {}).length;
          const input = block.input && typeof block.input === "object" ? block.input : {};
          const call = { tool: (block.name ?? "tool").replace(/^mcp__openchamber__/, ""), input, outputChars: 0 };
          if (block.id && !callsById.has(block.id)) {
            callsById.set(block.id, call);
            toolCalls.push(call);
          }
        }
      }
    } else if (line.type === "user" && !line.isMeta) {
      const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
      const toolResults = blocks.filter((block) => block.type === "tool_result");
      for (const block of toolResults) {
        const call = block.tool_use_id ? callsById.get(block.tool_use_id) : undefined;
        if (call)
          call.outputChars += contentChars(block.content);
        else
          toolCalls.push({ tool: "tool", input: {}, outputChars: contentChars(block.content) });
      }
      if (toolResults.length === 0) {
        const chars = contentChars(blocks);
        messageChars.user += chars;
        if (firstUserMessageChars === null)
          firstUserMessageChars = chars;
      }
    }
  }
  const fullModel = link?.modelId ?? model;
  return {
    source: "claude-code",
    model: fullModel,
    catalogLimit: catalogLimit2(fullModel),
    turns: [...turnsByMessage.values()].filter((turn) => turn.context > 0),
    firstUserMessageChars: firstUserMessageChars ?? 0,
    toolCalls,
    messageChars,
    lastTurnAt,
    cacheTtlMs,
    compaction: CLAUDE_CODE_COMPACTION
  };
}
function readSessionLink(sessionId) {
  try {
    const links = JSON.parse(readFileSync3(SESSIONS_MAP_PATH, "utf8"));
    return links[sessionId] ?? null;
  } catch {
    return null;
  }
}
var projectFolder = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
function findTranscript(transcriptId, cwd) {
  if (!/^[\w-]+$/.test(transcriptId) || !existsSync3(PROJECTS_PATH))
    return null;
  const fileName = `${transcriptId}.jsonl`;
  if (cwd) {
    const direct = join3(PROJECTS_PATH, projectFolder(cwd), fileName);
    if (existsSync3(direct))
      return direct;
  }
  for (const folder of readdirSync(PROJECTS_PATH)) {
    const candidate = join3(PROJECTS_PATH, folder, fileName);
    if (existsSync3(candidate))
      return candidate;
  }
  return null;
}
function parseLine(raw) {
  if (!raw)
    return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function toTurn2(usage) {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return {
    context: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cacheRead,
    output: usage.output_tokens ?? 0,
    cacheRead
  };
}
function contentChars(content) {
  if (!content)
    return 0;
  if (typeof content === "string")
    return content.length;
  return content.reduce((sum2, block) => sum2 + (block.text?.length ?? 0) + contentChars(block.content), 0);
}
function catalogLimit2(model) {
  if (!model)
    return null;
  try {
    const models = JSON.parse(readFileSync3(MODELS_CATALOG_PATH2, "utf8"));
    return models.find((entry) => entry.id === model)?.contextWindow ?? null;
  } catch {
    return null;
  }
}

// service/prompt-parts.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join4 } from "node:path";
var DATABASE_PATH2 = join4(homedir4(), ".local/share/opencode/opencode.db");
var GLOBAL_AGENT_FOLDERS = ["agents", "agent"].map((folder) => join4(homedir4(), ".config/opencode", folder));
function partOf(key) {
  if (key === "core/skill-guidance")
    return "skills";
  if (key === "core/instructions")
    return "instructions";
  if (key === "core/mcp-guidance")
    return "mcp";
  if (key === "core/codemode")
    return "codemode";
  if (key === "core/environment" || key === "core/date")
    return "environment";
  if (key.startsWith("api/"))
    return "openchamber";
  return "other";
}
async function readPromptParts(sessionId) {
  if (!existsSync4(DATABASE_PATH2))
    return [];
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite)
    return [];
  const db = new sqlite.DatabaseSync(DATABASE_PATH2, { readOnly: true });
  try {
    const parts = new Map;
    const add = (id, { label, key, chars, ...rest }) => {
      const items = parts.get(id) ?? new Map;
      const known = items.get(key);
      items.set(key, { ...known ?? { label, key, ...rest }, chars: (known?.chars ?? 0) + chars });
      parts.set(id, items);
    };
    const state = db.prepare("SELECT current_values FROM instruction_state WHERE session_id = ?").get(sessionId);
    const hashes = state ? JSON.parse(state.current_values) : {};
    const blob = db.prepare("SELECT value FROM instruction_blob WHERE hash = ?");
    for (const [key, hash] of Object.entries(hashes)) {
      const row = blob.get(hash);
      if (row?.value)
        for (const item of blockItems(key, row.value))
          add(partOf(key), item);
    }
    const session = db.prepare("SELECT agent, directory FROM session_v2 WHERE id = ?").get(sessionId);
    if (session?.agent)
      add("agent", { label: session.agent, key: session.agent, chars: agentPromptChars(session.agent, session.directory) });
    return [...parts].map(([id, items]) => ({
      id,
      items: [...items.values()].filter((item) => item.chars > 0)
    })).filter((part) => part.items.length > 0);
  } catch {
    return [];
  } finally {
    db.close();
  }
}
var BLOCK_KEYS = { "core/environment": "environment", "core/date": "date" };
function blockItems(key, value) {
  const whole = (chars) => [
    BLOCK_KEYS[key] ? { label: BLOCK_KEYS[key], translate: true, key, chars } : { label: blockLabel(key), key, chars }
  ];
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    return whole(value.length);
  }
  const list = Array.isArray(data) ? data : key === "core/codemode" ? data.namespaces : null;
  if (!Array.isArray(list))
    return whole(stringChars(data));
  return list.map((item, index) => {
    const label = itemLabel(item) ?? `${blockLabel(key)} ${index + 1}`;
    return { label, key: itemKey(item) ?? label, chars: stringChars(item) };
  });
}
function itemKey(item) {
  if (!item || typeof item !== "object")
    return null;
  const { id, server, name } = item;
  const key = [id, server, name].find((candidate) => typeof candidate === "string");
  return typeof key === "string" ? key : null;
}
function blockLabel(key) {
  return key.replace(/^(api|core)\//, "");
}
function itemLabel(item) {
  if (!item || typeof item !== "object")
    return null;
  const { name, server, path, id } = item;
  const label = [name, server, path, id].find((candidate) => typeof candidate === "string");
  return typeof label === "string" ? label.replace(homedir4(), "~") : null;
}
function stringChars(value) {
  if (typeof value === "string")
    return value.length;
  if (Array.isArray(value))
    return value.reduce((sum2, item) => sum2 + stringChars(item), 0);
  if (value && typeof value === "object")
    return Object.values(value).reduce((sum2, item) => sum2 + stringChars(item), 0);
  return 0;
}
function agentPromptChars(agent, directory) {
  if (!/^[\w.-]+$/.test(agent))
    return 0;
  const folders = [
    ...directory ? ["agents", "agent"].map((folder) => join4(directory, ".opencode", folder)) : [],
    ...GLOBAL_AGENT_FOLDERS
  ];
  for (const folder of folders) {
    const file = join4(folder, `${agent}.md`);
    if (!existsSync4(file))
      continue;
    const text = readFileSync4(file, "utf8");
    return text.replace(/^---\n[\s\S]*?\n---\n/, "").trim().length;
  }
  return 0;
}

// service/subagents.ts
var MAX_SUBAGENTS = 20;
async function readSubagents(sessionId, readUsage) {
  const db = await openDatabase().catch(() => null);
  if (!db)
    return [];
  let children;
  try {
    children = db.prepare(`SELECT id, title, agent, model FROM session_v2 WHERE parent_id = ? ORDER BY time_created DESC LIMIT ${MAX_SUBAGENTS}`).all(sessionId);
  } catch {
    return [];
  } finally {
    db.close();
  }
  const subagents = [];
  for (const child of children) {
    const usage = await readUsage(child.id).catch(() => null);
    const turns = usage?.turns ?? [];
    subagents.push({
      id: child.id,
      title: child.title || child.id,
      agent: child.agent,
      model: usage?.model ?? modelOf(child.model),
      processed: turns.reduce((total, turn) => total + turn.context + turn.output, 0),
      context: turns.at(-1)?.context ?? 0
    });
  }
  return subagents.sort((a, b) => b.processed - a.processed);
}
function modelOf(raw) {
  try {
    const model = raw ? JSON.parse(raw) : null;
    return model?.id ? `${model.providerID}/${model.id}` : null;
  } catch {
    return null;
  }
}

// service/main.ts
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
var CONTEXT_PATH = "/context";
var notFound = (reason) => ({ status: "not-found", reason });

class ReadError extends Error {
  reason;
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
async function readContext(body) {
  let request;
  try {
    request = JSON.parse(body || "{}");
  } catch {
    return notFound("bad-request");
  }
  if (typeof request.sessionId !== "string" || request.sessionId === "") {
    return notFound("no-session");
  }
  const model = typeof request.model === "string" ? request.model : null;
  const sessionId = request.sessionId;
  let usage;
  try {
    usage = await readUsage(sessionId);
  } catch (error) {
    return notFound(error instanceof ReadError ? error.reason : "failed");
  }
  if (!usage) {
    return notFound("no-data");
  }
  const [parts, subagents] = await Promise.all([readPromptParts(sessionId), readSubagents(sessionId, (id) => readUsage(id).catch(() => null))]);
  return buildReport(usage, parts, subagents, model);
}
async function readUsage(sessionId) {
  let claudeCode;
  try {
    claudeCode = readClaudeCodeSession(sessionId);
  } catch {
    throw new ReadError("transcript-unreadable");
  }
  if (claudeCode && claudeCode.turns.length > 0)
    return claudeCode;
  try {
    return await readOpenCodeSession(sessionId) ?? claudeCode;
  } catch (error) {
    if (claudeCode)
      return claudeCode;
    throw new ReadError(error instanceof OpenCodeUnavailableError ? "node-too-old" : "database-unreadable");
  }
}
http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end();
    return;
  }
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/health") {
    res.writeHead(200).end("{}");
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (path !== CONTEXT_PATH || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    readContext(body).catch(() => notFound("failed")).then((report) => {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(report));
    });
  });
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), "127.0.0.1");
