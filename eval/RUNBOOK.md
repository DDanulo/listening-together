# Recording session runbook

One session of about **1.5–2 hours** produces the data for E1–E6. Follow it top to bottom; every run has a **label**, and the label is the recording's file name (`E1-delay150-r1.m4a`). Afterwards, put the recordings into `eval/recordings/` (git-ignored) and download the server's event log (see the end). The analysis does the rest.

---

## 0. Setup (15 min, once)

### What you need
- **2–3 devices under test** (A, B, optionally C), e.g. the Linux laptop, a phone, a second laptop or phone. The Linux laptop is the one that can run `netem`.
- **A recorder**: a phone that is *not* under test, with any voice-recorder app (m4a/AAC is fine: its encoder delay shifts the whole recording, not the devices against each other). Or a laptop with Audacity, if it's not a device under test.
- A quiet room. A towel or soft cloth to put the devices on (fewer reflections off the table).

### Placement
```
          A            B            C
           \           |           /
            \  20 cm   |  20 cm   /
                    [mic]
```
- Every device's speaker exactly **20 cm** from the recorder's microphone (measure it: 1 cm = 0.03 ms, 10 cm = 0.3 ms of fake sync error).
- Same volume on all devices, about 50–70 %. Do not move anything during a series of runs. If you must, note it.
- Phones: screen on (a locked screen can throttle the browser), do-not-disturb on, Wi-Fi as noted per run.

### The room and the track
1. Open the deployed app, create a room, note its id (e.g. `k3x9qa`). Use one room for the whole session.
2. Upload `eval/tracks/clicks-5min.flac` and `eval/tracks/clicks-30min.flac` (and, for E5, `clicks-mono-5min.flac`).
3. Each device opens the room with its own channel (and later the switches of the run):
   - A: `https://<host>/r/<room>?evalChannel=1`
   - B: `https://<host>/r/<room>?evalChannel=2`
   - C: `https://<host>/r/<room>?evalChannel=3`
4. Name each device after itself when joining (`A-laptop-chrome`, `B-pixel`, …): the names end up in the server log.
5. **Changing switches** = edit the URL and reload the page, then join again (same name). The playback keeps running on the server; the device rejoins it within a second or two.

### Calibration (2 min, once per placement)
Device A alone plays `?evalChannel=all` (the others muted or paused locally with volume 0) for **30 s** → label `CAL-A`. It measures the per-band bias of the speaker, microphone and detector; the analysis subtracts it.

### Smoke test before the real thing
Play the 5 min track on all devices for 30 s, record → label `DRY-r1`. Send it to Claude (or run step "Analysis" below) and check that every device's chirps are detected before investing an hour.

---

## Recording procedure (for every run)

1. Set the switches on all devices (URL + reload + join), wait until each shows **Synced: yes** in "Sync status".
2. Start playback (or let it continue), wait **10 s** (convergence), then **start the recorder**.
3. Record for the time given in the table (default **90 s**).
4. Stop the recorder, rename the file to the run's label.
5. Write anything unusual into the notes (a phone switched networks, someone talked, a notification sound).

---

## E1: network conditions (≈ 30 min)

Netem impairs the **Linux laptop (device A)** only; the others stay on normal Wi-Fi. That's the realistic case: one listener on a bad connection.

```bash
sudo eval/netem/netem.sh apply delay150 --server <server-ip>   # before the run
sudo eval/netem/netem.sh reset                                 # after the run (always!)
```
`--server` restricts the impairment to traffic to the app's server, so your other traffic stays normal. Get the IP with `getent hosts <host>`.

| Label | netem on A | Duration |
|---|---|---|
| `E1-delay0-r1`, `-r2` | `delay0` (none) | 90 s each |
| `E1-delay50-r1`, `-r2` | `delay50` (50 ms RTT added) | 90 s |
| `E1-delay150-r1`, `-r2` | `delay150` | 90 s |
| `E1-delay300-r1`, `-r2` | `delay300` | 90 s |
| `E1-jitter50-r1`, `-r2` | `jitter50` (±25 ms jitter) | 90 s |
| `E1-loss5-r1`, `-r2` | `loss5` (5 % loss) | 90 s |
| `E1-asym150-r1` | `asym-150` (150 ms one way only) | 90 s |
| `E1-naive-r1` | `delay150`, and **all devices** `&naive=1` | 90 s |

After applying a scenario, **reload A and rejoin**, so its clock sync starts fresh under the new conditions. The `naive` run is the "before" baseline: it ignores the scheduled start, like a "3, 2, 1, play" sync.

## E2: clock-sync strategies (≈ 15 min)

All devices use the same `clock=` value. Run it with `jitter50` on A: on a clean network all strategies look the same.

