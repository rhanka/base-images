#!/usr/bin/env node
// Smoke-run a built image (amd64) with docker: read-only root filesystem, non-root, no new privileges.
//
//   node scripts/smoke.mjs <name> <image.tar>
import { execFileSync, spawnSync } from 'node:child_process';
import { catalog, imageRef } from './lib.mjs';

const [name, tar] = process.argv.slice(2);
const cat = catalog();
const spec = cat.images[name];
if (!spec || !tar) { console.error('usage: smoke.mjs <name> <image.tar>'); process.exit(2); }

const loaded = execFileSync('docker', ['load', '-i', tar], { encoding: 'utf8' });
const ref = `${imageRef(name, cat)}:${spec.track}-amd64`;
if (!loaded.includes(ref)) throw new Error(`docker load did not produce ${ref}:\n${loaded}`);
const base = ['run', '--rm', '--read-only', '--tmpfs', '/tmp', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL'];

let failed = 0;
for (const cmd of spec.smoke) {
  const flags = cmd.filter((a) => a.startsWith('--entrypoint='));
  const args = cmd.filter((a) => !a.startsWith('--entrypoint='));
  const r = spawnSync('docker', [...base, ...flags, ref, ...args], { encoding: 'utf8' });
  const outText = (r.stdout + r.stderr).trim().split('\n').slice(0, 4).join(' | ');
  console.log(`${r.status === 0 ? 'OK  ' : 'FAIL'} ${name}: ${cmd.join(' ')} -> ${outText}`);
  if (r.status !== 0) failed++;
}

if (name === 'web') {
  // serve on 8080 as uid 65532 with a read-only root filesystem
  const id = execFileSync('docker', [...base.filter((a) => a !== '--rm'), '-d', '-p', '127.0.0.1::8080', ref], { encoding: 'utf8' }).trim();
  try {
    const port = execFileSync('docker', ['port', id, '8080/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
    let body = '';
    for (let i = 0; i < 20 && !body; i++) {
      const r = spawnSync('curl', ['-sSf', `http://127.0.0.1:${port}/`], { encoding: 'utf8' });
      if (r.status === 0) body = r.stdout; else spawnSync('sleep', ['0.5']);
    }
    const ok = body.includes('ghcr.io/rhanka/base/web');
    console.log(`${ok ? 'OK  ' : 'FAIL'} web: GET / on 8080 as non-root, read-only rootfs`);
    if (!ok) { failed++; console.log(execFileSync('docker', ['logs', id], { encoding: 'utf8' })); }
  } finally {
    spawnSync('docker', ['rm', '-f', id]);
  }
}
process.exit(failed ? 1 : 0);
