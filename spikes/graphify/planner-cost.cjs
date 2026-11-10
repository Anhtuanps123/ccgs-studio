// Spike (graphify Bước 0, mục 6): cost of past planner / critic tasks from the Studio DB (read-only).
// Counts tool calls per task from hook events (PreToolUse), split by tool, plus cost and tokens if known.
// Run from apps/server (needs better-sqlite3): node ../../spikes/graphify/planner-cost.cjs [taskId...]
const D = require('better-sqlite3');
const db = new D(process.env.USERPROFILE + '/.ccgs-studio/studio.db', { readonly: true });
const ids = process.argv.slice(2);
const tasks = ids.length
  ? ids.map(id => db.prepare('select * from tasks where id = ?').get(id)).filter(Boolean)
  : db.prepare("select * from tasks where kind = 'prompt' and (prompt like 'You are planning work%' or prompt like 'You review a work plan%' or prompt like 'A reviewer checked your plan%') order by created_at").all();
const kindOf = p => p.startsWith('You are planning') ? 'plan' : p.startsWith('You review') ? 'critic' : 'revise';
for (const t of tasks) {
  const ev = db.prepare("select tool_name, count(*) n from events where task_id = ? and event_type = 'PreToolUse' group by tool_name order by n desc").all(t.id);
  const total = ev.reduce((a, b) => a + b.n, 0);
  const req = (t.prompt.match(/"""\n([\s\S]*?)\n"""/) || [])[1] || '';
  const ms = t.started_at && t.ended_at ? Date.parse(t.ended_at) - Date.parse(t.started_at) : null;
  console.log(`${t.created_at} ${kindOf(t.prompt)} ${t.status} model=${t.model ?? 'default'} cost=${t.cost_usd ?? 'Unknown'} min=${ms ? (ms / 60000).toFixed(1) : 'Unknown'} tools=${total} ${ev.map(e => `${e.tool_name}:${e.n}`).join(' ')}`);
  console.log(`   request: ${req.replace(/\s+/g, ' ').slice(0, 110)}`);
}
