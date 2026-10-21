import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { baselineFor, editsFromDiff, fetchPristine } from './capture.js';
import { editTargetJson, findConfig, loadConfig, normalizePatch, userConfigDir } from './config.js';
import { unifiedDiff } from './diff.js';
import * as E from './engine.js';
import { assertWritable, checkIdle, restart, waitHealthy } from './hooks.js';
import { c, colorDiff, err, out, statusLabel } from './output.js';
import * as P from './patch.js';
import { resolveTarget } from './resolve.js';
import { buildReview } from './review.js';
import { StickyError, insideRoot, readJson, short, writeJson } from './util.js';

export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const HELP = `${c.bold('stickypatch')} — local patches that survive \`npm update -g\`, and tell you when upstream fixed them.

${c.bold('Usage')}
  stickypatch <command> [options]

${c.bold('Everyday')}
  status                 Check every patch against the installed version (exit 1 if anything needs attention)
  apply                  Apply missing / outdated patches as one atomic, recoverable batch
  review                 Write a Markdown report an AI agent (or you) can use to retire / keep / adapt patches
  plan                   Show what apply would write, without writing (add --diff for a unified diff)

${c.bold('Setup')}
  init <package>         Create a config for an installed npm package (--global for ~/.config/stickypatch)
  capture <file...>      Turn your hand edits in the installed package into a patch (--id <id>)
  approve                Record the installed version as tested with your patches
  retire <id>            Stop maintaining a patch because upstream now ships the fix

${c.bold('Safety')}
  batches                List applied batches
  rollback <batch-id>    Restore the exact bytes a batch replaced

${c.bold('Options')}
  -c, --config <file>    Config file (default: ./stickypatch.json, then ~/.config/stickypatch/)
  -t, --target <name>    Only this target (when a config lists several packages)
      --dir <path>       Use this package directory instead of auto-detecting it
      --only <id,...>    Only these patches
      --json             Machine-readable output
      --restart          After apply/rollback: run "restart", wait for "health", auto-rollback on failure
      --allow-untested   Apply to a version not in testedVersions
      --approve          Same as running \`approve\` first (apply only)
      --partial          Apply what can be applied even if other patches need attention
      --ignore-busy      Skip the "busy" check before --restart
  -y, --yes              Don't ask for confirmation
  -h, --help / -v, --version

Docs: https://github.com/tone-leh/stickypatch`;

const FLAGS = new Set(['json', 'diff', 'restart', 'allow-untested', 'approve', 'partial', 'ignore-busy', 'yes', 'help', 'version', 'all', 'force', 'global', 'no-color']);
const ALIASES = { c: 'config', t: 'target', y: 'yes', h: 'help', v: 'version', o: 'out' };

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    if (token === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--') || (token.startsWith('-') && token.length === 2)) {
      let value;
      if (token.includes('=')) [token, value] = token.split(/=(.*)/s);
      let name = token.replace(/^--?/, '');
      name = ALIASES[name] || name;
      if (FLAGS.has(name)) {
        args[name] = true;
        continue;
      }
      if (value === undefined) {
        value = argv[i + 1];
        i += 1;
        if (value === undefined) throw new StickyError(`--${name} needs a value`);
      }
      args[name] = value;
    } else {
      args._.push(token);
    }
  }
  if (args['no-color']) process.env.NO_COLOR = '1';
  if (args.only) args.only = args.only.split(',').map((s) => s.trim()).filter(Boolean);
  return args;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function pickTargets(config, args) {
  if (!args.target) return config.targets;
  const hit = config.targets.filter((t) => t.name === args.target || t.package === args.target);
  if (!hit.length) {
    throw new StickyError(`no target named "${args.target}" (have: ${config.targets.map((t) => t.name).join(', ')})`);
  }
  return hit;
}

function oneTarget(config, args) {
  const list = pickTargets(config, args);
  if (list.length > 1) {
    throw new StickyError(`this config has ${list.length} targets; pick one with --target (${list.map((t) => t.name).join(', ')})`);
  }
  return list[0];
}

function versionNote(tree) {
  const v = E.versionState(tree);
  if (!v.tested.length) return c.dim('(no tested versions recorded)');
  return v.ok ? c.dim('(tested)') : c.yellow(`(new — tested: ${v.tested.join(', ')})`);
}

function header(tree) {
  out(`${c.bold(tree.name)} ${c.bold(tree.version)} ${versionNote(tree)}`);
  out(c.dim(`  ${tree.root}  ·  via ${tree.via}`));
}

