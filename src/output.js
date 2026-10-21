const useColor = () =>
  !process.env.NO_COLOR && process.env.FORCE_COLOR !== '0' && (process.env.FORCE_COLOR || process.stdout.isTTY);

const wrap = (open, close) => (s) => (useColor() ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const STATUS_STYLE = {
  applied: { icon: '✔', color: c.green },
  missing: { icon: '●', color: c.yellow },
  outdated: { icon: '↻', color: c.yellow },
  upstream: { icon: '★', color: c.magenta },
  incompatible: { icon: '✖', color: c.red },
  unverifiable: { icon: '?', color: c.red },
  retired: { icon: '–', color: c.gray },
};

export function statusLabel(status) {
  const s = STATUS_STYLE[status] || { icon: ' ', color: (x) => x };
  return s.color(`${s.icon} ${status.padEnd(12)}`);
}

export function colorDiff(text) {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return c.bold(line);
      if (line.startsWith('@@')) return c.cyan(line);
      if (line.startsWith('+')) return c.green(line);
      if (line.startsWith('-')) return c.red(line);
      return line;
    })
    .join('\n');
}

export const out = (s = '') => process.stdout.write(`${s}\n`);
export const err = (s = '') => process.stderr.write(`${s}\n`);
