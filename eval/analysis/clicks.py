"""Measures the sync error between devices in one microphone recording of the evaluation click track.

Each device plays its own channel of the track (`?evalChannel=1|2|3`), so each device's chirps sit in their own
frequency band. Per band: zero-phase band-pass → matched filter with that band's chirp → envelope peak per tick,
interpolated to a fraction of a sample. Ticks of different devices are paired by time; the difference is the sync
error between them (positive = the second device is late).

    eval/.venv/bin/python eval/analysis/clicks.py rec.wav --channels 1,2 --label E1-delay150-r1 \\
        [--cal cal.wav] [--csv eval/results/ticks.csv] [--summary eval/results/summary.csv]

The optional calibration recording is one device playing `?evalChannel=all` (all chirps at once): any per-band
bias of speaker, microphone and detector shows up there as a nonzero offset between bands, and is subtracted.
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile
from scipy import signal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clicktrack  # noqa: E402

#: Ticks of two devices further apart than this are not the same tick (sync errors are far below 1 s).
PAIR_WINDOW_S = 0.4
#: A detection must reach this fraction of the band's typical (median) peak: rejects noise and reflections.
MIN_RELATIVE_PEAK = 0.3
#: A tick further than this from the median of its neighbours is an outlier (a missed chirp paired with the wrong
#: one, or a loud sound in the room). Real changes (a resync, a nudge) move many ticks, and the median follows them.
OUTLIER_MS = 15.0
OUTLIER_NEIGHBOURS = 5


@dataclass(frozen=True)
class Tick:
    time_s: float
    strength: float


def load_mono(path: Path) -> tuple[np.ndarray, int]:
    audio, rate = soundfile.read(path, always_2d=True)
    return audio.mean(axis=1), rate


def detect(recording: np.ndarray, rate: int, channel: int) -> list[Tick]:
    """Arrival times (s, start of the chirp) of `channel`'s chirps (0-based channel), marker repeats removed."""
    f0, f1 = clicktrack.BANDS[channel]
    sos = signal.butter(4, [f0 * 0.85, min(f1 * 1.15, rate / 2 * 0.95)], btype="bandpass", fs=rate, output="sos")
    # Zero-phase: filtering forwards and backwards cancels the filter's delay, which differs per band.
    filtered = signal.sosfiltfilt(sos, recording)
    template = clicktrack.chirp(channel, rate)
    # Correlation with the template, indexed by where the template starts in the recording.
    correlation = signal.fftconvolve(filtered, template[::-1], mode="full")[len(template) - 1:]
    envelope = np.abs(signal.hilbert(correlation))

    min_distance = int(0.05 * rate)  # the marker's second chirp is 100 ms later
    peaks, props = signal.find_peaks(envelope, distance=min_distance, height=envelope.max() * 0.05)
    if len(peaks) == 0:
        return []
    heights = props["peak_heights"]
    keep = heights >= MIN_RELATIVE_PEAK * np.median(np.sort(heights)[-max(1, len(heights) // 2):])
    ticks = [Tick(_interpolate(envelope, _first_arrival(envelope, p, rate)) / rate, float(h))
             for p, h in zip(peaks[keep], heights[keep])]
    return _keep_periodic(_drop_marker_repeats(ticks))


#: Ticks are 1 s of track time apart; nudging changes that by at most 0.3 % (3 ms).
PERIOD_TOLERANCE_S = 0.015


def _keep_periodic(ticks: list[Tick]) -> list[Tick]:
    """Keeps detections that have a neighbour 1 s before or after them, and the strongest one per second: other
    sounds in the room (talking, music) also produce matched-filter peaks, but not on a 1 s grid."""
    times = np.array([t.time_s for t in ticks])
    period = clicktrack.TICK_PERIOD_S
    periodic = [t for t in ticks
                if np.any(np.abs(times - t.time_s - period) < PERIOD_TOLERANCE_S)
                or np.any(np.abs(times - t.time_s + period) < PERIOD_TOLERANCE_S)]
    best: list[Tick] = []
    for tick in periodic:
        if best and tick.time_s - best[-1].time_s < period / 2:
            if tick.strength > best[-1].strength:
                best[-1] = tick
            continue
        best.append(tick)
    return best


#: A reflection can be stronger than the direct sound; the direct sound arrives at most this long before it.
FIRST_ARRIVAL_WINDOW_S = 0.015
#: An earlier envelope peak at least this high (relative to the strongest) is taken as the direct sound.
FIRST_ARRIVAL_MIN_RELATIVE = 0.5


def _first_arrival(envelope: np.ndarray, strongest: int, rate: int) -> int:
    """The earliest envelope peak shortly before `strongest` that is nearly as strong: the direct sound, which comes
    first, even when a reflection (a nearby wall or table) adds up to a stronger peak."""
    start = max(1, strongest - int(FIRST_ARRIVAL_WINDOW_S * rate))
    window = envelope[start:strongest + 1]
    local, _ = signal.find_peaks(window, height=FIRST_ARRIVAL_MIN_RELATIVE * envelope[strongest])
    return start + int(local[0]) if len(local) else strongest


def _interpolate(envelope: np.ndarray, peak: int) -> float:
    """Sub-sample peak position by fitting a parabola through the peak and its neighbours."""
    if peak == 0 or peak == len(envelope) - 1:
        return float(peak)
    a, b, c = envelope[peak - 1], envelope[peak], envelope[peak + 1]
    denominator = a - 2 * b + c
    return peak + (0.5 * (a - c) / denominator if denominator != 0 else 0.0)


def _drop_marker_repeats(ticks: list[Tick]) -> list[Tick]:
    """Removes the second chirp of each 10 s marker: it would otherwise pair with the wrong tick."""
    gap = clicktrack.MARKER_GAP_MS / 1000
    result: list[Tick] = []
    for tick in ticks:
        if result and abs(tick.time_s - result[-1].time_s - gap) < 0.02:
            continue
        result.append(tick)
    return result


def pair(reference: list[Tick], other: list[Tick]) -> list[tuple[float, float]]:
    """(reference time s, other − reference in ms) for every reference tick with a matching tick of `other`."""
    if not reference or not other:
        return []
    other_times = np.array([t.time_s for t in other])
    pairs = []
    for tick in reference:
        i = int(np.argmin(np.abs(other_times - tick.time_s)))
        delta = other_times[i] - tick.time_s
        if abs(delta) <= PAIR_WINDOW_S:
            pairs.append((tick.time_s, delta * 1000))
    return pairs


def band_bias_ms(calibration: np.ndarray, rate: int, channels: list[int]) -> dict[int, float]:
    """Median offset of each band against the first one when a single device plays all chirps at once."""
    ticks = {c: detect(calibration, rate, c) for c in channels}
    bias = {channels[0]: 0.0}
    for c in channels[1:]:
        deltas = [d for _, d in pair(ticks[channels[0]], ticks[c])]
        bias[c] = float(np.median(deltas)) if deltas else 0.0
    return bias


def summarize(deltas_ms: np.ndarray) -> dict[str, float]:
    magnitude = np.abs(deltas_ms)
    return {
        "n": int(len(deltas_ms)),
        "mean_ms": float(np.mean(deltas_ms)),
        "std_ms": float(np.std(deltas_ms)),
        "mean_abs_ms": float(np.mean(magnitude)),
        "p95_abs_ms": float(np.percentile(magnitude, 95)),
        "max_abs_ms": float(np.max(magnitude)),
    }


def analyze(recording: np.ndarray, rate: int, channels: list[int], bias: dict[int, float] | None = None):
    """Per-tick deltas of every device against the first one, bias-corrected.

    Returns rows (device channel, tick time s, delta ms), 1-based channels as on the URL.
    """
    bias = bias or {}
    ticks = {c: detect(recording, rate, c) for c in channels}
    rows = []
    for c in channels[1:]:
        for time_s, delta in pair(ticks[channels[0]], ticks[c]):
            rows.append((c + 1, time_s, delta - bias.get(c, 0.0)))
    return rows, {c + 1: len(t) for c, t in ticks.items()}


#: Mono-pair mode: two arrivals closer than this merge into one peak (the chirp of the widest band compresses to a
#: pulse of about this width); such ticks are reported as "below the resolution".
MONO_PAIR_RESOLUTION_MS = 0.8
#: Mono-pair mode: the second device must reach this fraction of the first one's peak.
MONO_PAIR_MIN_RELATIVE = 0.35
MONO_PAIR_WINDOW_S = 0.06


def analyze_mono_pair(recording: np.ndarray, rate: int) -> np.ndarray:
    """|Δ| (ms) per tick for two devices playing the same mono click track (apps that can't play one channel per
    device, e.g. Beatsync in E5): the two strongest distinct arrivals per tick in the sharpest band. The order of the
    devices can't be known, and a delta below MONO_PAIR_RESOLUTION_MS comes out as 0."""
    channel = len(clicktrack.BANDS) - 1  # the widest band compresses to the sharpest pulse
    f0, f1 = clicktrack.BANDS[channel]
    sos = signal.butter(4, [f0 * 0.85, min(f1 * 1.15, rate / 2 * 0.95)], btype="bandpass", fs=rate, output="sos")
    filtered = signal.sosfiltfilt(sos, recording)
    template = clicktrack.chirp(channel, rate)
    correlation = signal.fftconvolve(filtered, template[::-1], mode="full")[len(template) - 1:]
    envelope = np.abs(signal.hilbert(correlation))
    deltas = []
    for tick in detect(recording, rate, channel):
        center = int(tick.time_s * rate)
        lo, hi = max(0, center - int(MONO_PAIR_WINDOW_S * rate)), center + int(MONO_PAIR_WINDOW_S * rate)
        window = envelope[lo:hi]
        peaks, props = signal.find_peaks(window, height=MONO_PAIR_MIN_RELATIVE * window.max())
        if len(peaks) == 0:
            continue
        order = np.argsort(props["peak_heights"])[::-1]
        first = peaks[order[0]]
        second = next((p for p in peaks[order[1:]]
                       if abs(p - first) >= MONO_PAIR_RESOLUTION_MS / 1000 * rate), None)
        deltas.append(0.0 if second is None else abs(_interpolate(window, second) - _interpolate(window, first))
                      / rate * 1000)
    return np.array(deltas)


def mark_outliers(deltas_ms: np.ndarray) -> np.ndarray:
    """True for ticks far from the median of the ticks around them (see OUTLIER_MS)."""
    marks = np.zeros(len(deltas_ms), dtype=bool)
    for i in range(len(deltas_ms)):
        lo, hi = max(0, i - OUTLIER_NEIGHBOURS), min(len(deltas_ms), i + OUTLIER_NEIGHBOURS + 1)
        marks[i] = abs(deltas_ms[i] - np.median(deltas_ms[lo:hi])) > OUTLIER_MS
    return marks


def spread_per_tick(rows: list[tuple[int, float, float]], devices: int) -> np.ndarray:
    """Max − min arrival time per tick across all devices (the reference counts as 0); ticks heard on all only."""
    by_tick: dict[float, list[float]] = {}
    for _, time_s, delta in rows:
        by_tick.setdefault(round(time_s, 1), [0.0]).append(delta)
    return np.array([max(d) - min(d) for d in by_tick.values() if len(d) == devices])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recording", type=Path)
    parser.add_argument("--channels", default="1,2", help="evalChannel of each device, e.g. 1,2,3")
    parser.add_argument("--label", default=None, help="experiment label for the CSV rows (default: file name)")
    parser.add_argument("--cal", type=Path, help="calibration recording (one device, evalChannel=all)")
    parser.add_argument("--csv", type=Path, help="append per-tick deltas here")
    parser.add_argument("--summary", type=Path, help="append the summary row here")
    parser.add_argument("--mono-pair", action="store_true",
                        help="two devices playing the mono track (E5): |Δ| from the two strongest arrivals per tick")
    args = parser.parse_args()

    if args.mono_pair:
        recording, rate = load_mono(args.recording)
        label = args.label or args.recording.stem
        deltas = analyze_mono_pair(recording, rate)
        if len(deltas) == 0:
            sys.exit("no ticks found")
        result = {"label": label, "device": "mono-pair", "outliers": 0, **summarize(deltas)}
        print(f"{label}: |Δ| n={result['n']} median={np.median(deltas):.2f} ms  p95={result['p95_abs_ms']:.2f} ms  "
              f"max={result['max_abs_ms']:.2f} ms  ({int(np.sum(deltas == 0))} ticks below "
              f"{MONO_PAIR_RESOLUTION_MS} ms)")
        if args.summary:
            _append(args.summary, list(result.keys()), [result])
        return

    channels = [int(c) - 1 for c in args.channels.split(",")]
    label = args.label or args.recording.stem
    recording, rate = load_mono(args.recording)
    bias = None
    if args.cal:
        calibration, cal_rate = load_mono(args.cal)
        bias = band_bias_ms(calibration, cal_rate, channels)
        print("band bias (ms):", {c + 1: round(b, 3) for c, b in bias.items()})

    rows, counts = analyze(recording, rate, channels, bias)
    print(f"{label}: chirps detected per channel {counts}")
    if not rows:
        sys.exit("no tick pairs found: wrong --channels, or the devices were not recorded?")

    outlier = np.zeros(len(rows), dtype=bool)
    for c in channels[1:]:
        index = [i for i, row in enumerate(rows) if row[0] == c + 1]
        outlier[index] = mark_outliers(np.array([rows[i][2] for i in index]))
    kept = [row for row, out in zip(rows, outlier) if not out]

    summaries = []
    for c in channels[1:]:
        deltas = np.array([d for ch, _, d in kept if ch == c + 1])
        summaries.append({"label": label, "device": f"ch{c + 1}-ch{channels[0] + 1}",
                          "outliers": int(sum(out for row, out in zip(rows, outlier) if row[0] == c + 1)),
                          **summarize(deltas)})
    if len(channels) > 2:
        summaries.append({"label": label, "device": "spread", "outliers": int(outlier.sum()),
                          **summarize(spread_per_tick(kept, len(channels)))})
    for s in summaries:
        print(f"  {s['device']:>8}: n={s['n']} mean={s['mean_ms']:+.2f} ms  std={s['std_ms']:.2f} ms  "
              f"p95|Δ|={s['p95_abs_ms']:.2f} ms  max|Δ|={s['max_abs_ms']:.2f} ms  ({s['outliers']} outliers left out)")

    if args.csv:
        _append(args.csv, ["label", "channel", "time_s", "delta_ms", "outlier"],
                [{"label": label, "channel": c, "time_s": f"{t:.4f}", "delta_ms": f"{d:.4f}", "outlier": int(out)}
                 for (c, t, d), out in zip(rows, outlier)])
    if args.summary:
        _append(args.summary, list(summaries[0].keys()), summaries)


def _append(path: Path, fields: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    new = not path.exists()
    with path.open("a", newline="") as out:
        writer = csv.DictWriter(out, fieldnames=fields)
        if new:
            writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
