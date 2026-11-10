// Spike (graphify Bước 0, mục 5): attach graphify-mcp to an Agent SDK session via `mcpServers`
// and check that Claude can call query_graph. Isolated: neutral cwd, no setting sources, only
// graphify tools allowed. Run: node spikes/graphify/mcp-spike.mjs <graph.json> [cwd]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../package.json', import.meta.url));
const { query } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);

const [graph, cwd = process.cwd()] = process.argv.slice(2);
if (!graph) { console.error('usage: mcp-spike.mjs <graph.json> [cwd]'); process.exit(2); }

const q = query({
  prompt: 'Use the graphify tool query_graph (and get_node / get_neighbors if useful) to find which method calls PiggyBank.OnLevelWon in this Unity project. Do not use any other tool. Answer in one short line: caller method, file and line.',
  options: {
    cwd,
    model: 'haiku',
    settingSources: [],
    maxTurns: 6,
    mcpServers: { graphify: { command: 'graphify-mcp', args: [graph], env: { ...process.env, GRAPHIFY_QUERY_LOG_DISABLE: '1', PYTHONIOENCODING: 'utf-8' } } },
    allowedTools: ['mcp__graphify__query_graph', 'mcp__graphify__get_node', 'mcp__graphify__get_neighbors', 'mcp__graphify__shortest_path', 'mcp__graphify__graph_stats'],
    canUseTool: async (name, input) => (name.startsWith('mcp__graphify__') ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'spike: graphify tools only' }),
  },
});

const t0 = Date.now();
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') console.log('init mcp_servers:', JSON.stringify(m.mcp_servers), '| graphify tools:', (m.tools ?? []).filter(t => t.startsWith('mcp__graphify')).join(', '));
  if (m.type === 'assistant') for (const c of m.message.content ?? []) if (c.type === 'tool_use') console.log('tool_use:', c.name, JSON.stringify(c.input).slice(0, 200));
  if (m.type === 'user') for (const c of m.message.content ?? []) if (c.type === 'tool_result') console.log('tool_result:', String(Array.isArray(c.content) ? c.content.map(x => x.text ?? '').join('') : c.content).slice(0, 300).replace(/\n/g, ' | '));
  if (m.type === 'result') {
    console.log('result:', m.subtype, '|', (m.result ?? '').replace(/\n/g, ' '));
    console.log('turns', m.num_turns, 'cost_usd', m.total_cost_usd, 'usage', JSON.stringify(m.usage), 'ms', Date.now() - t0);
  }
}
