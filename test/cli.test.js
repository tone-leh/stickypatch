import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { SERVER_V1, basicConfig, sandbox } from './helpers.js';

test('status: missing -> apply -> applied, exit codes', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig());
  let r = s.json(['status']);
  assert.equal(r.code, 1);
  assert.equal(r.data.targets[0].patches[0].status, 'missing');
  r = s.json(['apply']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.data[0].status, 'applied');
  assert.match(s.read('pkg/src/server.js'), /MAX_ITEMS = 200000/);
  r = s.json(['status']);
  assert.equal(r.code, 0);
  assert.equal(r.data.targets[0].patches[0].status, 'applied');
  // second apply is a no-op and creates no batch
  r = s.json(['apply']);
  assert.equal(r.data[0].status, 'no-op');
  assert.equal(s.json(['batches']).data.length, 1);
});

test('untested version is refused until approved', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig());
  s.version('1.1.0');
  let r = s.run(['apply']);
  assert.equal(r.code, 2);
  assert.match(r.out, /has not been tested/);
  assert.match(s.read('pkg/src/server.js'), /4096/);
  r = s.run(['apply', '--approve']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(s.readConfig().testedVersions, ['1.0.0', '1.1.0']);
});

test('approve refuses while a patch is incompatible', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', 'nothing like the anchor');
  s.config(basicConfig());
  s.version('2.0.0');
  const r = s.run(['approve']);
  assert.equal(r.code, 2);
  assert.match(r.out, /incompatible/);
});

test('apply refuses a partial set unless --partial', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  const cfg = basicConfig();
  cfg.patches.push({ id: 'broken', edits: [{ file: 'src/server.js', find: 'not in the file', replace: 'BROKEN_PATCH' }] });
  s.config(cfg);
  let r = s.run(['apply']);
  assert.equal(r.code, 2);
  assert.match(r.out, /broken: incompatible/);
  assert.match(s.read('pkg/src/server.js'), /4096/);
  r = s.run(['apply', '--partial']);
  assert.equal(r.code, 0, r.out);
  assert.match(s.read('pkg/src/server.js'), /200000/);
});

test('rollback restores exact bytes; refuses after drift', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig());
  const batch = s.json(['apply']).data[0].batchId;
  let r = s.run(['rollback', batch]);
  assert.equal(r.code, 0, r.out);
  assert.equal(s.read('pkg/src/server.js'), SERVER_V1);
  r = s.run(['rollback', batch]);
  assert.match(r.out, /already rolled back/);

  const b2 = s.json(['apply']).data[0].batchId;
  s.write('pkg/src/server.js', `${SERVER_V1}// updated by npm\n`);
  r = s.run(['rollback', b2]);
  assert.equal(r.code, 2);
  assert.match(r.out, /changed since batch/);
  assert.match(s.read('pkg/src/server.js'), /updated by npm/);
});

test('rollback requires an explicit batch id', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig());
  s.run(['apply']);
  const r = s.run(['rollback']);
  assert.equal(r.code, 2);
  assert.match(r.out, /explicit batch id/);
});

test('read-only guard blocks writes but not inspection', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig({ guard: { denyEnv: ['AGENT_SESSION'] } }));
  let r = s.run(['apply'], { AGENT_SESSION: 'abc' });
  assert.equal(r.code, 3);
  assert.match(r.out, /read-only context/);
  r = s.run(['apply'], { STICKYPATCH_READONLY: '1' });
  assert.equal(r.code, 3);
  assert.match(s.read('pkg/src/server.js'), /4096/);
  r = s.run(['status'], { AGENT_SESSION: 'abc' });
  assert.equal(r.code, 1);
  r = s.run(['review'], { AGENT_SESSION: 'abc' });
  assert.equal(r.code, 0);
});

test('retire records the decision and stops checking the patch', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', 'export const MAX_ITEMS = Infinity;');
  s.config(basicConfig());
  s.run(['retire', 'bigger-budget', '--reason', 'upstream removed the cap']);
  const p = s.readConfig().patches[0];
  assert.equal(p.retired.reason, 'upstream removed the cap');
  assert.equal(p.retired.version, '1.0.0');
  const r = s.json(['status']);
  assert.equal(r.code, 0);
  assert.equal(r.data.targets[0].patches[0].status, 'retired');
});

