// Tolerant reader for Claude Code transcript JSONL (R11). Only user / assistant records are read; unknown lines are skipped.
// Token rule (Phase 0 §5): one API message is split into several assistant lines that repeat the same usage,
// so usage is counted once per message.id (falling back to requestId, then the line uuid).
import fs from 'node:fs';
import path from 'node:path';
import type { TokenUsage, TranscriptItem } from '@ccgs/shared';
import { redactString } from './redact';

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, messages: 0 });
export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input, output: a.output + b.output, cacheCreation: a.cacheCreation + b.cacheCreation,
  cacheRead: a.cacheRead + b.cacheRead, messages: a.messages + b.messages,
});

export interface ParsedTranscript { usage: TokenUsage; models: string[]; items: TranscriptItem[] }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function parseTranscript(text: string, opts: { sidechain?: boolean } = {}): ParsedTranscript {
  const usage = emptyUsage();
  const models = new Set<string>();
  const seen = new Set<string>();
  const items: TranscriptItem[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.type !== 'user' && r?.type !== 'assistant') continue;
    // The main transcript may carry sidechain (subagent) lines in older versions; those belong to the subagent file.
    if (opts.sidechain === false && r.isSidechain === true) continue;
    const m = r.message;
    if (!m || typeof m !== 'object') continue;
    const at: string | null = typeof r.timestamp === 'string' ? r.timestamp : null;

    if (r.type === 'assistant') {
      if (m.model && m.model !== '<synthetic>') models.add(String(m.model));
      const key = String(m.id ?? r.requestId ?? r.uuid ?? '');
      if (m.usage && key && !seen.has(key)) {
        seen.add(key);
        const u = m.usage;
        usage.input += num(u.input_tokens); usage.output += num(u.output_tokens);
        usage.cacheCreation += num(u.cache_creation_input_tokens); usage.cacheRead += num(u.cache_read_input_tokens);
        usage.messages++;
      }
    }

    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        const text = redactString(cut(c.text, 20000));
        items.push(r.type === 'user' ? { kind: 'user', at, text } : { kind: 'assistant', at, text, model: m.model ?? null });
      } else if (c?.type === 'tool_use') {
        items.push({ kind: 'tool_use', at, id: String(c.id ?? ''), name: String(c.name ?? '?'), input: redactString(cut(JSON.stringify(c.input ?? null), 4000)) });
      } else if (c?.type === 'tool_result') {
        const t = typeof c.content === 'string' ? c.content
          : Array.isArray(c.content) ? c.content.map((x: any) => (x?.type === 'text' ? x.text : `[${x?.type ?? '?'}]`)).join('\n') : '';
        items.push({ kind: 'tool_result', at, toolUseId: String(c.tool_use_id ?? ''), text: redactString(cut(t, 4000)), isError: !!c.is_error });
      }
    }
  }
  return { usage, models: [...models], items };
}

/** Cache by (file, size, mtime) so repeated views do not re-read big transcripts. */
const cache = new Map<string, { size: number; mtime: number; sidechain: boolean | undefined; parsed: ParsedTranscript }>();
export function readTranscript(file: string, opts: { sidechain?: boolean } = {}): ParsedTranscript | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const c = cache.get(file);
  if (c && c.size === st.size && c.mtime === st.mtimeMs && c.sidechain === opts.sidechain) return c.parsed;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const parsed = parseTranscript(text, opts);
  if (cache.size > 200) cache.clear();
  cache.set(file, { size: st.size, mtime: st.mtimeMs, sidechain: opts.sidechain, parsed });
  return parsed;
}

/** Subagent transcript path: the one from hooks, else <session dir>/<session id>/subagents/agent-<id>.jsonl. */
export function subagentTranscript(agentId: string, known: string | null, sessionTranscript: string | null, sessionId: string): string | null {
  if (known && fs.existsSync(known)) return known;
  if (!sessionTranscript) return known;
  const guess = path.join(path.dirname(sessionTranscript), sessionId, 'subagents', `agent-${agentId}.jsonl`);
  return fs.existsSync(guess) ? guess : known;
}
