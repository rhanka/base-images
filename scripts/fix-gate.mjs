#!/usr/bin/env node
// "Fix available" gate, CPE-free by construction (review r2, section 4.3, signal 1).
//
// For every package in the committed lock (what is published), look up its origin's secfixes in the
// Wolfi security feed. A secfixes version newer than the locked version is a Wolfi fix for a CVE that
// affected what we ship. It is "available" when the refreshed lock (working tree) reaches that version.
// No NVD, no CPE heuristics. Severity is not in the feed: the lane comes from the grype scan of the
// published digest (scan.mjs ref).
//
//   node scripts/fix-gate.mjs --security security.json --index APKINDEX(x86_64, uncompressed)
//        [--base-ref HEAD] [--report fixes.json]
//
// Also reports (signal 3 and freshness): Node.js 26 releases newer than the melange recipe
// (security: true flagged), and newer Wolfi builds of the apks the workshop repackages.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, catalog, lockPath, apkVersionCompare as cmp, recipes, writeJson } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const security = JSON.parse(fs.readFileSync(opt('--security'), 'utf8'));
const indexText = fs.readFileSync(opt('--index'), 'utf8');
const baseRef = opt('--base-ref', 'HEAD');

// name@version -> origin; name -> newest version (by build time)
const origin = new Map();
const newest = new Map();
for (const rec of indexText.split('\n\n')) {
  const o = {};
  for (const l of rec.split('\n')) if (l[1] === ':') o[l[0]] = l.slice(2);
  if (!o.P) continue;
  origin.set(`${o.P}@${o.V}`, o.o || o.P);
  const n = newest.get(o.P);
  if (!n || Number(o.t) > n.t) newest.set(o.P, { v: o.V, t: Number(o.t) });
}
const secfixes = new Map(security.packages.map((p) => [p.pkg.name, p.pkg.secfixes || {}]));

function rawAt(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  } catch {
    return null;
  }
}
function lockAt(ref, file) {
  const raw = rawAt(ref, file);
  return raw ? JSON.parse(raw.toString('utf8')) : null;
}
const pkgs = (lock) => new Map((lock?.contents.packages || []).filter((p) => p.architecture === 'x86_64').map((p) => [p.name, p.version]));

const report = { generated: new Date().toISOString(), baseRef, images: {}, node: null, workshop: [] };
const cat = catalog();
for (const name of Object.keys(cat.images)) {
  const file = lockPath(name);
  const before = lockAt(baseRef, file);
  const afterPath = path.join(ROOT, file);
  const after = fs.existsSync(afterPath) ? JSON.parse(fs.readFileSync(afterPath, 'utf8')) : null;
  const oldPkgs = pkgs(before);
  const newPkgs = pkgs(after);
  const changed = JSON.stringify(before?.contents.packages) !== JSON.stringify(after?.contents.packages);
  const available = [];
  const pending = [];
  const removed = [];
  const platform = new Set((before?.contents.packages || []).filter((p) => p.url.startsWith('./apks/')).map((p) => p.name));
  for (const [pkg, from] of oldPkgs) {
    const to = newPkgs.get(pkg);
    const org = origin.get(`${pkg}@${from}`) || pkg;
    for (const [fixedIn, ids] of Object.entries(secfixes.get(org) || {})) {
      if (fixedIn === '0' || cmp(fixedIn, from) <= 0) continue;
      const entry = { package: pkg, origin: org, from, to: to || null, fixedIn, ids };
      if (to && cmp(fixedIn, to) <= 0) available.push(entry); else pending.push(entry);
    }
    // freshness: a locked Wolfi package that disappeared from the index
    if (!newest.has(pkg) && !platform.has(pkg) && !removed.includes(pkg)) removed.push(pkg);
  }
  report.images[name] = {
    new: !before,
    changed,
    headLockSha256: before ? crypto.createHash('sha256').update(rawAt(baseRef, file)).digest('hex') : null,
    fixes: available,
    pendingFixes: pending,
    removedFromIndex: removed,
    ids: [...new Set(available.flatMap((f) => f.ids))].sort(),
  };
}

// Node.js upstream (official binary: OpenSSL is bundled, the apk scan cannot see it)
try {
  const recipe = recipes().find((r) => r.name === 'nodejs-26-official');
  const idx = JSON.parse(execFileSync('curl', ['-sSfL', '--retry', '3', 'https://nodejs.org/dist/index.json'], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const newer = idx.filter((r) => r.version.startsWith('v26.') && cmp(r.version.slice(1), recipe.version) > 0);
  report.node = { recipe: recipe.version, newer: newer.map((r) => ({ version: r.version.slice(1), date: r.date, security: r.security })), securityRelease: newer.some((r) => r.security) };
} catch (e) {
  report.node = { error: String(e.message || e) };
}

// Workshop subsets pinned to a Wolfi apk: is there a newer Wolfi build of the source?
const SOURCES = { 'gdal-tools-geo': 'gdal-tools', 'at-spi2-core-libatspi': 'at-spi2-core' };
for (const r of recipes()) {
  const src = SOURCES[r.name];
  if (!src) continue;
  const n = newest.get(src);
  report.workshop.push({ recipe: r.name, pinned: r.fullVersion, source: src, wolfiNewest: n?.v || null, bumpNeeded: !!n && cmp(n.v, r.fullVersion) > 0 });
}

if (opt('--report')) writeJson(opt('--report'), report);
for (const [n, r] of Object.entries(report.images)) {
  console.log(`${n}: ${r.new ? 'new image' : r.changed ? 'lock changed' : 'lock unchanged'}, ${r.fixes.length} fix(es) available (${r.ids.length} ids), ${r.pendingFixes.length} pending, ${r.removedFromIndex.length} removed`);
  for (const f of r.fixes.slice(0, 10)) console.log(`  fix ${f.package} ${f.from} -> ${f.to} (fixed in ${f.fixedIn}: ${f.ids.join(' ')})`);
}
if (report.node?.newer) console.log(`node: recipe ${report.node.recipe}; newer 26.x: ${report.node.newer.map((x) => x.version + (x.security ? ' (security)' : '')).join(', ') || 'none'}`);
for (const w of report.workshop) console.log(`workshop ${w.recipe}: pinned ${w.pinned}, Wolfi ${w.source} newest ${w.wolfiNewest}${w.bumpNeeded ? ' -> bump needed' : ''}`);
