// Find the installed copy of a package — the one that actually runs.
//
// Global installs move around: fnm / nvm / volta / Homebrew / bun / pnpm all keep
// their own trees, and a Node upgrade can leave an old copy behind. Patching the
// wrong copy is worse than failing, so every candidate is validated by reading its
// package.json, and the copy reached through the command on PATH wins.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StickyError, readJson } from './util.js';

function manifestName(dir) {
  try {
    const data = readJson(path.join(dir, 'package.json'));
    return { name: data.name, version: String(data.version ?? '0.0.0'), bin: data.bin };
  } catch {
    return null;
  }
}

function packageRootFrom(start, packageName) {
  let dir = start;
  try {
    dir = fs.statSync(start).isDirectory() ? start : path.dirname(start);
  } catch {
    return null;
  }
  for (;;) {
    const info = manifestName(dir);
    if (info && (!packageName || info.name === packageName)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function which(command) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, command);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function globDirs(pattern) {
  // Tiny glob: only supports "*" as a whole path segment.
  const parts = pattern.split('/');
  let current = [parts[0] === '' ? '/' : parts[0]];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const next = [];
    for (const base of current) {
      if (part === '*') {
        let entries = [];
        try {
          entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) if (entry.isDirectory()) next.push(path.join(base, entry.name));
      } else {
        const candidate = path.join(base, part);
        if (fs.existsSync(candidate)) next.push(candidate);
      }
    }
    current = next;
  }
  return current;
}

export function globalRoots() {
  const home = os.homedir();
  const patterns = [
    `${home}/.local/share/fnm/node-versions/*/installation/lib/node_modules`,
    `${home}/Library/Application Support/fnm/node-versions/*/installation/lib/node_modules`,
    `${home}/.fnm/node-versions/*/installation/lib/node_modules`,
    `${home}/.nvm/versions/node/*/lib/node_modules`,
    `${home}/.volta/tools/image/node/*/lib/node_modules`,
    `${home}/.bun/install/global/node_modules`,
    `${home}/Library/pnpm/global/*/node_modules`,
    `${home}/.local/share/pnpm/global/*/node_modules`,
    `${home}/.npm-global/lib/node_modules`,
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
  const roots = [];
  for (const pattern of patterns) roots.push(...globDirs(pattern));
  return roots;
}

function npmRootGlobal() {
  try {
    return execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve a target to { root, name, version, via }.
 * opts.dir overrides everything (CLI --dir).
 */
export function resolveTarget(target, opts = {}) {
  const want = target.package;
  const describe = (root, via) => {
    const info = manifestName(root);
    if (!info) throw new StickyError(`${root} has no readable package.json`);
    if (want && info.name !== want) {
      throw new StickyError(`${root} is ${info.name}, not ${want}; refusing to patch the wrong package`);
    }
    return { root: fs.realpathSync(root), name: info.name, version: info.version, via };
  };

  if (opts.dir) return describe(path.resolve(opts.dir), '--dir');
  if (target.path) return describe(target.path, 'config path');
  if (!want) throw new StickyError(`target "${target.name}" has neither package nor path`);

  // 1. The command people actually run.
  const bins = new Set();
  if (target.bin) bins.add(target.bin);
  const unscoped = want.replace(/^@[^/]+\//, '');
  bins.add(unscoped);
  for (const bin of bins) {
    const file = which(bin);
    if (!file) continue;
    let real;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    const root = packageRootFrom(real, want);
    if (root) return describe(root, `\`${bin}\` on PATH`);
  }

  // 2. npm's own idea of the global root.
  const npmRoot = npmRootGlobal();
  if (npmRoot && manifestName(path.join(npmRoot, want))) {
    return describe(path.join(npmRoot, want), 'npm root -g');
  }

  // 3. Known node-manager layouts.
  const found = globalRoots()
    .map((r) => path.join(r, want))
    .filter((dir) => manifestName(dir)?.name === want);
  if (found.length === 1) return describe(found[0], 'global install scan');
  if (found.length > 1) {
    const list = found.map((d) => `  ${d} (${manifestName(d).version})`).join('\n');
    throw new StickyError(
      `found ${found.length} installed copies of ${want}:\n${list}\n`
        + 'Set "path" in the config (or pass --dir) to the copy your service really runs.',
      { code: 'AMBIGUOUS' },
    );
  }
  throw new StickyError(
    `cannot find an installed copy of ${want}. Install it, or set "path" in the config / pass --dir.`,
    { code: 'NOT_FOUND' },
  );
}
