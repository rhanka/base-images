#!/usr/bin/env node
// Content gates on melange output before it enters the mirror: no Python interpreter or library, no *.py
// outside the inert node-gyp allowlist, no dependency on Python or on a shell, no setuid file.
//
//   node scripts/apk-gates.mjs <dir containing *.apk>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = process.argv[2];
const ALLOW_PY = [/^usr\/lib\/node_modules\/npm\/node_modules\/node-gyp\//];
let failures = 0;
const fail = (apk, msg) => { failures++; console.log(`FAIL ${apk}: ${msg}`); };
for (const apk of fs.readdirSync(dir).filter((f) => f.endsWith('.apk'))) {
  const file = path.join(dir, apk);
  const list = execFileSync('tar', ['-tvzf', file, '--numeric-owner'], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
  let py = 0;
  for (const line of list.split('\n')) {
    const m = line.match(/^(\S{10})\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*?)(?: -> .*)?$/);
    if (!m) continue;
    const [, mode, p] = m;
    const base = path.posix.basename(p);
    if (/[sS]/.test(mode[3]) || /[sS]/.test(mode[6])) fail(apk, `setuid/setgid ${p}`);
    if (/^python[0-9.]*$/.test(base) || /^libpython/.test(base)) fail(apk, `python ${p}`);
    if (/\.pyc?$/.test(base)) { if (ALLOW_PY.some((re) => re.test(p))) py++; else fail(apk, `python file ${p}`); }
    if (['sh', 'bash', 'ash', 'dash', 'busybox'].includes(base) && /bin\//.test(p)) fail(apk, `shell ${p}`);
  }
  const pkginfo = execFileSync('tar', ['-xzOf', file, '.PKGINFO'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  for (const d of pkginfo.split('\n').filter((l) => l.startsWith('depend = ')).map((l) => l.slice(9))) {
    if (/python|^py3-|^cmd:(bash|sh)$|^\/bin\/sh$|^busybox$|^bash$/.test(d)) fail(apk, `depends on ${d}`);
  }
  console.log(`checked ${apk}: ${py} inert node-gyp .py`);
}
process.exit(failures ? 1 : 0);
