#!/usr/bin/env node
// Blocking content gates on a built apko tarball (both architectures). No execution of image content.
//
//   node scripts/gates.mjs <name> <image.tar> [--report out.json] [--kind runtime --budget MB]
//
// Gates (design r2 section 5.5):
//   python      no interpreter, no libpython, no python shebang, no *.py outside the inert allowlist
//   shell       runtime images: none of sh/ash/bash/dash/busybox/...; jobs images: busybox only
//   pkgmgr      no apk/npm/pip/... outside dev images
//   setuid      no setuid/setgid file
//   apk-deps    runtime images: no installed package depends on a shell; no image depends on Python
//   scanner     /etc/os-release and the apk installed database are present (grype matches the Wolfi feed)
//   user        image config runs as 65532
//   size        amd64 compressed size within images.json budgetMB
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { catalog, writeJson, OCI_ARCH } from './lib.mjs';

const [name, tarFile, ...rest] = process.argv.slice(2);
const reportFile = rest[rest.indexOf('--report') + 1] && rest.includes('--report') ? rest[rest.indexOf('--report') + 1] : null;
const cat = catalog();
// --kind <kind> --budget <MB> gates an image that is not in images.json (check images under test/).
const spec = cat.images[name] || (rest.includes('--kind') ? { kind: rest[rest.indexOf('--kind') + 1], budgetMB: Number(rest[rest.indexOf('--budget') + 1] || 1e9) } : null);
if (!spec || !tarFile) { console.error('usage: gates.mjs <name> <image.tar> [--report file]'); process.exit(2); }
const kind = spec.kind;

const SHELLS = ['sh', 'ash', 'bash', 'dash', 'busybox', 'zsh', 'ksh', 'mksh', 'csh', 'tcsh', 'fish'];
const JOB_SHELLS = ['sh', 'ash', 'busybox'];
const PKG_MANAGERS = ['apk', 'apt', 'apt-get', 'dpkg', 'rpm', 'dnf', 'yum', 'microdnf', 'pip', 'pip3', 'npm', 'npx', 'yarn', 'pnpm', 'corepack'];
const PY_ALLOW = [
  /^usr\/lib\/libstdc\+\+\.so\.[0-9.]+-gdb\.py$/,
  /^usr\/share\/gdb\//,
  /^usr\/share\/arrow\/gdb\/gdb_arrow\.py$/, // Apache Arrow gdb pretty-printer (pulled by libgdal), inert
  /^usr\/share\/doc\//,
  /^usr\/share\/bash-completion\//,
  ...(kind === 'dev' ? [/^usr\/lib\/node_modules\/(npm\/node_modules\/)?node-gyp\//] : []),
];
const BIN_DIRS = /^(usr\/)?(local\/)?s?bin\//;

const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), `gates-${name}-`));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 30, env: { ...process.env, LC_ALL: 'C' }, ...opts });

sh('tar', ['-xf', tarFile, '-C', work]);
const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
const failures = [];
const info = {};
const fail = (arch, gate, detail) => failures.push({ arch, gate, detail });

