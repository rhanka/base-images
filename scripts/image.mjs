#!/usr/bin/env node
// Lock, build and publish one image with apko.
//
//   node scripts/image.mjs lock <name> [--arch x86_64]     refresh images/<name>/apko.lock.json
//   node scripts/image.mjs build <name> [--out dir] [--arch x86_64]
//        build from the committed lock into <out>/image.tar (+ SBOMs); prints the index digest
//   node scripts/image.mjs publish <name> [--out dir]      apko publish from the same lock and inputs;
//        fails unless the pushed digest equals the digest built (and gated) in <out>
//   node scripts/image.mjs digest <tar>                    index digest of a built tarball
//
// Reproducibility inputs: the lock (exact apks by checksum), SOURCE_DATE_EPOCH = commit time of the
// lock, no VCS annotation (the commit lives in the provenance attestation, not in the image).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, bin, run, catalog, imageRef, lockPath, releasesInLock, currentReleases, apkoFlags, sourceDateEpoch, writeJson } from './lib.mjs';

const [cmd, name, ...rest] = process.argv.slice(2);
const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const cat = catalog();

function configPath(n) { return path.join('images', n, 'apko.yaml'); }
function archFlags() { return opt('--arch') ? ['--arch', opt('--arch')] : []; }

function lockHash(n) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, lockPath(n)))).digest('hex');
}

function commonBuildArgs(n) {
  const lock = lockPath(n);
  return [
    '--lockfile', lock,
    '--vcs=false',
    '--annotations', `dev.rhanka.base.lock-sha256:${lockHash(n)}`,
    '--annotations', `dev.rhanka.base.track:${cat.images[n].track}`,
    ...apkoFlags(releasesInLock(path.join(ROOT, lock))),
    ...archFlags(),
  ];
}

export function tarDigest(tar) {
  const idx = execFileSync('tar', ['-xOf', tar, 'index.json'], { maxBuffer: 1 << 24 });
  return 'sha256:' + crypto.createHash('sha256').update(idx).digest('hex');
}

function env(n) {
  return { SOURCE_DATE_EPOCH: sourceDateEpoch(lockPath(n)) };
}

if (!name && cmd !== 'digest') { console.error('usage: image.mjs lock|build|publish|digest <name>'); process.exit(2); }
if (cmd !== 'digest' && !cat.images[name]) throw new Error(`unknown image ${name}`);

switch (cmd) {
  case 'lock': {
    run(bin('apko'), ['lock', configPath(name), '--output', lockPath(name), ...apkoFlags(currentReleases(name)), ...archFlags()]);
    break;
  }
  case 'build': {
    const dir = opt('--out', path.join('.work', 'out', name));
    fs.rmSync(path.join(ROOT, dir), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, dir), { recursive: true });
    const ref = `${imageRef(name, cat)}:${cat.images[name].track}`;
    const e = env(name);
    run(bin('apko'), ['build', configPath(name), ref, path.join(dir, 'image.tar'), '--sbom-path', dir, ...commonBuildArgs(name)], { env: e });
    const digest = tarDigest(path.join(ROOT, dir, 'image.tar'));
    writeJson(path.join(dir, 'build.json'), { image: name, ref, digest, sourceDateEpoch: e.SOURCE_DATE_EPOCH, lockSha256: lockHash(name) });
    console.log(digest);
    break;
  }
  case 'publish': {
    const dir = opt('--out', path.join('.work', 'out', name));
    const built = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'build.json'), 'utf8'));
    const base = imageRef(name, cat);
    const track = cat.images[name].track;
    const tags = [`${base}:${track}`, `${base}:${track}-${built.lockSha256.slice(0, 12)}`];
    const refsFile = path.join(dir, 'published.txt');
    run(bin('apko'), ['publish', configPath(name), ...tags, '--sbom=false', '--image-refs', refsFile, ...commonBuildArgs(name)], { env: env(name) });
    // the moving tag must now resolve to the index digest that passed the gates
    const pushed = execFileSync(bin('crane'), ['digest', tags[0]], { encoding: 'utf8' }).trim();
    if (pushed !== built.digest) throw new Error(`published digest ${pushed} differs from the gated build ${built.digest}`);
    writeJson(path.join(dir, 'publish.json'), { ...built, tags, digest: pushed });
    console.log(`${base}@${pushed}`);
    break;
  }
  case 'digest':
    console.log(tarDigest(name));
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
