#!/usr/bin/env node
// CCGS Studio hook client (marker: ccgs-studio-hook). Forwards the hook payload to the local Studio server.
// Contract: never blocks Claude Code. Always exit 0, never print to stdout, give up after 500 ms of network,
// hard stop at 900 ms. Usage: node ccgs-studio-hook.mjs <local|studio|doctor>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const receivedAt = new Date().toISOString();
const bail = () => process.exit(0);
setTimeout(bail, 900).unref();
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

const originArg = process.argv[2] ?? 'local';
const origin = originArg === 'studio' ? 'studio-settings' : originArg === 'doctor' ? 'doctor' : 'local-settings';
const taskId = process.env.CCGS_STUDIO_TASK_ID || null;
// Studio-run tasks get this hook through the SDK `settings` option; skip the settings.local.json copy to avoid duplicates.
if (origin === 'local-settings' && taskId) bail();

// The installed copy lives in the studio home next to hook.json; sessions started from a terminal have no CCGS_STUDIO_HOME.
const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.existsSync(path.join(here, 'hook.json')) ? here : (process.env.CCGS_STUDIO_HOME || path.join(os.homedir(), '.ccgs-studio'));
let token = '';
let port = 4310;
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'hook.json'), 'utf8'));
  token = String(cfg.token ?? '');
  port = Number(cfg.port) || port;
} catch { bail(); }

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('error', bail);
process.stdin.on('end', async () => {
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { bail(); return; }
  const body = JSON.stringify({ v: 1, receivedAt, taskId, origin, payload });
  try {
    await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body,
      signal: AbortSignal.timeout(500),
    });
  } catch (e) {
    // Backend down (connection refused): keep the event in the spool, the server loads it on start.
    // A timeout is not spooled: the server may have received it, and a duplicate would double count.
    if (origin !== 'doctor' && e?.name !== 'TimeoutError' && e?.name !== 'AbortError') {
      try {
        const spool = path.join(home, 'spool.jsonl');
        let size = 0;
        try { size = fs.statSync(spool).size; } catch { /* none yet */ }
        if (size < 50 * 1024 * 1024) fs.appendFileSync(spool, body + String.fromCharCode(10));
      } catch { /* stay silent */ }
    }
  }
  bail();
});
