// Spike (graphify Bước 0, mục 6): token usage and tool calls of a Claude Code session, from its transcript.
// Usage: node session-tokens.cjs <transcripts-dir> <sessionId> [sinceIso] [untilIso]
// sinceIso: only count messages at/after this time (a resumed session holds earlier turns too).
const fs = require('node:fs');
const path = require('node:path');
const [dir, sid, since, until] = process.argv.slice(2);
const files = [path.join(dir, `${sid}.jsonl`)];
const sub = path.join(dir, sid, 'subagents');
if (fs.existsSync(sub)) for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f));
const tot = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 };
const tools = {};
const seen = new Set();
for (const f of files) {
  if (!fs.existsSync(f)) { console.log('missing', f); continue; }
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'assistant' || !m.message) continue;
    if (since && m.timestamp && m.timestamp < since) continue;
    if (until && m.timestamp && m.timestamp > until) continue;
    const id = m.message.id;
    for (const c of m.message.content ?? []) if (c.type === 'tool_use') tools[c.name] = (tools[c.name] ?? 0) + 1;
    if (id && seen.has(id)) continue; // one API message is split over several transcript lines
    if (id) seen.add(id);
    const u = m.message.usage ?? {};
    tot.input += u.input_tokens ?? 0; tot.cacheWrite += u.cache_creation_input_tokens ?? 0;
    tot.cacheRead += u.cache_read_input_tokens ?? 0; tot.output += u.output_tokens ?? 0; tot.turns++;
  }
}
console.log(JSON.stringify({ session: sid, files: files.length, ...tot, tools }));
