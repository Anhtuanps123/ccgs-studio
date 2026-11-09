// Phase 0 spike: Agent SDK — AskUserQuestion, permission prompt, interrupt, resume.
// Run from anywhere: node spikes/sdk-spike.mjs. Writes captures/sdk-*.jsonl.
import fs from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';

const CWD = 'D:/Meodoku';
const SETTINGS = 'D:/ccgs-studio/spikes/capture-settings.json';
const log = (name) => {
  const f = new URL(`./captures/sdk-${name}.jsonl`, import.meta.url);
  fs.writeFileSync(f, '');
  return (o) => fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
};

const base = (taskId, w) => ({
  cwd: CWD,
  model: 'haiku',
  settingSources: ['user', 'project', 'local'],
  settings: SETTINGS,
  env: { ...process.env, CCGS_STUDIO_TASK_ID: taskId },
  permissionMode: 'default',
  canUseTool: async (toolName, input, opts) => {
    w({ kind: 'canUseTool', toolName, input, opts: { toolUseID: opts.toolUseID, agentID: opts.agentID, title: opts.title, displayName: opts.displayName, decisionReason: opts.decisionReason, blockedPath: opts.blockedPath, suggestions: opts.suggestions } });
    if (toolName === 'AskUserQuestion') {
      const answers = {};
      for (const q of input.questions) answers[q.question] = q.options[1].label; // pick option 2
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    if (toolName === 'Write') return { behavior: 'deny', message: 'Studio spike: user denied this write.' };
    return { behavior: 'allow', updatedInput: input };
  },
});

async function run(name, prompt, extra = {}, onMsg) {
  const w = log(name);
  const q = query({ prompt, options: { ...base(name.toUpperCase(), w), ...extra } });
  let sid = null, result = null;
  const t0 = Date.now();
  for await (const m of q) {
    w({ kind: 'msg', type: m.type, subtype: m.subtype, session_id: m.session_id, parent_tool_use_id: m.parent_tool_use_id, m: m.type === 'result' ? m : undefined });
    if (m.session_id) sid = m.session_id;
    if (m.type === 'result') result = m;
    if (onMsg) await onMsg(m, q, Date.now() - t0);
  }
  console.log(name, '->', result?.subtype, JSON.stringify(result?.result)?.slice(0, 200), 'denials=', JSON.stringify(result?.permission_denials), 'ms=', Date.now() - t0);
  return { sid, result };
}

// A: AskUserQuestion + a Write that will be denied
const a = await run('ask', "First, use the AskUserQuestion tool to ask me one question 'Pick a color' with options 'Red' and 'Blue'. Then use the Write tool to create D:/ccgs-studio/spikes/captures/perm-probe.txt containing the color. Finally reply 'COLOR=<color> WRITE=<ok|denied>'.");

// B: resume the same session
await run('resume', "What color did I pick earlier? Reply with one word.", { resume: a.sid });

// C: interrupt mid-run
let interrupted = false;
await run('interrupt', "Use Bash to run: sleep 60 && echo done. Then reply DONE.", {}, async (m, q, ms) => {
  if (!interrupted && m.type === 'assistant' && ms > 1000) {
    interrupted = true;
    setTimeout(async () => { const r = await q.interrupt(); console.log('interrupt response', JSON.stringify(r)); }, 2000);
  }
});
