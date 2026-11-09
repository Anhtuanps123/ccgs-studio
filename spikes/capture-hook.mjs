// Phase 0 capture hook: append raw stdin + selected env to a JSONL file. Always exit 0.
import fs from 'node:fs';
const t0 = Date.now();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (buf += c));
process.stdin.on('end', () => {
  try {
    const rec = {
      _recv: new Date().toISOString(),
      _env: { CCGS_STUDIO_TASK_ID: process.env.CCGS_STUDIO_TASK_ID ?? null, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null, ppid: process.ppid },
      payload: (() => { try { return JSON.parse(buf); } catch { return { _raw: buf }; } })(),
    };
    rec._ms = Date.now() - t0;
    fs.appendFileSync(new URL('./captures/events.jsonl', import.meta.url), JSON.stringify(rec) + '\n');
  } catch {}
  process.exit(0);
});
setTimeout(() => process.exit(0), 800);
