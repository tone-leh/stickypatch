# Contributing

Thanks for helping! stickypatch is small on purpose: zero runtime dependencies, plain Node ESM,
no build step.

```bash
git clone https://github.com/tone-leh/stickypatch && cd stickypatch
npm test                     # node:test, a few seconds
bash examples/demo/try.sh    # end-to-end tour in a temp dir
```

Guidelines:

- **Safety first.** Anything that writes must check before it writes, never leave a half-applied
  state, and say exactly what it did. New write paths need a test that proves the failure case.
- **Honest output.** Don't collapse distinct situations into one status or message.
- **Pure core.** `src/patch.js` must stay free of I/O so behaviour is testable on in-memory files.
- Keep it dependency-free. If you need a helper, write the small version.

Good first contributions: Windows support, more node-manager layouts in `src/resolve.js`,
`stickypatch capture` for whole directories, a `--watch` mode, recipes for popular CLIs in
`examples/`.

Found a security issue (e.g. a way to write outside the package root)? Please open a private
security advisory on GitHub instead of a public issue.
