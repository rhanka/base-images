#!/usr/bin/env node
// Rollout dispatcher, DRY-RUN ONLY in P1: prints the pull request it would open in one tenant repository.
//
// Run by a tenant repository (reusable workflow .github/workflows/dispatch.yml) on its own checkout, with
// its own GITHUB_TOKEN: the base repository never lists or names tenant repositories.
//
//   node scripts/dispatch.mjs --root <tenant checkout> --rollout <rollout.json path or URL> [--dry-run]
//
// It rewrites every "ghcr.io/rhanka/base/<image>[:tag]@sha256:<digest>" reference whose digest is not the
// current one in rollout.json (Dockerfiles, manifests, Makefiles, compose files, workflows), and builds
// ONE pull request per repository per rollout: title, branch, body with the images, the fixed advisory
// ids and the lane. Opening the PR is P3; this script refuses to do it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const root = path.resolve(opt('--root', '.'));
const source = opt('--rollout');
if (!source) { console.error('usage: dispatch.mjs --root <dir> --rollout <file|url> [--dry-run]'); process.exit(2); }
if (!args.includes('--dry-run')) {
  console.error('dispatch.mjs: only --dry-run is enabled in P1 (opening PRs is P3).');
  process.exit(2);
}

const rollout = /^https?:\/\//.test(source)
  ? JSON.parse(execFileSync('curl', ['-sSfL', '--retry', '3', source], { encoding: 'utf8' }))
  : JSON.parse(fs.readFileSync(source, 'utf8'));
const registry = rollout.registry;
const last = rollout.rollouts.at(-1);
if (!last) { console.log('dispatch: no rollout recorded yet'); process.exit(0); }

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'vendor', '.work']);
function files(dir) {
  try {
    const tracked = execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 })
      .split('\0').filter(Boolean).map((f) => path.join(dir, f));
    if (!tracked.length) throw new Error('no tracked files');
    return tracked;
  } catch {
    const outList = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name)); } else if (e.isFile()) outList.push(path.join(d, e.name));
      }
    })(dir);
    return outList;
  }
}

const esc = registry.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const REF = new RegExp(`${esc}/([a-z0-9][a-z0-9-]*)(:[A-Za-z0-9._-]+)?@sha256:([a-f0-9]{64})`, 'g');
const edits = [];
for (const f of files(root)) {
  let st;
  try { st = fs.statSync(f); } catch { continue; }
  if (st.size > 2e6) continue;
  const text = fs.readFileSync(f, 'utf8');
  if (!text.includes(registry) || text.includes('\0')) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(REF)) {
      const [, image, tag, digest] = m;
      const cur = rollout.current[image];
      if (!cur || `sha256:${digest}` === cur.digest) continue;
      edits.push({ file: path.relative(root, f), line: i + 1, image, tag: tag || '', from: `sha256:${digest}`, to: cur.digest });
    }
  });
}

const touched = [...new Set(edits.map((e) => e.image))];
if (!edits.length) {
  console.log(`dispatch (dry-run): ${path.basename(root)} already on rollout ${last.id} for every referenced base image; no PR.`);
  process.exit(0);
}
const lane = last.lane === 'security' ? `security (deadline ${last.deadline})` : 'routine';
const body = [
  `Base image rollout ${last.id} (${last.reason || 'n/a'}), lane: ${lane}.`,
  '',
  '| image | from | to |',
  '|---|---|---|',
  ...touched.map((i) => `| ${registry}/${i} | ${edits.find((e) => e.image === i).from.slice(0, 19)} | ${rollout.current[i].digest.slice(0, 19)} |`),
  '',
  last.ids?.length ? `Fixed advisories (Wolfi secfixes): ${last.ids.join(', ')}` : 'No advisory in this rollout (monthly floor, new image or configuration change).',
  '',
  'Verify before merge:',
  ...touched.map((i) => `- \`cosign verify ${registry}/${i}@${rollout.current[i].digest} --certificate-identity https://github.com/rhanka/base-images/.github/workflows/build.yml@refs/heads/main --certificate-oidc-issuer https://token.actions.githubusercontent.com\``),
  '',
  'Merge rule: auto-merge on green CI deploys preprod only; production waits for the owner GO of this rollout.',
].join('\n');

console.log(`dispatch (dry-run): WOULD OPEN 1 pull request in ${path.basename(root)}`);
console.log(`  branch: base-images/rollout-${last.id}`);
console.log(`  title:  chore(base): roll out base images ${last.id} (${touched.join(', ')})`);
console.log(`  labels: base-images${last.lane === 'security' ? ', security' : ''}`);
console.log(`  edits (${edits.length}):`);
for (const e of edits) console.log(`    ${e.file}:${e.line} ${e.image}${e.tag} ${e.from.slice(0, 19)}… -> ${e.to.slice(0, 19)}…`);
console.log('  body:');
console.log(body.split('\n').map((l) => `    ${l}`).join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Dispatcher dry-run: would open 1 PR\n\n**chore(base): roll out base images ${last.id}**\n\n${body}\n\nEdits:\n${edits.map((e) => `- \`${e.file}:${e.line}\` ${e.image}`).join('\n')}\n`);
}
