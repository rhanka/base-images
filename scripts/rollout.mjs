#!/usr/bin/env node
// Rollout policy (owner decision D3, 2026-11-07): « Supervision faille daily. En fonction des failles.
// Max 1/j min 1/mois ».
//
//   decide  --fixes fixes.json [--scans dir] [--today YYYY-MM-DD] [--force reason] [--out decision.json]
//           which images roll out today, and why. Rules, in order:
//             1. at most one rollout per UTC day (cap): if rollout.json already has one today, nothing;
//             2. an image rolls when its refreshed lock makes a Wolfi fix available (fix-gate);
//             3. a new image, or a published digest not yet rolled out (config change), rolls;
//             4. floor: an image whose lock changed and whose last rollout is >= floorDays old rolls,
//                so every image with any change gets at least one rollout per calendar month;
//             5. lane "security" (72 h target) when the published digest has a High/Critical with a
//                fix (grype --only-fixed), else "routine".
//           Trial images never roll out.
//   record  --decision decision.json --results dir [--today YYYY-MM-DD]
//           append the rollout to rollout.json with the digests actually published.
//
// rollout.json is what the dispatcher reads (P1: dry-run only). Production: each rollout that is green
// in preprod gets its own owner GO (owner answer 2026-11-07, « À chaque mise à jour »).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, catalog, imageRef, today as utcToday, daysBetween, writeJson } from './lib.mjs';

const [cmd, ...args] = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const ROLLOUT = path.resolve(opt('--state', path.join(ROOT, 'rollout.json')));
const state = JSON.parse(fs.readFileSync(ROLLOUT, 'utf8'));
const cat = catalog();
const day = opt('--today', utcToday());

function readDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

if (cmd === 'decide') {
  const fixes = JSON.parse(fs.readFileSync(opt('--fixes'), 'utf8'));
  const scans = readDir(opt('--scans'));
  const force = opt('--force', null);
  const last = state.rollouts.at(-1);
  const decision = { date: day, rollout: false, reason: null, lane: 'routine', images: {}, notes: [] };

  if (last && last.date === day && !force) {
    decision.notes.push(`cap: rollout ${last.id} already done today`);
  } else {
    for (const [name, spec] of Object.entries(cat.images)) {
      if (spec.trial) continue;
      const f = fixes.images[name];
      const cur = state.current[name];
      const reasons = [];
      if (!cur) reasons.push('initial');
      if (f?.fixes.length) reasons.push('fix-available');
      if (cur && f?.changed && daysBetween(cur.since, day) >= state.policy.floorDays) reasons.push('monthly-floor');
      if (cur && f?.headLockSha256 && cur.lockSha256 !== f.headLockSha256) reasons.push('config-change');
      if (force) reasons.push(`forced: ${force}`);
      if (reasons.length) decision.images[name] = { reasons, ids: f?.ids || [], fixes: f?.fixes || [], refreshLock: !!(f?.changed && (f.fixes.length || reasons.includes('monthly-floor') || force)) };
    }
    const scanBlocking = scans.flatMap((s) => s.blocking.map((b) => ({ subject: s.subject, ...b })));
    if (scanBlocking.length) {
      decision.lane = 'security';
      decision.scanBlocking = scanBlocking;
    }
    decision.rollout = Object.keys(decision.images).length > 0;
    decision.reason = [...new Set(Object.values(decision.images).flatMap((i) => i.reasons))].join(', ') || null;
    if (!decision.rollout) decision.notes.push('no fix available, nothing new, floor not reached: no rollout today');
  }
  if (opt('--out')) writeJson(opt('--out'), decision);
  console.log(JSON.stringify({ rollout: decision.rollout, reason: decision.reason, lane: decision.lane, images: Object.keys(decision.images), notes: decision.notes }));
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `rollout=${decision.rollout}\nimages=${JSON.stringify(Object.keys(decision.images))}\nrefresh=${JSON.stringify(Object.entries(decision.images).filter(([, v]) => v.refreshLock).map(([k]) => k))}\nlane=${decision.lane}\n`);
  }
} else if (cmd === 'record') {
  const decision = JSON.parse(fs.readFileSync(opt('--decision'), 'utf8'));
  const results = readDir(opt('--results'));
  const sameDay = state.rollouts.filter((r) => r.date === day).length;
  const id = sameDay ? `${day}.${sameDay + 1}` : day;
  const entry = { id, date: day, reason: decision.reason, lane: decision.lane, deadline: decision.lane === 'security' ? new Date(Date.parse(day) + 72 * 3600e3).toISOString() : null, images: {}, ids: [] };
  for (const r of results) {
    const spec = cat.images[r.image];
    if (!spec || spec.trial || !decision.images[r.image]) continue;
    const prev = state.current[r.image];
    if (prev && prev.digest === r.digest) continue; // same digest: nothing to roll for this image
    entry.images[r.image] = { ref: imageRef(r.image, cat), track: spec.track, from: prev?.digest || null, to: r.digest, reasons: decision.images[r.image].reasons };
    entry.ids.push(...decision.images[r.image].ids);
    state.current[r.image] = { ref: imageRef(r.image, cat), track: spec.track, digest: r.digest, lockSha256: r.lockSha256, since: day, rollout: id };
  }
  entry.ids = [...new Set(entry.ids)].sort();
  if (!Object.keys(entry.images).length) {
    console.log('record: no digest changed, nothing recorded');
    process.exit(0);
  }
  state.rollouts.push(entry);
  state.rollouts = state.rollouts.slice(-60);
  state.updated = new Date().toISOString();
  fs.writeFileSync(ROLLOUT, JSON.stringify(state, null, 2) + '\n');
  console.log(`recorded rollout ${id}: ${Object.keys(entry.images).join(', ')}`);
} else {
  console.error('usage: rollout.mjs decide|record ...');
  process.exit(2);
}