for (const m of manifest) {
  const config = JSON.parse(fs.readFileSync(path.join(work, m.Config), 'utf8'));
  const arch = config.architecture;
  const root = path.join(work, `rootfs-${arch}`);
  fs.mkdirSync(root);
  const entries = [];
  let compressed = 0;
  for (const layer of m.Layers) {
    const lf = path.join(work, layer);
    compressed += fs.statSync(lf).size;
    for (const line of sh('tar', ['-tvzf', lf, '--numeric-owner']).split('\n')) {
      if (!line) continue;
      // -rwxr-xr-x 0/0 1234 2025-11-05 00:00 usr/bin/node[ -> target]
      const mm = line.match(/^(\S{10})\s+\S+\s+\d+\s+\S+\s+\S+\s+(.*)$/);
      if (!mm) continue;
      let p = mm[2];
      let target = null;
      if (mm[1][0] === 'l') [p, target] = p.split(' -> ');
      if (mm[1][0] === 'h') p = p.split(' link to ')[0];
      entries.push({ mode: mm[1], path: p.replace(/^\.?\//, ''), target });
    }
    sh('tar', ['-xzf', lf, '-C', root, '--no-same-owner', '--exclude=dev/*']);
  }

  let inertPy = 0;
  for (const e of entries) {
    const base = path.posix.basename(e.path);
    const type = e.mode[0];
    if (type === 'd') continue;
    // setuid / setgid
    if (/[sS]/.test(e.mode[3]) || /[sS]/.test(e.mode[6])) fail(arch, 'setuid', `${e.mode} ${e.path}`);
    // python
    if (/^python[0-9.]*$/.test(base) || /^pypy/.test(base)) fail(arch, 'python', `interpreter ${e.path}`);
    if (/^libpython/.test(base)) fail(arch, 'python', `library ${e.path}`);
    const allowed = PY_ALLOW.some((re) => re.test(e.path));
    if (base.endsWith('.py') || base.endsWith('.pyc')) {
      if (allowed) inertPy++;
      else fail(arch, 'python', `file ${e.path}`);
    }
    if (type === '-' && /x/.test(e.mode.slice(1)) && !allowed) {
      const fd = fs.openSync(path.join(root, e.path), 'r');
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, 128, 0);
      fs.closeSync(fd);
      const head = buf.subarray(0, n).toString('latin1');
      if (head.startsWith('#!') && /python/.test(head.split('\n')[0])) fail(arch, 'python', `shebang ${e.path}: ${head.split('\n')[0]}`);
    }
    // shells and package managers (by name, in a bin directory)
    if (BIN_DIRS.test(e.path) || type === 'l') {
      if (SHELLS.includes(base)) {
        if (kind === 'runtime' || (kind === 'jobs' && !JOB_SHELLS.includes(base))) fail(arch, 'shell', e.path);
      }
      if (PKG_MANAGERS.includes(base) && kind !== 'dev' && BIN_DIRS.test(e.path)) fail(arch, 'pkgmgr', e.path);
    }
  }

  // apk installed database: dependencies
  const dbPath = ['usr/lib/apk/db/installed', 'lib/apk/db/installed'].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  if (!dbPath) fail(arch, 'scanner', 'apk installed database missing');
  if (!fs.existsSync(path.join(root, 'etc/os-release')) && !fs.existsSync(path.join(root, 'usr/lib/os-release'))) fail(arch, 'scanner', 'os-release missing');
  const packages = [];
  if (dbPath) {
    for (const rec of fs.readFileSync(dbPath, 'utf8').split('\n\n')) {
      const P = (rec.match(/^P:(.*)$/m) || [])[1];
      const V = (rec.match(/^V:(.*)$/m) || [])[1];
      if (!P) continue;
      packages.push(`${P}-${V}`);
      const deps = ((rec.match(/^D:(.*)$/m) || [])[1] || '').split(/\s+/).filter(Boolean);
      for (const d of deps) {
        if (/^(cmd:)?python|^so:libpython|^py3-/.test(d)) fail(arch, 'apk-deps', `${P} depends on ${d}`);
        if (kind === 'runtime' && /^(cmd:(bash|sh|ash|dash|busybox)|\/bin\/sh|busybox|bash)(=|$)/.test(d)) fail(arch, 'apk-deps', `${P} depends on ${d}`);
      }
    }
  }

  // user
  const user = String(config.config?.User || '');
  if (!/^65532(:65532)?$/.test(user)) fail(arch, 'user', `runs as "${user}"`);

  const mb = compressed / 1e6;
  if (OCI_ARCH.x86_64 === arch && mb > spec.budgetMB) fail(arch, 'size', `${mb.toFixed(1)} MB > budget ${spec.budgetMB} MB`);
  info[arch] = { compressedMB: Number(mb.toFixed(1)), files: entries.length, inertPy, packages: packages.length, user };
}

fs.rmSync(work, { recursive: true, force: true });
const report = { image: name, kind, ok: failures.length === 0, info, failures };
if (reportFile) writeJson(reportFile, report);
for (const [a, i] of Object.entries(info)) console.log(`${name} ${a}: ${i.compressedMB} MB compressed, ${i.packages} packages, ${i.files} entries, ${i.inertPy} inert .py, user ${i.user}`);
if (failures.length) {
  for (const f of failures.slice(0, 50)) console.log(`FAIL ${f.gate} [${f.arch}] ${f.detail}`);
  if (failures.length > 50) console.log(`... ${failures.length - 50} more`);
  process.exit(1);
}
console.log(`${name}: all gates passed (kind ${kind})`);
