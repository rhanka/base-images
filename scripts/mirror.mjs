#!/usr/bin/env node
// Mirror every Wolfi apk named in the committed locks into this repository's releases.
//
// Release "wolfi-mirror-<YYYY-MM>" (one per month of first sighting), asset "<arch>.<file>.apk".
// An asset already present in any wolfi-mirror-* release is skipped. Each downloaded apk is checked
// against the lock (sha1 of the control segment, byte range taken from the lock).
// Restore after Wolfi deleted a stale binary: gh release download wolfi-mirror-<month> -p '<arch>.<file>'.
//
//   node scripts/mirror.mjs [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, REPO, catalog, lockPath } from './lib.mjs';

const dry = process.argv.includes('--dry-run');
const gh = (args, opts = {}) => execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
// GitHub replaces characters outside this set in asset names
const assetName = (arch, file) => `${arch}.${file}`.replace(/[^A-Za-z0-9._-]/g, '.');

const wanted = new Map();
for (const name of Object.keys(catalog().images)) {
  const f = path.join(ROOT, lockPath(name));
  if (!fs.existsSync(f)) continue;
  for (const p of JSON.parse(fs.readFileSync(f, 'utf8')).contents.packages) {
    if (!p.url.startsWith('https://packages.wolfi.dev/')) continue;
    wanted.set(assetName(p.architecture, path.posix.basename(p.url)), p);
  }
}

const releases = JSON.parse(gh(['api', `repos/${REPO}/releases?per_page=100`, '--paginate', '--jq', '[.[] | {tag: .tag_name, assets: [.assets[].name]}]']).replace(/\]\s*\[/g, ','));
const have = new Set(releases.filter((r) => r.tag.startsWith('wolfi-mirror-')).flatMap((r) => r.assets));
const missing = [...wanted.entries()].filter(([a]) => !have.has(a));
console.log(`mirror: ${wanted.size} Wolfi apks in the locks, ${wanted.size - missing.length} already mirrored, ${missing.length} to add`);
if (!missing.length || dry) process.exit(0);

const tag = `wolfi-mirror-${new Date().toISOString().slice(0, 7)}`;
if (!releases.some((r) => r.tag === tag)) {
  gh(['release', 'create', tag, '--repo', REPO, '--title', tag, '--latest=false', '--notes',
    'Copies of the Wolfi apks named in the committed apko locks (asset name: <arch>.<file>). Wolfi removes stale binaries six months after publication; these copies keep old locks rebuildable.']);
}


const tmp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'mirror-'));
let n = 0;
for (const [asset, p] of missing) {
  const file = path.join(tmp, asset);
  execFileSync('curl', ['-sSfL', '--retry', '3', '-o', file, p.url]);
  const ctl = p.control?.range?.match(/bytes=(\d+)-(\d+)/);
  if (ctl) {
    const buf = fs.readFileSync(file);
    const sha1 = 'sha1-' + crypto.createHash('sha1').update(buf.subarray(Number(ctl[1]), Number(ctl[2]) + 1)).digest('base64');
    if (sha1 !== p.control.checksum) throw new Error(`${p.url}: control checksum ${sha1} does not match the lock (${p.control.checksum})`);
  }
  n++;
  if (n % 20 === 0 || n === missing.length) {
    const batch = fs.readdirSync(tmp).map((f) => path.join(tmp, f));
    gh(['release', 'upload', tag, ...batch, '--repo', REPO]);
    for (const f of batch) fs.rmSync(f);
    console.log(`mirror: uploaded ${n}/${missing.length}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
