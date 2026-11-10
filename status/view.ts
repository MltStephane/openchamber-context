import type { Category, CategoryId, CategoryItem, ContextReport, Source } from '../service/breakdown.ts';
import { messagesFor } from './i18n.ts';
import type { Messages } from './i18n.ts';

export type Report = Extract<ContextReport, { status: 'ok' }>;

const WARNING_PERCENT = 70;
const ERROR_PERCENT = 90;
const CHART_HEIGHT = 32;
const MAX_ITEMS = 12;

const SOURCE_LABELS: Record<Source, string> = { opencode: 'OpenCode', 'claude-code': 'Claude Code' };

// The host's language: words from its catalog, numbers in its format. English until it says.
let m: Messages = messagesFor('en').messages;
let numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
let percentFormat = new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 1 });

export function setLocale(hostLocale: string | undefined): Messages {
  const chosen = messagesFor(hostLocale);
  m = chosen.messages;
  const locale = Intl.NumberFormat.supportedLocalesOf(chosen.locale)[0] ?? 'en';
  numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return m;
}

/** A category's name; the system part is named for what it still holds once the measured parts are out. */
function categoryLabel(id: CategoryId, report: Report): string {
  if (id !== 'system') return m.category[id];
  return report.categories.some((category) => PROMPT_IDS.includes(category.id) && category.id !== 'system' && category.tokens > 0)
    ? m.category.system
    : m.category.systemOnly;
}

const itemLabel = (item: Pick<CategoryItem, 'label' | 'translate'>) => (item.translate ? (m.item[item.label] ?? item.label) : item.label);

/** What the model is given before anyone speaks, then what the conversation adds. */
const PROMPT_IDS: CategoryId[] = ['system', 'agent', 'instructions', 'skills', 'mcp', 'codemode', 'openchamber', 'environment', 'other'];
const CONVERSATION_IDS: CategoryId[] = ['tools', 'messages'];

const CATEGORY_COLORS: Record<CategoryId, string> = {
  system: 'color-mix(in srgb, var(--oc-muted) 75%, transparent)',
  agent: 'var(--oc-error)',
  instructions: 'var(--oc-warning)',
  skills: 'color-mix(in srgb, var(--oc-warning) 55%, var(--oc-success))',
  mcp: 'color-mix(in srgb, var(--oc-info) 50%, var(--oc-success))',
  codemode: 'color-mix(in srgb, var(--oc-warning) 50%, var(--oc-error))',
  openchamber: 'color-mix(in srgb, var(--oc-primary) 50%, var(--oc-info))',
  environment: 'color-mix(in srgb, var(--oc-muted) 50%, var(--oc-warning))',
  other: 'color-mix(in srgb, var(--oc-muted) 50%, var(--oc-info))',
  tools: 'var(--oc-success)',
  messages: 'var(--oc-primary)',
  free: 'transparent',
};

/** What the page keeps across refreshes, so a turn ending does not undo what the user opened. */
export type ViewState = { open: Set<string>; sections: Map<string, boolean> };

// The cache line counts down on its own; a new render replaces the timer.
let cacheTimer: ReturnType<typeof setInterval> | undefined;
const CACHE_TICK_MS = 30_000;

