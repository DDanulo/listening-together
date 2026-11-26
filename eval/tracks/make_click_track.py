"""Writes the evaluation click tracks (see ../clicktrack.py).

    eval/.venv/bin/python eval/tracks/make_click_track.py    # into eval/tracks/

FLAC, not MP3: MP3 encoders add padding at the start that decoders remove differently (Chrome vs Firefox vs Safari),
which would show up as a fake sync error between browsers. FLAC is lossless and has no such delay, and since the
track is ~98 % silence it compresses far below the 50 MB upload limit even for 30 minutes of 3 channels.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import soundfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clicktrack  # noqa: E402

#: name, duration (s), channels. The mono track mixes all three chirps, for apps that won't play our multichannel
#: file per channel (Beatsync, experiment E5).
TRACKS = [
    ("clicks-5min.flac", 5 * 60, 3),
    ("clicks-30min.flac", 30 * 60, 3),
    ("clicks-mono-5min.flac", 5 * 60, 1),
]

UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    for name, duration, channels in TRACKS:
        audio = clicktrack.render(duration)
        if channels == 1:
            audio = audio.sum(axis=1, keepdims=True) / len(clicktrack.BANDS)
        path = args.out / name
        soundfile.write(path, audio, clicktrack.SAMPLE_RATE, subtype="PCM_16")
        size = path.stat().st_size
        print(f"{path} ({size / 1e6:.1f} MB)")
        if size > UPLOAD_LIMIT_BYTES:
            sys.exit(f"{name} is over the 50 MB upload limit")


if __name__ == "__main__":
    main()
