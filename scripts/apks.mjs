#!/usr/bin/env node
// Platform apk mirror (melange workshop output).
//
// Each melange package version is built ONCE and stored as an immutable GitHub release
// "apk-<name>-<version>-r<epoch>" of this repository. Assets:
//   <arch>.APKINDEX.tar.gz   index of that release, signed by the ephemeral key of the build job
//   <arch>.<package>.apk     the packages (signed by the same ephemeral key)
//   <id>-<arch>.rsa.pub      the public half of that key (the private half never left the job)
// Image builds download the assets into ./apks/<id>/{<arch>,keys}/ and pass them to apko as
// build-only repositories. The apko lock pins every apk by its signature, control and data checksums.
//
//   node scripts/apks.mjs fetch --image node        releases for the current recipes of an image
//   node scripts/apks.mjs fetch --lock <lock.json>  releases referenced by a lock
//   node scripts/apks.mjs fetch --all               every release of every recipe
//   node scripts/apks.mjs flags --image node | --lock <lock.json>
//   node scripts/apks.mjs exists <recipe.yaml>      exit 0 if the release already exists
//   node scripts/apks.mjs stage <recipe.yaml> <melange-out-dir> <staging-dir>   (CI: name assets)
//   node scripts/apks.mjs tag|id <recipe.yaml>
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, REPO, ARCHS, run, out, readRecipe, recipes, releaseOf, releasesInLock, currentReleases, apkoFlags, catalog } from './lib.mjs';

const [cmd, ...args] = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

function selected() {
  if (opt('--lock')) return releasesInLock(opt('--lock'));
  if (opt('--image')) return currentReleases(opt('--image'));
  if (args.includes('--all')) return recipes().map(releaseOf);
  if (args.includes('--catalog')) {
    const ids = new Map();
    for (const n of Object.keys(catalog().images)) for (const r of currentReleases(n)) ids.set(r.id, r);
    return [...ids.values()];
  }
  throw new Error('need --image, --lock, --catalog or --all');
}

function releaseExists(tag) {
  return run('gh', ['release', 'view', tag, '-R', REPO, '--json', 'tagName'], { capture: true, allowFail: true }).includes(tag);
}

function fetchRelease(rel) {
  const dir = path.join(ROOT, rel.dir);
  if (fs.existsSync(path.join(dir, 'keys'))) return; // already fetched (immutable)
  const tmp = `${dir}.dl`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  run('gh', ['release', 'download', rel.tag, '-R', REPO, '-D', tmp]);
  fs.mkdirSync(path.join(tmp, 'keys'));
  for (const f of fs.readdirSync(tmp)) {
    if (f === 'keys') continue;
    if (f.endsWith('.rsa.pub')) { fs.renameSync(path.join(tmp, f), path.join(tmp, 'keys', f)); continue; }
    const arch = ARCHS.find((a) => f.startsWith(`${a}.`));
    if (!arch) continue;
    fs.mkdirSync(path.join(tmp, arch), { recursive: true });
    fs.renameSync(path.join(tmp, f), path.join(tmp, arch, f.slice(arch.length + 1)));
  }
  for (const a of ARCHS) {
    if (!fs.existsSync(path.join(tmp, a, 'APKINDEX.tar.gz'))) throw new Error(`${rel.tag}: no ${a} index`);
  }
  fs.renameSync(tmp, dir);
  console.error(`fetched ${rel.tag} -> ${rel.dir}`);
}

switch (cmd) {
  case 'fetch':
    for (const rel of selected()) fetchRelease(rel);
    break;
  case 'flags':
    process.stdout.write(apkoFlags(selected()).join('\n') + '\n');
    break;
  case 'exists': {
    const rel = releaseOf(readRecipe(args[0]));
    console.log(rel.tag);
    process.exit(releaseExists(rel.tag) ? 0 : 1);
  }
  case 'stage': {
    // stage <recipe> <melange-out-dir> <staging-dir>: copy one arch's melange output as release assets.
    const [recipe, outDir, staging] = args;
    const rel = releaseOf(readRecipe(recipe));
    fs.mkdirSync(staging, { recursive: true });
    for (const a of ARCHS) {
      const d = path.join(outDir, a);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) fs.copyFileSync(path.join(d, f), path.join(staging, `${a}.${f}`));
    }
    console.log(rel.id);
    break;
  }
  case 'tag':
    console.log(releaseOf(readRecipe(args[0])).tag);
    break;
  case 'id':
    console.log(releaseOf(readRecipe(args[0])).id);
    break;
  default:
    console.error('usage: apks.mjs fetch|flags|exists|stage|tag ...');
    process.exit(2);
}

