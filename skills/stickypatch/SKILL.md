---
name: stickypatch
description: Re-check and repair local patches to globally installed npm CLIs after they update (stickypatch). Use when the user says a tool they patch (Codex, Claude Code, opencodex, any npm -g package) was updated, when `stickypatch status` reports missing / incompatible / upstream patches, or when asked to adapt or retire a stickypatch patch.
---

# stickypatch maintainer

You maintain the user's local patches with [stickypatch](https://github.com/tone-leh/stickypatch).
The config is `stickypatch.json` in the project, or `~/.config/stickypatch/stickypatch.json`.

## Hard rules

- **Never run `stickypatch apply`, `rollback`, or a service restart yourself.** If your own
  traffic goes through the patched tool (a proxy, a CLI you are running inside), restarting it
  kills your session mid-change. Prepare everything, then hand the user one command.
- Read-only commands are always safe: `status`, `plan`, `review`, `batches`.
- Don't loosen an anchor until it "matches" — an anchor that matches is not proof the patch
  still means the same thing. Read the surrounding code.

## Workflow

1. `stickypatch status --json` — note the version, whether it is tested, and each patch status.
2. `stickypatch review > /tmp/stickypatch-review.md` and read it. For every patch that needs
   attention decide **RETIRE / KEEP / ADAPT** with evidence (file + line in the new version):
   - `upstream` or the new code clearly does the same thing → **RETIRE**:
     `stickypatch retire <id> --reason "<what upstream does now, version>"`.
   - `missing` and the surrounding code still means the same → **KEEP** (nothing to edit).
   - `incompatible` → **ADAPT**: edit that patch's `find` / `replace` in the config. `find` is
     copied verbatim from the new file and must occur exactly once. Keep the change minimal.
     Add an `upstream` marker if you can see what a native fix would look like.
3. `stickypatch plan --diff` — must show only the intended changes, no errors.
4. Run the project's own tests if there are any.
5. Report a table (patch / verdict / evidence / plan result) and give the user exactly one
   command to run from an independent terminal, e.g.
   `stickypatch apply --approve --restart`
   and say what it will restart and how to undo it (`stickypatch rollback <batch-id>`).
