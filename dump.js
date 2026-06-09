/* heatsink dump — the same sample main.js paints, as newline-delimited
 * JSON. One record per line: every thermal zone, the GPU, and each core's
 * clock, tagged by `kind` so a single stream feeds jq.
 *
 *   yeet run examples/heatsink/dump.js | jq -c 'select(.kind=="zone")'
 *   yeet run examples/heatsink/dump.js -- --interval 1000   # stream forever
 */

import { headroom, sample, status } from "./data.js";

const args = (typeof yeet !== "undefined" && yeet.args) || {};
const INTERVAL = args.interval != null ? Math.max(100, Number(args.interval) | 0) : null;

function records(s) {
  const out = [];
  for (const z of s.zones) {
    out.push({
      kind: "zone",
      chip: z.chip,
      sensor: z.sensor,
      temp_c: z.tempC,
      limit_c: z.critC ?? z.maxC ?? null,
      headroom_c: headroom(z),
      status: status(z),
      alarm: z.alarm,
    });
  }
  if (s.gpu) {
    out.push({
      kind: "gpu",
      name: s.gpu.name,
      temp_c: s.gpu.tempC,
      power_w: s.gpu.powerW,
      util_pct: s.gpu.utilPct,
    });
  }
  for (const c of s.clocks) {
    out.push({ kind: "clock", core: c.core, cur_ghz: c.curGHz, max_ghz: c.maxGHz });
  }
  return out;
}

async function emit() {
  const s = await sample();
  for (const rec of records(s)) console.log(JSON.stringify(rec));
}

await emit();
if (INTERVAL != null) {
  setInterval(emit, INTERVAL);
  await new Promise(() => {});
}
