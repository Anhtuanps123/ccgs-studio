// Shared Phase 4 widgets: diffs, token tables, transcript view.
import type { DiffLine, SessionUsage, TokenUsage, TranscriptItem } from '@ccgs/shared';
import { clock } from './monitor';

export const fmtNum = (n: number) => n.toLocaleString('vi-VN');
export const totalTok = (u: TokenUsage) => u.input + u.output + u.cacheCreation + u.cacheRead;
export const fmtUsd = (n: number | null | undefined) => (n === null || n === undefined ? 'Unknown' : `$${n.toFixed(n < 1 ? 4 : 2)}`);

export function DiffView({ lines, max = 2000 }: { lines: DiffLine[]; max?: number }) {
  if (!lines.length) return <div className="muted small">Không có thay đổi.</div>;
  const shown = lines.slice(0, max);
  return (
    <div className="diff">
      {shown.map((d, i) => (
        <div key={i} className={d.op === 'ctx' ? '' : d.op} style={d.op === 'hunk' ? { color: 'var(--muted)' } : undefined}>
          {d.op === 'add' ? '+ ' : d.op === 'del' ? '- ' : d.op === 'hunk' ? '' : '  '}{d.line}
        </div>
      ))}
      {lines.length > max && <div style={{ color: 'var(--muted)' }}>… còn {lines.length - max} dòng</div>}
    </div>
  );
}

/** Unified diff text (git diff output) to DiffLine[]. */
export function parseGitDiff(text: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git') || l.startsWith('index ') || l.startsWith('--- ') || l.startsWith('+++ ') || l.startsWith('new file') || l.startsWith('deleted file')) continue;
    if (l.startsWith('@@')) out.push({ op: 'hunk', line: l });
    else if (l.startsWith('+')) out.push({ op: 'add', line: l.slice(1) });
    else if (l.startsWith('-')) out.push({ op: 'del', line: l.slice(1) });
    else if (l.startsWith('\\')) out.push({ op: 'hunk', line: l });
    else out.push({ op: 'ctx', line: l.slice(1) });
  }
  while (out.length && out[out.length - 1].op === 'ctx' && !out[out.length - 1].line) out.pop();
  return out;
}

export function UsageTable({ u, names }: { u: SessionUsage; names?: Map<string, string> }) {
  const max = Math.max(1, ...u.byAgent.map(a => (a.usage ? totalTok(a.usage) : 0)));
  return (
    <div className="stack">
      <div className="big">
        <div><b>{fmtNum(totalTok(u.total))}</b><span>tổng token</span></div>
        <div><b>{fmtNum(u.total.input)}</b><span>input</span></div>
        <div><b>{fmtNum(u.total.output)}</b><span>output</span></div>
        <div><b>{fmtNum(u.total.cacheCreation)}</b><span>cache ghi</span></div>
        <div><b>{fmtNum(u.total.cacheRead)}</b><span>cache đọc</span></div>
      </div>
      <div className="tablewrap"><table>
        <thead><tr><th>Agent</th><th>Input</th><th>Output</th><th>Cache ghi</th><th>Cache đọc</th><th>Lượt API</th><th style={{ width: '22%' }}>Tỉ lệ</th></tr></thead>
        <tbody>{u.byAgent.map(a => (
          <tr key={a.invocationId} title={a.transcriptPath ?? ''}>
            <td><b>{names?.get(a.invocationId) ?? (a.agentType === 'main' ? 'Main session' : a.agentType)}</b>{a.models.length > 0 && <div className="muted small">{a.models.join(', ')}</div>}</td>
            {a.usage ? <>
              <td className="mono">{fmtNum(a.usage.input)}</td><td className="mono">{fmtNum(a.usage.output)}</td>
              <td className="mono">{fmtNum(a.usage.cacheCreation)}</td><td className="mono">{fmtNum(a.usage.cacheRead)}</td><td className="mono">{a.usage.messages}</td>
              <td><div className="hbar" style={{ gridTemplateColumns: '1fr', padding: 0 }}><div className="track"><div className="fill" style={{ width: `${(totalTok(a.usage) / max) * 100}%` }} /></div></div></td>
            </> : <td colSpan={6} className="muted">Unknown (không đọc được transcript)</td>}
          </tr>
        ))}</tbody>
      </table></div>
      {u.missing.length > 0 && <div className="small muted">Không đọc được: {u.missing.map(m => <code key={m} style={{ marginRight: 6 }}>{m}</code>)}</div>}
      <div className="small muted">Đọc từ transcript JSONL, mỗi <code>message.id</code> chỉ tính một lần.</div>
    </div>
  );
}

export function TranscriptView({ items }: { items: TranscriptItem[] }) {
  if (!items.length) return <div className="empty">Transcript trống hoặc chưa đọc được.</div>;
  return (
    <div className="conv">
      {items.map((it, i) => {
        if (it.kind === 'user') return <div key={i} className="msg user"><div className="who">Giao việc / người dùng, {clock(it.at)}</div><div className="bubble" style={{ whiteSpace: 'pre-wrap' }}>{it.text}</div></div>;
        if (it.kind === 'assistant') return <div key={i} className="msg ai"><div className="who">Agent, {clock(it.at)}{it.model ? ` · ${it.model}` : ''}</div><div className="bubble" style={{ whiteSpace: 'pre-wrap' }}>{it.text}</div></div>;
        if (it.kind === 'tool_use') return <details key={i} className="tool"><summary><b>{it.name}</b> <span className="muted small">{clock(it.at)}</span></summary><pre className="md small" style={{ margin: 0 }}>{it.input}</pre></details>;
        return <details key={i} className="tool"><summary><span className={it.isError ? 'badge-err' : 'muted'}>{it.isError ? 'Kết quả lỗi' : 'Kết quả tool'}</span></summary><pre className="md small" style={{ margin: 0 }}>{it.text}</pre></details>;
      })}
    </div>
  );
}
