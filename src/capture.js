// Turn hand edits in an installed package into stickypatch edits.
//
// Edit the installed file however you like, then `stickypatch capture <file>`.
// We diff it against a pristine copy (plus any patches you already keep for that
// file) and grow each changed region's context until its anchor is unique.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changeRegions, diffLines, splitLines } from './diff.js';
import * as P from './patch.js';
import { StickyError, count, insideRoot } from './util.js';

export function fetchPristine(packageName, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickypatch-pristine-'));
  let tarball;
  try {
    const out = execFileSync('npm', ['pack', `${packageName}@${version}`, '--pack-destination', dir, '--silent'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    tarball = path.join(dir, out.trim().split('\n').pop());
    execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: 'ignore' });
  } catch (error) {
    throw new StickyError(
      `could not download a pristine ${packageName}@${version} with npm pack (${error.message.split('\n')[0]}).\n`
        + 'Pass --pristine <dir> pointing at an unmodified copy of the package instead.',
    );
  }
  return path.join(dir, 'package');
}

function join(lines, from, to) {
  return lines.slice(from, to).join('');
}

/**
 * Build find/replace edits that turn `base` into `current`.
 * `owned` lists [startLine, endLine) ranges of `base` that other patches produced;
 * anchors avoid them when possible so patches stay independent of each other.
 */
export function editsFromDiff(file, base, current, { maxContext = 30, owned = [] } = {}) {
  const a = splitLines(base);
  const b = splitLines(current);
  let regions = changeRegions(diffLines(a, b));
  if (!regions.length) return [];

  // Merge regions that are close to each other — one edit reads better than two.
  const merge = (list, gap) => {
    const merged = [];
    for (const r of list) {
      const last = merged[merged.length - 1];
      if (last && r.a0 - last.a1 <= gap) {
        last.a1 = r.a1;
        last.b1 = r.b1;
      } else merged.push({ ...r });
    }
    return merged;
  };
  regions = merge(regions, 2);
  const touchesOwned = (a0, a1) => owned.some(([s, e]) => a0 < e && s < a1);

  const anchorFor = (r, allowOwned) => {
    // Smallest context first. Prefer at least one line of context so an anchor is never just
    // the edit itself; fall back to zero context only when the region already spans the file.
    const spansFile = r.a0 === 0 && r.a1 === a.length;
    for (let total = spansFile ? 0 : 1; total <= maxContext * 2; total += 1) {
      for (let lead = 0; lead <= total; lead += 1) {
        const trail = total - lead;
        const a0 = r.a0 - lead;
        const a1 = r.a1 + trail;
        if (a0 < 0 || a1 > a.length) continue;
        if (!allowOwned && touchesOwned(a0, a1)) continue;
        const find = join(a, a0, a1);
        const replace = join(b, r.b0 - lead, r.b1 + trail);
        if (find && count(base, find) === 1 && find !== replace) return { a0, a1, find, replace };
      }
    }
    return null;
  };

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const edits = [];
    let overlap = false;
    for (const r of regions) {
      const found = anchorFor(r, false) || anchorFor(r, true);
      if (!found) {
        throw new StickyError(`${file}: could not find a unique anchor for the change near line ${r.a0 + 1}`);
      }
      const prev = edits[edits.length - 1];
      if (prev && found.a0 < prev.a1) {
        overlap = true;
        break;
      }
      edits.push(found);
    }
    if (!overlap) return edits.map((e) => ({ file, find: e.find, replace: e.replace }));
    regions = merge(regions, maxContext * 2);
  }
  throw new StickyError(`${file}: could not split the change into independent edits`);
}

/**
 * Baseline for a file = pristine bytes with the target's existing (non-retired)
 * patches applied. Also returns the line ranges those patches produced.
 */
export function baselineFor(target, relative, pristineRoot, warn = () => {}) {
  const abs = insideRoot(pristineRoot, relative);
  if (!fs.existsSync(abs)) throw new StickyError(`${relative} does not exist in the pristine package`);
  let text = fs.readFileSync(abs, 'utf8');
  const replaced = [];
  for (const patch of target.patches) {
    if (patch.retired || !patch.files.includes(relative)) continue;
    const files = {};
    for (const f of patch.readFiles) {
      const p = insideRoot(pristineRoot, f);
      if (fs.existsSync(p)) files[f] = f === relative ? text : fs.readFileSync(p, 'utf8');
    }
    const finding = P.detect(files, patch);
    if (P.ACTIONABLE.has(finding.status)) {
      try {
        const out = P.render(files, patch);
        if (out[relative] !== undefined) text = out[relative];
      } catch (error) {
        warn(`existing patch "${patch.id}" did not render on the pristine copy: ${error.message}`);
        continue;
      }
    } else if (finding.status !== P.APPLIED) {
      warn(`existing patch "${patch.id}" is ${finding.status} on the pristine copy; its changes may show up in this capture`);
      continue;
    }
    for (const edit of patch.edits || []) if (edit.file === relative && edit.replace) replaced.push(edit.replace);
  }
  const owned = [];
  for (const r of replaced) {
    const at = text.indexOf(r);
    if (at === -1) continue;
    const start = text.slice(0, at).split('\n').length - 1;
    const end = start + r.replace(/\n$/, '').split('\n').length;
    owned.push([start, end]);
  }
  return { text, owned };
}