function printFindings(findings) {
  const width = Math.max(8, ...findings.map((f) => f.id.length));
  for (const f of findings) out(`  ${statusLabel(f.status)} ${f.id.padEnd(width)}  ${c.dim(f.detail)}`);
  if (!findings.length) out(c.dim('  (no patches yet — edit the installed files, then `stickypatch capture <file> --id <name>`)'));
}

function nextSteps(tree, findings, cmdSuffix) {
  const has = (s) => findings.some((f) => f.status === s);
  const steps = [];
  const untested = !E.versionState(tree).ok;
  if (has(P.INCOMPATIBLE) || has(P.UNVERIFIABLE) || has(P.UPSTREAM)) {
    steps.push([`stickypatch review${cmdSuffix} > review.md`, 'hand this to your AI agent / read it']);
  }
  for (const f of findings.filter((x) => x.status === P.UPSTREAM)) {
    steps.push([`stickypatch retire ${f.id}${cmdSuffix}`, 'upstream ships it now']);
  }
  if (has(P.MISSING) || has(P.OUTDATED)) {
    const partial = has(P.INCOMPATIBLE) || has(P.UNVERIFIABLE) ? ' --partial' : '';
    if (untested) steps.push([`stickypatch apply --approve${partial}${cmdSuffix}`, 'after checking the anchors still mean the same thing']);
    else steps.push([`stickypatch apply${partial}${cmdSuffix}`, partial ? 'the rest can wait for review' : '']);
  } else if (untested && findings.length && findings.every((f) => [P.APPLIED, P.RETIRED].includes(f.status))) {
    steps.push([`stickypatch approve${cmdSuffix}`, 'record this version as tested']);
  }
  if (!steps.length) return;
  out(c.dim('\n  next:'));
  const w = Math.max(...steps.map((s) => s[0].length));
  for (const [cmd, why] of steps) out(`    ${c.cyan(cmd.padEnd(w))}  ${why ? c.dim(`# ${why}`) : ''}`);
}

function openTree(target, args) {
  const resolved = resolveTarget(target, { dir: args.dir });
  return E.loadTree(target, resolved);
}

// ---------------------------------------------------------------- commands

async function cmdStatus(config, args) {
  const results = [];
  let attention = false;
  const targets = pickTargets(config, args);
  for (const [i, target] of targets.entries()) {
    let tree;
    try {
      tree = openTree(target, args);
    } catch (error) {
      attention = true;
      results.push({ target: target.name, error: error.message });
      if (!args.json) {
        out(`${c.bold(target.name)} ${c.red('✖ not found')}`);
        out(c.dim(`  ${error.message.split('\n').join('\n  ')}`));
      }
      continue;
    }
    const findings = E.inspect(tree);
    const v = E.versionState(tree);
    if (findings.some((f) => P.NEEDS_ATTENTION.has(f.status)) || !v.ok) attention = true;
    results.push({ target: tree.name, version: tree.version, tested: v.ok, testedVersions: v.tested, root: tree.root, via: tree.via, patches: findings.map(({ id, status, detail }) => ({ id, status, detail })) });
    if (!args.json) {
      if (i) out('');
      header(tree);
      out('');
      printFindings(findings);
      nextSteps(tree, findings, targets.length > 1 || config.targets.length > 1 ? ` -t ${tree.name}` : '');
    }
  }
  if (args.json) out(JSON.stringify({ attention, targets: results }, null, 2));
  return attention ? 1 : 0;
}

async function cmdPlan(config, args) {
  const reports = [];
  for (const target of pickTargets(config, args)) {
    const tree = openTree(target, args);
    const prepared = E.prepare(tree, { only: args.only, allowUntested: true, partial: true });
    reports.push({ tree, prepared });
    if (args.json) continue;
    header(tree);
    out('');
    printFindings(prepared.findings);
    out('');
    if (!prepared.writes.length) {
      out(c.dim('  apply would write nothing.'));
    } else {
      out(`  apply would write ${prepared.writes.length} file(s):`);
      for (const w of prepared.writes) {
        out(`    ${w.path}  ${c.dim(`${short(w.sha256Before)} → ${short(w.sha256After)}  [${w.patches.join(', ')}]`)}`);
      }
      if (args.diff) {
        for (const w of prepared.writes) {
          out('');
          out(colorDiff(unifiedDiff(w.before, w.after, { fromFile: `a/${w.path}`, toFile: `b/${w.path}` })));
        }
      }
    }
    if (!prepared.version.ok) out(c.yellow(`\n  note: ${tree.version} is not in testedVersions; apply needs --approve or --allow-untested.`));
  }
  if (args.json) {
    out(JSON.stringify(reports.map(({ tree, prepared }) => ({
      target: tree.name,
      version: tree.version,
      tested: prepared.version.ok,
      patches: prepared.findings.map(({ id, status, detail }) => ({ id, status, detail })),
      writes: prepared.writes.map(({ path: p, patches, sha256Before, sha256After, before, after }) => ({
        path: p, patches, sha256Before, sha256After, diff: args.diff ? unifiedDiff(before, after, { fromFile: `a/${p}`, toFile: `b/${p}` }) : undefined,
      })),
    })), null, 2));
  }
  return 0;
}

async function restartAndVerify(target, onFailure) {
  out(c.dim(`  restarting: ${target.restart}`));
  const r = restart(target);
  let health = { checked: false, ok: true };
  if (r.ok) {
    if (target.health) out(c.dim(`  waiting for health: ${target.health.url || target.health.command}`));
    health = await waitHealthy(target.health);
  }
  if (r.ok && health.ok) {
    out(`  ${c.green('✔')} restarted${health.checked ? ` and healthy (${health.detail})` : ''}`);
    return true;
  }
  const why = !r.ok ? `restart command failed (exit ${r.code}): ${r.output.slice(0, 500)}` : `health check failed: ${health.detail}`;
  err(c.red(`  ✖ ${why}`));
  if (onFailure) await onFailure();
  return false;
}

async function cmdApply(config, args) {
  let code = 0;
  const summary = [];
  for (const target of pickTargets(config, args)) {
    const tree = openTree(target, args);
    assertWritable(target, 'apply patches');
    if (args.approve && !E.versionState(tree).ok) {
      approveVersion(config, target, tree.version);
      target.testedVersions.push(tree.version);
      if (!args.json) out(c.dim(`approved ${tree.name}@${tree.version}`));
    }
    const prepared = E.prepare(tree, { only: args.only, allowUntested: args['allow-untested'], partial: args.partial });
    if (!args.json) {
      header(tree);
      out('');
      printFindings(prepared.findings);
      out('');
    }
    if (!prepared.writes.length) {
      if (!args.json) out(c.dim('  nothing to apply.'));
      summary.push({ target: tree.name, status: 'no-op' });
      continue;
    }
    if (args.restart && target.restart) {
      if (!args['ignore-busy']) {
        const idle = checkIdle(target);
        if (idle.checked && !args.json) out(c.dim('  busy check passed'));
      }
      if (!args.yes) {
        const ok = await confirm(`  Apply ${prepared.writes.length} file(s) and restart (${target.restart})?`);
        if (!ok) throw new StickyError('not confirmed; nothing was written', { exitCode: 3 });
      }
    }
    const result = E.apply(tree, prepared, config.batchDir);
    if (!args.json) {
      out(`  ${c.green('✔')} applied batch ${c.bold(result.batchId)}`);
      for (const w of result.writes) out(c.dim(`    ${w.path}  ${short(w.sha256Before)} → ${short(w.sha256After)}`));
      out(c.dim(`  undo: stickypatch rollback ${result.batchId}${config.targets.length > 1 ? ` -t ${tree.name}` : ''}`));
    }
    const entry = { target: tree.name, status: 'applied', batchId: result.batchId, files: result.writes.map((w) => w.path) };
    if (args.restart && target.restart) {
      const healthy = await restartAndVerify(target, async () => {
        err(c.yellow(`  rolling back batch ${result.batchId} ...`));
        E.rollback(config.batchDir, target.name, result.batchId);
        E.markBatch(config.batchDir, target.name, result.batchId, { autoRollback: 'health check failed after restart' });
        await restartAndVerify(target, null);
        err(c.yellow('  rolled back; the package is back to its pre-batch bytes.'));
      });
      entry.restart = healthy ? 'healthy' : 'rolled-back';
      if (!healthy) code = 1;
    } else if (target.restart && !args.json) {
      out(c.yellow(`  restart needed to load the change: ${target.restart}   (or re-run with --restart)`));
    }
    summary.push(entry);
  }
  if (args.json) out(JSON.stringify(summary, null, 2));
  return code;
}

async function cmdRollback(config, args) {
  const target = oneTarget(config, args);
  assertWritable(target, 'roll back');
  const batchId = args._[1];
  const r = E.rollback(config.batchDir, target.name, batchId, { force: args.force });
  if (args.json) out(JSON.stringify(r, null, 2));
  else {
    out(`${c.green('✔')} rolled back ${r.batchId} (${r.files.length} file(s))`);
    for (const f of r.files) out(c.dim(`  ${f}`));
  }
  if (args.restart && target.restart) return (await restartAndVerify(target, null)) ? 0 : 1;
  return 0;
}

async function cmdBatches(config, args) {
  const target = oneTarget(config, args);
  const list = E.listBatches(config.batchDir, target.name);
  if (args.json) {
    out(JSON.stringify(list, null, 2));
    return 0;
  }
  if (!list.length) out(c.dim('no batches yet'));
  for (const b of list) {
    out(`${c.bold(b.batchId)}  ${b.status.padEnd(12)} ${c.dim(`${b.version}  ${b.files} file(s)  ${b.patches.join(', ')}`)}`);
  }
  return 0;
}

async function cmdReview(config, args) {
  const parts = [];
  for (const target of pickTargets(config, args)) {
    const tree = openTree(target, args);
    parts.push(buildReview(tree, E.inspect(tree), { all: args.all }));
  }
  const body = parts.join('\n\n');
  if (args.out) {
    fs.writeFileSync(args.out, body);
    err(`wrote ${args.out}`);
  } else process.stdout.write(body);
  return 0;
}

function approveVersion(config, target, version) {
  editTargetJson(config, target.index, (raw) => {
    raw.testedVersions = [...new Set([...(raw.testedVersions || []), version])];
  });
}

async function cmdApprove(config, args) {
  for (const target of pickTargets(config, args)) {
    const tree = openTree(target, args);
    if (target.testedVersions.includes(tree.version)) {
      out(c.dim(`${tree.name}@${tree.version} is already approved`));
      continue;
    }
    const findings = E.inspect(tree);
    const bad = findings.filter((f) => [P.INCOMPATIBLE, P.UNVERIFIABLE].includes(f.status));
    if (bad.length && !args.force) {
      throw new StickyError(`not approving ${tree.version}: ${bad.map((f) => `${f.id} is ${f.status}`).join(', ')} (fix them first, or --force)`);
    }
    approveVersion(config, target, tree.version);
    out(`${c.green('✔')} approved ${tree.name}@${tree.version}`);
  }
  return 0;
}

async function cmdRetire(config, args) {
  const target = oneTarget(config, args);
  const id = args._[1];
  if (!id) throw new StickyError('usage: stickypatch retire <patch-id> [--reason "..."]');
  if (!target.patches.some((p) => p.id === id)) throw new StickyError(`unknown patch id: ${id}`);
  let version = null;
  try {
    version = openTree(target, args).version;
  } catch {
    /* retiring does not need the package */
  }
  editTargetJson(config, target.index, (raw) => {
    const patch = raw.patches.find((p) => p.id === id);
    patch.retired = { version, date: new Date().toISOString().slice(0, 10), reason: args.reason || 'upstream provides this behaviour' };
  });
  out(`${c.green('✔')} retired ${id}${version ? ` (as of ${version})` : ''} — it stays in the config as a record, but is no longer checked or applied`);
  return 0;
}

async function cmdInit(args) {
  const pkg = args._[1];
  if (!pkg && !args.path) throw new StickyError('usage: stickypatch init <npm-package> [--path <dir>] [--bin <command>] [--global]');
  const file = args.config
    ? path.resolve(args.config)
    : args.global
      ? path.join(userConfigDir(), 'stickypatch.json')
      : path.resolve('stickypatch.json');
  const entry = { package: pkg || undefined, path: args.path || undefined, bin: args.bin || undefined, testedVersions: [], patches: [] };
  const resolved = resolveTarget({ name: pkg || args.path, package: pkg || null, path: args.path ? path.resolve(args.path) : null, bin: args.bin || null }, { dir: args.dir });
  entry.testedVersions = [resolved.version];
  if (!entry.package) entry.name = resolved.name;
  let raw = { $schema: 'https://raw.githubusercontent.com/tone-leh/stickypatch/main/stickypatch.schema.json', ...entry };
  if (fs.existsSync(file)) {
    const existing = readJson(file);
    const list = Array.isArray(existing.targets) ? existing.targets : [existing];
    if (list.some((t) => (pkg && t.package === pkg) || (args.path && t.path === args.path))) {
      throw new StickyError(`${file} already has a target for ${pkg || args.path}`);
    }
    const { $schema, ...first } = existing;
    raw = { $schema: $schema || raw.$schema, targets: [...(Array.isArray(existing.targets) ? existing.targets : [first]), entry] };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, raw);
  out(`${c.green('✔')} ${path.relative(process.cwd(), file) || file}: tracking ${c.bold(`${resolved.name}@${resolved.version}`)}`);
  out(c.dim(`  found via ${resolved.via}: ${resolved.root}`));
  out('');
  out('Next: edit a file inside that folder, then capture it:');
  out(c.cyan(`  stickypatch capture ${c.dim('<path/inside/package>')} --id my-fix --why "what it fixes"`));
  return 0;
}

async function cmdCapture(config, args) {
  const target = oneTarget(config, args);
  const files = args._.slice(1);
  if (!files.length || !args.id) {
    throw new StickyError('usage: stickypatch capture <file...> --id <patch-id> [--title ..] [--why ..] [--pristine <dir>]');
  }
  if (target.patches.some((p) => p.id === args.id) && !args.force) {
    throw new StickyError(`patch id "${args.id}" already exists (use --force to replace it)`);
  }
  const tree = openTree(target, args);
  const rels = files.map((f) => {
    const abs = path.resolve(f);
    const rel = path.relative(tree.root, abs);
    const relative = !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(abs) ? rel : f;
    insideRoot(tree.root, relative);
    if (!fs.existsSync(path.join(tree.root, relative))) throw new StickyError(`${relative} does not exist in ${tree.root}`);
    return relative.split(path.sep).join('/');
  });
  const pristine = args.pristine ? path.resolve(args.pristine) : fetchPristine(tree.name, tree.version);
  const others = { ...target, patches: target.patches.filter((p) => p.id !== args.id) };
  const edits = [];
  for (const rel of rels) {
    const base = baselineFor(others, rel, pristine, (m) => err(c.yellow(`warning: ${m}`)));
    const current = fs.readFileSync(path.join(tree.root, rel), 'utf8');
    edits.push(...editsFromDiff(rel, base.text, current, { owned: base.owned }));
  }
  if (!edits.length) throw new StickyError('no differences from the pristine package — edit the installed file first');
  const patch = { id: args.id, title: args.title || args.id, why: args.why || '', edits };
  normalizePatch(patch, config.configDir); // validate
  editTargetJson(config, target.index, (raw) => {
    raw.patches = (raw.patches || []).filter((p) => p.id !== args.id);
    raw.patches.push(patch);
    raw.testedVersions = [...new Set([...(raw.testedVersions || []), tree.version])];
  });
  out(`${c.green('✔')} captured ${c.bold(args.id)}: ${edits.length} edit(s) in ${rels.join(', ')}`);
  const lines = (t) => t.replace(/\n$/, '').split('\n').length;
  for (const e of edits) out(c.dim(`  ${e.file}: ${lines(e.find)} anchor line(s) → ${lines(e.replace)} line(s)`));
  out(c.dim('  it is already live in the installed package; after the next update run `stickypatch status`.'));
  return 0;
}

// ---------------------------------------------------------------- main

export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(c.red(`error: ${error.message}`));
    return 2;
  }
  const command = args._[0];
  if (args.version) {
    out(VERSION);
    return 0;
  }
  if (!command || args.help || command === 'help') {
    out(HELP);
    return command || args.help ? 0 : 2;
  }
  try {
    if (command === 'init') return await cmdInit(args);
    const table = {
      status: cmdStatus,
      check: cmdStatus,
      plan: cmdPlan,
      diff: (cfg, a) => cmdPlan(cfg, { ...a, diff: true }),
      apply: cmdApply,
      rollback: cmdRollback,
      batches: cmdBatches,
      review: cmdReview,
      approve: cmdApprove,
      retire: cmdRetire,
      capture: cmdCapture,
    };
    const fn = table[command];
    if (!fn) throw new StickyError(`unknown command "${command}" — see stickypatch --help`);
    const config = await loadConfig(args.config);
    return await fn(config, args);
  } catch (error) {
    if (error instanceof StickyError) {
      if (args.json) out(JSON.stringify({ error: error.message, code: error.code }, null, 2));
      else err(c.red(`error: ${error.message}`));
      return error.exitCode ?? 2;
    }
    throw error;
  }
}

export { findConfig };
