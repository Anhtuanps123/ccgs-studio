// T-TC-05: files a task changed = difference between `git status` + content hash taken before and after (R8).
// Files the user had already modified count only if the task changed their content again.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, GitInfo, TaskDiff } from '@ccgs/shared';

/** path (repo-relative, forward slashes) -> "<XY>|<content hash or 'absent'>" */
export type Snapshot = Map<string, string>;

function git(cwd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))));
}

async function hashFile(f: string): Promise<string> {
  try {
    const st = await fs.stat(f);
    if (!st.isFile()) return 'dir';
    return createHash('sha1').update(await fs.readFile(f)).digest('hex');
  } catch { return 'absent'; }
}

/** Parses `git status --porcelain=v1 -z` into [XY, path] pairs (renames report the new path). */
export function parsePorcelainZ(out: string): [string, string][] {
  const parts = out.split('\0');
  const res: [string, string][] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    res.push([xy, e.slice(3)]);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // next entry is the original path
  }
  return res;
}

/** Returns null when `cwd` is not inside a git work tree. */
export async function takeSnapshot(cwd: string): Promise<Snapshot | null> {
  let root: string, out: string;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
    out = (await git(cwd, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString('utf8');
  } catch { return null; }
  const snap: Snapshot = new Map();
  const entries = parsePorcelainZ(out);
  const hashes = await Promise.all(entries.map(([, p]) => hashFile(path.join(root, p))));
  entries.forEach(([xy, p], i) => snap.set(p, `${xy}|${hashes[i]}`));
  return snap;
}

const kind = (xy: string, hash: string): ChangedFile['change'] =>
  hash === 'absent' || xy.includes('D') ? 'D' : xy === '??' || xy[0] === 'A' ? 'A' : xy[0] === 'R' ? 'R' : 'M';

export function diffSnapshots(before: Snapshot, after: Snapshot): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const [p, a] of after) {
    const b = before.get(p);
    if (b === a) continue;
    const [xy, hash] = a.split('|');
    out.push({ path: p, change: kind(xy, hash) });
  }
  // Dirty before, clean after: the task reverted (or committed) it.
  for (const p of before.keys()) if (!after.has(p)) out.push({ path: p, change: 'M' });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

// ---------- T-TC-06: diff of what a task changed ----------

export async function gitRoot(cwd: string): Promise<string | null> {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trim(); } catch { return null; }
}

/**
 * Commit holding the work tree as it is before the task. `git stash create` writes a dangling commit object
 * (no ref, no change to the index, work tree or stash list); a clean tree gives HEAD. Null without commits.
 */
export async function baseRef(cwd: string): Promise<string | null> {
  try {
    const s = (await git(cwd, ['stash', 'create'])).toString('utf8').trim();
    if (s) return s;
    return (await git(cwd, ['rev-parse', 'HEAD'])).toString('utf8').trim() || null;
  } catch { return null; }
}

const MAX_DIFF = 200 * 1024;
const capText = (s: string) => (s.length > MAX_DIFF ? s.slice(0, MAX_DIFF) + `\n…[cắt ${s.length - MAX_DIFF} ký tự]` : s);

/** Diff of each changed file against `base`; files git did not track at `base` are shown as their current content. */
export async function taskDiffs(cwd: string, base: string | null, files: ChangedFile[], before: Snapshot | null): Promise<TaskDiff[]> {
  const root = await gitRoot(cwd);
  if (!root) return files.map(f => ({ ...f, diff: null, note: 'Không phải git repo' }));
  const out: TaskDiff[] = [];
  for (const f of files.slice(0, 200)) {
    let tracked = false;
    if (base) { try { await git(root, ['cat-file', '-e', `${base}:${f.path}`]); tracked = true; } catch { /* not in base */ } }
    if (tracked) {
      try {
        const d = (await git(root, ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', base!, '--', f.path])).toString('utf8');
        out.push({ ...f, diff: d ? capText(d) : null, note: d ? null : 'Nội dung hiện tại giống bản trước task (có thể đã được sửa lại sau đó)' });
      } catch (e) { out.push({ ...f, diff: null, note: `git diff lỗi: ${(e as Error).message.split('\n')[0]}` }); }
      continue;
    }
    const wasUntracked = before?.get(f.path)?.startsWith('??') ?? false;
    try {
      const buf = await fs.readFile(path.join(root, f.path));
      if (buf.includes(0)) { out.push({ ...f, diff: null, note: 'File nhị phân' }); continue; }
      const body = buf.toString('utf8').split(/\r?\n/).map(l => '+' + l).join('\n');
      out.push({ ...f, diff: capText(`--- /dev/null\n+++ b/${f.path}\n${body}`), note: wasUntracked ? 'File chưa được git theo dõi trước task: chỉ có nội dung hiện tại, không có bản trước để so' : null });
    } catch {
      out.push({ ...f, diff: null, note: base ? 'Đã xoá; git không có bản trước của file này' : 'Không đọc được file' });
    }
  }
  return out;
}

/** T-PJ-02: branch, ahead/behind and uncommitted files (read-only git commands). */
export async function gitInfo(cwd: string, limit = 500): Promise<GitInfo> {
  const none: GitInfo = { isRepo: false, branch: null, head: null, ahead: null, behind: null, files: [], truncated: false, error: null };
  const root = await gitRoot(cwd);
  if (!root) return none;
  const info: GitInfo = { ...none, isRepo: true };
  try {
    const out = (await git(root, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal'])).toString('utf8');
    const [first, ...rest] = out.split('\0');
    const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(first ?? '');
    if (m) {
      info.branch = m[1] === 'HEAD' ? null : m[1];
      if (m[2]) { info.ahead = Number(m[3] ?? 0); info.behind = Number(m[4] ?? 0); }
    }
    const files = parsePorcelainZ(rest.join('\0'));
    info.truncated = files.length > limit;
    info.files = files.slice(0, limit).map(([status, p]) => ({ status, path: p }));
    try { info.head = (await git(root, ['rev-parse', '--short', 'HEAD'])).toString('utf8').trim(); } catch { /* no commits */ }
  } catch (e) { info.error = (e as Error).message.split('\n')[0]; }
  return info;
}