export function renderReport(root: HTMLElement, report: Report, state: ViewState) {
  const percent = (report.total / report.limit) * 100;
  const tone = percent >= ERROR_PERCENT ? 'error' : percent >= WARNING_PERCENT ? 'warning' : '';
  const shown = report.categories.filter((category) => category.tokens > 0 && category.id !== 'free');
  const { compaction } = report;
  // Like /context: the room kept for compaction is not free to use.
  const reserve = Math.min(compaction.buffer, Math.max(0, report.limit - report.total));
  const freeTokens = Math.max(0, report.limit - report.total - reserve);

  root.append(drawHeader(report, percent, tone, shown));

  const legend = el('div', 'cx-legend');
  legend.append(
    group(m.group.prompt, shown.filter((category) => PROMPT_IDS.includes(category.id)), report, state),
    group(m.group.conversation, shown.filter((category) => CONVERSATION_IDS.includes(category.id)), report, state),
  );
  const free = el('div', 'cx-row cx-row-free');
  free.append(el('span', 'cx-chevron'), swatch('free'), labelOf(m.category.free), ...numbers(freeTokens, report.limit));
  legend.append(free);
  if (reserve > 0) {
    const row = el('div', 'cx-row cx-row-free');
    row.append(el('span', 'cx-chevron'), swatch('reserve'), labelOf(m.category.reserve), ...numbers(reserve, report.limit));
    if (report.compactionEstimated) row.title = m.compaction.reserveEstimated;
    legend.append(row);
  }
  root.append(legend);

  root.append(...[contributorsSection(report, state), unusedSection(report, state), subagentsSection(report, state)].filter((node): node is HTMLElement => node !== null));

  const footer = el('footer', 'cx-footer');
  if (report.history.length > 1) {
    const trend = el('div', 'cx-trend');
    trend.append(el('div', 'cx-caption', m.trend(report.history.length)), drawHistory(report.history));
    footer.append(trend);
  }
  const facts = el('div', 'cx-facts');
  facts.append(
    fact(m.facts.source, SOURCE_LABELS[report.source]),
    ...(compaction.growth ? [fact(m.facts.growth, m.facts.perCall(formatTokens(compaction.growth)))] : []),
    fact(m.facts.cacheRead, `${formatTokens(report.cacheRead)} (${formatPercent((report.cacheRead / report.total) * 100)})`),
    fact(m.facts.lastOutput, formatTokens(report.output)),
  );
  footer.append(facts, el('div', 'cx-caption', m.estimateNote));
  root.append(footer);
}

/**
 * The top of the page: the share used, the model, a meter of the window with the compaction
 * threshold on it, then pills for what comes next: the cache, and compaction once it is due.
 */
function drawHeader(report: Report, percent: number, tone: string, shown: Category[]): HTMLElement {
  const { compaction } = report;
  const header = el('header', 'cx-header');
  if (tone) header.dataset.tone = tone;

  const top = el('div', 'cx-head-top');
  const figures = el('div', 'cx-figures');
  figures.append(el('span', 'cx-percent', formatPercent(percent)), el('span', 'cx-usage', m.tokensOf(formatTokens(report.total), formatTokens(report.limit))));
  top.append(figures);
  if (report.model) top.append(modelChip(report));
  header.append(top);

  // The bar is the whole window, one block per category in the legend's colors and order; the
  // hatched end is the reserve, and the tick where compaction starts.
  const meter = el('div', 'cx-meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(report.limit));
  meter.setAttribute('aria-valuenow', String(report.total));
  meter.setAttribute('aria-label', m.tokensOf(formatTokens(report.total), formatTokens(report.limit)));
  const share = (value: number) => `${Math.min(100, (value / report.limit) * 100)}%`;
  const reserve = el('span', 'cx-meter-reserve');
  reserve.style.left = share(compaction.threshold);
  const blocks = el('div', 'cx-meter-blocks');
  for (const category of shown) {
    const block = swatch(category.id);
    block.className = 'cx-block';
    // A tiny category keeps a sliver, so every legend color shows on the bar.
    block.style.width = `max(3px, ${share(category.tokens)})`;
    block.title = `${categoryLabel(category.id, report)} · ${formatTokens(category.tokens)} (${formatPercent((category.tokens / report.limit) * 100)})`;
    blocks.append(block);
  }
  const tick = el('span', 'cx-meter-tick');
  tick.style.left = share(compaction.threshold);
  meter.append(reserve, blocks, tick);
  header.append(meter);

  const threshold = `${m.compaction.at(formatTokens(compaction.threshold))}${report.compactionEstimated ? ` ${m.compaction.estimated}` : ''}`;
  const scale = el('div', 'cx-meter-scale');
  scale.append(el('span', 'cx-meter-threshold', threshold));
  header.append(scale);

  const pills = el('div', 'cx-pills');
  const cache = el('span', 'cx-pill');
  pills.append(cache, compactionPill(report));
  header.append(pills);

  clearInterval(cacheTimer);
  const paintCache = () => paintCachePill(cache, report);
  paintCache();
  if (report.cache.lastTurnAt) cacheTimer = setInterval(paintCache, CACHE_TICK_MS);
  return header;
}

/** The model, with its provider (or the harness) in front when the id does not carry it. */
function modelChip(report: Report): HTMLElement {
  const model = report.model ?? '';
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash) : SOURCE_LABELS[report.source];
  const name = slash > 0 ? model.slice(slash + 1) : model;
  const chip = el('span', 'cx-model');
  chip.title = `${model} · ${SOURCE_LABELS[report.source]}`;
  chip.append(el('span', 'cx-model-provider', provider), el('span', 'cx-model-name', name));
  return chip;
}

