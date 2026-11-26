# Evaluation results — recording session 2026-11-26

One session of about 3.5 hours that produced data for every experiment of [`eval/RUNBOOK.md`](../RUNBOOK.md)
(E1–E6) and for the PoC audio metrics A3/A4 (`docs/poc/05-acceptance.md`). This file describes what was done, how,
what deviated from the runbook, and what every file in `eval/results/` and `eval/recordings/2026-11-26/` is.

**Headline:** with normal network conditions two laptops play within **1–2 ms** of each other (median |Δ|), and
within a few ms after pause, seek, skip and a late join. Network delay up to 350 ms RTT and 5 % loss keep the
median below 8 ms. A network outage of 30 s or a Wi-Fi → hotspot switch does not disturb sync. The large errors all
come from things the clock sync cannot see: one-way (asymmetric) delay (78 ms), output latency that the browser does
not report (94 ms on one laptop, ~170 ms with Bluetooth), and the naive "play on arrival" baseline (198 ms).

## Contents

- [Setup](#setup)
- [Method](#method)
- [Deviations from the runbook](#deviations-from-the-runbook)
- [Results](#results): [Calibration](#calibration-and-dry-runs) · [A3](#a3-commands) · [E1](#e1-network-conditions) ·
  [E2](#e2-clock-sync-strategies) · [E3](#e3-drift-and-its-correction) · [E4](#e4-devices-and-outputs) ·
  [E5](#e5-comparison-with-beatsync) · [E6](#e6-recovery-after-an-outage)
- [Findings and follow-ups](#findings-and-follow-ups)
- [Files](#files)
- [Reproducing the analysis](#reproducing-the-analysis)

## Setup

| | |
|---|---|
| Server | Deployed app, `listening-together.duckdns.org` (92.5.45.36, Oracle Cloud), one room (`xjtrne`) for the whole session |
| Laptop A | Windows + WSL2. Brave (Chromium 158), separate profile, `evalChannel=1`, home Wi-Fi. Network impairment ran here (clumsy) |
| Laptop B | Windows. Chrome 158, `evalChannel=2`, home Wi-Fi (hotspot only in E6-switch) |
| Recorder | Phone voice recorder (AAC, 48 kHz), not a device under test, both laptop speakers 20 cm from its microphone |
| Track | `eval/tracks/clicks-5min.flac` (E1, E2, A3, E4, E6), `clicks-30min.flac` (E3), `clicks-mono-5min.flac` (E5) |
| Base RTT | 22–24 ms from both laptops (sync panel "Best RTT") |

### Output latency of laptop A (important for every result)

The first dry runs showed laptop A playing **94 ms after** laptop B, constantly (std < 0.3 ms), with no network
impairment and no audio enhancements enabled. Both laptops' browsers reported a similar `outputLatency` (40–48 ms,
`outputTimestamp`), so ~94 ms of laptop A's output path is invisible to the browser and the app cannot compensate it.

All runs from DRY-r6 on use the app's manual **Output delay = 94 ms on laptop A** (the setting tells the app that the
device sounds that much later, so it plays that much earlier). DRY-r6 confirmed the compensation (+0.35 ms). Two runs
deliberately leave it at 0: `E5-ours-nocomp-r1` and the naive baseline (naive mode ignores it, see E1).

### Automation

The runs were driven by scripts from laptop A, so both laptops changed settings and played in the same way every time:

- the Brave window on A and the Chrome window on B ran with a remote-debugging port and were controlled with
  Playwright (B through a port proxy on the LAN, reachable only from A); the scripts opened the room URL with the run's
  switches, joined, pressed Play/Pause/Seek/Skip and read the sync panel;
- clumsy (network impairment, see below) was restarted with the run's settings before every run, and every page
  was reloaded *after* that, so the clock sync of each run started under its network conditions;
- every run was logged as JSON lines (`play`, `window`, `end` with wall-clock times and the sync panel values of both
  laptops): [`eval/recordings/2026-11-26/run-logs/`](../recordings/2026-11-26/run-logs/).

Every run: reload both pages (fresh join) → seek to 0 → Play → **10 s convergence** → **measured window** (90 s, or as
noted) → Pause → ≥ 8 s of silence (the marker used to cut the long recordings).

## Method

**Audio sync error.** Each laptop plays its own channel of the click track, so its chirps sit in its own frequency
band; `eval/analysis/clicks.py` detects every chirp per band in the phone recording and reports, per tick,
**Δ = t(B) − t(A)** (positive: laptop B later), after subtracting the per-band bias measured in the calibration
recording. Tables give the mean of Δ (with sign: which laptop was ahead) and median / p95 / max of |Δ|, outliers
removed by `clicks.py` (a tick > 15 ms from its neighbours' median).

**Cutting.** Several runs share one phone recording. The playback regions in the recording (sound after silence)
were matched to the `play` events of the run log (a constant offset fitted over all runs, every run matched within
1 s), and each run's measured window was cut out minus 1 s at each end. Those cut windows are the files in
`eval/recordings/2026-11-26/` and exactly what was analysed.

**E5 (mono track).** Beatsync plays the same file on every device, so the devices cannot be told apart by band.
`clicks.py --mono-pair` turned out not to work for this (see [Findings](#findings-and-follow-ups)); E5 was measured
with a two-source fit instead: in `E5-ours-nocomp-r1` the two laptops' chirps arrive 94 ms apart, so each laptop's
response (its speaker plus the room, after the matched filter) can be learned separately. Every tick of every E5 run
is then fitted as the sum of both responses with independent arrival times (least squares, 0.01 ms grid), in bands
1 and 2 (band 3 has a constant artefact), and a tick is kept only if both bands agree within 1 ms. On synthetic
mixtures of held-out ticks with known offsets (0–10 ms, both signs) the fit recovers the offset with p95 error
0.04 ms. Δ has the same sign convention as the other experiments.

## Deviations from the runbook

| Runbook | Here | Consequence |
|---|---|---|
| `netem` on a Linux laptop | **clumsy 0.3** (WinDivert) on Windows laptop A, filter `ip.DstAddr == 92.5.45.36 or ip.SrcAddr == 92.5.45.36` | clumsy's lag overshoots its setting; conditions are given as the **measured RTT** of laptop A, not by scenario name |
| `jitter50` (E1, E2) | not possible: clumsy has no random delay | no jitter run in E1; E2 ran under `loss5` instead (TCP retransmissions delay some pings) |
| 3 devices, phone among them | 2 laptops; the only phone was the recorder | no A5 (3 devices), no E4-laptop-phone, no Safari, no A4 on mobile data |
| E4-wired | not run (no wired headphones or speaker) | |
| E4-bluetooth: headphones | a Bluetooth speaker at the 20 cm mark | same latency path |
| E1-naive: default switches | `naive=1&drift=off` | see [E1](#e1-network-conditions): naive mode with drift correction restarts on every resync |
| E3-off 15 min, resync/nudge 10 min | 15.8 / 10.4 / 10.4 min | |
| Server event log | not downloaded (no SSH key at hand) | per-device sync values come from the sync panel, logged by the session scripts |

## Results

### Calibration and dry runs

| Run | What | Δ mean | Note |
|---|---|---|---|
| CAL-A | laptop A alone, `evalChannel=all` | — | band bias: band 2 −0.91 ms vs band 1 (subtracted everywhere) |
| DRY-r1 | first try, Output delay 0 | −98.1 ms | A later |
| DRY-r2 | **invalid**: no `evalChannel` on either laptop, both played channels 1+2 | (+1.5 ms) | every chirp audible twice, 110 ms apart |
| DRY-r3 | clean, Output delay 0 | −94.3 ms | A later: unreported output latency |
| DRY-r4 | new automated Brave window on A | −93.9 ms | same |
| DRY-r5 | Output delay 94 set on **B** by mistake | −190.2 ms | the setting advances a device, so B moved further ahead |
| DRY-r6 | Output delay 94 on A | **+0.35 ms** | compensation confirmed (max 1.0 ms) |
| DRY-r7 | new automated Chrome window on B | +0.07 ms | still right |

### A3: commands

No impairment. A3 threshold (PoC): median ≤ 20 ms, max ≤ 40 ms. Window 43 s from 5 s after the command
(E1-delay0: 88 s).

| Run | Command | n | Δ mean | median \|Δ\| | p95 \|Δ\| | max \|Δ\| |
|---|---|---|---|---|---|---|
| E1-delay0-r1 | none (plain playback) | 87 | +1.41 | 1.33 | 2.36 | 2.48 |
| E1-delay0-r2 | none | 88 | −1.50 | 1.50 | 2.71 | 2.86 |
| A3-pause-r1 | pause 3 s, resume | 43 | +2.16 | 2.15 | 2.74 | 2.82 |
| A3-seek-r1 | seek to 2:00 | 43 | +4.79 | 4.81 | 5.27 | 5.33 |
| A3-skip-r1 | skip to the next track (clicks-30min) | 43 | +2.03 | 2.00 | 2.65 | 2.72 |
| A3-latejoin-r1 | laptop A reloads and rejoins mid-track | 43 | −0.47 | 0.46 | 1.07 | 1.14 |

All in ms. **A3 passes** by a factor of ~10. A4 (different networks) was not measured as specified (no phone under
test); E6-switch (B on a phone hotspot for 40 s) is the closest substitute.

### E1: network conditions

Impairment on laptop A only; laptop B on plain Wi-Fi. "Best RTT" is laptop A's sync panel at the start and end of
the run.

| Run | clumsy on A | Best RTT A | n | Δ mean | median \|Δ\| | p95 \|Δ\| | max \|Δ\| |
|---|---|---|---|---|---|---|---|
| E1-delay0-r1 | off | 22–24 | 87 | +1.41 | 1.33 | 2.36 | 2.48 |
| E1-delay0-r2 | off | 22–24 | 88 | −1.50 | 1.50 | 2.71 | 2.86 |
| E1-delay50-r1 | Lag 25 in+out | 96–122 | 88 | −1.69 | 1.22 | 7.96 | 8.70 |
| E1-delay50-r2 | Lag 25 in+out | 95–111 | 88 | −4.18 | 4.80 | 9.25 | 9.39 |
| E1-delay150-r1 | Lag 75 in+out | 183–195 | 88 | −3.06 | 4.02 | 6.37 | 7.11 |
| E1-delay150-r2 | Lag 75 in+out | 187–193 | 88 | −0.91 | 1.97 | 4.07 | 4.22 |
| E1-delay300-r1 | Lag 150 in+out | 349–362 | 87 | −9.98 | 7.84 | 16.86 | 17.01 |
| E1-delay300-r2 | Lag 150 in+out | 345–361 | 88 | −6.46 | 6.96 | 12.89 | 13.03 |
| E1-loss5-r1 | Lag 25 + Drop 5 % in+out | 106–110 | 88 | +1.52 | 2.48 | 3.25 | 14.08 |
| E1-loss5-r2 | Lag 25 + Drop 5 % in+out | 101–107 | 88 | +2.99 | 5.85 | 13.68 | 13.82 |
| E1-asym150-r1 | Lag 150 **outbound only** | 183–196 | 87 | **+78.46** | 78.21 | 81.37 | 81.47 |
| E1-naive-r2 | Lag 75 in+out, both `naive=1&drift=off` | 185–209 | 88 | **−198.01** | 198.01 | 199.33 | 207.83 |

All times in ms. Chart: [`E1.png`](E1.png).

- **Symmetric delay** degrades sync slowly: median |Δ| 1.4 ms → 2–5 ms at 100–190 ms RTT → 7–8 ms at 350 ms RTT,
  max 17 ms. The A6 criterion (A3 thresholds under impairment) holds for every symmetric-delay and loss run.
- **Loss** adds occasional jumps (single ticks up to 14 ms) while the median stays at 2.5–6 ms.
- **Asymmetric delay** shifts laptop A by **78 ms**, about half of the added one-way delay (RTT +160 ms). This is
  the expected limit of NTP-style sync, which assumes equal delays both ways. A's own sync panel showed a position
  error of only 3.8 ms: the error is in the clock estimate itself, so the client cannot see it.
- **Naive baseline** (play when the message arrives, as with "3, 2, 1, play"): **198 ms**, B ahead. About 100 ms is
  the longer path of the command to A; the other ~94 ms is A's output latency: naive mode plays on arrival, so the
  manual Output delay has no effect. Under the same network condition the synchronised app gives 2–4 ms
  (E1-delay150): **50–100× better**.
- Two earlier naive attempts are invalid and only kept for the record (`invalid/`): a script error left laptop A on
  its previous page (wrong switches, clock sync from before clumsy started). r1 gave B 325 ms later, attempt 1 of
  r2 B 2.59 s ahead. Both show the naive + resync effect described in [Findings](#findings-and-follow-ups).

### E2: clock-sync strategies

Both laptops `clock=<strategy>&drift=off` (drift correction would hide clock errors); clumsy `loss5` on A (RTT
81–113 ms) as a stand-in for jitter.

| Run | Strategy | n | Δ mean | median \|Δ\| | p95 \|Δ\| | max \|Δ\| |
|---|---|---|---|---|---|---|
| E2-single-loss5-r1 | `single` (first sample only) | 88 | −7.54 | **7.86** | 8.68 | 8.84 |
| E2-best-loss5-r1 | `best` (lowest-RTT sample of a burst) | 85 | +3.82 | 3.85 | 5.05 | 5.18 |
| E2-periodic-loss5-r1 | `periodic` (default: best + periodic re-sync) | 88 | −2.60 | **2.58** | 3.84 | 3.98 |
| E2-regression-loss5-r1 | `regression` | 88 | −3.60 | 3.58 | 4.82 | 4.97 |

Chart: [`E2.png`](E2.png). A single sample is clearly worst (8 ms); filtering several samples halves to thirds the
error; the default `periodic` is best. One run per strategy and no real jitter: the ~1 ms differences between
`best`, `periodic` and `regression` are not significant.

### E3: drift and its correction

`clicks-30min.flac`, no impairment, both laptops `drift=<strategy>`; the window is the **last 60 s** before the
stated play time.

| Run | Drift correction | Played | n | Δ mean | median \|Δ\| | p95 \|Δ\| | max \|Δ\| | Sync panel at the end (A / B) |
|---|---|---|---|---|---|---|---|---|
| E3-off-r1 | `off` | 15.8 min | 58 | −26.89 | **26.86** | 28.05 | 28.28 | +17.9 / −16.1 ms, 0 resyncs |
| E3-resync-r1 | `resync` | 10.4 min | 56 | −16.61 | **16.62** | 17.56 | 17.71 | +12.5 / −10.7 ms, **0 resyncs** |
| E3-nudge-r1 | `nudge` (default) | 10.4 min | 58 | −0.71 | **0.91** | 2.25 | 10.36 | +2.3 / −1.7 ms, 0 resyncs |

Chart: [`E3.png`](E3.png).

- Without correction the laptops drift apart at **~1.7 ms/min** (~28 ppm between their audio clocks), in opposite
  directions relative to the server timeline.
- **Nudging keeps them within ~1 ms** after 10 min (two single ticks around 10 ms).
- **Hard resync never fired**: `RESYNC_THRESHOLD_MS` = 20 ms is per device, and each laptop's own error stayed at
  11–13 ms, while the audible error between them was already 16.6 ms. Between two devices drifting in opposite
  directions the audible error can reach ~40 ms before either resyncs.

### E4: devices and outputs

Default switches, no impairment, 60 s windows.

| Run | Setup | n | Δ mean | median \|Δ\| | p95 \|Δ\| | max \|Δ\| | Reported outputLatency |
|---|---|---|---|---|---|---|---|
| E4-brave-firefox-r1 | laptop A: Brave = ch1, **Firefox** = ch2, both Output delay 94; B out of the room | 36 | **+35.52** | 35.51 | 38.44 | 38.46 | — |
| E4-bluetooth-r1 | B through a **Bluetooth speaker** at the 20 cm mark, Output delay 0 | 58 | **+222.77** | 217.04 | 241.39 | 241.72 | B: 56 ms |
| E4-bluetooth-comp-r1 | same, Output delay **223 ms** on B | 58 | −11.77 | 13.79 | 22.41 | 28.12 | B: 72 ms |

Chart: [`E4.png`](E4.png). In E4-brave-firefox, Δ is Firefox − Brave on the same laptop and speaker.

- **Firefox plays 35.5 ms later than Brave** on the same hardware with the same settings: the browsers report the
  output latency differently.
- **Bluetooth adds ~223 ms**, of which the browser reports only 56 ms, and it **varies** (std 12 ms, against < 1 ms on
  built-in speakers). A manual Output delay brings it to 12 ms mean / 28 ms max; the reported latency had changed by
  16 ms between the two runs, which explains the overcompensation.
- The recording of E4-brave-firefox started late: 36 s window instead of 58 s.

### E5: comparison with Beatsync

`clicks-mono-5min.flac` on both laptops, measured with the two-source fit ([Method](#method)). Beatsync: public
room on beatsync.gg created by laptop A, joined by B, file uploaded there, no use of Beatsync's manual offset.

| Run | App | Output delay A | n | Δ mean | std | median \|Δ\| | p95 \|Δ\| | max \|Δ\| |
|---|---|---|---|---|---|---|---|---|
| E5-beatsync-r1 | Beatsync | — | 79 | −95.51 | 0.78 | 95.50 | 96.70 | 96.82 |
| E5-beatsync-r2 | Beatsync | — | 79 | −95.92 | 0.80 | 95.92 | 97.15 | 97.28 |
| E5-ours-nocomp-r1 | ours | 0 | 78 | −93.75 | 0.80 | 93.75 | 94.97 | 95.09 |
| E5-ours-r1 | ours | 94 ms | 75 | **+0.61** | 0.63 | **0.66** | 1.54 | **1.66** |

Chart: [`E5.png`](E5.png).

- **Without manual compensation both apps are equivalent**: laptop A 94–96 ms late in both, with the same 0.8 ms
  spread. The network part of sync is as good in both; the error is A's unreported output latency.
- With its Output delay our app gets to **0.7 ms median, 1.7 ms max**. Beatsync also offers a manual offset, which
  was not tried, so this is not a claim that Beatsync can't do the same.
- Spotify Jam: not measured (qualitative comparison only, as planned).

### E6: recovery after an outage

Default switches, 5 min track.

| Run | Event | n | Δ mean | median \|Δ\| | p95 \|Δ\| | max \|Δ\| | Client side |
|---|---|---|---|---|---|---|---|
| E6-outage10-r1 | clumsy Drop 100 % on A for 10 s, 20 s into the window | 88 | −1.68 | 1.54 | 4.23 | 4.38 | no reconnect (liveness timeout 8 s + ping interval 5 s) |
| E6-outage30-r1 | same for 30 s | 118 | −0.18 | 0.65 | 1.32 | 1.46 | A reconnected once, outage 35.4 s |
| E6-switch-r1 | B: home Wi-Fi → phone hotspot at track 0:30, back at 1:10 | 115 | +0.01 | 0.39 | 2.63 | 4.14 | B reconnected 3 times, last outage 5.5 s |

Chart (error over time): [`E6.png`](E6.png). Playback continued through every outage and network switch without a gap
in the recording (every tick detected) or loss of sync; the slow slope in the outage runs is the audio-clock drift, corrected by nudging.

## Findings and follow-ups

1. **Unreported output latency is the largest error source.** Laptop A: 94 ms invisible to the browser; Bluetooth:
   ~170 ms invisible and variable; Firefox vs Chromium on one laptop: 35 ms. The manual Output delay removes a
   constant offset; something like a per-device acoustic calibration would be needed to do it automatically.
2. **Naive mode restarts on resync** (`client/src/session/session.ts`, `applyPlayback`): it replaces `effectiveAt`
   by "now" on every apply, so a drift resync restarts the track at the original position from the moment of the
   resync (observed +325 ms and −2.59 s). The naive baseline only works with `drift=off`; the runbook should say so,
   or naive mode should keep the arrival time of each `rev`.
3. **Resync threshold is per device** (`RESYNC_THRESHOLD_MS` = 20 ms in `client/src/sync/drift.ts`): two devices
   drifting in opposite directions can be ~40 ms apart before either corrects. Nudging (default) does not have this
   problem.
4. **`clicks.py --mono-pair` does not work for E5**: it searches ±60 ms and takes the strongest peak ≥ 0.8 ms away as
   the second device, which is a side lobe of the same chirp ~1.2 ms away (every E5 run gave 1.23 ms), and it misses
   offsets above 60 ms. The two-source fit used here should replace it.
5. **Asymmetric delay** gives the expected half-asymmetry error (78 ms) that clients cannot detect; worth a sentence
   in the report's limitations.

## Files

### `eval/results/`

| File | Contents |
|---|---|
| `README.md` | this document |
| `ticks.csv` | one row per tick and run: `label`, `channel` (2 = laptop B against laptop A), `time_s` (in the cut window), `delta_ms` (B − A), `outlier` (1 = left out) |
| `summary.csv` | one row per run from `clicks.py` (`mean_ms`, `std_ms`, `mean_abs_ms`, `p95_abs_ms`, `max_abs_ms`, `outliers`); E5 rows from the two-source fit (`device` = `B-A (mono fit)`) |
| `overview.csv` | one row per run, recomputed from `ticks.csv` without outliers: `n`, `mean_ms`, `std_ms`, `median_abs_ms`, `p95_abs_ms`, `max_abs_ms` (the numbers in the tables above) |
| `E1.png` | E1 distribution of \|Δ\| per condition (delay0, 50, 150, 300, loss5, asym150, naive) |
| `E2.png` | E2 per clock strategy |
| `E3.png` | E3 per drift strategy |
| `E4.png` | E4: Firefox vs Brave, Bluetooth, Bluetooth compensated |
| `E5.png` | E5: Beatsync, ours without and with compensation |
| `E6.png` | E6: Δ over time through the outages and the network switch |

### `eval/recordings/2026-11-26/`

FLAC, 48 kHz mono 16-bit, lossless copies of exactly the audio that was analysed: the measured windows (silence,
convergence time and the time between runs removed). The long continuous phone recordings are not kept.

| Folder | Files |
|---|---|
| `calibration/` | `CAL-A.flac`: laptop A alone with all channels (band bias) |
| `dry-runs/` | `DRY-r1` … `DRY-r7` (whole dry runs, see [Calibration](#calibration-and-dry-runs); DRY-r2 is invalid) |
| `A3/` | `A3-pause-r1`, `A3-seek-r1`, `A3-skip-r1`, `A3-latejoin-r1` |
| `E1/` | `E1-delay0-r1/r2`, `E1-delay50-r1/r2`, `E1-delay150-r1/r2`, `E1-delay300-r1/r2`, `E1-loss5-r1/r2`, `E1-asym150-r1`, `E1-naive-r2` |
| `E2/` | `E2-single-loss5-r1`, `E2-best-loss5-r1`, `E2-periodic-loss5-r1`, `E2-regression-loss5-r1` |
| `E3/` | `E3-off-r1`, `E3-resync-r1`, `E3-nudge-r1` (last 60 s each) |
| `E4/` | `E4-brave-firefox-r1`, `E4-bluetooth-r1`, `E4-bluetooth-comp-r1` |
| `E5/` | `E5-beatsync-r1/r2`, `E5-ours-nocomp-r1`, `E5-ours-r1` (mono track: no `--channels` analysis) |
| `E6/` | `E6-outage10-r1`, `E6-outage30-r1`, `E6-switch-r1` |
| `invalid/` | `E1-naive-r1`, `E1-naive-r2-attempt1`: not used in the results (see E1) |
| `run-logs/` | the session scripts' JSON-lines logs, numbered in session order (below) |

| Log | Runs | Recording |
|---|---|---|
| `1-E1-A3-E6-auto.jsonl` | E1-delay0 … E1-asym150, A3-*, E6-outage10/30 (19:31–20:09) | one 41 min recording |
| `invalid-E1-naive-r1.jsonl`, `invalid-E1-naive-r2-attempt1.jsonl` | the invalid naive attempts | one each |
| `2-DRY-r7-E2-E3.jsonl` | a valid E1-naive-r2 at 20:36 that was **not recorded**, DRY-r7, E2-*, E3-* | one 50 min recording, starting 20:42:46 |
| `3-E1-naive-r2.jsonl` | E1-naive-r2 (the one in the results) | |
| `4-E4-brave-firefox.jsonl`, `5-E4-bluetooth.jsonl`, `6-E4-bluetooth-comp.jsonl` | E4 runs | one each |
| `7-E5.jsonl` | E5 runs (Beatsync runs have no sync-panel values) | one 9 min recording |
| `8-E6-switch.jsonl` | E6-switch-r1 | |

Log events: `play` (Play pressed; laptop A's sync panel: `bestRtt`, `posError`, `resyncs`, `rate`, `reconnects`,
`listeners`; laptop B's as `b_*` from DRY-r7 on), `window` (start of the measured window, `seconds`), `end`, and
`action`, `progress`, `outage-start`, `outage-end` where relevant. Times are laptop A's wall clock.

## Reproducing the analysis

```bash
python3 -m venv eval/.venv && eval/.venv/bin/pip install -r eval/requirements.txt
R=eval/recordings/2026-11-26
eval/.venv/bin/python eval/analysis/clicks.py $R/E1/E1-delay150-r1.flac --channels 1,2 \
    --cal $R/calibration/CAL-A.flac --label E1-delay150-r1
eval/.venv/bin/python eval/analysis/charts.py distribution eval/results/ticks.csv --experiment E1 \
    --order delay0,delay50,delay150,delay300,loss5,asym150,naive --out eval/results/E1.png
```

Every two-laptop run reproduces its row of `summary.csv` this way. The E5 rows need the two-source fit, which is
not in the repository yet (follow-up 4).
