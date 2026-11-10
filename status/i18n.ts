import type { CategoryId, NotFoundReason } from '../service/breakdown.ts';

/** Every word the page shows, in one language. Functions take what the sentence needs. */
export type Messages = {
  category: Record<CategoryId, string> & { systemOnly: string; reserve: string };
  /** Items the service names by a key: message kinds and the environment blocks. */
  item: Record<string, string>;
  group: { prompt: string; conversation: string };
  tokensOf: (used: string, limit: string) => string;
  compaction: {
    at: (threshold: string) => string;
    reached: (threshold: string) => string;
    estimated: string;
    reserveEstimated: string;
    imminent: string;
  };
  cache: {
    warm: (left: string, lifetime: string, known: boolean) => string;
    cold: (elapsed: string, lifetime: string, tokens: string, known: boolean) => string;
    warmShort: (left: string, known: boolean) => string;
    coldShort: (tokens: string) => string;
  };
  sections: {
    top: string;
    unused: string;
    unusedHint: string;
    subagents: string;
    subagentsHint: string;
    finalContext: (tokens: string) => string;
    noCalls: string;
  };
  others: (count: number) => string;
  neverCalled: string;
  facts: { source: string; growth: string; perCall: (tokens: string) => string; cacheRead: string; lastOutput: string };
  trend: (turns: number) => string;
  estimateNote: string;
  duration: { seconds: (n: number) => string; minutes: (n: number) => string; hours: (h: number, m: string) => string; days: (n: number) => string };
  empty: {
    loading: string;
    noSession: [string, string];
    noTurn: [string, string];
    notFound: string;
    unreachable: string;
    reasons: Record<NotFoundReason, string>;
  };
};

const fr: Messages = {
  category: {
    system: 'Système et définitions des outils',
    systemOnly: 'Système et outils',
    agent: "Prompt de l'agent",
    instructions: 'Instructions (AGENTS.md)',
    skills: 'Skills',
    mcp: 'Consignes MCP',
    codemode: 'Catalogue Code Mode',
    openchamber: 'Contexte OpenChamber',
    environment: 'Environnement',
    other: 'Autres instructions',
    tools: "Sorties d'outils",
    messages: 'Messages',
    free: 'Libre',
    reserve: 'Réserve de compaction',
  },
  item: {
    user: 'Tes messages',
    notices: 'Notices et retours de sous-agents',
    text: "Réponses de l'agent",
    reasoning: 'Raisonnement',
    toolCalls: "Appels d'outils",
    environment: 'Environnement',
    date: 'Date',
  },
  group: { prompt: 'Prompt', conversation: 'Conversation' },
  tokensOf: (used, limit) => `${used} / ${limit} tokens`,
  compaction: {
    at: (threshold) => `Compaction à ${threshold}`,
    imminent: 'Compaction au prochain appel',
    reached: (threshold) => `Seuil de compaction atteint (${threshold}) : la prochaine réponse résumera la conversation.`,
    estimated: '(estimé)',
    reserveEstimated: 'Estimée : Claude Code ne documente pas cette réserve.',
  },
  cache: {
    warm: (left, lifetime, known) => `Cache ${known ? 'chaud' : 'probablement chaud'} encore ≈ ${left} (durée ${lifetime}).`,
    cold: (elapsed, lifetime, tokens, known) =>
      `Cache ${known ? 'expiré' : 'probablement expiré'} : dernier appel il y a ${elapsed} (durée ${lifetime}). Le prochain message relira ≈ ${tokens} tokens sans cache.`,
    warmShort: (left, known) => `Cache chaud${known ? '' : ' ?'} · ${left}`,
    coldShort: (tokens) => `Cache froid · ${tokens} à relire`,
  },
  sections: {
    top: 'Plus gros éléments',
    unused: 'Chargés sans servir',
    unusedHint: "Jamais appelés dans cette session. Les retirer de l'agent libère ces tokens à chaque appel.",
    subagents: 'Sous-agents',
    subagentsHint: 'Tokens traités par chaque sous-agent (contexte et sortie de tous ses appels). Ils ne pèsent pas sur ce contexte, seulement sur le coût.',
    finalContext: (tokens) => `contexte final ${tokens}`,
    noCalls: 'aucun appel',
  },
  others: (count) => `${count} ${count > 1 ? 'autres' : 'autre'}`,
  neverCalled: 'jamais appelé dans cette session',
  facts: { source: 'Source', growth: 'Croissance', perCall: (tokens) => `≈ ${tokens} par appel`, cacheRead: 'Cache lu', lastOutput: 'Dernière sortie' },
  trend: (turns) => `Évolution sur ${turns} tours`,
  estimateNote: 'Estimation : ≈ 4 caractères par token. Seul le total est exact.',
  duration: {
    seconds: (n) => `${n} s`,
    minutes: (n) => `${n} min`,
    hours: (h, m) => `${h} h ${m}`,
    days: (n) => `${n} j`,
  },
  empty: {
    loading: 'Lecture du contexte…',
    noSession: ['Aucune session ouverte', 'Ouvre une session pour voir son contexte.'],
    noTurn: ['Pas encore de réponse', "Le contexte apparaît après la première réponse de l'agent."],
    notFound: 'Contexte introuvable',
    unreachable: "Le service Contexte ne répond pas. Vérifie qu'il est approuvé dans Réglages → Extensions.",
    reasons: {
      'bad-request': 'Demande illisible : rouvre la section.',
      'no-session': 'Ouvre une session pour voir son contexte.',
      'no-data':
        'Aucune donnée pour cette session dans OpenCode (~/.local/share/opencode) ni dans Claude Code (~/.claude/projects). Envoie un message dans la session, puis rouvre la section.',
      'node-too-old': 'La base OpenCode demande Node 22.5 ou plus récent pour être lue.',
      'database-unreadable': 'La base OpenCode est illisible pour le moment.',
      'transcript-unreadable': 'Le journal Claude Code de cette session est illisible pour le moment. Réessaie après le prochain tour.',
      failed: 'Lecture du contexte impossible pour le moment.',
    },
  },
};

