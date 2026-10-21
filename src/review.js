// Build a Markdown "review bundle" an LLM (or a human) can act on after an update:
// for every patch that needs attention it shows what was expected, what the new
// version looks like around the closest match, and whether upstream markers
// appeared — plus precise instructions for deciding retire / keep / adapt.

import * as P from './patch.js';
import { count, lineOf } from './util.js';

const TOKEN = /[A-Za-z_$][\w$]*|\d+|[^\s\w]/g;

function tokens(line) {
  return new Set(line.match(TOKEN) || []);
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Find the regions of `text` that look most like `anchor`. */
export function nearest(text, anchor, { limit = 2 } = {}) {
  const lines = text.split('\n');
  const wanted = anchor.split('\n').filter((l) => l.trim());
  if (!wanted.length) return [];
  const want = wanted.map(tokens);
  const have = lines.map(tokens);
  const scores = [];
  const k = Math.min(want.length, 40);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    let sum = 0;
    let used = 0;
    let row = i;
    for (let j = 0; j < k && row < lines.length; j += 1) {
      while (row < lines.length && !lines[row].trim()) row += 1;
      if (row >= lines.length) break;
      sum += jaccard(want[j], have[row]);
      used += 1;
      row += 1;
    }
    if (used) scores.push({ start: i, end: row, score: sum / k });
  }
  scores.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const s of scores) {
    if (s.score < 0.25) break;
    if (picked.some((p) => s.start < p.end + 3 && p.start < s.end + 3)) continue;
    picked.push(s);
    if (picked.length >= limit) break;
  }
  return picked.map((p) => ({ startLine: p.start + 1, endLine: p.end, score: Number(p.score.toFixed(2)) }));
}

