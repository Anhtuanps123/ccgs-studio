import { execFile } from 'node:child_process';

// The browser cannot read a real folder path, so the server (same machine, 127.0.0.1 only) opens the native dialog.
const PS = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Chọn thư mục project CCGS'
$d.ShowNewFolderButton = $false
if ($env:CCGS_PICK_START) { $d.SelectedPath = $env:CCGS_PICK_START }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
$owner.Dispose()
`;

export class PickerUnsupported extends Error {}

/** Opens the Windows folder dialog; resolves the chosen path or null when cancelled. */
export function pickFolder(start?: string | null): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.reject(new PickerUnsupported('Hộp thoại chọn thư mục chỉ hỗ trợ Windows. Hãy nhập đường dẫn.'));
  const enc = Buffer.from(PS, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-EncodedCommand', enc],
      { timeout: 10 * 60_000, windowsHide: false, encoding: 'utf8', env: { ...process.env, CCGS_PICK_START: start ?? '' } },
      (err, out) => {
        if (err) return reject(new Error(`Không mở được hộp thoại: ${err.message.split('\n')[0]}`));
        const p = String(out).trim();
        resolve(p || null);
      });
  });
}
