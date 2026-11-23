"""The detector must recover known offsets from synthetic "recordings": the measurement must be far more precise
than the sync errors it measures (target: within 0.2 ms)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from scipy import signal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analysis"))
import clicks  # noqa: E402
import clicktrack  # noqa: E402

RATE = 48_000
DURATION_S = 25.0


def device(channel: int, delay_ms: float, gain: float = 1.0, rate: int = RATE) -> np.ndarray:
    """One device playing `channel` of the click track, `delay_ms` late (fractional delays via the spectrum)."""
    track = clicktrack.render(DURATION_S, sample_rate=rate)[:, channel] * gain
    spectrum = np.fft.rfft(track)
    frequencies = np.fft.rfftfreq(len(track), 1 / rate)
    return np.fft.irfft(spectrum * np.exp(-2j * np.pi * frequencies * delay_ms / 1000), n=len(track))


def room(audio: np.ndarray, rng: np.random.Generator, rate: int = RATE, reflection: float = 0.0) -> np.ndarray:
    """A small room with the microphone ~30 cm from the speakers: the direct sound, then 60 ms of diffuse decaying
    reflections (about 6 dB below the direct sound), optionally one strong reflection (e.g. off the table) 2.5 ms
    later, and background noise."""
    n = int(0.06 * rate)
    tail = rng.standard_normal(n) * np.exp(-np.arange(n) / (0.012 * rate)) * 0.03
    impulse = np.concatenate([[1.0], np.zeros(int(0.002 * rate)), tail])
    impulse[int(0.0025 * rate)] += reflection
    wet = signal.fftconvolve(audio, impulse)[: len(audio)]
    return wet + rng.standard_normal(len(audio)) * 0.01


def test_recovers_offset_between_two_devices_in_a_noisy_room():
    rng = np.random.default_rng(1)
    recording = room(device(0, 0.0) + device(1, 3.25, gain=0.6), rng)

    rows, counts = clicks.analyze(recording, RATE, [0, 1])
    deltas = np.array([d for _, _, d in rows])

    assert counts[1] == counts[2] == 24  # 24 ticks in 25 s (marker repeats removed)
    assert np.median(deltas) == pytest.approx(3.25, abs=0.2)
    assert np.max(np.abs(deltas - 3.25)) < 0.3


def test_separates_three_devices_whose_chirps_overlap():
    rng = np.random.default_rng(2)
    recording = room(device(0, 0.0) + device(1, -0.8) + device(2, 1.7, gain=0.5), rng)

    rows, _ = clicks.analyze(recording, RATE, [0, 1, 2])

    assert np.median([d for c, _, d in rows if c == 2]) == pytest.approx(-0.8, abs=0.2)
    assert np.median([d for c, _, d in rows if c == 3]) == pytest.approx(1.7, abs=0.2)
    assert np.median(clicks.spread_per_tick(rows, 3)) == pytest.approx(2.5, abs=0.3)


def test_calibration_removes_a_per_band_bias():
    rng = np.random.default_rng(3)
    # A speaker that delays the band of channel 2 by 0.6 ms: same device, all chirps at once
    calibration = room(device(0, 0.0) + device(1, 0.6), rng)
    recording = room(device(0, 0.0) + device(1, 2.0 + 0.6), rng)

    bias = clicks.band_bias_ms(calibration, RATE, [0, 1])
    rows, _ = clicks.analyze(recording, RATE, [0, 1], bias)

    assert bias[1] == pytest.approx(0.6, abs=0.15)
    assert np.median([d for _, _, d in rows]) == pytest.approx(2.0, abs=0.2)


def test_works_on_a_16_khz_phone_recording():
    rate = 16_000
    rng = np.random.default_rng(4)
    recording = room(device(0, 0.0, rate=rate) + device(1, 5.0, rate=rate), rng, rate)

    rows, _ = clicks.analyze(recording, rate, [0, 1])

    assert np.median([d for _, _, d in rows]) == pytest.approx(5.0, abs=0.2)


def test_large_offsets_still_pair_with_the_right_tick():
    # the naive baseline can be 100+ ms off; the 10 s marker repeat is 100 ms after a tick
    recording = device(0, 0.0) + device(1, 150.0)

    rows, _ = clicks.analyze(recording, RATE, [0, 1])

    assert np.median([d for _, _, d in rows]) == pytest.approx(150.0, abs=0.2)


def test_takes_the_direct_sound_even_when_a_reflection_is_louder():
    rng = np.random.default_rng(5)
    # a reflection 2.5 ms after the direct sound, 90 % as loud: with the diffuse tail it adds up to a stronger peak
    recording = room(device(0, 0.0) + device(1, 1.5), rng, reflection=0.9)

    rows, _ = clicks.analyze(recording, RATE, [0, 1])

    assert np.median([d for _, _, d in rows]) == pytest.approx(1.5, abs=0.2)


def test_ignores_other_sounds_in_the_room():
    rng = np.random.default_rng(6)
    clean = device(0, 0.0) + device(1, 2.0)
    # music-like interference: 200 random tone bursts across all bands, louder than the chirps
    noise = np.zeros_like(clean)
    for _ in range(200):
        start = rng.integers(0, len(clean) - RATE // 10)
        length = rng.integers(RATE // 100, RATE // 10)
        t = np.arange(length) / RATE
        noise[start:start + length] += 0.8 * np.sin(2 * np.pi * rng.uniform(500, 7500) * t) * np.hanning(length)
    recording = room(clean + noise, rng)

    rows, counts = clicks.analyze(recording, RATE, [0, 1])
    deltas = np.array([d for _, _, d in rows])

    assert max(counts.values()) <= 24  # no extra "ticks"
    assert len(deltas) >= 20
    assert np.median(deltas) == pytest.approx(2.0, abs=0.2)
    assert np.percentile(np.abs(deltas - 2.0), 90) < 0.5


def test_outliers_are_isolated_jumps_not_real_changes():
    deltas = np.array([5.0] * 10 + [320.0] + [5.0] * 5 + [-10.0] * 10)  # one wrong pairing, then a real 15 ms step

    marks = clicks.mark_outliers(deltas)

    assert marks.tolist() == [False] * 10 + [True] + [False] * 15


def mono(delay_ms: float, gain: float = 1.0) -> np.ndarray:
    """A device playing the mono track (all three chirps at once)."""
    return sum(device(c, delay_ms, gain) for c in range(3)) / 3


def test_mono_pair_measures_two_devices_playing_the_same_track():
    rng = np.random.default_rng(7)
    recording = room(mono(0.0) + mono(4.0, gain=0.7), rng)

    deltas = clicks.analyze_mono_pair(recording, RATE)

    assert len(deltas) >= 20
    assert np.median(deltas) == pytest.approx(4.0, abs=0.2)


def test_mono_pair_reports_deltas_below_the_resolution_as_zero():
    rng = np.random.default_rng(8)
    recording = room(mono(0.0) + mono(0.3), rng)

    assert np.median(clicks.analyze_mono_pair(recording, RATE)) < clicks.MONO_PAIR_RESOLUTION_MS
