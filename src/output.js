// How beacons, conversations and accounts read in a terminal.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Beacons and messages are written by strangers. Drop every control character
 * but newline and tab, and the invisible direction marks, so a beacon cannot
 * move the cursor, recolour the screen or reorder what a reader sees.
 */
export function clean(/** @type {unknown} */ text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, "");
}

/** @param {boolean} enabled */
export function palette(enabled) {
  const wrap = (/** @type {number} */ open, /** @type {number} */ close) =>
    enabled ? (/** @type {unknown} */ s) => `\x1b[${open}m${s}\x1b[${close}m` : (/** @type {unknown} */ s) => String(s);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
  };
}

/** @typedef {ReturnType<typeof palette>} Palette */

/** `4 Oct 2026` */
export function day(/** @type {string | null | undefined} */ iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** `4 Oct 14:05` */
export function moment(/** @type {string | null | undefined} */ iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

/** `8 seconds ago`, `1 minute ago`, `3 hours ago`, `2 days ago`: how old a location is. @param {string} iso @param {Date} [now] */
export function ago(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return clean(iso);
  const count = (/** @type {number} */ n, /** @type {string} */ unit) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const seconds = Math.max(1, Math.floor((now.getTime() - at.getTime()) / 1000));
  if (seconds < 60) return count(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return count(hours, "hour");
  return count(Math.floor(hours / 24), "day");
}

/** A text block set off with a rule, wrapped to `width`, so it reads as quoted. @param {string} text @param {Palette} c @param {number} width */
export function quoted(text, c, width) {
  return clean(text)
    .split("\n")
    .flatMap((line) => (line ? wrap(line, width - 2) : [""]))
    .map((line) => `${c.dim("│")} ${line}`);
}

/** Wrap words to `width`, breaking a word only when it is longer than a line. @param {string} text @param {number} width */
export function wrap(text, width) {
  const words = text.split(" ").flatMap((word) => {
    const chars = Array.from(word);
    if (chars.length <= width) return [word];
    const pieces = [];
    for (let i = 0; i < chars.length; i += width) pieces.push(chars.slice(i, i + width).join(""));
    return pieces;
  });
  /** @type {string[]} */
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && Array.from(`${line} ${word}`).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
