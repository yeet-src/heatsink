/* heatsink — a live thermal, power & clock dashboard for one Linux box.
 * Every hwmon sensor (CPU package, GPU edge, NVMe, board) is charted with
 * its headroom to the throttle point; the GPU's draw and the per-core clock
 * spread sit below it. The whole thing is instantaneous — no counters, no
 * deltas — so a snapshot is as honest as the live view.
 *
 *   yeet run examples/heatsink/main.js
 *   yeet run examples/heatsink/main.js -- --sort head
 *   yeet run examples/heatsink/main.js -- --once | less -R
 *
 * Flags:
 *   --sort temp|head|chip|name   thermal-table order (default temp, hottest first)
 *   --interval N                 refresh period in ms (default 1000)
 *   --secs N                     exit cleanly after N seconds (default: until Ctrl-C)
 *   --once                       print one snapshot and exit (pipe-safe)
 */

import { headroom, sample, status } from "./data.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};

/* The `tty` namespace only exists when the daemon handed us a PTY, so its
 * absence is our "we're being piped" signal — drop straight to a snapshot. */
const TTY = (typeof tty !== "undefined" && tty) || null;
const ONCE = !!args.once || !TTY;
const INTERVAL = Math.max(100, Number(args.interval ?? 1000) | 0);
const SECS = args.secs != null ? Number(args.secs) : null;

const ESC = "\x1b";
const ERASE = `${ESC}[2K`;
const at = (row, col) => `${ESC}[${row};${col}H`;

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visLen = (s) => stripAnsi(s).length;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/* Clip a (possibly colored) line to `width` visible columns, stepping over
 * zero-width SGR escapes. Only re-closes color when the line actually
 * carried any, so piped output stays free of stray resets. */
