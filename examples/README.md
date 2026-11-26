# stickypatch Recipes & Templates

Ready-to-copy configuration templates for globally installed npm CLIs, local LLM proxies, and MCP tooling.

## Scope & Prerequisites

- **Supported targets:** Globally installed npm packages distributed as editable **JS / TS / JSON** source files (installed via `npm i -g`, `pnpm add -g`, `bun add -g`, fnm, nvm, Volta, or Homebrew npm layouts).
- **Unsupported targets:** Precompiled native binaries (such as standalone native `claude.exe` / native executable builds, or compiled Rust binaries) and Electron `app.asar` archives. When a CLI ships an npm wrapper around a native binary, stickypatch applies only to the text JS/TS/JSON files inside that npm package.

## Recipe Index

| Template | Target(s) | Typical Use Case | Built-in Guards / Lifecycle |
| --- | --- | --- | --- |
| [`claude-code.stickypatch.json`](claude-code.stickypatch.json) | `@anthropic-ai/claude-code` (`claude`) | Patching the npm-distributed JS CLI of Claude Code while blocking writes from inside Claude sessions | `guard.denyEnv`: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` |
| [`codex-cli.stickypatch.json`](codex-cli.stickypatch.json) | `@openai/codex` (`codex`) | Patching JS/JSON files inside the `@openai/codex` global npm package while preventing self-modification from Codex shells | `guard.denyEnv`: `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_SANDBOX` |
| [`opencodex.stickypatch.json`](opencodex.stickypatch.json) | `@bitkyc08/opencodex` (`ocx`) | Local LLM proxy service with service restart and `/readyz` health-check rollback | `restart`, `health` (`url`, `timeout`), `guard.denyEnv` |
| [`antigravity-mcp-tooling.stickypatch.json`](antigravity-mcp-tooling.stickypatch.json) | `local-llm-proxy`, `mcp-filesystem`, `mcp-remote` | Shared multi-target toolchain for Antigravity, Claude Code, and Codex (local proxy + global MCP server CLIs) | `targets`, `restart`, HTTP & command `health`, cross-agent `guard.denyEnv` |
| [`multi-target.stickypatch.json`](multi-target.stickypatch.json) | `@openai/codex` + `@bitkyc08/opencodex` | Minimal multi-target template managing two global npm packages in one config | `targets`, `restart`, `health`, `guard.denyEnv` |
| [`custom-patch.stickypatch.config.mjs`](custom-patch.stickypatch.config.mjs) | Local `./demo/v1` fixture | JavaScript config using custom `detect()` and `render()` functions for programmatic transforms | Custom JS patch logic |
| [`demo/try.sh`](demo/try.sh) | Self-contained sandbox | 60-second end-to-end walkthrough in a temp directory covering `status`, `apply`, `review`, `retire`, and `rollback` | Zero changes to real global packages |

## Quick Workflow with `stickypatch capture`

1. Copy a template into your config location (project-local `stickypatch.json` or `~/.config/stickypatch/stickypatch.json`):

```bash
mkdir -p ~/.config/stickypatch
cp examples/codex-cli.stickypatch.json ~/.config/stickypatch/stickypatch.json
```

2. Edit the JS/TS/JSON file directly inside the installed global npm package, then capture the minimal unique anchors:

```bash
# Single-target config:
stickypatch capture "$(npm root -g)/@openai/codex/<relative-file-path>" \
  --id my-local-fix \
  --why "Describe the bug or behavior this patch adjusts"

# Multi-target config (select the target with -t):
stickypatch capture -t mcp-remote "$(npm root -g)/mcp-remote/<relative-file-path>" \
  --id custom-timeout \
  --why "Raise OAuth callback timeout on slow networks"
```

3. Verify and apply from an independent terminal (outside guarded agent sessions):

```bash
stickypatch status
stickypatch plan --diff
stickypatch apply --approve            # add --restart for services with restart/health configured
```

4. After future `npm update -g` runs, re-check with `stickypatch status`, generate an agent review brief with `stickypatch review`, and retire obsolete patches with `stickypatch retire <id>` once upstream ships the fix.
