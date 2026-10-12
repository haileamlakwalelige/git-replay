'use strict';

const useColor =
  process.env.NO_COLOR == null &&
  process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
};

function wrap(code, text) {
  if (!useColor) return text;
  return `\u001b[${code}m${text}\u001b[${CODES.reset}m`;
}

const c = {
  bold: (t) => wrap(CODES.bold, t),
  dim: (t) => wrap(CODES.dim, t),
  italic: (t) => wrap(CODES.italic, t),
  underline: (t) => wrap(CODES.underline, t),
  red: (t) => wrap(CODES.red, t),
  green: (t) => wrap(CODES.green, t),
  yellow: (t) => wrap(CODES.yellow, t),
  blue: (t) => wrap(CODES.blue, t),
  magenta: (t) => wrap(CODES.magenta, t),
  cyan: (t) => wrap(CODES.cyan, t),
  gray: (t) => wrap(CODES.gray, t),
};

function padRight(text, width) {
  const visible = stripAnsi(text).length;
  if (visible >= width) return text;
  return text + ' '.repeat(width - visible);
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '');
}

function truncate(text, width) {
  const s = String(text);
  if (s.length <= width) return s;
  if (width <= 1) return s.slice(0, width);
  return s.slice(0, width - 1) + '…';
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 10);
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const day = 86400000;
  const abs = Math.abs(diff);
  const units = [
    ['year', 365 * day],
    ['month', 30 * day],
    ['day', day],
    ['hour', 3600000],
    ['minute', 60000],
  ];
  for (const [name, ms] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

module.exports = {
  c,
  padRight,
  stripAnsi,
  truncate,
  shortDate,
  relativeTime,
  useColor,
};