const en: Messages = {
  category: {
    system: 'System and tool definitions',
    systemOnly: 'System and tools',
    agent: 'Agent prompt',
    instructions: 'Instructions (AGENTS.md)',
    skills: 'Skills',
    mcp: 'MCP instructions',
    codemode: 'Code Mode catalog',
    openchamber: 'OpenChamber context',
    environment: 'Environment',
    other: 'Other instructions',
    tools: 'Tool outputs',
    messages: 'Messages',
    free: 'Free',
    reserve: 'Compaction reserve',
  },
  item: {
    user: 'Your messages',
    notices: 'Notices and subagent results',
    text: 'Agent replies',
    reasoning: 'Reasoning',
    toolCalls: 'Tool calls',
    environment: 'Environment',
    date: 'Date',
  },
  group: { prompt: 'Prompt', conversation: 'Conversation' },
  tokensOf: (used, limit) => `${used} / ${limit} tokens`,
  compaction: {
    at: (threshold) => `Compaction at ${threshold}`,
    imminent: 'Compaction on the next call',
    reached: (threshold) => `Compaction threshold reached (${threshold}): the next reply will summarize the conversation.`,
    estimated: '(estimated)',
    reserveEstimated: 'Estimated: Claude Code does not document this reserve.',
  },
  cache: {
    warm: (left, lifetime, known) => `Cache ${known ? 'warm' : 'probably warm'} for ≈ ${left} more (lifetime ${lifetime}).`,
    cold: (elapsed, lifetime, tokens, known) =>
      `Cache ${known ? 'expired' : 'probably expired'}: last call ${elapsed} ago (lifetime ${lifetime}). The next message will read ≈ ${tokens} tokens without cache.`,
    warmShort: (left, known) => `Cache warm${known ? '' : '?'} · ${left}`,
    coldShort: (tokens) => `Cache cold · ${tokens} to reread`,
  },
  sections: {
    top: 'Largest items',
    unused: 'Loaded but unused',
    unusedHint: 'Never called in this session. Removing them from the agent frees these tokens on every call.',
    subagents: 'Subagents',
    subagentsHint: 'Tokens each subagent processed (context and output of all its calls). They do not weigh on this context, only on cost.',
    finalContext: (tokens) => `final context ${tokens}`,
    noCalls: 'no calls',
  },
  others: (count) => `${count} ${count > 1 ? 'others' : 'other'}`,
  neverCalled: 'never called in this session',
  facts: { source: 'Source', growth: 'Growth', perCall: (tokens) => `≈ ${tokens} per call`, cacheRead: 'Cache read', lastOutput: 'Last output' },
  trend: (turns) => `Last ${turns} turns`,
  estimateNote: 'Estimate: ≈ 4 characters per token. Only the total is exact.',
  duration: {
    seconds: (n) => `${n} s`,
    minutes: (n) => `${n} min`,
    hours: (h, m) => `${h} h ${m}`,
    days: (n) => `${n} d`,
  },
  empty: {
    loading: 'Reading the context…',
    noSession: ['No session open', 'Open a session to see its context.'],
    noTurn: ['No reply yet', "The context shows after the agent's first reply."],
    notFound: 'Context not found',
    unreachable: 'The Context service does not answer. Check that it is approved in Settings → Extensions.',
    reasons: {
      'bad-request': 'Unreadable request: reopen the section.',
      'no-session': 'Open a session to see its context.',
      'no-data':
        'No data for this session in OpenCode (~/.local/share/opencode) or Claude Code (~/.claude/projects). Send a message in the session, then reopen the section.',
      'node-too-old': 'Reading the OpenCode database needs Node 22.5 or newer.',
      'database-unreadable': 'The OpenCode database cannot be read right now.',
      'transcript-unreadable': "This session's Claude Code transcript cannot be read right now. Try again after the next turn.",
      failed: 'The context cannot be read right now.',
    },
  },
};

const CATALOG: Record<string, Messages> = { fr, en };

/** The host's language when there is a translation for it, else English. */
export function messagesFor(locale: string | undefined): { locale: string; messages: Messages } {
  const language = (locale ?? 'en').toLowerCase().split(/[-_]/)[0]!;
  const messages = CATALOG[language];
  return messages ? { locale: locale!, messages } : { locale: 'en', messages: en };
}