| Label | URL switch on all devices | netem on A | Duration |
|---|---|---|---|
| `E2-single-r1` | `&clock=single` | `jitter50` | 90 s |
| `E2-best-r1` | `&clock=best` | `jitter50` | 90 s |
| `E2-periodic-r1` | `&clock=periodic` (default) | `jitter50` | 90 s |
| `E2-regression-r1` | `&clock=regression` | `jitter50` | 90 s |

**Important:** for E2, also set `&drift=off`, or the drift correction hides the clock error.

## E3: drift and its correction (≈ 35 min, can overlap with breaks)

Play the **30 min track**, no netem. The server log records each device's own error every 2 s, so long runs need no recording of the whole duration: record only the **last 60 s** of each.

| Label | URL switch on all devices | Play for | Record |
|---|---|---|---|
| `E3-off-r1` | `&drift=off` | 15 min | last 60 s |
| `E3-resync-r1` | `&drift=resync` | 10 min | last 60 s |
| `E3-nudge-r1` | `&drift=nudge` (default) | 10 min | last 60 s |

Optional, to see a correction happen: during `E3-nudge-r1`, record 60 s while someone opens the browser console on A and runs `__session.debugShiftMs(-20)` only in a dev build; on the deployed app, instead start the recording right after a seek (all devices restart, then converge).

## E4: devices and outputs (≈ 15 min)

Same room, `delay0`, default switches. Change one thing per run, note what in the label.

| Label | Setup | Duration |
|---|---|---|
| `E4-chrome-firefox-r1` | Laptop A: Chrome `evalChannel=1` **and** Firefox `evalChannel=2` on the same laptop (two browsers, one speaker); other devices muted | 60 s |
| `E4-laptop-phone-r1` | A = laptop, B = phone (both speakers) | 60 s |
| `E4-bluetooth-r1` | B plays through Bluetooth earbuds/headphones held at the 20 cm mark instead of its speaker | 60 s |
| `E4-wired-r1` | B through wired headphones, same position | 60 s |
| `E4-safari-r1` | (if an iPhone/Mac is available) Safari as B | 60 s |

Note the "Output latency" each device shows in "Sync status": Bluetooth usually reports a part of its latency or none, which the run will show as a constant offset. Then:

| Label | Setup | Duration |
|---|---|---|
| `E4-bluetooth-comp-r1` | As `E4-bluetooth-r1`, with B's **Output delay** (under the player) set to the offset `E4-bluetooth-r1` measured (Claude tells you the number, or raise it by ear until the clicks merge) | 60 s |

Set the output delay back to 0 afterwards: it is remembered per device.

## E5: comparison with Beatsync (≈ 15 min)

Beatsync plays the same file on every device, so devices can't be told apart by channel: use **only two devices** (A, B) and the **mono** track. Analysis with `--mono-pair` (it measures |Δ| between the two arrivals, resolution 0.8 ms).

| Label | App | Duration |
|---|---|---|
| `E5-beatsync-r1`, `-r2` | Beatsync (its public site), both devices in one Beatsync room, `clicks-mono-5min.flac` uploaded there | 90 s each |
| `E5-ours-r1`, `-r2` | Our app, `clicks-mono-5min.flac`, **no** `evalChannel` | 90 s each |

Spotify Jam is not measured (it needs Premium); the report compares it qualitatively.

## E6: recovery after an outage (≈ 15 min)

5 min track, default switches. The recorder runs **through** the outage; mark the moment in the notes.

| Label | What happens | Record |
|---|---|---|
| `E6-outage10-r1` | at ~20 s into the recording: `sudo eval/netem/netem.sh outage 10 --server <ip>` on A | 90 s |
| `E6-outage30-r1` | same with `outage 30` | 120 s |
| `E6-switch-r1` | phone B: turn Wi-Fi off at ~20 s (falls back to mobile data), back on at ~60 s | 120 s |

The audio is local, so it should keep playing in sync through the outage; the server log shows when each device noticed and how long the outage was (`lastOutageMs`).

---

## After the session

1. Copy all recordings into `eval/recordings/` with their labels as names, plus a `notes.md` with your notes.
2. Download the server's event log of the session day (Claude can do this with the VM's SSH key if you allow it):
   ```bash
   scp -i keys/ssh-key-2026-11-04.key <user>@<vm>:<app-dir>/logs/events-<date>.jsonl eval/recordings/
   ```
3. Analysis (Claude runs this):
   ```bash
   eval/.venv/bin/python eval/analysis/clicks.py eval/recordings/E1-delay150-r1.m4a --channels 1,2 \
       --cal eval/recordings/CAL-A.m4a --csv eval/results/ticks.csv --summary eval/results/summary.csv
   eval/.venv/bin/python eval/analysis/server_log.py eval/recordings/events-*.jsonl --room <room> \
       --csv eval/results/stats.csv
   eval/.venv/bin/python eval/analysis/charts.py distribution eval/results/ticks.csv --experiment E1 \
       --out eval/results/E1.png
   ```
   (m4a and other formats: convert first with `ffmpeg -i in.m4a -ac 1 -ar 48000 out.wav`.)