function clip(line, width) {
  if (visLen(line) <= width) return line;
  let out = "";
  let vis = 0;
  for (let i = 0; i < line.length && vis < width; ) {
    const esc = line[i] === "\x1b" && /^\x1b\[[0-9;]*m/.exec(line.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
    } else {
      out += line[i++];
      vis++;
    }
  }
  return out.includes("\x1b[") ? out + "\x1b[0m" : out;
}

function log(msg = "") {
  const s = String(msg);
  console.log(TTY ? s.replace(/\r?\n/g, "\r\n") + "\r" : s);
}

const RGB = {
  ok: [74, 222, 128],
  warm: [250, 204, 21],
  hot: [251, 146, 60],
  crit: [248, 113, 113],
};

const paint = (level, s) => style.fg(String(s), ...(RGB[level] || RGB.ok));

const SEP = "  ";
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const GAUGE_MAX = 32;
const CELL_W = 10; /* "cNN ▇ 4.10" — one clock cell, padded to this width */

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SORTS = {
  temp: (a, b) => b.tempC - a.tempC,
  head: (a, b) => (headroom(a) ?? Infinity) - (headroom(b) ?? Infinity),
  chip: (a, b) => cmp(a.chip, b.chip) || cmp(a.sensor, b.sensor),
  name: (a, b) => cmp(a.sensor, b.sensor),
};

const SORT = SORTS[args.sort] ? args.sort : "temp";

/* Column order is the on-screen order; `drop` is the priority when the
 * terminal is too narrow to hold them all (lowest goes first). TEMP and
 * STATE carry the headline and never drop. The gauge is the one flexible
 * column — it takes whatever width is left, capped so it stays readable. */
const COLUMNS = [
  { key: "chip", label: "CHIP", width: 14, align: "left", drop: 4 },
  { key: "sensor", label: "SENSOR", width: 11, align: "left", drop: 3 },
  { key: "temp", label: "TEMP", width: 8, align: "right", drop: 99 },
  { key: "gauge", label: "", flex: true, min: 8, drop: 0 },
  { key: "limit", label: "LIMIT", width: 8, align: "right", drop: 2 },
  { key: "head", label: "HEAD", width: 7, align: "right", drop: 1 },
  { key: "state", label: "STATE", width: 5, align: "left", drop: 99 },
];

function fit(text, width, align) {
  let s = String(text ?? "");
  if (s.length > width) s = width <= 1 ? s.slice(0, width) : s.slice(0, width - 1) + "…";
  return align === "right" ? s.padStart(width) : s.padEnd(width);
}

function fmtTemp(c) {
  return c == null ? "—" : `${c.toFixed(1)}°C`;
}

function fmtUptime(secs) {
  if (secs == null) return "?";
  const s = Math.floor(secs);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function fmtLoad(load) {
  const n = (x) => (x == null ? "—" : x.toFixed(2));
  return `${n(load.one)} ${n(load.five)} ${n(load.fifteen)}`;
}

function hhmmss() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function gauge(frac, width, level) {
  const w = Math.max(0, Math.min(width, Math.round(clamp01(frac) * width)));
  return paint(level, "█".repeat(w)) + style.dim("░".repeat(width - w));
}

/* Drop the lowest-priority columns until the row fits, then hand the gauge
 * whatever space remains. Returns the surviving columns with the gauge's
 * width resolved against this terminal size. */
function layout(cols) {
  let sel = COLUMNS.map((c) => ({ ...c }));
  const fixed = (arr) => arr.reduce((a, c) => (c.flex ? a : a + c.width), 0);
  const seps = (n) => SEP.length * Math.max(0, n - 1);
  const flex = () => sel.find((c) => c.flex);

  while (sel.length > 2) {
    const base = fixed(sel) + seps(sel.length) + (flex() ? flex().min : 0);
    if (base <= cols) break;
    let victim = null;
    for (const c of sel) {
      if (c.drop < 99 && (!victim || c.drop < victim.drop)) victim = c;
    }
    if (!victim) break;
    sel = sel.filter((c) => c !== victim);
  }

  const f = flex();
  if (f) {
    const leftover = cols - fixed(sel) - seps(sel.length);
    if (leftover < f.min) sel = sel.filter((c) => c !== f);
    else f.width = Math.min(GAUGE_MAX, leftover);
  }
  return sel;
}

function cell(col, zone, level) {
  if (col.key === "gauge") {
    const ceiling = zone.critC ?? zone.maxC ?? 90;
    const base = 30;
    const frac = ceiling > base ? (zone.tempC - base) / (ceiling - base) : 0;
    return gauge(frac, col.width, level);
  }

  let text;
  switch (col.key) {
    case "chip":
      return fit(zone.chip, col.width, col.align);
    case "sensor":
      return style.dim(fit(zone.sensor, col.width, col.align));
    case "temp":
      return paint(level, fit(fmtTemp(zone.tempC), col.width, col.align));
    case "limit": {
      const limit = zone.critC ?? zone.maxC;
      text = limit == null ? "—" : `${limit.toFixed(0)}°`;
      return style.dim(fit(text, col.width, col.align));
    }
    case "head": {
      const head = headroom(zone);
      text = head == null ? "—" : `${head.toFixed(1)}°`;
      return paint(level, fit(text, col.width, col.align));
    }
    case "state":
      return paint(level, fit(level, col.width, col.align));
    default:
      return fit("", col.width, col.align);
  }
}

function renderTable(zones, cols) {
  const sel = layout(cols);
  const header = sel.map((c) => style.dim(fit(c.label, c.width, c.align))).join(SEP);
  const rows = zones.map((z) => {
    const level = status(z);
    return sel.map((c) => cell(c, z, level)).join(SEP);
  });
  return { header, rows };
}

function utilGauge(pct, width) {
  const frac = clamp01((pct || 0) / 100);
  const level = pct >= 90 ? "crit" : pct >= 60 ? "hot" : pct >= 25 ? "warm" : "ok";
  return gauge(frac, width, level);
}

function gpuLine(g) {
  const level = g.tempC >= 85 ? "crit" : g.tempC >= 75 ? "hot" : g.tempC >= 60 ? "warm" : "ok";
  const util =
    g.utilPct == null ? "" : `   ${style.dim("util")} ${utilGauge(g.utilPct, 10)} ${String(g.utilPct).padStart(3)}%`;
  return (
    `${style.bold("GPU")}  ${g.name}   ${paint(level, `${g.tempC}°C`)}` +
    `   ${style.bold(g.powerW.toFixed(1))} ${style.dim("W")}${util}`
  );
}

function clockCell(c) {
  const label = `c${String(c.core).padStart(2, "0")}`;
  if (c.curGHz == null) return style.dim(fit(`${label} —`, CELL_W, "left"));

  const max = c.maxGHz || c.curGHz;
  const frac = max > 0 ? clamp01(c.curGHz / max) : 0;
  const block = BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(frac * BLOCKS.length))];
  const rgb = frac < 0.45 ? [96, 165, 250] : frac < 0.7 ? [45, 212, 191] : frac < 0.9 ? [74, 222, 128] : [250, 204, 21];
  return `${style.dim(label)} ${style.fg(block, ...rgb)} ${style.fg(c.curGHz.toFixed(2), ...rgb)}`;
}

