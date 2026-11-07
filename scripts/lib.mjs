// Shared helpers for the build scripts. Node.js standard library only (no npm dependencies).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = process.env.GITHUB_REPOSITORY || 'rhanka/base-images';
export const ARCHS = ['x86_64', 'aarch64'];
export const OCI_ARCH = { x86_64: 'amd64', aarch64: 'arm64' };

export function catalog() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'images.json'), 'utf8'));
}

export function imageRef(name, cat = catalog()) {
  return `${cat.registry}/${name}`;
}

export function bin(tool) {
  const local = path.join(ROOT, '.bin', tool);
  return fs.existsSync(local) ? local : tool;
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', env: { ...process.env, ...(opts.env || {}) } });
  if (r.status !== 0 && !opts.allowFail) {
    if (opts.capture) process.stderr.write(r.stderr || '');
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  }
  return opts.capture ? r.stdout : r.status;
}

export function out(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts }).trim();
}

/** Minimal YAML field read for melange recipes: package.name / version / epoch and subpackage names. */
export function readRecipe(file) {
  const text = fs.readFileSync(file, 'utf8');
  const pkg = text.split(/\n(?=\S)/).find((b) => b.startsWith('package:')) || '';
  const field = (k) => (pkg.match(new RegExp(`^  ${k}:\\s*"?([^"\\s#]+)"?`, 'm')) || [])[1];
  const subs = [...text.matchAll(/^  - name: (\S+)/gm)].map((m) => m[1]);
  const name = field('name');
  const version = field('version');
  const epoch = field('epoch') || '0';
  if (!name || !version) throw new Error(`cannot parse ${file}`);
  return { file, name, version, epoch, fullVersion: `${version}-r${epoch}`, subpackages: subs };
}

export function recipes() {
  const dir = path.join(ROOT, 'melange');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => readRecipe(path.join(dir, f)));
}

/** Release (= mirror entry) for one melange package build: immutable once published. */
export function releaseOf(recipe) {
  const id = `${recipe.name}-${recipe.fullVersion}`;
  return { id, tag: `apk-${id}`, dir: `./apks/${id}` };
}

/** Platform package releases referenced by a lock file (package urls under ./apks/<id>/<arch>/). */
export function releasesInLock(lockFile) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const ids = new Set();
  for (const p of [...(lock.contents.repositories || []), ...(lock.contents.packages || [])]) {
    const m = p.url.match(/^\.\/apks\/([^/]+)\//);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort().map((id) => ({ id, tag: `apk-${id}`, dir: `./apks/${id}` }));
}

/** Current releases for an image, from images.json "platform" and the melange recipes. */
export function currentReleases(imageName, cat = catalog()) {
  const all = recipes();
  return (cat.images[imageName].platform || []).map((n) => {
    const r = all.find((x) => x.name === n);
    if (!r) throw new Error(`no melange recipe for ${n}`);
    return releaseOf(r);
  });
}

/** apko flags for a set of releases: build-only repositories and their per-arch public keys. */
export function apkoFlags(releases) {
  const flags = [];
  for (const rel of releases) {
    const abs = path.join(ROOT, rel.dir);
    if (!fs.existsSync(abs)) throw new Error(`${rel.dir} missing: run node scripts/apks.mjs fetch first`);
    flags.push('-b', rel.dir);
    for (const k of fs.readdirSync(path.join(abs, 'keys')).filter((f) => f.endsWith('.rsa.pub')).sort()) {
      flags.push('-k', `${rel.dir}/keys/${k}`);
    }
  }
  return flags;
}

export function lockPath(name) {
  return path.join('images', name, 'apko.lock.json');
}

/** SOURCE_DATE_EPOCH = commit time of the last commit that touched the lock (falls back to now for an uncommitted lock). */
export function sourceDateEpoch(file) {
  const t = spawnSync('git', ['log', '-1', '--format=%ct', '--', file], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  if (t) return t;
  if (process.env.CI) throw new Error(`${file} is not committed: SOURCE_DATE_EPOCH undefined`);
  return String(Math.floor(Date.now() / 1000));
}

export function sha256File(file) {
  return out('sha256sum', [file]).split(/\s+/)[0];
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(path.resolve(ROOT, file)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, file), JSON.stringify(obj, null, 2) + '\n');
}

/** apk version comparison (apk-tools semantics, subset used by Wolfi: digits, letters, _suffixN, -rN). */
export function apkVersionCompare(a, b) {
  const parse = (v) => {
    const m = v.match(/^(.*?)(?:-r(\d+))?$/);
    return { body: m[1], rel: Number(m[2] || 0) };
  };
  const suffixRank = { alpha: -4, beta: -3, pre: -2, rc: -1, '': 0, cvs: 1, svn: 2, git: 3, hg: 4, p: 5 };
  const tok = (s) => {
    const parts = [];
    const [main, ...sfx] = s.split('_');
    for (const seg of main.split('.')) {
      const m = seg.match(/^(\d+)([a-z]?)$/);
      if (m) parts.push([0, Number(m[1])], [1, m[2] ? m[2].charCodeAt(0) : 0]);
      else parts.push([2, seg]);
    }
    for (const s2 of sfx) {
      const m = s2.match(/^([a-z]+)(\d*)$/) || [null, s2, ''];
      parts.push([3, suffixRank[m[1]] ?? 0], [0, Number(m[2] || 0)]);
    }
    return parts;
  };
  const A = parse(a), B = parse(b);
  const ta = tok(A.body), tb = tok(B.body);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (!x) return y[0] === 3 && y[1] < 0 ? 1 : -1;
    if (!y) return x[0] === 3 && x[1] < 0 ? -1 : 1;
    if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  }
  return A.rel === B.rel ? 0 : A.rel < B.rel ? -1 : 1;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
