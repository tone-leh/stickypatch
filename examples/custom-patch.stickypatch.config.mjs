// A JS config lets one patch use code instead of find/replace — handy when the
// change is easier to express as a transformation (e.g. "raise every timeout").
export default {
  path: './demo/v1', // try: stickypatch status -c examples/custom-patch.stickypatch.config.mjs
  testedVersions: ['1.0.0'],
  patches: [
    {
      id: 'triple-timeouts',
      why: 'slow networks',
      files: ['src/fetch.js'],
      detect(files) {
        const src = files['src/fetch.js'];
        if (src.includes('/* stickypatch:triple-timeouts */')) return { status: 'applied' };
        if (!/timeoutMs = \d+/.test(src)) return { status: 'incompatible', detail: 'no timeoutMs literal found' };
        return { status: 'missing' };
      },
      render(files) {
        const src = files['src/fetch.js'].replace(/timeoutMs = (\d+)/g, (_, ms) => `timeoutMs = ${ms * 3}`);
        return { 'src/fetch.js': `/* stickypatch:triple-timeouts */\n${src}` };
      },
    },
  ],
};
