# Evaluation

Tooling and results for measuring synchronization accuracy.

## Measurement method

All test devices stand next to **one microphone**, at the same distance, but reach the server over **different network paths** (Wi-Fi, mobile data, a machine with `tc netem` impairment). They play a **click track** with a short chirp every second. Each device plays its own channel of the track (`?evalChannel=1|2|3`), and each channel's chirp is in its own frequency band, so one mono recording can be split back into one signal per device, even when their chirps overlap. The analysis measures, per chirp, how far apart the devices' chirps arrive: the sync error between them.

The detector (per band: zero-phase band-pass → matched filter → envelope → first arrival → sub-sample peak) is tested on synthetic recordings with noise, room reflections and music-like interference, and recovers known offsets within 0.2 ms (`tests/`). Beatsync can't play one channel per device, so for E5 two devices play a mono track and the two arrivals per chirp are measured directly (`--mono-pair`, resolution 0.8 ms).

Besides recordings, every client reports its own measurements every 2 s (`stats`: clock offset, RTT, its own position error, nudging rate, resyncs, reconnects and outages, active strategies), which the server logs as JSON lines.

**The session itself: [RUNBOOK.md](RUNBOOK.md).**

## Contents

| Path | Contents |
|---|---|
| `clicktrack.py` | The click track definition (bands, chirp, timing), shared by the generator and the analysis |
| `tracks/` | `make_click_track.py` and the generated tracks: 5 min and 30 min (3 channels), 5 min mono (FLAC) |
| `netem/netem.sh` | Network scenarios (delay, jitter, loss, asymmetric delay, outage) with `tc netem`, optionally limited to the server's IP |
| `analysis/clicks.py` | Sync error between devices from a recording |
| `analysis/server_log.py` | Per-member summary of the server's event log |
| `analysis/charts.py` | Charts (distribution per condition, error over time) and Markdown tables for the report |
| `tests/` | Detector tests on synthetic recordings |
| `results/` | Processed results and charts; [`results/README.md`](results/README.md) describes the session and every file |
| `recordings/<date>/` | A session's recordings, trimmed to the analysed windows (FLAC). Raw recordings stay local in `recordings/` |

## Setup

```bash
python3 -m venv eval/.venv && eval/.venv/bin/pip install -r eval/requirements.txt
eval/.venv/bin/python -m pytest -q eval/tests
eval/.venv/bin/python eval/tracks/make_click_track.py     # regenerates eval/tracks/*.flac
```

## Experiments

| # | Question | Variables |
|---|---|---|
| E1 | Sync accuracy under different network conditions | latency 0 / 50 / 150 / 300 ms, jitter, 5 % loss, asymmetric delay; naive baseline |
| E2 | Best clock-sync strategy | single ping vs. best-of-N vs. + periodic re-sync vs. + regression |
| E3 | Drift and its correction | none vs. hard resync vs. playback-rate nudging, 10–15 min |
| E4 | Devices and outputs | laptop vs. phone; Chrome / Firefox / Safari; speaker / wired / Bluetooth |
| E5 | Comparison with existing solutions | our app vs. Beatsync (Spotify Jam: qualitative only) |
| E6 | Recovery | outage of 10 s / 30 s, Wi-Fi → mobile data switch |

**Metrics:** sync error between devices (mean, standard deviation, p95 and max of |Δ|), time to first sync (`syncedAfterMs`), outage and recovery time, share of time spent nudging, number of resyncs.
