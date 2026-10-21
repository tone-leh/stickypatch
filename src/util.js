import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function short(hash) {
  return hash ? hash.slice(0, 12) : '-';
}

export function count(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Write a file via temp + rename so a crash never leaves a half-written target. */
export function atomicWrite(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o7777;
  } catch {
    /* new file */
  }
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.stickypatch-${process.pid}-${Date.now()}`,
  );
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function batchStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Line number (1-based) of a character offset. */
export function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export class StickyError extends Error {
  constructor(message, { code = 'ERROR', exitCode = 2 } = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Ensure a relative path stays inside root (no "..", no absolute escape). */
export function insideRoot(root, relative) {
  if (path.isAbsolute(relative)) {
    throw new StickyError(`patch file must be relative to the package root: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new StickyError(`patch file escapes the package root: ${relative}`);
  }
  return resolved;
}
