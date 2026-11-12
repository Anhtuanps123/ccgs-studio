// context-mode (npm "context-mode", ELv2): a Claude Code plugin that keeps large tool output out of the context
// (MCP server + hooks). Studio loads it into task sessions through the Agent SDK `plugins` option when
// Settings.contextMode is on. Nothing is installed globally or written into the CCGS project.
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST = path.join('.claude-plugin', 'plugin.json');

/**
 * Folder of the installed context-mode plugin, or null when it is not installed. The package's `exports` hide
 * package.json from require.resolve, so walk up the node_modules folders instead.
 */
export function contextModeDir(from = __dirname): string | null {
  for (let d = path.resolve(from); ; d = path.dirname(d)) {
    const dir = path.join(d, 'node_modules', 'context-mode');
    if (fs.existsSync(path.join(dir, MANIFEST))) return dir;
    if (path.dirname(d) === d) return null;
  }
}

/** Version from the plugin manifest, null when unreadable. */
export function contextModeVersion(dir: string | null = contextModeDir()): string | null {
  if (!dir) return null;
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')).version ?? '') || null; } catch { return null; }
}
