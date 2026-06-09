# heatsink

> **htop for your thermals.** Six columns, four colors, the number that actually predicts a throttle.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet-8A2BE2" alt="yeet">
  <a href="https://discord.gg/dYZu9PjKB"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

![heatsink demo](assets/heatsink.gif)

**heatsink is a live terminal dashboard that reads every hwmon sensor on a Linux box and shows each one's temperature, throttle limit, and headroom in a color-coded table, with GPU draw and per-core clock speeds below.**

> [!TIP]
> No kernel modules, no BPF. heatsink queries the kernel's hwmon sysfs tree directly through yeet's graph API, so the same one-liner runs on any Linux box that exposes `/sys/class/hwmon`.

## Quick start

```sh
curl -fsSL https://yeet.cx | sh
yeet run github:yeet-src/heatsink
```
[Manual install guide](https://yeet.cx/docs/installation) · Linux only

Sort by who's closest to throttling, or grab a single pipe-safe snapshot:

```sh
yeet run github:yeet-src/heatsink -- --sort head
yeet run github:yeet-src/heatsink -- --once | less -R
```

### Flags

**Live dashboard (`main.js`)**

- `--sort <temp|head|chip|name>` (default `temp`) — `temp`: hottest first; `head`: least throttle headroom first; `chip`: by chip then sensor; `name`: by sensor name.
- `--interval <ms>` (default `1000`, floored at `100`) — live refresh period.
- `--secs <n>` — exit after n seconds (default: run until Ctrl-C).
- `--once` — render a single snapshot and exit (automatic when output is piped).

**JSON stream (`dump.js`)**

```sh
yeet run github:yeet-src/heatsink/dump.js
```

- `--interval <ms>` — stream a record set every interval (default: emit one snapshot, then exit).

## A 60-second primer on hwmon and throttle headroom

The Linux kernel exposes hardware sensors through the `hwmon` subsystem. Each sensor chip (a CPU temperature controller, an NVMe drive, a voltage regulator) registers under `/sys/class/hwmon/hwmonN/` and publishes temperature readings in millidegrees Celsius, along with optional `_max` and `_crit` thresholds the chip's firmware considers dangerous.

**Throttle headroom** is the gap between the current reading and that threshold. A CPU package 8°C under its `crit` limit is about to throttle; the same chip at 40°C under is fine. The raw temperature tells you where you are; the headroom tells you how much margin you have. heatsink surfaces both, and colors the row to match.

**Per-core clock speed** comes from `cpufreq` (`scaling_cur_freq`). When a core is running flat-out, it boosts to its maximum clock; when the chip is power- or thermally-limited, the clocks back off. The CLOCKS grid shows that spread core-by-core.

**GPU data** (temperature, power draw, utilization) comes from NVIDIA's management layer, not hwmon. It appears in a separate panel below the thermal table when a device is present.

## Common use cases

Mostly sysadmins and developers who want to know why a box is slow or loud, without ssh-ing into a stats stack.

- Fan is screaming. What's actually hot right now?
- Compile job is slower than expected. Are the cores throttling?
- New server arrived. What sensors does this board actually expose?
- GPU training run. Is the card power-limited or thermally-limited?

## What you're looking at

**Header line:** box uptime, 1/5/15-minute load average, core count, and the single hottest sensor highlighted in its severity color. The current time sits at the right edge.

**THERMAL table:** one row per hwmon sensor that reports a reading. Columns, left to right:

- `CHIP`: the hwmon chip label (e.g. `k10temp`, `nvme`, `gigabyte_wmi`). This is the hardware source.
- `SENSOR`: the specific input within that chip (e.g. `Tctl`, `Composite`, `cpu_fan`).
- `TEMP`: current reading in °C. Color reflects severity: green (ok), yellow (warm), orange (hot), red (crit).
- Gauge: a filled bar from a 30°C floor to the chip's limit (or 90°C when none is published). Width adapts to terminal width.
- `LIMIT`: the crit or max threshold the chip published, in °C. A dash means the driver exposes no threshold for this sensor.
- `HEAD`: degrees of headroom to that limit. This is the number to watch. A dash means no threshold.
- `STATE`: the severity word. `crit` fires when the driver raises an alarm bit or headroom drops to 5°C or below; `hot` at 15°C; `warm` at 30°C. Sensors with no threshold fall back to absolute temperature bands.

When the terminal is too narrow to hold all columns, lower-priority columns drop first. The gauge is flexible and takes whatever space remains, down to its minimum width.

**GPU panel:** appears when an NVIDIA device is detected. Shows the device name, temperature, power draw in watts, and a utilization gauge.

**CLOCKS grid:** one cell per CPU core: label, a block character scaled to current-vs-max ratio, and the current frequency in GHz. A core running at full boost fills the block and turns yellow-green; a throttled or parked core shows a shorter block in blue.

## How it works

**JS side (the whole thing).** heatsink is pure JavaScript with no compiled components.

- `main.js` (entrypoint): terminal management, the render loop, and screen layout. Detects whether stdout is a PTY; if not, it falls back to a single snapshot automatically. Handles column dropping when the terminal is too narrow and clips colored lines to the visible width without breaking ANSI escape sequences. Flags: `--sort`, `--interval`, `--secs`, `--once`.
- `data.js`: one `yeet.graph.query()` call per refresh, covering `hwmons`, `cpu.cores.cpufreq`, `nvidia`, `load_average`, and `host.uptime`. Converts millidegrees to °C, milliwatts to W, and kHz to GHz. Computes headroom and sensor severity (`ok` / `warm` / `hot` / `crit`). Shared by both `main.js` and `dump.js`.
- `dump.js`: alternate entrypoint. Emits the same sample as newline-delimited JSON, one record per line, tagged by `kind` (`zone`, `gpu`, `clock`). Pipe to `jq` to filter or stream into other tools. Accepts `--interval` to stream continuously.
- `demo.sh`: spins up one CPU busy-loop per core to force clock boost and temperature climb, then launches the dashboard. Override the worker count with `LOAD=N`.

**Data flow.** Each refresh: `data.js` queries yeet's graph layer, which reads the relevant sysfs paths and NVIDIA management interfaces. The result is a plain JS object (zones, clocks, GPU, load, uptime). `main.js` sorts and renders it to the terminal in one write per frame, using the alternate screen buffer and cursor positioning to avoid flicker.

## Requirements

> [!IMPORTANT]
> yeet itself is the only hard requirement. The hwmon subsystem is present on all mainstream Linux distributions by default; no special kernel config is needed. NVIDIA GPU data requires the NVIDIA driver to be loaded. Per-core clock data requires the `cpufreq` subsystem, which is enabled by default on most x86 and ARM systems.

- The yeet daemon, which handles process sandboxing and the graph API. `curl -fsSL https://yeet.cx | sh` installs it.

## Honest caveats

> [!NOTE]
> What heatsink doesn't do, and where it gets things wrong.

- Every reading is an instantaneous snapshot. There are no counters, no rate calculations, no min/max history. A brief throttle event between refreshes is invisible.
- hwmon coverage depends entirely on what drivers are loaded on the box. A board probe that the kernel driver never fills shows no input and is silently dropped. What you see is what the kernel exposes; sensors the driver doesn't publish are absent with no indication.
- Sensor names (`Tctl`, `Tdie`, `Composite`) are driver-defined and vary by hardware. The `CHIP` and `SENSOR` columns show raw driver strings; there is no normalization or aliasing across machines.
- GPU support covers NVIDIA only, via the device's management interface. AMD and Intel GPUs may surface a temperature through hwmon (when their driver publishes one) but do not appear in the dedicated GPU panel with power and utilization data.
- The severity thresholds (`crit` ≤ 5°C headroom, `hot` ≤ 15°C, `warm` ≤ 30°C) are fixed in code. They are not configurable. Sensors that publish no `crit` or `max` value use absolute temperature bands (85°C / 70°C / 55°C) that may not match the actual hardware limit.
- Headroom calculations use whichever of `crit` or `max` the driver publishes. Some drivers publish both with different meanings; heatsink prefers `crit` when present.

## Community questions

**1. Why are some sensors missing a HEAD / LIMIT value?**
Not all hwmon drivers publish a `crit` or `max` threshold. When the driver exposes no threshold for a sensor, heatsink has no limit to measure against, so HEAD and LIMIT both show a dash. Severity for those rows falls back to absolute temperature bands.

**2. Will this affect my system's performance or thermals?**
One sysfs round-trip per second at default settings. The read load is negligible. `demo.sh` does spin up CPU workers intentionally to generate heat for demonstration; that's opt-in and stops when you Ctrl-C.

**3. Why don't I see my GPU / some sensors?**
hwmon reports only what the loaded kernel drivers publish. If a sensor chip has no driver, or the driver doesn't populate a given input, the reading is absent. NVIDIA GPU data specifically requires the proprietary NVIDIA driver. On AMD systems, GPU temperature may appear as an hwmon zone (`amdgpu`) but the dedicated GPU panel (with power and utilization) will be empty.

**4. Is this safe to run on shared or production infrastructure?**
heatsink reads sensor data only; it writes nothing to the system. It does not attach to other processes, does not trace network traffic, and does not modify kernel state. Running it on a production box is equivalent to running `cat /sys/class/hwmon/hwmon0/temp1_input` in a loop.

**5. How is this different from `sensors` (lm-sensors) or `psensor`?**
`sensors` (the lm-sensors CLI) also reads hwmon, but it prints a one-shot human-readable dump with no headroom calculation, no sort order, no GPU panel, and no clock spread. `psensor` is a GUI application. heatsink is a live terminal dashboard that adds the headroom column (the number that predicts throttling), per-core clock visualization, and pipe-friendly JSON output via `dump.js`, all in a single `yeet run` without installation.

## License

heatsink is pure JavaScript and currently ships without a dedicated license file in this repository.

---

Built with [yeet](https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=heatsink), a JS runtime for writing eBPF programs on Linux machines. Join us on [discord](https://discord.gg/dYZu9PjKB?utm_source=github&utm_medium=readme&utm_campaign=heatsink).
