// Replace the Windows user profile path with "~" in an evidence file (in place).
import fs from 'node:fs';
const f = process.argv[2];
const t = fs.readFileSync(f, 'utf8').replace(/C:[\\/]+Users[\\/]+(D2M-DEV-003|D2M-DE~1)/gi, '~');
fs.writeFileSync(f, t);
