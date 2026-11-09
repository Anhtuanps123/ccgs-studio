// Phase 1 acceptance: edit an agent file externally, measure time until config:changed + API reflects it, restore bytes.
import fs from 'node:fs';
import { io } from 'socket.io-client';
const F = 'D:/Meodoku/.claude/agents/qa-tester.md';
const orig = fs.readFileSync(F);
const s = io('http://127.0.0.1:4310/live', { transports: ['websocket'] });
await new Promise(r => s.on('connect', r));
const results = [];
for (const [label, mutate] of [['edit', b => b.toString().replace('description: "', 'description: "STUDIO-PROBE ')], ['restore', () => orig]]) {
  const t0 = Date.now();
  const got = new Promise(r => s.once('config:changed', p => r(p)));
  fs.writeFileSync(F, mutate(orig));
  const p = await Promise.race([got, new Promise(r => setTimeout(() => r('TIMEOUT'), 5000))]);
  const a = await (await fetch('http://127.0.0.1:4310/api/agents/qa-tester')).json();
  results.push({ label, ms: Date.now() - t0, event: p, probeVisible: a.description.includes('STUDIO-PROBE') });
}
console.log(JSON.stringify(results));
console.log('bytes restored:', Buffer.compare(fs.readFileSync(F), orig) === 0);
s.close();
