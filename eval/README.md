# Evaluation

Tooling and results for measuring synchronization accuracy.

## Measurement method

All test devices stand next to **one microphone** but reach the server over **different network paths** (Wi-Fi, mobile hotspot, a machine with `tc netem` impairment). They play a test track with a sharp click every second. The recording is analyzed to measure the time spread between the devices' clicks.

## Planned contents

| Path | Contents |
|---|---|
| `netem/` | Scripts applying network scenarios (latency, jitter, loss) and resetting them |
| `tracks/` | Test tracks (click track) |
| `analysis/` | Click detection and statistics on recordings; parsing of server `stats` logs |
| `results/` | Processed results and charts for the report (raw recordings are not committed) |

## Experiments

| # | Question | Variables |
|---|---|---|
| E1 | Sync accuracy under different network conditions | latency 0 / 50 / 150 / 300 ms, jitter, loss 0 / 1 / 5 % |
| E2 | Best clock-sync strategy | single ping vs. best-of-N vs. + periodic re-sync |
| E3 | Drift and its correction | none vs. hard resync vs. playback-rate nudging; 1 vs. 30 min |
| E4 | Devices and outputs | laptop vs. phone; Chrome / Firefox / Safari; speaker / wired / Bluetooth |
| E5 | Comparison with existing solutions | our app vs. Beatsync vs. Spotify Jam |
| E6 | Recovery | time to re-align after disconnect / network switch |

**Metrics:** sync error between devices (mean, max, standard deviation), time to first sync, recovery time.
