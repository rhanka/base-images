#!/usr/bin/env node
// Vulnerability scan with grype, per architecture.
//
//   node scripts/scan.mjs tar <name> <image.tar> [--report out.json]    built tarball (build gate)
//   node scripts/scan.mjs ref <image@sha256:...> [--report out.json]    published digest (daily scan)
//
// Gate: grype --only-fixed --fail-on high. --only-fixed drops matches without a fix (the NVD-CPE-only
// glibc / sqlite matches carry fix state "unknown"), so the gate fails only on a High/Critical that a
// newer package fixes. The report also keeps the unfiltered counts, for the digest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { bin, writeJson } from './lib.mjs';

const [mode, a1, a2, ...rest] = process.argv.slice(2);
const reportFile = rest.includes('--report') ? rest[rest.indexOf('--report') + 1] : (a2 === '--report' ? rest[0] : null);
const tmp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'scan-'));

function grype(source, platform) {
  const args = [source, '-o', 'json', '-q'];
  if (platform) args.push('--platform', platform);
  const r = spawnSync(bin('grype'), args, { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) { process.stderr.write(r.stderr); throw new Error(`grype failed on ${source}`); }
  const doc = JSON.parse(r.stdout);
  const all = doc.matches.map((m) => ({
    id: m.vulnerability.id,
    severity: m.vulnerability.severity,
    fix: m.vulnerability.fix?.state,
    fixedIn: m.vulnerability.fix?.versions || [],
    pkg: m.artifact.name,
    version: m.artifact.version,
    type: m.artifact.type,
    matchType: (m.matchDetails || []).map((d) => d.type).join(','),
  }));
  const fixed = all.filter((m) => m.fix === 'fixed');
  const blocking = fixed.filter((m) => ['High', 'Critical'].includes(m.severity));
  // The literal gate: grype's own --only-fixed --fail-on high. Fail closed if it disagrees.
  const gateArgs = [source, '--only-fixed', '--fail-on', 'high', '-q', '-o', 'table'];
  if (platform) gateArgs.push('--platform', platform);
  const gate = spawnSync(bin('grype'), gateArgs, { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (gate.status !== 0 && blocking.length === 0) {
    process.stderr.write(gate.stdout + gate.stderr);
    blocking.push({ id: 'grype-gate', severity: 'High', fix: 'fixed', fixedIn: [], pkg: 'grype exit ' + gate.status, version: '', type: '', matchType: '' });
  }
  return { source: source.replace(tmp, '<tmp>'), platform, total: all.length, fixed: fixed.length, blocking, cpeOnly: all.filter((m) => m.matchType === 'cpe-match').length, matches: all };
}

function splitTar(tarFile) {
  const dir = path.join(tmp, 'x');
  fs.mkdirSync(dir);
  execFileSync('tar', ['-xf', tarFile, '-C', dir]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  return manifest.map((m) => {
    const arch = JSON.parse(fs.readFileSync(path.join(dir, m.Config), 'utf8')).architecture;
    const d = path.join(tmp, arch);
    fs.mkdirSync(d);
    for (const f of [m.Config, ...m.Layers]) fs.linkSync(path.join(dir, f), path.join(d, f));
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify([m]));
    const out = path.join(tmp, `${arch}.tar`);
    execFileSync('tar', ['-cf', out, '-C', d, '.']);
    return { arch, source: `docker-archive:${out}` };
  });
}

let results;
let subject;
if (mode === 'tar') {
  subject = a1;
  results = splitTar(a2).map(({ arch, source }) => ({ arch, ...grype(source) }));
} else if (mode === 'ref') {
  subject = a1;
  results = ['amd64', 'arm64'].map((arch) => ({ arch, ...grype(`registry:${a1}`, `linux/${arch}`) }));
} else {
  console.error('usage: scan.mjs tar <name> <image.tar> | ref <image@digest>  [--report file]');
  process.exit(2);
}
fs.rmSync(tmp, { recursive: true, force: true });

const blocking = results.flatMap((r) => r.blocking.map((b) => ({ arch: r.arch, ...b })));
const report = { subject, ok: blocking.length === 0, results: results.map(({ matches, ...r }) => ({ ...r, matches: matches.filter((m) => m.fix === 'fixed') })), blocking };
if (reportFile) writeJson(reportFile, report);
for (const r of results) console.log(`${subject} ${r.arch}: ${r.total} matches (${r.cpeOnly} CPE-only), ${r.fixed} with a fix, ${r.blocking.length} High/Critical with a fix`);
for (const b of blocking) console.log(`BLOCKING ${b.arch} ${b.severity} ${b.id} ${b.pkg} ${b.version} -> ${b.fixedIn.join(',')}`);
process.exit(blocking.length ? 1 : 0);
