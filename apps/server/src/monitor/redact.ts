// Secret redaction applied BEFORE anything is stored (M-LG-02). Also caps long strings.

export const REDACTED = '[đã che]';
export const MAX_STRING = 8192;

// S-04 / S-05: user patterns and the per-string cap, set from settings.
let extra: RegExp[] = [];
let maxString = MAX_STRING;
export function configureRedaction(o: { patterns?: string[]; maxPayloadKB?: number }) {
  if (o.patterns) extra = o.patterns.flatMap(p => { try { return [new RegExp(p, 'g')]; } catch { return []; } });
  if (o.maxPayloadKB) maxString = Math.max(256, Math.round(o.maxPayloadKB * 1024));
}

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,                 // Anthropic
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // OpenAI / Stripe style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,  // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,             // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                         // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g,                     // Google API key
  /\bglpat-[A-Za-z0-9_-]{20,}/g,                   // GitLab
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

// key=value / key: value / "key": "value" where the key name looks secret.
const KEYED = /((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth(?:orization)?|access[_-]?key|private[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"'&,;]{6,})/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;
// Field names whose whole value is secret, whatever it looks like.
const SECRET_FIELD = /^(?:api[_-]?key|secret|token|password|passwd|authorization|x-studio-token|client[_-]?secret)$/i;

export function redactString(s: string): string {
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  for (const re of extra) out = out.replace(re, REDACTED);
  out = out.replace(BEARER, `$1 ${REDACTED}`);
  out = out.replace(KEYED, (_m, k: string, v: string) => (v === REDACTED ? k + v : k + REDACTED));
  if (out.length > maxString) out = out.slice(0, maxString) + `…[cắt ${out.length - maxString} ký tự]`;
  return out;
}

export function redact<T>(v: T, key?: string): T {
  if (typeof v === 'string') return (key && SECRET_FIELD.test(key) && v ? REDACTED : redactString(v)) as T;
  if (Array.isArray(v)) return v.map(x => redact(x)) as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = redact(x, k);
    return o as T;
  }
  return v;
}
