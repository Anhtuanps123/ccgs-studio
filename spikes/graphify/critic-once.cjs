// Spike (graphify, phản hồi Bước 0 – Quyết định 1): run exactly ONE critic round for an existing pipeline,
// as a standalone task (fresh session, so cost_usd is that round alone; no automatic revise loop).
// Run from apps/server after `npm run build`: node ../../spikes/graphify/critic-once.cjs <pipelineId> [model]
const { criticPrompt } = require(require('node:path').resolve('dist/pipelines/pipeline.service'));
const { loadTemplates } = require(require('node:path').resolve('dist/pipelines/plan-rules'));
const [id, model = 'opus'] = process.argv.slice(2);
const base = 'http://127.0.0.1:4310';
(async () => {
  const p = await (await fetch(`${base}/api/pipelines/${id}`)).json();
  if (!p.steps?.length) throw new Error(`pipeline ${id} has no plan (status ${p.status})`);
  const prompt = criticPrompt(p, 1, loadTemplates().templates);
  const r = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'prompt', prompt, model, permissionMode: 'default' }) });
  const t = await r.json();
  console.log(r.status, t.id ?? t.message, `prompt ${prompt.length} chars`);
})().catch(e => { console.error(e.message); process.exit(1); });