function clockSection(clocks, cols) {
  if (!clocks.length) return [];
  const perRow = Math.max(1, Math.floor((cols + SEP.length) / (CELL_W + SEP.length)));
  const out = [`${style.bold("CLOCKS")}  ${style.dim("cur/max GHz per core")}`];
  for (let i = 0; i < clocks.length; i += perRow) {
    out.push(clocks.slice(i, i + perRow).map(clockCell).join(SEP));
  }
  return out;
}

function headerLine(s, cols) {
  const hottest = [...s.zones].sort(SORTS.temp)[0];
  const hot = hottest
    ? `${style.dim("hottest")} ${paint(status(hottest), `${hottest.chip} ${hottest.sensor} ${hottest.tempC.toFixed(0)}°C`)}`
    : style.dim("no sensors");
  const left =
    `${style.bold("heatsink")}   ${style.dim("up")} ${fmtUptime(s.uptimeSecs)}` +
    `   ${style.dim("load")} ${fmtLoad(s.load)}   ${s.cores} ${style.dim("cores")}   ${hot}`;

  const time = hhmmss();
  const pad = cols - visLen(left) - time.length;
  return pad > 1 ? left + " ".repeat(pad) + style.dim(time) : left;
}

const rule = (cols) => style.dim("─".repeat(cols));

export function renderScreen(s, cols, rows) {
  const out = [headerLine(s, cols), rule(cols)];

  const bottom = [rule(cols)];
  if (s.gpu) bottom.push(gpuLine(s.gpu));
  const clocks = clockSection(s.clocks, cols);

  out.push(style.bold("THERMAL"));
  const zones = [...s.zones].sort(SORTS[SORT]);
  const tbl = renderTable(zones, cols);
  out.push(tbl.header);

  let avail = rows - out.length - bottom.length;
  const includeClocks = avail - clocks.length >= Math.min(3, zones.length);
  if (includeClocks) avail -= clocks.length;

  let shown = tbl.rows;
  if (tbl.rows.length > avail) {
    const keep = Math.max(1, avail - 1);
    shown = tbl.rows.slice(0, keep);
    shown.push(style.dim(`… +${tbl.rows.length - keep} more`));
  }

  out.push(...shown, ...bottom);
  if (includeClocks) out.push(...clocks);
  return out.slice(0, rows).map((line) => clip(line, cols));
}

function size() {
  const s = TTY?.size?.() || {};
  return {
    cols: Math.max(40, (s.cols | 0) || 80),
    rows: Math.max(10, (s.rows | 0) || 24),
  };
}

async function snapshot() {
  const s = await sample();
  const { cols } = size();
  for (const line of renderScreen(s, cols, Infinity)) log(line);
}

async function live() {
  TTY.alt();
  TTY.hideCursor();
  TTY.clear();
  TTY.on?.("resize", () => TTY.clear());

  let stop = false;
  if (SECS != null) setTimeout(() => (stop = true), SECS * 1000);

  try {
    while (!stop) {
      const t0 = Date.now();
      try {
        const s = await sample();
        const { cols, rows } = size();
        const lines = renderScreen(s, cols, rows);
        let out = "";
        let r = 1;
        for (const line of lines) out += at(r++, 1) + ERASE + line;
        for (; r <= rows; r++) out += at(r, 1) + ERASE;

        TTY.beginFrame?.();
        TTY.write(out);
        TTY.endFrame?.();
      } catch {
        /* A transient query failure shouldn't tear the dashboard down;
         * keep the last frame and try again next tick. */
      }
      await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL - (Date.now() - t0))));
    }
  } finally {
    TTY.showCursor();
    TTY.main();
  }
}

if (import.meta.main) {
  try {
    await (ONCE ? snapshot() : live());
  } catch (err) {
    if (TTY) {
    TTY.showCursor();
    TTY.main();
  }
    console.error(String((err && err.stack) || err));
  }
}