test('review bundle shows nearest code for a moved anchor', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1.replace('const MAX_ITEMS = 4096;', 'const MAX_ITEMS = limits.items ?? 4096;'));
  s.config(basicConfig());
  const r = s.run(['review']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /RETIRE/);
  assert.match(r.stdout, /Closest code in the new version/);
  assert.match(r.stdout, /limits\.items/);
});

test('plan --diff writes nothing', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig());
  const r = s.run(['plan', '--diff']);
  assert.match(r.stdout, /-  const MAX_ITEMS = 4096;/);
  assert.match(r.stdout, /\+  const MAX_ITEMS = 200000;/);
  assert.equal(s.read('pkg/src/server.js'), SERVER_V1);
});

test('capture turns hand edits into a patch that re-applies after an update', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.write('pristine/package.json', JSON.stringify({ name: 'demo-cli', version: '1.0.0' }));
  s.write('pristine/src/server.js', SERVER_V1);
  s.config({ path: './pkg', testedVersions: ['1.0.0'], patches: [] });
  s.write('pkg/src/server.js', SERVER_V1.replace('return 30000;', 'return 120000;'));
  let r = s.run(['capture', 'pkg/src/server.js', '--id', 'longer-timeout', '--pristine', 'pristine']);
  assert.equal(r.code, 0, r.out);
  assert.equal(s.json(['status']).data.targets[0].patches[0].status, 'applied');
  // simulate `npm update -g` wiping it
  s.write('pkg/src/server.js', SERVER_V1);
  assert.equal(s.json(['status']).data.targets[0].patches[0].status, 'missing');
  r = s.run(['apply']);
  assert.equal(r.code, 0, r.out);
  assert.match(s.read('pkg/src/server.js'), /return 120000;/);
});

test('capture excludes changes already owned by other patches', () => {
  const s = sandbox();
  s.write('pristine/package.json', JSON.stringify({ name: 'demo-cli', version: '1.0.0' }));
  s.write('pristine/src/server.js', SERVER_V1);
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig());
  s.run(['apply']);
  s.write('pkg/src/server.js', s.read('pkg/src/server.js').replace('return 30000;', 'return 1;'));
  const r = s.run(['capture', 'pkg/src/server.js', '--id', 'second', '--pristine', 'pristine']);
  assert.equal(r.code, 0, r.out);
  const second = s.readConfig().patches.find((p) => p.id === 'second');
  assert.equal(second.edits.length, 1);
  assert.doesNotMatch(second.edits[0].find, /MAX_ITEMS/);
});

test('multi-target config and --target', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.write('other/package.json', JSON.stringify({ name: 'other-cli', version: '3.0.0' }));
  s.write('other/index.js', 'debug = false;');
  s.config({
    targets: [
      basicConfig(),
      { path: './other', testedVersions: ['3.0.0'], patches: [{ id: 'debug', edits: [{ file: 'index.js', find: 'debug = false', replace: 'debug = true' }] }] },
    ],
  });
  const r = s.json(['status']);
  assert.equal(r.data.targets.length, 2);
  assert.equal(s.run(['batches']).code, 2);
  assert.equal(s.run(['apply', '-t', 'other-cli']).code, 0);
  assert.equal(s.read('other/index.js'), 'debug = true;');
  assert.match(s.read('pkg/src/server.js'), /4096/);
});

test('init creates a config and a second init adds a target', () => {
  const s = sandbox();
  s.write('other/package.json', JSON.stringify({ name: 'other-cli', version: '3.0.0' }));
  let r = s.run(['init', 'demo-cli', '--dir', 'pkg']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(s.readConfig().testedVersions, ['1.0.0']);
  r = s.run(['init', 'other-cli', '--dir', 'other']);
  assert.equal(r.code, 0, r.out);
  assert.equal(s.readConfig().targets.length, 2);
  r = s.run(['init', 'other-cli', '--dir', 'other']);
  assert.equal(r.code, 2);
});

test('refuses to patch a directory holding a different package', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config({ ...basicConfig(), package: 'something-else' });
  const r = s.run(['status']);
  assert.equal(r.code, 1);
  assert.match(r.out, /refusing to patch the wrong package/);
});