/** Shown only once the threshold is reached: the next call will compact. */
function compactionPill(report: Report): HTMLElement {
  const pill = el('span', 'cx-pill');
  if (report.total < report.compaction.threshold) {
    pill.hidden = true;
    return pill;
  }
  pill.dataset.tone = 'warning';
  pill.append(el('span', 'cx-pill-dot'), el('span', '', m.compaction.imminent));
  pill.title = m.compaction.reached(formatTokens(report.compaction.threshold));
  return pill;
}

/** Whether the prompt cache is still warm: past its lifetime, the next message is billed in full. */
function paintCachePill(node: HTMLElement, report: Report) {
  const { lastTurnAt, ttlMs, ttlKnown } = report.cache;
  if (!lastTurnAt) {
    node.hidden = true;
    return;
  }
  const elapsed = Date.now() - lastTurnAt;
  const lifetime = formatDuration(ttlMs);
  const cold = elapsed >= ttlMs;
  node.hidden = false;
  node.dataset.tone = cold ? 'warning' : 'success';
  node.replaceChildren(
    el('span', 'cx-pill-dot'),
    el('span', '', cold ? m.cache.coldShort(formatTokens(report.total)) : m.cache.warmShort(formatDuration(ttlMs - elapsed), ttlKnown)),
  );
  node.title = cold ? m.cache.cold(formatDuration(elapsed), lifetime, formatTokens(report.total), ttlKnown) : m.cache.warm(formatDuration(ttlMs - elapsed), lifetime, ttlKnown);
}

/** A titled block the user can fold; it remembers its state across refreshes. */
function section(key: string, title: string, summary: string, openByDefault: boolean, state: ViewState, body: HTMLElement[]): HTMLElement {
  const details = el('details', 'cx-section');
  details.open = state.sections.get(key) ?? openByDefault;
  details.addEventListener('toggle', () => state.sections.set(key, details.open));
  const head = el('summary', 'cx-section-heading');
  head.append(el('span', 'cx-chevron'), el('span', 'cx-section-title', title), el('span', 'cx-num cx-section-summary', summary));
  details.append(head, ...body);
  return details;
}

function contributorsSection(report: Report, state: ViewState): HTMLElement | null {
  if (report.contributors.length === 0) return null;
  const largest = report.contributors[0]!.tokens || 1;
  const rows = report.contributors.map((item) => {
    const row = el('div', 'cx-entry');
    const text = el('div', 'cx-entry-text');
    const label = el('span', 'cx-entry-label', itemLabel(item));
    // A tool output says what it touched; a prompt item, which part of the prompt it sits in.
    const about = item.detail || categoryLabel(item.category, report);
    const detail = el('span', 'cx-entry-detail', item.detail ? shortenPath(item.detail) : about);
    detail.title = about;
    text.append(swatch(item.category), label, detail);
    row.append(text, shareBar(item.tokens / largest, CATEGORY_COLORS[item.category]), el('span', 'cx-num', formatTokens(item.tokens)));
    return row;
  });
  return section('top', m.sections.top, '', true, state, [el('div', 'cx-entries', '', rows)]);
}

