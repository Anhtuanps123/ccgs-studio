import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { contextModeDir, contextModeVersion } from '../src/context-mode';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/settings/settings.service';

describe('context-mode plugin', () => {
  it('finds the plugin installed with the server, with its manifest, hooks and MCP server', () => {
    const dir = contextModeDir();
    expect(dir).not.toBeNull();
    const m = JSON.parse(fs.readFileSync(path.join(dir!, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(m.name).toBe('context-mode');
    expect(m.mcpServers?.['context-mode']).toBeTruthy();
    expect(fs.existsSync(path.join(dir!, m.hooks))).toBe(true);
    expect(contextModeVersion(dir)).toBe(m.version);
  });

  it('returns null outside any node_modules that has it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgs-cm-'));
    try {
      expect(contextModeDir(tmp)).toBeNull();
      expect(contextModeVersion(null)).toBeNull();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  it('is off by default and only turns on with true', () => {
    const d = DEFAULT_SETTINGS();
    expect(d.contextMode).toBe(false);
    expect(mergeSettings(d, { contextMode: true }).contextMode).toBe(true);
    expect(mergeSettings(d, { contextMode: 'yes' }).contextMode).toBe(false);
    expect(mergeSettings({ ...d, contextMode: true }, { retention: { days: 3 } }).contextMode).toBe(true);
  });
});