function fence(body, lang = '') {
  const longest = Math.max(2, ...(body.match(/`+/g) || []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${body.replace(/\n$/, '')}\n${ticks}`;
}

function excerpt(text, startLine, endLine, pad = 6) {
  const lines = text.split('\n');
  const from = Math.max(1, startLine - pad);
  const to = Math.min(lines.length, endLine + pad);
  const width = String(to).length;
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(`${String(n).padStart(width)} | ${lines[n - 1]}`);
  return out.join('\n');
}

function langOf(file) {
  const ext = (file.split('.').pop() || '').toLowerCase();
  return { ts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', py: 'python', json: 'json', rs: 'rust', go: 'go', sh: 'sh' }[ext] || '';
}

const INSTRUCTIONS = `## Instructions for the reviewer

You are reviewing local source patches after the package above was updated. This
report is read-only context; **do not apply patches, restart services, or run
\`stickypatch apply\` yourself** — a human runs the final apply from an
independent terminal.

For **each patch listed below**, decide one verdict and give evidence:

1. **RETIRE** — the new version already provides this behaviour natively. Point at
   the exact upstream code (file + lines) and explain any behaviour difference.
   Then set \`"retired": { "version": "<new version>", "reason": "..." }\` on that patch
   in the stickypatch config (or run \`stickypatch retire <id> --reason "..."\`).
2. **KEEP** — still needed, and the anchors still match the same *meaning*
   (status \`missing\`). A textual match is not proof of semantic equivalence:
   read the surrounding code and confirm the patch still does what "Why" says.
3. **ADAPT** — still needed but the code moved (status \`incompatible\`). Rewrite
   that patch's \`find\` / \`replace\` in the config against the new code:
   - \`find\` must be copied **verbatim** from the new file and occur **exactly once**;
   - keep the change minimal and keep the original intent;
   - keep the old \`replace\` text in \`previous\` only if older patched copies may
     still exist somewhere.

Then run \`stickypatch plan --diff\` to prove the config renders cleanly, run the
project's tests if any, and finish with a table: patch / verdict / evidence /
plan result. If everything is KEEP or RETIRE and the plan is clean, say which
command the human should run (usually \`stickypatch approve && stickypatch apply\`).
`;

export function buildReview(tree, findings, { all = false } = {}) {
  const t = tree.target;
  const version = t.testedVersions.length
    ? (t.testedVersions.includes(tree.version)
      ? `tested (${t.testedVersions.join(', ')})`
      : `**NEW** — tested so far: ${t.testedVersions.join(', ')}`)
    : 'no testedVersions recorded';
  const out = [];
  out.push(`# stickypatch review — \`${tree.name}@${tree.version}\``);
  out.push('');
  out.push(`- Package root: \`${tree.root}\` (found via ${tree.via})`);
  out.push(`- Version: ${version}`);
  out.push(`- Generated: ${new Date().toISOString()}`);
  out.push('');
  out.push('| Patch | Status | Detail |');
  out.push('| --- | --- | --- |');
  for (const f of findings) out.push(`| \`${f.id}\` | ${f.status} | ${f.detail.replace(/\|/g, '\\|')} |`);
  out.push('');

  const selected = findings.filter((f) => all || P.NEEDS_ATTENTION.has(f.status));
  if (!selected.length) {
    out.push('Nothing needs review: every patch is applied or retired.');
    return `${out.join('\n')}\n`;
  }
  out.push(INSTRUCTIONS);

  for (const f of selected) {
    const patch = t.patches.find((p) => p.id === f.id);
    out.push(`---\n\n## \`${patch.id}\` — ${patch.title}`);
    out.push('');
    out.push(`**Status:** ${f.status} — ${f.detail}`);
    if (patch.why) out.push(`\n**Why this patch exists:** ${patch.why}`);
    out.push('');
    if (patch.custom) {
      out.push(`_Custom patch (code-defined in the config). Files: ${patch.files.map((x) => `\`${x}\``).join(', ')}._`);
      out.push('');
      continue;
    }
    patch.edits.forEach((edit, i) => {
      const text = tree.files[edit.file];
      const state = f.edits?.[i]?.state;
      out.push(`### Edit ${i + 1} — \`${edit.file}\`${state ? ` (${state})` : ''}`);
      out.push('');
      out.push('Expected anchor (`find`):');
      out.push(fence(edit.find, langOf(edit.file)));
      out.push('');
      out.push('Patched form (`replace`):');
      out.push(fence(edit.replace, langOf(edit.file)));
      out.push('');
      if (text === undefined) {
        out.push('> The file does not exist in this version. Look for where its contents moved.');
        out.push('');
        return;
      }
      const n = count(text, edit.find);
      if (n === 1) {
        const at = lineOf(text, text.indexOf(edit.find));
        const len = edit.find.split('\n').length;
        out.push(`Anchor found once at line ${at}. Current code around it:`);
        out.push(fence(excerpt(text, at, at + len - 1), ''));
      } else if (n > 1) {
        const lines = [];
        let idx = text.indexOf(edit.find);
        while (idx !== -1) {
          lines.push(lineOf(text, idx));
          idx = text.indexOf(edit.find, idx + 1);
        }
        out.push(`Anchor is **ambiguous** — it appears ${n} times (lines ${lines.join(', ')}). Widen it until it is unique.`);
      } else if (state !== 'applied') {
        const hits = nearest(text, edit.find);
        if (hits.length) {
          out.push('Anchor **not found**. Closest code in the new version:');
          for (const h of hits) {
            out.push('');
            out.push(`Lines ${h.startLine}–${h.endLine} (similarity ${h.score}):`);
            out.push(fence(excerpt(text, h.startLine, h.endLine), ''));
          }
        } else {
          out.push('Anchor **not found**, and nothing similar is in this file. The code may have moved to another file.');
        }
      }
      out.push('');
    });
    if (patch.upstream.length) {
      out.push('Upstream markers (all must hold for "upstream"):');
      for (const u of patch.upstream) {
        const text = tree.files[u.file];
        const parts = [];
        if (u.contains) {
          const at = text?.indexOf(u.contains) ?? -1;
          parts.push(at >= 0 ? `contains ✓ (line ${lineOf(text, at)})` : 'contains ✗');
        }
        if (u.absent) parts.push(text?.includes(u.absent) ? 'absent ✗ (still present)' : 'absent ✓');
        out.push(`- \`${u.file}\`: ${parts.join(', ')}`);
      }
      out.push('');
    }
  }
  return `${out.join('\n')}\n`;
}