function unusedSection(report: Report, state: ViewState): HTMLElement | null {
  if (report.unused.length === 0) return null;
  const total = report.unused.reduce((sum, item) => sum + item.tokens, 0);
  // One line per category, its unused items named after it: a long list of small items says less.
  const groups = new Map<CategoryId, { tokens: number; labels: string[] }>();
  for (const item of [...report.unused].sort((a, b) => b.tokens - a.tokens)) {
    const group = groups.get(item.category) ?? { tokens: 0, labels: [] };
    group.tokens += item.tokens;
    group.labels.push(item.label);
    groups.set(item.category, group);
  }
    const rows = [...groups].sort(([, a], [, b]) => b.tokens - a.tokens).map(([id, group]) => {
    const row = el('div', 'cx-entry cx-entry-block');
    const text = el('div', 'cx-entry-text');
    text.append(swatch(id), el('span', 'cx-entry-label cx-entry-grow', `${categoryLabel(id, report)} · ${group.labels.length}`));
    row.append(text, el('span', 'cx-num', formatTokens(group.tokens)), el('div', 'cx-entry-list', group.labels.join(', ')));
    return row;
  });
  const hint = el('div', 'cx-caption', m.sections.unusedHint);
  return section('unused', m.sections.unused, `${report.unused.length} · ${formatTokens(total)}`, false, state, [hint, el('div', 'cx-entries', '', rows)]);
}

function subagentsSection(report: Report, state: ViewState): HTMLElement | null {
  if (report.subagents.length === 0) return null;
  const total = report.subagents.reduce((sum, item) => sum + item.processed, 0);
  const largest = Math.max(...report.subagents.map((item) => item.processed)) || 1;
  const rows = report.subagents.map((item) => {
    const row = el('div', 'cx-entry cx-entry-block cx-entry-bar');
    const label = el('span', 'cx-entry-label cx-entry-grow', item.title);
    label.title = item.title;
    const about = [item.agent, item.model, item.context ? m.sections.finalContext(formatTokens(item.context)) : ''].filter(Boolean).join(' · ');
    row.append(
      el('div', 'cx-entry-text', '', [label]),
      item.processed ? shareBar(item.processed / largest, 'var(--oc-primary)') : el('span'),
      el('span', 'cx-num', item.processed ? formatTokens(item.processed) : m.sections.noCalls),
      el('div', 'cx-entry-list', about),
    );
    return row;
  });
  const hint = el('div', 'cx-caption', m.sections.subagentsHint);
  return section('subagents', m.sections.subagents, `${report.subagents.length} · ${formatTokens(total)}`, false, state, [hint, el('div', 'cx-entries', '', rows)]);
}

/** A path keeps its end, where the file name is: /home/me/project/src/app.ts → …/src/app.ts. */
function shortenPath(text: string): string {
  if (!/^[~/]/.test(text) || /\s/.test(text)) return text;
  const segments = text.split('/').filter(Boolean);
  return segments.length > 2 ? `…/${segments.slice(-2).join('/')}` : text;
}

function shareBar(share: number, color: string): HTMLElement {
  const bar = el('span', 'cx-item-bar');
  bar.style.setProperty('--share', `${Math.max(2, share * 100)}%`);
  bar.style.setProperty('--color', color);
  return bar;
}

/** 45 s, 12 min, 1 h 05. */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return m.duration.seconds(Math.max(1, Math.round(ms / 1000)));
  if (minutes < 60) return m.duration.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours >= 48) return m.duration.days(Math.floor(hours / 24));
  return m.duration.hours(hours, String(minutes % 60).padStart(2, '0'));
}

/** A group heading with its subtotal, then one row per category. */
function group(name: string, categories: Category[], report: Report, state: ViewState): HTMLElement {
  const section = el('section', 'cx-group');
  if (categories.length === 0) return section;
  const subtotal = categories.reduce((total, category) => total + category.tokens, 0);
  const heading = el('div', 'cx-group-heading');
  heading.append(el('span', '', name), el('span', 'cx-num', formatTokens(subtotal)));
  section.append(heading);
  for (const category of categories) section.append(categoryRow(category, report, state));
  return section;
}

