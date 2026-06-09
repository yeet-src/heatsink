/* heatsink data layer — one sysgraph round-trip per sample, normalized into
 * plain numbers in display units (°C, W, GHz). Nothing here knows about
 * colors, columns, or terminals; main.js and dump.js share it. */

const QUERY = `{
  host { uptime { uptime } }
  load_average { one five fifteen }
  cpu {
    num_cores
    cores {
      core_num
      cpufreq { scaling_cur_freq scaling_max_freq scaling_min_freq }
    }
  }
  hwmons {
    name
    label
    temps { name input max crit max_alarm crit_alarm }
  }
  nvidia {
    count
    devices {
      name
      temperature
      power_usage
      utilization_rates { gpu }
    }
  }
}`;

/* hwmon temperatures arrive in millidegrees and GPU power in milliwatts;
 * cpufreq is in kHz. */
const MILLI = 1000;
const KHZ_PER_GHZ = 1e6;

const celsius = (milli) => (milli == null ? null : milli / MILLI);
const ghz = (khz) => (khz == null ? null : khz / KHZ_PER_GHZ);

function zonesFrom(hwmons) {
  const zones = [];
  for (const h of hwmons || []) {
    const chip = h.label || h.name;
    for (const t of h.temps || []) {
      /* A sensor with no `input` is a stub the driver exposes but never
       * fills (common on board probes) — drop it rather than chart a blank. */
      if (t.input == null) continue;
      zones.push({
        chip,
        sensor: t.name,
        tempC: celsius(t.input),
        critC: celsius(t.crit),
        maxC: celsius(t.max),
        alarm: !!(t.crit_alarm || t.max_alarm),
      });
    }
  }
  return zones;
}

function clocksFrom(cpu) {
  return (cpu?.cores || []).map((c) => ({
    core: c.core_num,
    curGHz: ghz(c.cpufreq?.scaling_cur_freq),
    maxGHz: ghz(c.cpufreq?.scaling_max_freq),
    minGHz: ghz(c.cpufreq?.scaling_min_freq),
  }));
}

function gpuFrom(nvidia) {
  const dev = nvidia && nvidia.count > 0 ? (nvidia.devices || [])[0] : null;
  if (!dev) return null;
  return {
    name: dev.name,
    tempC: dev.temperature,
    powerW: dev.power_usage / MILLI,
    utilPct: dev.utilization_rates?.gpu ?? null,
  };
}

export async function sample() {
  const res = await yeet.graph.query(QUERY);
  const d = (res && res.data) || {};
  return {
    uptimeSecs: d.host?.uptime?.uptime ?? null,
    load: {
      one: d.load_average?.one ?? null,
      five: d.load_average?.five ?? null,
      fifteen: d.load_average?.fifteen ?? null,
    },
    cores: d.cpu?.num_cores ?? (d.cpu?.cores || []).length,
    zones: zonesFrom(d.hwmons),
    clocks: clocksFrom(d.cpu),
    gpu: gpuFrom(d.nvidia),
  };
}

/* Headroom to the manufacturer limit, in °C — the number that actually
 * predicts a throttle. `null` when the sensor exposes no crit/max. */
export function headroom(zone) {
  const limit = zone.critC ?? zone.maxC;
  return limit == null ? null : limit - zone.tempC;
}

/* Severity with no color attached. Prefer headroom to the limit; fall back
 * to absolute temperature for the ambient/board probes that ship no
 * threshold. main.js maps these levels to a palette, dump.js emits them. */
export function status(zone) {
  if (zone.alarm) return "crit";

  const head = headroom(zone);
  if (head != null) {
    if (head <= 5) return "crit";
    if (head <= 15) return "hot";
    if (head <= 30) return "warm";
    return "ok";
  }

  if (zone.tempC >= 85) return "crit";
  if (zone.tempC >= 70) return "hot";
  if (zone.tempC >= 55) return "warm";
  return "ok";
}
