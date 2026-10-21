// Inspect, plan, apply and roll back patches as recoverable batches.
//
// Guarantees:
//   * everything is checked before anything is written (targets, version, anchors)
//   * every result is rendered in memory first, so a batch is never half-applied
//   * each file's hash is re-checked right before its write (concurrent edits stop the batch)
//   * if any write fails, files already written are restored from the batch backup
//   * applying an already-applied set is a no-op and creates no batch
//   * rollback is per batch and never guesses "the newest backup"

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as P from './patch.js';
import { StickyError, atomicWrite, batchStamp, insideRoot, isoNow, readJson, sha256, sha256File, short, writeJson } from './util.js';

export const TOOL = 'stickypatch/1';

export function loadTree(target, resolved) {
  const files = {};
  const wanted = new Set();
  for (const patch of target.patches) for (const f of patch.readFiles) wanted.add(f);
  for (const relative of wanted) {
    const abs = insideRoot(resolved.root, relative);
    try {
      files[relative] = fs.readFileSync(abs, 'utf8');
    } catch {
      /* reported as unverifiable by detect() */
    }
  }
  return { ...resolved, target, files };
}

export function inspect(tree) {
  return tree.target.patches.map((patch) => P.detect(tree.files, patch));
}

export function versionState(tree) {
  const tested = tree.target.testedVersions;
  if (!tested.length) return { ok: true, tested, note: 'no testedVersions configured' };
  return { ok: tested.includes(tree.version), tested };
}

function selectPatches(tree, only) {
  if (!only || !only.length) return tree.target.patches;
  const known = new Set(tree.target.patches.map((p) => p.id));
  for (const id of only) if (!known.has(id)) throw new StickyError(`unknown patch id: ${id}`);
  return tree.target.patches.filter((p) => only.includes(p.id));
}

/** Decide what a batch would write. Throws (writing nothing) if the batch must not start. */
export function prepare(tree, { only = null, allowUntested = false, partial = false } = {}) {
  const patches = selectPatches(tree, only);
  const findings = patches.map((patch) => P.detect(tree.files, patch));
  const version = versionState(tree);
  if (!version.ok && !allowUntested) {
    throw new StickyError(
      `${tree.name}@${tree.version} has not been tested with these patches (tested: ${version.tested.join(', ')}).\n`
        + 'Check `stickypatch status` / `stickypatch review`, then run `stickypatch approve`, '
        + 'or pass --allow-untested. Nothing was written.',
      { code: 'UNTESTED_VERSION' },
    );
  }
  const blocking = findings.filter((f) => f.status === P.INCOMPATIBLE || f.status === P.UNVERIFIABLE);
  if (blocking.length && !partial && !only) {
    const lines = blocking.map((f) => `  ${f.id}: ${f.status} — ${f.detail}`).join('\n');
    throw new StickyError(
      `refusing to apply a partial set while some patches need attention:\n${lines}\n`
        + 'Fix or retire them (try `stickypatch review`), or pass --partial / --only <id>. Nothing was written.',
      { code: 'BLOCKED' },
    );
  }
  const pending = findings.filter((f) => P.ACTIONABLE.has(f.status));
  const working = {};
  const touched = {};
  for (const finding of pending) {
    const patch = patches.find((p) => p.id === finding.id);
    const view = { ...tree.files, ...working };
    const out = P.render(view, patch);
    for (const [file, body] of Object.entries(out)) {
      working[file] = body;
      (touched[file] ||= []).push(patch.id);
    }
  }
  const writes = Object.keys(working)
    .filter((file) => working[file] !== tree.files[file])
    .sort()
    .map((file) => ({
      path: file,
      patches: touched[file],
      before: tree.files[file],
      after: working[file],
      sha256Before: sha256(tree.files[file]),
      sha256After: sha256(working[file]),
    }));
  return { findings, version, writes };
}

function targetDir(batchRoot, name) {
  return path.join(batchRoot, name.replace(/[^A-Za-z0-9._-]+/g, '_'));
}

function log(dir, message) {
  fs.appendFileSync(path.join(dir, 'batch.log'), `${isoNow()} ${message}\n`);
}