function categoryRow(category: Category, report: Report, state: ViewState): HTMLElement {
  const items = category.items ?? [];
  const row = el(items.length > 0 ? 'summary' : 'div', 'cx-row');
  row.append(el('span', 'cx-chevron'), swatch(category.id), labelOf(categoryLabel(category.id, report)), ...numbers(category.tokens, report.limit));

  // Pointing at a row lights its block on the bar.
  const highlight = (on: boolean) => {
    const blocks = document.querySelector('.cx-meter-blocks');
    blocks?.classList.toggle('cx-focus', on);
    blocks?.querySelector(`[data-id="${category.id}"]`)?.classList.toggle('cx-lit', on);
  };
  row.addEventListener('pointerenter', () => highlight(true));
  row.addEventListener('pointerleave', () => highlight(false));


  if (items.length === 0) return row;

  const details = el('details', 'cx-details');
  details.open = state.open.has(category.id);
  details.addEventListener('toggle', () => {
    if (details.open) state.open.add(category.id);
    else state.open.delete(category.id);
  });

  const list = el('div', 'cx-items');
  const largest = items[0]?.tokens || 1;
  const rest = items.slice(MAX_ITEMS);
  const lines = items.slice(0, MAX_ITEMS);
  const restLabel = rest.length > 0 ? m.others(rest.length) : null;
  if (restLabel) lines.push({ label: restLabel, tokens: rest.reduce((total, item) => total + item.tokens, 0) });
  for (const item of lines) {
    const line = el('div', 'cx-item');
    // The "N others" line adds up many items: a bar beside single ones would mislead.
    const bar = item.label === restLabel ? el('span') : shareBar(item.tokens / largest, CATEGORY_COLORS[category.id]);
    const text = itemLabel(item);
    const label = el('span', 'cx-item-label', text);
    label.title = item.calls === 0 ? `${text} · ${m.neverCalled}` : text;
    if (item.calls === 0) line.dataset.unused = '';
    line.append(label, bar, el('span', 'cx-num', formatTokens(item.tokens)));
    list.append(line);
  }
  details.append(row, list);
  return details;
}

function labelOf(text: string): HTMLElement {
  const node = el('span', 'cx-label', text);
  node.title = text;
  return node;
}

function numbers(tokens: number, limit: number): HTMLElement[] {
  return [el('span', 'cx-num', formatTokens(tokens)), el('span', 'cx-num cx-share', formatPercent((tokens / limit) * 100))];
}

function fact(label: string, value: string): HTMLElement {
  const node = el('div', 'cx-fact');
  node.append(el('span', 'cx-caption', label), el('span', 'cx-fact-value', value));
  return node;
}

function swatch(id: CategoryId | 'reserve'): HTMLElement {
  const node = el('span', 'cx-swatch');
  node.dataset.id = id;
  if (id !== 'free' && id !== 'reserve') node.style.background = CATEGORY_COLORS[id];
  return node;
}

