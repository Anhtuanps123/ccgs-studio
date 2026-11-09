import type { DiffLine } from '@ccgs/shared';

const MAX_CELLS = 4_000_000; // LCS table cap (~2000 x 2000 lines)

/** Line diff with up to `context` unchanged lines around each change; big inputs fall back to del-all/add-all. */
export function unifiedDiff(a: string, b: string, context = 3): DiffLine[] {
  const x = a ? a.split(/\r?\n/) : [], y = b ? b.split(/\r?\n/) : [];
  let raw: DiffLine[];
  if (x.length * y.length > MAX_CELLS) {
    raw = [...x.map(line => ({ op: 'del' as const, line })), ...y.map(line => ({ op: 'add' as const, line }))];
  } else {
    const n = x.length, m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    raw = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) { raw.push({ op: 'ctx', line: x[i] }); i++; j++; }
      else if (j < m && (i === n || L[i][j + 1] > L[i + 1][j])) raw.push({ op: 'add', line: y[j++] });
      else raw.push({ op: 'del', line: x[i++] });
    }
  }
  // Keep only context near changes; mark skipped ranges with a hunk line.
  const keep = new Array(raw.length).fill(false);
  raw.forEach((d, k) => { if (d.op !== 'ctx') for (let t = Math.max(0, k - context); t <= Math.min(raw.length - 1, k + context); t++) keep[t] = true; });
  const out: DiffLine[] = [];
  let skipped = 0;
  raw.forEach((d, k) => {
    if (keep[k]) { if (skipped) { out.push({ op: 'hunk', line: `… ${skipped} dòng không đổi` }); skipped = 0; } out.push(d); }
    else skipped++;
  });
  if (skipped && out.length) out.push({ op: 'hunk', line: `… ${skipped} dòng không đổi` });
  return out;
}
