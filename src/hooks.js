// Guards and the restart -> health-check -> auto-rollback loop.

import { spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { StickyError } from './util.js';

/**
 * Refuse write operations from contexts that must stay read-only.
 *
 * The classic failure: an AI agent whose own requests flow through a local proxy
 * patches that proxy and restarts it — killing the session mid-change. Mark such
 * contexts with STICKYPATCH_READONLY=1, or list env vars in guard.denyEnv
 * (e.g. "CODEX_THREAD_ID"), and stickypatch will only inspect, plan and review.
 */
export function assertWritable(target, action) {
  const reasons = [];
  if (process.env.STICKYPATCH_READONLY && process.env.STICKYPATCH_READONLY !== '0') {
    reasons.push('STICKYPATCH_READONLY is set');
  }
  for (const name of target.guard.denyEnv) {
    if (process.env[name] !== undefined) reasons.push(`${name} is set (guard.denyEnv)`);
  }
  if (reasons.length) {
    throw new StickyError(
      `refusing to ${action} from a read-only context: ${reasons.join('; ')}.\n`
        + 'Run the same command from an independent terminal. Read-only commands (status, plan, review) still work.',
      { code: 'READONLY', exitCode: 3 },
    );
  }
}

function sh(command, timeoutMs = 120000) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', timeout: timeoutMs });
  return {
    ok: r.status === 0,
    code: r.status,
    output: `${r.stdout || ''}${r.stderr || ''}`.trim(),
    error: r.error ? r.error.message : null,
  };
}

/** busy: a shell command that exits 0 when it is safe to restart. */
export function checkIdle(target) {
  if (!target.busy) return { checked: false };
  const r = sh(target.busy, 60000);
  if (!r.ok) {
    throw new StickyError(
      `busy check failed (exit ${r.code ?? 'timeout'}): ${target.busy}\n${r.output}\n`
        + 'Something is still running. Wait for it to finish (or pass --ignore-busy). Nothing was written.',
      { code: 'BUSY', exitCode: 3 },
    );
  }
  return { checked: true, output: r.output };
}

function httpStatus(url, timeoutMs) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitHealthy(health, { timeoutSec } = {}) {
  if (!health) return { checked: false, ok: true };
  const deadline = Date.now() + 1000 * (timeoutSec ?? health.timeout ?? 30);
  const delay = health.delay ?? 1;
  if (delay) await sleep(delay * 1000);
  let last = '';
  while (Date.now() < deadline) {
    if (health.url) {
      const code = await httpStatus(health.url, 3000);
      const want = health.expectStatus ?? null;
      if (code !== null && (want ? code === want : code >= 200 && code < 300)) {
        return { checked: true, ok: true, detail: `${health.url} -> ${code}` };
      }
      last = `${health.url} -> ${code ?? 'no response'}`;
    } else if (health.command) {
      const r = sh(health.command, 15000);
      if (r.ok) return { checked: true, ok: true, detail: `${health.command} -> exit 0` };
      last = `${health.command} -> exit ${r.code ?? 'timeout'} ${r.output.slice(0, 200)}`;
    }
    await sleep(500);
  }
  return { checked: true, ok: false, detail: last || 'health check timed out' };
}

export function restart(target) {
  if (!target.restart) return { ran: false, ok: true };
  const r = sh(target.restart);
  return { ran: true, ok: r.ok, code: r.code, output: r.output };
}
