import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StickyError, readJson, writeJson } from './util.js';

const CANDIDATES = ['stickypatch.json', 'stickypatch.config.mjs', 'stickypatch.config.js'];

export function userConfigDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'stickypatch');
}

export function findConfig(explicit, cwd = process.cwd()) {
  if (explicit) {
    const file = path.resolve(cwd, explicit);
    if (!fs.existsSync(file)) throw new StickyError(`config not found: ${file}`);
    return file;
  }
  if (process.env.STICKYPATCH_CONFIG) return findConfig(process.env.STICKYPATCH_CONFIG, cwd);
  for (const dir of [cwd, userConfigDir()]) {
    for (const name of CANDIDATES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

function textField(value, configDir, where) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.file === 'string') {
    const file = path.resolve(configDir, value.file);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      throw new StickyError(`${where}: cannot read ${value.file}`);
    }
  }
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) {
    // Array-of-lines form keeps multi-line anchors readable inside JSON.
    return value.join('\n');
  }
  throw new StickyError(`${where}: expected a string, an array of lines, or { "file": "..." }`);
}

function checkRelative(file, where) {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new StickyError(`${where}: "${file}" escapes the package root; use a path relative to it`);
  }
}

function normalizeEdit(raw, patchId, index, configDir) {
  const where = `patch "${patchId}" edit #${index + 1}`;
  if (!raw || typeof raw !== 'object') throw new StickyError(`${where}: must be an object`);
  if (typeof raw.file !== 'string' || !raw.file) throw new StickyError(`${where}: "file" is required`);
  checkRelative(raw.file, where);
  const find = textField(raw.find, configDir, `${where} find`);
  const replace = textField(raw.replace, configDir, `${where} replace`);
  if (!find) throw new StickyError(`${where}: "find" is required and must not be empty`);
  if (replace === undefined) throw new StickyError(`${where}: "replace" is required`);
  if (find === replace) throw new StickyError(`${where}: "find" and "replace" are identical`);
  const marker = textField(raw.marker, configDir, `${where} marker`);
  const previous = (raw.previous || []).map((p, i) => textField(p, configDir, `${where} previous #${i + 1}`));
  return { file: raw.file, find, replace, marker, previous };
}

function normalizeUpstream(raw, patchId, configDir) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item, i) => {
    const where = `patch "${patchId}" upstream #${i + 1}`;
    if (!item || typeof item !== 'object' || typeof item.file !== 'string') {
      throw new StickyError(`${where}: expected { "file": "...", "contains": "..." }`);
    }
    const contains = textField(item.contains, configDir, `${where} contains`);
    const absent = textField(item.absent, configDir, `${where} absent`);
    if (!contains && !absent) throw new StickyError(`${where}: needs "contains" and/or "absent"`);
    checkRelative(item.file, where);
    return { file: item.file, contains, absent };
  });
}

export function normalizePatch(raw, configDir) {
  if (!raw || typeof raw !== 'object') throw new StickyError('each patch must be an object');
  const id = raw.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new StickyError(`invalid patch id: ${JSON.stringify(id)} (use letters, digits, . _ -)`);
  }
  const custom = typeof raw.detect === 'function' || typeof raw.render === 'function';
  if (custom && (typeof raw.detect !== 'function' || !Array.isArray(raw.files))) {
    throw new StickyError(`patch "${id}": custom patches need detect(), render() and files[]`);
  }
  const edits = custom ? [] : (raw.edits || []).map((e, i) => normalizeEdit(e, id, i, configDir));
  if (!custom && !edits.length) throw new StickyError(`patch "${id}": needs at least one edit`);
  const upstream = normalizeUpstream(raw.upstream, id, configDir);
  const files = custom
    ? [...raw.files]
    : [...new Set([...edits.map((e) => e.file)])];
  const upstreamFiles = upstream.map((u) => u.file).filter((f) => !files.includes(f));
  let retired = null;
  if (raw.retired) {
    retired = typeof raw.retired === 'object' ? raw.retired : { reason: String(raw.retired) };
  }
  return {
    id,
    title: raw.title || id,
    why: raw.why || '',
    files,
    readFiles: [...files, ...new Set(upstreamFiles)],
    edits,
    upstream,
    retired,
    custom,
    detect: custom ? raw.detect : null,
    render: custom ? raw.render : null,
  };
}

function normalizeTarget(raw, index, configDir) {
  if (!raw || typeof raw !== 'object') throw new StickyError(`target #${index + 1} must be an object`);
  if (!raw.package && !raw.path) {
    throw new StickyError(`target #${index + 1}: set "package" (npm name) or "path" (directory)`);
  }
  let name = raw.name || raw.package;
  if (!name) {
    const dir = path.resolve(configDir, raw.path.replace(/^~(?=\/|$)/, os.homedir()));
    try {
      name = readJson(path.join(dir, 'package.json')).name;
    } catch {
      /* fall back to the folder name */
    }
    name ||= path.basename(dir);
  }
  const patches = (raw.patches || []).map((p) => normalizePatch(p, configDir));
  const ids = new Set();
  for (const p of patches) {
    if (ids.has(p.id)) throw new StickyError(`target "${name}": duplicate patch id "${p.id}"`);
    ids.add(p.id);
  }
  let health = raw.health || null;
  if (typeof health === 'string') health = health.startsWith('http') ? { url: health } : { command: health };
  return {
    index,
    name,
    package: raw.package || null,
    path: raw.path ? path.resolve(configDir, raw.path.replace(/^~(?=\/|$)/, os.homedir())) : null,
    bin: raw.bin || null,
    testedVersions: [...(raw.testedVersions || [])].map(String),
    patches,
    restart: raw.restart || null,
    health,
    busy: raw.busy || null,
    guard: { denyEnv: [...((raw.guard && raw.guard.denyEnv) || [])] },
  };
}

export async function loadConfig(explicit, cwd = process.cwd()) {
  const file = findConfig(explicit, cwd);
  if (!file) {
    throw new StickyError(
      'no stickypatch config found. Run "stickypatch init <npm-package>" to create stickypatch.json, '
        + 'or pass --config <file>.',
      { code: 'NO_CONFIG' },
    );
  }
  const configDir = path.dirname(file);
  let raw;
  if (/\.(mjs|js)$/.test(file)) {
    const mod = await import(pathToFileURL(file).href);
    raw = mod.default ?? mod;
    if (typeof raw === 'function') raw = await raw();
  } else {
    try {
      raw = readJson(file);
    } catch (error) {
      throw new StickyError(`cannot parse ${file}: ${error.message}`);
    }
  }
  const list = Array.isArray(raw.targets) ? raw.targets : [raw];
  const targets = list.map((t, i) => normalizeTarget(t, i, configDir));
  const batchDir = raw.batchDir
    ? path.resolve(configDir, raw.batchDir)
    : process.env.STICKYPATCH_HOME
      ? path.join(process.env.STICKYPATCH_HOME, 'batches')
      : path.join(os.homedir(), '.stickypatch', 'batches');
  return { file, configDir, editable: file.endsWith('.json'), multi: Array.isArray(raw.targets), targets, batchDir };
}

/** Apply a mutation to the raw JSON config of one target. Only JSON configs are editable. */
export function editTargetJson(config, targetIndex, mutate) {
  if (!config.editable) {
    throw new StickyError(`${path.basename(config.file)} is a JS config; edit it by hand`);
  }
  const raw = readJson(config.file);
  const target = config.multi ? raw.targets[targetIndex] : raw;
  mutate(target);
  writeJson(config.file, raw);
}
