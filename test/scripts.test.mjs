// node --test test/  (Node.js built-in test runner, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { apkVersionCompare as cmp, readRecipe, releaseOf, ROOT } from '../scripts/lib.mjs';

test('apk version comparison', () => {
  assert.equal(cmp('1.2.3-r0', '1.2.3-r1'), -1);
  assert.equal(cmp('1.2.10-r0', '1.2.9-r5'), 1);
  assert.equal(cmp('26.13.0-r0', '26.13.0-r0'), 0);
  assert.equal(cmp('2.44-r14', '2.44-r9'), 1);
  assert.equal(cmp('1.0_rc1-r0', '1.0-r0'), -1);
  assert.equal(cmp('1.0_p1-r0', '1.0-r0'), 1);
  assert.equal(cmp('20261020-r0', '20250911-r3'), 1);
  assert.equal(cmp('1.2', '1.2.1'), -1);
  assert.equal(cmp('3.13.3-r6', '3.13.3-r10'), -1);
});

test('melange recipes parse and map to immutable releases', () => {
  const r = readRecipe(path.join(ROOT, 'melange/nodejs-26-official.yaml'));
  assert.equal(r.name, 'nodejs-26-official');
  assert.match(r.fullVersion, /^26\.\d+\.\d+-r\d+$/);
  assert.deepEqual(r.subpackages, ['nodejs-26-official-npm']);
  assert.equal(releaseOf(r).tag, `apk-nodejs-26-official-${r.fullVersion}`);
});

function tmpState(rollouts, current = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-'));
  const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'rollout.json'), 'utf8'));
  state.rollouts = rollouts;
  state.current = current;
  fs.writeFileSync(path.join(dir, 'rollout.json'), JSON.stringify(state));
  return dir;
}
function fixes(images) {
  return { images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, { changed: false, fixes: [], ids: [], headLockSha256: 'h', ...v }])) };
}
function decide(dir, fx, day) {
  fs.writeFileSync(path.join(dir, 'fixes.json'), JSON.stringify(fx));
  const outFile = path.join(dir, 'decision.json');
  execFileSync('node', [path.join(ROOT, 'scripts/rollout.mjs'), 'decide', '--state', path.join(dir, 'rollout.json'), '--fixes', path.join(dir, 'fixes.json'), '--today', day, '--out', outFile], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' } });
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}
const cur = (since, lock = 'h') => ({ digest: 'sha256:a', lockSha256: lock, since });
const allCurrent = (since) => ({ node: cur(since), 'node-poppler': cur(since), web: cur(since), cc: cur(since), toolbox: cur(since), 'node-dev': cur(since) });

test('rollout: a fix available rolls out, routine lane', () => {
  const dir = tmpState([{ id: '2026-11-01', date: '2026-11-01' }], allCurrent('2026-11-01'));
  const d = decide(dir, fixes({ node: { changed: true, fixes: [{ ids: ['CVE-1'] }], ids: ['CVE-1'] } }), '2026-11-08');
  assert.equal(d.rollout, true);
  assert.deepEqual(Object.keys(d.images), ['node']);
  assert.equal(d.images.node.refreshLock, true);
  assert.equal(d.lane, 'routine');
});

test('rollout: at most one per day (cap)', () => {
  const dir = tmpState([{ id: '2026-11-08', date: '2026-11-08' }], allCurrent('2026-11-08'));
  const d = decide(dir, fixes({ node: { changed: true, fixes: [{ ids: ['CVE-1'] }], ids: ['CVE-1'] } }), '2026-11-08');
  assert.equal(d.rollout, false);
  assert.match(d.notes.join(' '), /cap/);
});

test('rollout: lock changes without fix wait for the monthly floor', () => {
  const dir = tmpState([{ id: '2026-10-20', date: '2026-10-20' }], allCurrent('2026-10-20'));
  assert.equal(decide(dir, fixes({ web: { changed: true } }), '2026-11-08').rollout, false);
  const d = decide(dir, fixes({ web: { changed: true } }), '2026-11-17');
  assert.equal(d.rollout, true);
  assert.deepEqual(d.images.web.reasons, ['monthly-floor']);
});

test('rollout: new images roll out first time, trial images never', () => {
  const dir = tmpState([]);
  const d = decide(dir, fixes({ node: {}, e2e: {} }), '2026-11-07');
  assert.equal(d.rollout, true);
  assert.ok(d.images.node.reasons.includes('initial'));
  assert.equal(d.images.e2e, undefined);
});

test('dispatcher dry-run plans one PR with every stale reference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  const digest = (c) => `sha256:${c.repeat(64)}`;
  const state = { registry: 'ghcr.io/rhanka/base', current: { node: { digest: digest('a') }, 'node-dev': { digest: digest('b') }, toolbox: { digest: digest('3') } }, rollouts: [{ id: '2026-11-08', date: '2026-11-08', reason: 'fix-available', lane: 'routine', ids: ['CVE-1'] }] };
  fs.writeFileSync(path.join(dir, 'rollout.json'), JSON.stringify(state));
  const r = spawnSync('node', [path.join(ROOT, 'scripts/dispatch.mjs'), '--root', path.join(ROOT, 'test/fixtures/tenant'), '--rollout', path.join(dir, 'rollout.json'), '--dry-run'], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WOULD OPEN 1 pull request/);
  assert.match(r.stdout, /edits \(2\)/); // node-dev and node; toolbox already current
  const refused = spawnSync('node', [path.join(ROOT, 'scripts/dispatch.mjs'), '--root', dir, '--rollout', path.join(dir, 'rollout.json')], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
});

test('fix gate: a newer locked version listed in secfixes is an available fix; CPE plays no part', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixgate-'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'images/cc/apko.lock.json'), 'utf8'));
  const glibc = lock.contents.packages.find((p) => p.name.startsWith('glibc-2.') && p.architecture === 'x86_64' && !p.name.includes('locale'));
  const old = structuredClone(lock);
  for (const p of old.contents.packages) if (p.name === glibc.name) p.version = glibc.version.replace(/-r\d+$/, '-r1');
  fs.writeFileSync(path.join(dir, 'cc.lock.json'), JSON.stringify(old));
  for (const n of ['node', 'node-poppler', 'web', 'toolbox', 'node-dev', 'e2e']) fs.copyFileSync(path.join(ROOT, `images/${n}/apko.lock.json`), path.join(dir, `${n}.lock.json`));
  const sec = { packages: [{ pkg: { name: glibc.name, secfixes: { '0': ['CVE-2000-0001'], [glibc.version]: ['CVE-2026-0001'], [glibc.version.replace(/-r\d+$/, '-r999')]: ['CVE-2026-0002'] } } }] };
  fs.writeFileSync(path.join(dir, 'security.json'), JSON.stringify(sec));
  fs.writeFileSync(path.join(dir, 'APKINDEX'), `P:${glibc.name}\nV:${glibc.version}\no:${glibc.name}\nt:1\n\n`);
  execFileSync('node', [path.join(ROOT, 'scripts/fix-gate.mjs'), '--security', path.join(dir, 'security.json'), '--index', path.join(dir, 'APKINDEX'), '--base-dir', dir, '--report', path.join(dir, 'fixes.json')], { encoding: 'utf8' });
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'fixes.json'), 'utf8')).images;
  assert.deepEqual(r.cc.ids, ['CVE-2026-0001']); // fixed in the version the fresh lock reaches
  assert.equal(r.cc.pendingFixes[0].ids[0], 'CVE-2026-0002'); // listed, not yet reachable
  assert.equal(r.node.fixes.length, 0);
});
