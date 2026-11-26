"""The evaluation click track: shared by the generator (tracks/) and the analysis (analysis/).

Every whole second of track time, each channel plays a short linear chirp in its own frequency band. A device
playing with `?evalChannel=k` outputs only channel k, so one microphone recording of several devices can be split
back into one signal per device by band-pass filtering, even when their clicks overlap in time. A chirp (rather
than a click or a tone burst) compresses to a sharp, unambiguous peak under matched filtering: sub-millisecond
timing even with noise and room reflections.

Every 10 s the chirp is doubled (a second one 100 ms later), so recordings can be aligned to track time.
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 48_000
CHIRP_MS = 20.0
#: Second chirp after every 10th tick (alignment marker).
MARKER_GAP_MS = 100.0
TICK_PERIOD_S = 1.0
MARKER_EVERY = 10
AMPLITUDE = 0.5

#: (start Hz, end Hz) per channel. Phone speakers reproduce little below ~500 Hz, so the bands start above that;
#: they stay apart so band-pass filters separate them cleanly, and below 7.5 kHz so a 16 kHz file can carry them.
BANDS: tuple[tuple[float, float], ...] = ((600.0, 1600.0), (2000.0, 3800.0), (4500.0, 7000.0))


def chirp(channel: int, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """The chirp of `channel` (0-based), with short fades so it doesn't click at its edges."""
    f0, f1 = BANDS[channel]
    n = int(round(CHIRP_MS / 1000 * sample_rate))
    t = np.arange(n) / sample_rate
    duration = n / sample_rate
    phase = 2 * np.pi * (f0 * t + (f1 - f0) / (2 * duration) * t**2)
    fade = max(1, int(0.1 * n))
    window = np.ones(n)
    ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, fade))
    window[:fade] = ramp
    window[-fade:] = ramp[::-1]
    return AMPLITUDE * np.sin(phase) * window


def tick_times(duration_s: float) -> list[float]:
    """Track times (s) of every chirp: one per second from 1 s on, plus the second chirp of each marker."""
    times: list[float] = []
    k = 1
    while k * TICK_PERIOD_S + (CHIRP_MS + MARKER_GAP_MS) / 1000 < duration_s:
        times.append(k * TICK_PERIOD_S)
        if k % MARKER_EVERY == 0:
            times.append(k * TICK_PERIOD_S + MARKER_GAP_MS / 1000)
        k += 1
    return times


def render(duration_s: float, channels: int = len(BANDS), sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """The track as float samples, shape (frames, channels)."""
    frames = int(round(duration_s * sample_rate))
    audio = np.zeros((frames, channels))
    for channel in range(channels):
        template = chirp(channel, sample_rate)
        for t in tick_times(duration_s):
            start = int(round(t * sample_rate))
            audio[start:start + len(template), channel] += template
    return audio