/** Context size at each turn, oldest first, from zero to the largest. */
function drawHistory(history: number[]): SVGSVGElement {
  const width = 100;
  const max = Math.max(...history) || 1;
  const step = width / (history.length - 1);
  const y = (value: number) => (CHART_HEIGHT - (value / max) * (CHART_HEIGHT - 2) - 1).toFixed(2);
  const points = history.map((value, index) => `${(index * step).toFixed(2)},${y(value)}`);
  const svg = svgEl('svg', { class: 'cx-history', viewBox: `0 0 ${width} ${CHART_HEIGHT}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  svg.append(
    svgEl('polygon', { points: `0,${CHART_HEIGHT} ${points.join(' ')} ${width},${CHART_HEIGHT}`, fill: 'color-mix(in srgb, var(--oc-primary) 15%, transparent)' }),
    svgEl('polyline', { points: points.join(' '), fill: 'none', stroke: 'var(--oc-primary)', 'stroke-width': '1.5', 'vector-effect': 'non-scaling-stroke' }),
  );
  return svg;
}


/** 950, 1,2 k, 142 k, 1 M: the scale Claude Code's /context uses. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${numberFormat.format(tokens / 1_000_000)} M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)} k`;
  if (tokens >= 1000) return `${numberFormat.format(tokens / 1000)} k`;
  return String(tokens);
}

/** 0,2 %, 8 %, 88,2 % (8.4% in English); under 0.1 %, says so rather than 0 %. */
function formatPercent(percent: number): string {
  if (percent > 0 && percent < 0.1) return `< ${percentFormat.format(0.001)}`;
  return percentFormat.format(percent / 100);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '', children: Node[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  node.append(...children);
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

export const STYLES = `
  html, body { margin: 0; background: transparent; }
  body { container-type: inline-size; color: var(--oc-fg); font-family: var(--oc-font, system-ui, sans-serif); }
  #root { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.5rem 0.75rem 0.75rem; font-size: 0.8125rem; line-height: 1.35; }
  .cx-caption { color: var(--oc-muted); font-size: 0.7rem; }
  .cx-num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }

  .cx-header { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.65rem 0.7rem 0.6rem; border-radius: 8px; background: color-mix(in srgb, var(--oc-muted) 8%, transparent); --cx-tone: var(--oc-primary); --cx-tone-text: var(--oc-fg); }
  .cx-header[data-tone="warning"] { --cx-tone: var(--oc-warning); --cx-tone-text: var(--oc-warning-text, var(--oc-warning)); }
  .cx-header[data-tone="error"] { --cx-tone: var(--oc-error); --cx-tone-text: var(--oc-error-text, var(--oc-error)); }
  .cx-head-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; }
  .cx-figures { display: flex; flex-direction: column; gap: 0.05rem; }
  .cx-percent { font-size: 1.6rem; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; color: var(--cx-tone-text); }
  .cx-usage { color: var(--oc-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
  .cx-model { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; border-radius: 999px; overflow: hidden; font-size: 0.7rem; box-shadow: inset 0 0 0 1px var(--oc-border); }
  .cx-model-provider { padding: 0.15rem 0.45rem; color: var(--oc-muted); background: color-mix(in srgb, var(--oc-muted) 12%, transparent); white-space: nowrap; }
  .cx-model-name { padding: 0.15rem 0.5rem; font-family: var(--oc-mono, ui-monospace, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  .cx-meter { position: relative; height: 10px; border-radius: 3px; background: color-mix(in srgb, var(--oc-muted) 16%, transparent); margin-top: 0.25rem; }
  .cx-meter-blocks { position: absolute; inset: 0; display: flex; gap: 1px; overflow: hidden; border-radius: 3px; }
  .cx-block { flex: none; height: 100%; transition: opacity 120ms; }
  .cx-meter-blocks.cx-focus .cx-block:not(.cx-lit) { opacity: 0.25; }
  .cx-meter-reserve { position: absolute; top: 0; bottom: 0; right: 0; border-radius: 0 3px 3px 0; background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--oc-muted) 40%, transparent) 0 1px, transparent 1px 3px); }
  .cx-meter-tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--oc-fg); opacity: 0.55; }
  .cx-meter-scale { display: flex; justify-content: flex-end; color: var(--oc-muted); font-size: 0.68rem; font-variant-numeric: tabular-nums; }
  .cx-meter-threshold { text-align: right; }

  .cx-pills { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem; }
  .cx-pill { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.15rem 0.55rem 0.15rem 0.45rem; border-radius: 999px; font-size: 0.72rem; background: color-mix(in srgb, var(--oc-muted) 12%, transparent); cursor: default; --cx-dot: var(--oc-muted); }
  .cx-pill[hidden] { display: none; }
  .cx-pill[data-tone="success"] { --cx-dot: var(--oc-success); }
  .cx-pill[data-tone="warning"] { --cx-dot: var(--oc-warning); color: var(--oc-warning-text, var(--oc-warning)); background: color-mix(in srgb, var(--oc-warning) 14%, transparent); }
  .cx-pill-dot { width: 0.45rem; height: 0.45rem; border-radius: 999px; background: var(--cx-dot); flex: none; }


  .cx-swatch[data-id="reserve"] {
    background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--oc-muted) 45%, transparent) 0 1px, transparent 1px 3px);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--oc-muted) 45%, transparent);
  }

  .cx-section { border-top: 1px solid var(--oc-border); padding-top: 0.5rem; }
  .cx-section > summary { cursor: pointer; list-style: none; }
  .cx-section > summary::-webkit-details-marker { display: none; }
  .cx-section-heading { display: grid; grid-template-columns: 0.75rem minmax(0, 1fr) auto; align-items: center; gap: 0.45rem; padding: 0.2rem 0.35rem; border-radius: 4px; }
  .cx-section-heading:hover { background: var(--oc-hover, color-mix(in srgb, var(--oc-muted) 10%, transparent)); }
  .cx-section-heading .cx-chevron::before { content: '›'; display: inline-block; color: var(--oc-muted); transition: transform 120ms; }
  .cx-section[open] > .cx-section-heading .cx-chevron::before { transform: rotate(90deg); }
  .cx-section-title { font-weight: 600; }
  .cx-section-summary { color: var(--oc-muted); }
  .cx-section > .cx-caption { margin: 0.2rem 0.35rem 0.35rem 1.55rem; }
  .cx-entries { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.3rem 0.35rem 0.2rem 1.55rem; font-size: 0.75rem; }
  .cx-entry { display: grid; grid-template-columns: minmax(0, 1fr) minmax(2rem, 25%) 3.6rem; align-items: center; gap: 0.5rem; }
  .cx-entry-text { display: flex; align-items: center; gap: 0.4rem; min-width: 0; }
  .cx-entry-text .cx-swatch { flex: none; }
  .cx-entry-label { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-entry-grow { flex: 1; max-width: none; }
  .cx-entry-block { row-gap: 0.1rem; grid-template-columns: minmax(0, 1fr) auto; }
  .cx-entry-block.cx-entry-bar { grid-template-columns: minmax(0, 1fr) minmax(2rem, 25%) 3.6rem; }
  .cx-entry-list { grid-column: 1 / -1; padding-left: 1.05rem; font-size: 0.7rem; color: var(--oc-muted); overflow-wrap: anywhere; }
  .cx-entry-detail { color: var(--oc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  .cx-legend { display: flex; flex-direction: column; gap: 0.6rem; }
  .cx-group { display: flex; flex-direction: column; gap: 1px; }
  .cx-group:empty { display: none; }
  .cx-group-heading { display: flex; justify-content: space-between; padding: 0 0.35rem 0.2rem; color: var(--oc-muted); font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .cx-row { display: grid; grid-template-columns: 0.75rem 0.65rem minmax(0, 1fr) auto 3.4rem; align-items: center; gap: 0.45rem; padding: 0.3rem 0.35rem; border-radius: 4px; }
  .cx-row:hover { background: var(--oc-hover, color-mix(in srgb, var(--oc-muted) 10%, transparent)); }
  .cx-row-free { color: var(--oc-muted); }
  .cx-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-share { color: var(--oc-muted); }
  .cx-swatch { width: 0.65rem; height: 0.65rem; border-radius: 2px; }
  .cx-swatch[data-id="free"] { box-shadow: inset 0 0 0 1px var(--oc-border); }

  .cx-details > summary { cursor: pointer; list-style: none; }
  .cx-details > summary::-webkit-details-marker { display: none; }
  .cx-details > summary .cx-chevron::before { content: '›'; display: inline-block; color: var(--oc-muted); transition: transform 120ms; }
  .cx-details[open] > summary .cx-chevron::before { transform: rotate(90deg); }
  .cx-details > summary:focus-visible { outline: 1px solid var(--oc-primary); outline-offset: -1px; }
  .cx-items { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.15rem 0 0.4rem 1.55rem; padding-left: 0.6rem; border-left: 1px solid var(--oc-border); font-size: 0.75rem; }
  .cx-item { display: grid; grid-template-columns: minmax(0, 1fr) minmax(2rem, 30%) 3rem; align-items: center; gap: 0.5rem; }
  .cx-item[data-unused] .cx-item-label { color: var(--oc-muted); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--oc-muted) 60%, transparent); }
  .cx-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cx-item-bar { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--color) var(--share), color-mix(in srgb, var(--oc-muted) 12%, transparent) var(--share)); }

  .cx-footer { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.6rem; border-top: 1px solid var(--oc-border); }
  .cx-trend { display: flex; flex-direction: column; gap: 0.2rem; }
  .cx-history { width: 100%; height: ${CHART_HEIGHT}px; display: block; }
  .cx-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr)); gap: 0.5rem; }
  .cx-fact { display: flex; flex-direction: column; gap: 0.05rem; }
  .cx-fact-value { font-variant-numeric: tabular-nums; }

  @media (prefers-reduced-motion: reduce) { .cx-chevron::before, .cx-block { transition: none; } }
`;
