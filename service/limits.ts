const DEFAULT_LIMIT = 200_000;
const ONE_MILLION = 1_000_000;

/**
 * Models with a 1M window whose id does not say so. Taken from the local
 * Claude catalog (~/.local/share/opencode-claude/models.json) on 2026-11-09,
 * for when that file is missing.
 */
const KNOWN_LIMITS: Record<string, number> = {
  'claude-sonnet-5-5': ONE_MILLION,
  'claude-haiku-5-5': ONE_MILLION,
  'claude-sonnet-5': ONE_MILLION,
  'claude-opus-4-8': ONE_MILLION,
  'claude-opus-4-7': ONE_MILLION,
};

/** The catalog's window when a source gives one, else what the model id tells. */
export function contextLimit(model: string | null, catalogLimit: number | null): number {
  if (catalogLimit && catalogLimit > 0) return catalogLimit;
  if (!model) return DEFAULT_LIMIT;
  const id = model.toLowerCase();
  if (id.includes('1m')) return ONE_MILLION;
  const bareId = id.slice(id.lastIndexOf('/') + 1);
  return KNOWN_LIMITS[bareId] ?? DEFAULT_LIMIT;
}
