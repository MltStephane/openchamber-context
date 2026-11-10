import { connectHost } from '@openchamber/sdk';
import type { HostClient, SessionSnapshot } from '@openchamber/sdk';
import { applyHostReady, mountEmpty, mountSpinner } from '@openchamber/sdk/ui';

import type { ContextReport } from '../service/breakdown.ts';
import { STYLES, renderReport, setLocale } from './view.ts';
import type { ViewState } from './view.ts';
import type { Messages } from './i18n.ts';

const root = document.querySelector<HTMLElement>('#root')!;
let host: HostClient;
// Only the latest request may paint: an answer for a session left behind is dropped.
let loadRequest = 0;
let shownSessionKey: string | null = null;
let shownSessionId: string | null = null;
let shownLocale: string | undefined;
let m: Messages = setLocale(undefined);
const state: ViewState = { open: new Set(), sections: new Map() };

function boot() {
  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);
  // The host sizes the frame to the content, up to its own maximum.
  let reported = -1;
  new ResizeObserver(() => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height === reported) return;
    reported = height;
    void host.setHeight(height).catch(() => undefined);
  }).observe(root);

  host = connectHost();
  host.onReady((context) => {
    applyHostReady(context, document.documentElement);
    // A language change redraws: the same session would otherwise keep its old words.
    if (context.locale !== shownLocale) {
      shownLocale = context.locale;
      m = setLocale(context.locale);
      document.documentElement.lang = context.locale || 'en';
      shownSessionKey = null;
    }
    // A turn ends when `busy` goes back to false: that is when the numbers move.
    const sessionKey = context.session ? `${context.session.id}|${context.session.busy}` : '';
    if (sessionKey === shownSessionKey) return;
    const sessionId = context.session?.id ?? null;
    const sessionChanged = sessionId !== shownSessionId;
    shownSessionKey = sessionKey;
    shownSessionId = sessionId;
    if (sessionChanged) {
      state.open.clear();
      state.sections.clear();
    }
    if (context.session) void load(context.session, sessionChanged);
    else showEmpty(...m.empty.noSession);
  });
}

async function load(session: SessionSnapshot, sessionChanged: boolean) {
  const request = ++loadRequest;
  // A new session starts on a spinner; the same session keeps its numbers until the new ones arrive.
  if (sessionChanged || !root.hasChildNodes()) {
    root.replaceChildren();
    mountSpinner(root, { size: 'sm', label: m.empty.loading });
  }
  let report: ContextReport;
  try {
    const result = await host.serviceRequest({
      method: 'POST',
      path: '/context',
      body: JSON.stringify({ sessionId: session.id, model: session.model }),
    });
    report = JSON.parse(result.body) as ContextReport;
  } catch {
    if (request === loadRequest) showEmpty(m.empty.notFound, m.empty.unreachable);
    return;
  }
  if (request !== loadRequest) return;
  if (report.status === 'ok') {
    root.replaceChildren();
    renderReport(root, report, state);
  } else if (report.status === 'no-turn') {
    showEmpty(...m.empty.noTurn);
  } else {
    showEmpty(m.empty.notFound, m.empty.reasons[report.reason] ?? m.empty.reasons.failed);
  }
}

function showEmpty(title: string, body?: string) {
  root.replaceChildren();
  mountEmpty(root, body ? { title, body } : { title });
}

boot();
