import type { SessionUsage, Subagent } from './breakdown.ts';
import { openDatabase } from './opencode.ts';

const MAX_SUBAGENTS = 20;

type ChildRow = { id: string; title: string | null; agent: string | null; model: string | null };

/**
 * The latest sessions this one started (OpenCode's `parent_id`), largest first, with what each one
 * processed: every call's context plus its answer, the tokens it was billed for.
 */
export async function readSubagents(sessionId: string, readUsage: (id: string) => Promise<SessionUsage | null>): Promise<Subagent[]> {
  const db = await openDatabase().catch(() => null);
  if (!db) return [];
  let children: ChildRow[];
  try {
    children = db
      .prepare(`SELECT id, title, agent, model FROM session_v2 WHERE parent_id = ? ORDER BY time_created DESC LIMIT ${MAX_SUBAGENTS}`)
      .all(sessionId) as ChildRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }

  const subagents: Subagent[] = [];
  for (const child of children) {
    const usage = await readUsage(child.id).catch(() => null);
    const turns = usage?.turns ?? [];
    subagents.push({
      id: child.id,
      title: child.title || child.id,
      agent: child.agent,
      model: usage?.model ?? modelOf(child.model),
      processed: turns.reduce((total, turn) => total + turn.context + turn.output, 0),
      context: turns.at(-1)?.context ?? 0,
    });
  }
  return subagents.sort((a, b) => b.processed - a.processed);
}

function modelOf(raw: string | null): string | null {
  try {
    const model = raw ? (JSON.parse(raw) as { id?: string; providerID?: string }) : null;
    return model?.id ? `${model.providerID}/${model.id}` : null;
  } catch {
    return null;
  }
}
