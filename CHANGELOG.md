# Changelog

## 0.1.0 — 2026-10-21

First public release.

- `status`, `plan --diff`, `apply`, `rollback`, `batches` with atomic, hash-checked batches
- Seven statuses: applied / missing / outdated / upstream / incompatible / unverifiable / retired
- `capture`: turn hand edits into patches with minimal unique anchors (pristine copy via `npm pack`)
- `review`: Markdown brief for AI agents with nearest-code hints for moved anchors
- `approve` version gate, `retire` with recorded reason
- `--restart` with health check (URL or command), busy check, and automatic rollback
- Read-only guard (`guard.denyEnv`, `STICKYPATCH_READONLY`) for agent sessions
- Package resolution through PATH, `npm root -g`, fnm / nvm / Volta / Homebrew / bun / pnpm
- JSON and JS configs, multi-target configs, JSON Schema