export function apply(tree, prepared, batchRoot, { onBeforeWrite = null } = {}) {
  const { writes } = prepared;
  if (!writes.length) return { status: 'no-op', batchId: null, writes: [] };

  const now = new Date();
  const batchId = `${batchStamp(now)}-${createHash('sha256').update(`${now.getTime()}${process.pid}${Math.random()}`).digest('hex').slice(0, 6)}`;
  const dir = path.join(targetDir(batchRoot, tree.target.name), batchId);
  const filesDir = path.join(dir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  for (const w of writes) {
    const backup = insideRoot(filesDir, w.path);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(insideRoot(tree.root, w.path), backup);
    if (sha256File(backup) !== w.sha256Before) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new StickyError(`${w.path} changed after the check (while it was being backed up); nothing was written`);
    }
  }
  const manifest = {
    tool: TOOL,
    batchId,
    createdAt: isoNow(),
    status: 'applying',
    target: { name: tree.target.name, packageName: tree.name, package: tree.target.package, version: tree.version, root: tree.root, via: tree.via },
    patches: [...new Set(writes.flatMap((w) => w.patches))],
    files: writes.map((w) => ({ path: w.path, patches: w.patches, sha256Before: w.sha256Before, sha256After: w.sha256After })),
  };
  const manifestPath = path.join(dir, 'manifest.json');
  writeJson(manifestPath, manifest);
  log(dir, `batch created for ${manifest.patches.join(', ')}`);

  const written = [];
  try {
    for (const w of writes) {
      const abs = insideRoot(tree.root, w.path);
      if (onBeforeWrite) onBeforeWrite(w.path, abs);
      const current = sha256File(abs);
      if (current !== w.sha256Before) {
        throw new StickyError(
          `${w.path} changed on disk after the check (expected ${short(w.sha256Before)}, found ${short(current)}). `
            + 'Another process edited it; the batch was stopped.',
        );
      }
      atomicWrite(abs, w.after);
      written.push(w);
      log(dir, `wrote ${w.path} ${short(w.sha256After)}`);
    }
    for (const w of writes) {
      if (sha256File(insideRoot(tree.root, w.path)) !== w.sha256After) {
        throw new StickyError(`${w.path} does not match the rendered result after writing`);
      }
    }
  } catch (error) {
    const restored = [];
    const preserved = [];
    for (const w of written) {
      const abs = insideRoot(tree.root, w.path);
      let current = null;
      try {
        current = sha256File(abs);
      } catch {
        /* missing */
      }
      if (current !== w.sha256After) {
        preserved.push(w.path); // someone else changed it after us: do not clobber
        continue;
      }
      atomicWrite(abs, w.before);
      restored.push(w.path);
    }
    Object.assign(manifest, { status: 'failed', failure: error.message, restored, preservedConcurrentEdits: preserved });
    writeJson(manifestPath, manifest);
    log(dir, `FAILED: ${error.message}; restored ${restored.length} file(s)`);
    const tail = preserved.length
      ? ` Concurrent edits were preserved in: ${preserved.join(', ')}. Inspect ${manifestPath}.`
      : ' Every file was restored to its pre-batch bytes.';
    throw new StickyError(error.message + tail, { code: 'APPLY_FAILED' });
  }
  manifest.status = 'applied';
  manifest.appliedAt = isoNow();
  writeJson(manifestPath, manifest);
  log(dir, `applied ${writes.length} file(s)`);
  return { status: 'applied', batchId, batchDir: dir, writes };
}

export function listBatches(batchRoot, name) {
  const dir = targetDir(batchRoot, name);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .reverse()
    .map((id) => {
      try {
        const m = readJson(path.join(dir, id, 'manifest.json'));
        return { batchId: m.batchId, createdAt: m.createdAt, status: m.status, version: m.target?.version, patches: m.patches, files: m.files.length };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function markBatch(batchRoot, name, batchId, fields) {
  const manifestPath = path.join(targetDir(batchRoot, name), batchId, 'manifest.json');
  const m = readJson(manifestPath);
  Object.assign(m, fields);
  writeJson(manifestPath, m);
}

/**
 * Restore one batch's pre-apply bytes. Everything is verified before the first
 * byte is written, so a missing backup can never leave a half-rolled-back tree.
 */
export function rollback(batchRoot, name, batchId, { force = false } = {}) {
  if (!batchId) {
    throw new StickyError('rollback needs an explicit batch id (see `stickypatch batches`); refusing to guess');
  }
  const dir = path.join(targetDir(batchRoot, name), batchId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new StickyError(`unknown batch for ${name}: ${batchId}`);
  const manifest = readJson(manifestPath);
  if (manifest.status === 'rolled-back' && !force) throw new StickyError(`batch ${batchId} is already rolled back`);
  if (manifest.status !== 'applied' && manifest.status !== 'rolled-back' && !force) {
    throw new StickyError(`batch ${batchId} has status "${manifest.status}"; inspect ${manifestPath} (or pass --force)`);
  }
  const root = manifest.target.root;
  for (const f of manifest.files) {
    const backup = insideRoot(path.join(dir, 'files'), f.path);
    if (!fs.existsSync(backup)) throw new StickyError(`backup missing: ${backup}; nothing was changed`);
    if (sha256File(backup) !== f.sha256Before) {
      throw new StickyError(`backup ${backup} does not match the recorded bytes; nothing was changed`);
    }
    const abs = insideRoot(root, f.path);
    if (!fs.existsSync(abs)) {
      if (!force) throw new StickyError(`${f.path} no longer exists; refusing (pass --force)`);
      continue;
    }
    const current = sha256File(abs);
    if (current !== f.sha256After && !force) {
      throw new StickyError(
        `${f.path} changed since batch ${batchId} was applied (expected ${short(f.sha256After)}, found ${short(current)}). `
          + 'The package was probably updated or edited; refusing to overwrite newer bytes (pass --force). Nothing was changed.',
        { code: 'DRIFT' },
      );
    }
  }
  const restored = [];
  try {
    for (const f of manifest.files) {
      const abs = insideRoot(root, f.path);
      atomicWrite(abs, fs.readFileSync(insideRoot(path.join(dir, 'files'), f.path)));
      if (sha256File(abs) !== f.sha256Before) throw new StickyError(`rollback of ${f.path} did not reproduce the bytes`);
      restored.push(f.path);
    }
  } catch (error) {
    Object.assign(manifest, { status: 'rollback-failed', rollbackFailure: error.message, restored });
    writeJson(manifestPath, manifest);
    log(dir, `ROLLBACK FAILED after ${restored.length} file(s): ${error.message}`);
    throw new StickyError(`rollback failed after ${restored.length}/${manifest.files.length} file(s): ${error.message}`);
  }
  Object.assign(manifest, { status: 'rolled-back', rolledBackAt: isoNow() });
  writeJson(manifestPath, manifest);
  log(dir, `rolled back ${restored.length} file(s)`);
  return { status: 'rolled-back', batchId, files: restored };
}
