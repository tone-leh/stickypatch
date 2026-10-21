// Pure inspection and rendering of one patch against in-memory file texts.
// Nothing here touches the disk, which is what makes every command testable and
// what lets `plan` show exactly what `apply` would write.

import { StickyError, count } from './util.js';

// Distinct on purpose: collapsing these into one "ok" is how a stale or
// unverifiable patch ends up reported as healthy.
export const APPLIED = 'applied'; //           present and complete
export const MISSING = 'missing'; //           absent, anchors intact -> apply can add it
export const OUTDATED = 'outdated'; //         an older form is present -> apply migrates it
export const UPSTREAM = 'upstream'; //         upstream now ships the fix -> retire it
export const INCOMPATIBLE = 'incompatible'; // anchors moved or became ambiguous -> needs a human/LLM
export const UNVERIFIABLE = 'unverifiable'; // a target file is missing -> cannot judge
export const RETIRED = 'retired'; //           you retired it; no longer checked or applied

export const STATUSES = [APPLIED, MISSING, OUTDATED, UPSTREAM, INCOMPATIBLE, UNVERIFIABLE, RETIRED];
export const ACTIONABLE = new Set([MISSING, OUTDATED]);
export const NEEDS_ATTENTION = new Set([MISSING, OUTDATED, UPSTREAM, INCOMPATIBLE, UNVERIFIABLE]);

export class PatchError extends StickyError {}

function editState(text, edit) {
  const marker = edit.marker ?? (edit.replace === '' ? null : edit.replace);
  if (marker && text.includes(marker)) {
    // The patched text is present. If the original anchor is *also* still there
    // (and is not simply part of the patched text) the marker is too generic to
    // trust — report it instead of claiming "applied".
    if (marker.includes(edit.find) || count(text, edit.find) === 0) return { state: 'applied' };
    return { state: 'conflict' };
  }
  for (let i = 0; i < edit.previous.length; i += 1) {
    if (edit.previous[i] && count(text, edit.previous[i]) === 1) return { state: 'outdated', previous: i };
  }
  const n = count(text, edit.find);
  if (n === 1) return { state: 'missing' };
  if (n > 1) return { state: 'ambiguous', occurrences: n };
  if (!marker) return { state: 'applied', note: 'deletion: anchor already absent' };
  return { state: 'gone' };
}

function upstreamSatisfied(files, patch) {
  if (!patch.upstream.length) return false;
  return patch.upstream.every((u) => {
    const text = files[u.file];
    if (text === undefined) return false;
    if (u.contains && !text.includes(u.contains)) return false;
    if (u.absent && text.includes(u.absent)) return false;
    return true;
  });
}

function normalizeCustom(result, patchId) {
  if (Array.isArray(result)) return { status: result[0], detail: result[1] || '' };
  if (result && typeof result === 'object') return { status: result.status, detail: result.detail || '' };
  throw new PatchError(`patch "${patchId}": detect() must return { status, detail }`);
}

/** Inspect a patch. `files` maps relative path -> text (missing files are absent keys). */
export function detect(files, patch) {
  const missingFiles = patch.files.filter((f) => files[f] === undefined);
  const base = { id: patch.id, title: patch.title, files: patch.files, edits: [] };

  if (patch.retired) {
    const since = patch.retired.version ? ` since ${patch.retired.version}` : '';
    return { ...base, status: RETIRED, detail: `retired${since}${patch.retired.reason ? `: ${patch.retired.reason}` : ''}` };
  }
  if (missingFiles.length) {
    return { ...base, status: UNVERIFIABLE, detail: `target file missing: ${missingFiles.join(', ')}` };
  }
  if (patch.custom) {
    const r = normalizeCustom(patch.detect(files), patch.id);
    if (!r.status || ![APPLIED, MISSING, OUTDATED, UPSTREAM, INCOMPATIBLE, UNVERIFIABLE].includes(r.status)) {
      throw new PatchError(`patch "${patch.id}": detect() returned unknown status ${JSON.stringify(r.status)}`);
    }
    return { ...base, ...r };
  }

  const edits = patch.edits.map((edit) => ({ file: edit.file, ...editState(files[edit.file], edit) }));
  const upstream = upstreamSatisfied(files, patch);
  const states = edits.map((e) => e.state);
  const total = edits.length;
  const applied = states.filter((s) => s === 'applied').length;
  const result = (status, detail) => ({ ...base, status, detail, edits, upstreamHit: upstream });

  if (applied === total) {
    return result(APPLIED, upstream
      ? 'applied — but upstream markers are present too; consider retiring'
      : `applied (${total}/${total} edit${total > 1 ? 's' : ''})`);
  }
  const conflict = edits.find((e) => e.state === 'conflict');
  if (conflict) {
    return result(INCOMPATIBLE, `${conflict.file}: both the anchor and the patched text are present — make "replace" (or "marker") more specific`);
  }
  const ambiguous = edits.find((e) => e.state === 'ambiguous');
  if (ambiguous) {
    return result(INCOMPATIBLE, `${ambiguous.file}: anchor matches ${ambiguous.occurrences} places; it must be unique`);
  }
  const gone = edits.find((e) => e.state === 'gone');
  if (gone) {
    if (upstream) return result(UPSTREAM, 'upstream markers found — the fix appears to be built in');
    return result(INCOMPATIBLE, `${gone.file}: anchor not found — upstream changed this code`);
  }
  if (upstream) return result(UPSTREAM, 'upstream markers found — the fix appears to be built in');
  if (states.includes('outdated')) {
    return result(OUTDATED, `older form present; apply will migrate it (${applied}/${total} current)`);
  }
  return result(MISSING, applied
    ? `partially applied (${applied}/${total}); apply will finish it`
    : `not applied; anchor${total > 1 ? 's' : ''} intact`);
}

/** Render a patch into new file texts. Only call for MISSING / OUTDATED findings. */
export function render(files, patch) {
  if (patch.custom) {
    if (typeof patch.render !== 'function') throw new PatchError(`patch "${patch.id}" has no render()`);
    const out = patch.render(files);
    if (!out || typeof out !== 'object') throw new PatchError(`patch "${patch.id}": render() must return { file: text }`);
    for (const file of Object.keys(out)) {
      if (!patch.files.includes(file)) {
        throw new PatchError(`patch "${patch.id}": render() wrote ${file}, which is not in files[]`);
      }
    }
    return out;
  }
  const working = {};
  const textOf = (f) => (working[f] !== undefined ? working[f] : files[f]);
  for (const edit of patch.edits) {
    const text = textOf(edit.file);
    const st = editState(text, edit);
    if (st.state === 'applied') continue;
    if (st.state === 'outdated') {
      working[edit.file] = text.replace(edit.previous[st.previous], () => edit.replace);
    } else if (st.state === 'missing') {
      working[edit.file] = text.replace(edit.find, () => edit.replace);
    } else {
      throw new PatchError(`patch "${patch.id}": ${edit.file} cannot be edited (${st.state}). Nothing was written.`);
    }
    const after = editState(working[edit.file], edit);
    if (after.state !== 'applied') {
      throw new PatchError(`patch "${patch.id}": ${edit.file} did not verify after rendering. Nothing was written.`);
    }
  }
  return working;
}