test('patch paths cannot escape the package root', () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config({ path: './pkg', testedVersions: ['1.0.0'], patches: [{ id: 'evil', edits: [{ file: '../stickypatch.json', find: 'a', replace: 'b' }] }] });
  const r = s.run(['status']);
  assert.equal(r.code, 2);
  assert.match(r.out, /escapes the package root/);
});

function server(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('apply --restart: healthy service keeps the batch', async () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  const srv = await server((req, res) => res.end('ok'));
  const url = `http://127.0.0.1:${srv.address().port}/healthz`;
  s.config(basicConfig({ restart: `node -e "require('fs').appendFileSync('restarts.log','x')"`, health: { url, timeout: 5, delay: 0 } }));
  const r = await runAsync(s, ['apply', '--restart', '--yes']);
  srv.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /healthy/);
  assert.equal(s.read('restarts.log'), 'x');
  assert.match(s.read('pkg/src/server.js'), /200000/);
});

test('apply --restart: failed health check rolls the batch back', async () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig({ restart: 'true', health: { command: 'exit 1', timeout: 1, delay: 0 } }));
  const r = await runAsync(s, ['apply', '--restart', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.out, /rolling back/);
  assert.equal(s.read('pkg/src/server.js'), SERVER_V1);
  const [batch] = s.json(['batches']).data;
  assert.equal(batch.status, 'rolled-back');
});

test('apply --restart refuses while busy', async () => {
  const s = sandbox();
  s.write('pkg/src/server.js', SERVER_V1);
  s.config(basicConfig({ restart: 'true', busy: 'echo "2 active tasks"; exit 1' }));
  const r = await runAsync(s, ['apply', '--restart', '--yes']);
  assert.equal(r.code, 3);
  assert.match(r.out, /2 active tasks/);
  assert.equal(s.read('pkg/src/server.js'), SERVER_V1);
});

test('a failure mid-batch restores every file already written', () => {
  const s = sandbox();
  s.write('pkg/src/a.js', 'A = 1');
  s.write('pkg/src/b.js', 'B = 1');
  s.config({
    path: './pkg',
    testedVersions: ['1.0.0'],
    patches: [
      { id: 'a', edits: [{ file: 'src/a.js', find: 'A = 1', replace: 'A = 2' }] },
      { id: 'b', edits: [{ file: 'src/b.js', find: 'B = 1', replace: 'B = 2' }] },
    ],
  });
  return import('../src/engine.js').then(async (E) => {
    const { loadConfig } = await import('../src/config.js');
    const { resolveTarget } = await import('../src/resolve.js');
    const config = await loadConfig(path.join(s.dir, 'stickypatch.json'));
    const target = config.targets[0];
    const tree = E.loadTree(target, resolveTarget(target));
    const prepared = E.prepare(tree);
    // another process edits b.js after a.js was already written:
    const onBeforeWrite = (rel, abs) => {
      if (rel === 'src/b.js') fs.writeFileSync(abs, 'B = 1 // edited by someone else');
    };
    assert.throws(() => E.apply(tree, prepared, path.join(s.dir, 'home'), { onBeforeWrite }), /changed on disk after the check[\s\S]*restored/);
    assert.equal(s.read('pkg/src/a.js'), 'A = 1');
    assert.equal(s.read('pkg/src/b.js'), 'B = 1 // edited by someone else');
  });
});

function runAsync(s, args, env = {}) {
  // spawnSync would block the in-process health server; use async spawn.
  return import('node:child_process').then(({ spawn }) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve('bin/stickypatch.js'), ...args], {
      cwd: s.dir,
      env: { ...process.env, NO_COLOR: '1', STICKYPATCH_HOME: s.home, ...env },
    });
    let outText = '';
    child.stdout.on('data', (d) => { outText += d; });
    child.stderr.on('data', (d) => { outText += d; });
    child.on('close', (code) => resolve({ code, out: outText }));
  }));
}
