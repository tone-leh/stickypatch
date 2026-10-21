import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/stickypatch.js');

export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stickypatch-test-'));
  const pkg = path.join(dir, 'pkg');
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  const api = {
    dir,
    pkg,
    home: path.join(dir, 'home'),
    write(rel, body) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return file;
    },
    read(rel) {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    },
    version(v, name = 'demo-cli') {
      api.write('pkg/package.json', JSON.stringify({ name, version: v }));
    },
    config(obj) {
      api.write('stickypatch.json', JSON.stringify(obj, null, 2));
    },
    readConfig() {
      return JSON.parse(api.read('stickypatch.json'));
    },
    run(args, env = {}) {
      const r = spawnSync(process.execPath, [BIN, ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', STICKYPATCH_HOME: path.join(dir, 'home'), STICKYPATCH_READONLY: '', ...env },
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
    },
    json(args, env) {
      const r = api.run([...args, '--json'], env);
      try {
        return { ...r, data: JSON.parse(r.stdout) };
      } catch {
        throw new Error(`not JSON (exit ${r.code}):\n${r.out}`);
      }
    },
  };
  api.version('1.0.0');
  return api;
}

export const SERVER_V1 = `export function retryBudget(items) {
  const MAX_ITEMS = 4096;
  if (items.length > MAX_ITEMS) return false;
  return true;
}

export function timeoutMs() {
  return 30000;
}
`;

export function basicConfig(extra = {}) {
  return {
    path: './pkg',
    testedVersions: ['1.0.0'],
    patches: [
      {
        id: 'bigger-budget',
        why: 'long histories should be replayable',
        edits: [{ file: 'src/server.js', find: 'const MAX_ITEMS = 4096;', replace: 'const MAX_ITEMS = 200000;' }],
      },
    ],
    ...extra,
  };
}
