const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open, close) => (s) => (useColor ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));

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

const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
const width = (s) => stripAnsi(s).length;

export function money(n) {
  if (!Number.isFinite(n)) return '-';
  if (n === 0) return '$0.00';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1000) return '$' + n.toFixed(2);
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function tokens(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M';
}

export function when(d) {
  if (!d) return '-';
  return d.toISOString().replace('T', ' ').slice(0, 16);
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

/** Shorten a long absolute path to something that still identifies the project. */
export function shortPath(p, n = 34) {
  const s = String(p ?? '');
  if (s.length <= n) return s;
  const parts = s.split('/').filter(Boolean);
  let out = parts.slice(-2).join('/');
  while (out.length > n - 2 && out.includes('/')) out = out.slice(out.indexOf('/') + 1);
  return '…/' + truncate(out, n - 2);
}

/**
 * @param {Array<{header:string, key?:string, get?:Function, align?:'left'|'right', width?:number}>} columns
 * @param {Array<object>} rows
 */
export function table(columns, rows, { indent = '' } = {}) {
  const cells = rows.map((row) =>
    columns.map((col) => String(col.get ? col.get(row) : row[col.key] ?? ''))
  );

  const widths = columns.map((col, i) => {
    const longest = Math.max(width(col.header), ...cells.map((r) => width(r[i])), 0);
    return col.width ? Math.min(longest, col.width) : longest;
  });

  const pad = (s, w, align) => {
    const raw = width(s);
    if (raw > w) {
      const plain = truncate(stripAnsi(s), w);
      return align === 'right' ? plain.padStart(w) : plain.padEnd(w);
    }
    const fill = ' '.repeat(w - raw);
    return align === 'right' ? fill + s : s + fill;
  };

  const lines = [];
  lines.push(
    indent + columns.map((col, i) => c.bold(pad(col.header, widths[i], col.align))).join('  ')
  );
  lines.push(indent + c.gray(widths.map((w) => '─'.repeat(w)).join('──')));
  for (const row of cells) {
    lines.push(indent + row.map((cell, i) => pad(cell, widths[i], columns[i].align)).join('  '));
  }
  return lines.join('\n');
}

export function bar(fraction, len = 24) {
  const f = Math.max(0, Math.min(1.5, fraction || 0));
  const filled = Math.min(len, Math.round(f * len));
  const glyph = '█'.repeat(filled) + c.gray('░'.repeat(Math.max(0, len - filled)));
  if (f >= 1) return c.red(glyph);
  if (f >= 0.8) return c.yellow(glyph);
  return c.green(glyph);
}

export function heading(text) {
  return '\n' + c.bold(c.cyan(text)) + '\n';
}

export function note(text) {
  return c.gray(text);
}
