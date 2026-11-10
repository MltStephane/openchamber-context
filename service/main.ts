import http from 'node:http';

import { buildReport } from './breakdown.ts';
import type { ContextReport, NotFoundReason, SessionUsage } from './breakdown.ts';
import { readClaudeCodeSession } from './claude-code.ts';
import { OpenCodeUnavailableError, readOpenCodeSession } from './opencode.ts';
import { readPromptParts } from './prompt-parts.ts';
import { readSubagents } from './subagents.ts';

const token = process.env.OPENCHAMBER_SERVICE_TOKEN;
const CONTEXT_PATH = '/context';

type ContextRequest = { sessionId?: unknown; model?: unknown };

const notFound = (reason: NotFoundReason): ContextReport => ({ status: 'not-found', reason });

/** A read that failed for a reason the page can word. */
class ReadError extends Error {
  constructor(readonly reason: NotFoundReason) {
    super(reason);
  }
}

async function readContext(body: string): Promise<ContextReport> {
  let request: ContextRequest;
  try {
    request = JSON.parse(body || '{}') as ContextRequest;
  } catch {
    return notFound('bad-request');
  }
  if (typeof request.sessionId !== 'string' || request.sessionId === '') {
    return notFound('no-session');
  }
  const model = typeof request.model === 'string' ? request.model : null;
  const sessionId = request.sessionId;

  let usage: SessionUsage | null;
  try {
    usage = await readUsage(sessionId);
  } catch (error) {
    return notFound(error instanceof ReadError ? error.reason : 'failed');
  }
  if (!usage) {
    return notFound('no-data');
  }
  const [parts, subagents] = await Promise.all([readPromptParts(sessionId), readSubagents(sessionId, (id) => readUsage(id).catch(() => null))]);
  return buildReport(usage, parts, subagents, model);
}

/**
 * Claude Code first: OpenCode also logs those sessions, but only the transcript tells the cache
 * lifetime and keeps every tool result. Then OpenCode's own database.
 */
async function readUsage(sessionId: string): Promise<SessionUsage | null> {
  let claudeCode: SessionUsage | null;
  try {
    claudeCode = readClaudeCodeSession(sessionId);
  } catch {
    throw new ReadError('transcript-unreadable');
  }
  if (claudeCode && claudeCode.turns.length > 0) return claudeCode;
  try {
    return (await readOpenCodeSession(sessionId)) ?? claudeCode;
  } catch (error) {
    if (claudeCode) return claudeCode;
    throw new ReadError(error instanceof OpenCodeUnavailableError ? 'node-too-old' : 'database-unreadable');
  }
}

http
  .createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/health') {
      res.writeHead(200).end('{}');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (path !== CONTEXT_PATH || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
        return;
      }
      // readContext answers every problem with a note, so the page never sees a 500.
      readContext(body)
        .catch(() => notFound('failed'))
        .then((report) => {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(report));
        });
    });
  })
  .listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
