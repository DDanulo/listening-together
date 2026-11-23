"""Charts and tables for the report, from the per-tick CSV that clicks.py writes (--csv).

Labels follow the run sheet naming `<experiment>-<condition>-r<repetition>`, e.g. `E1-delay150-r2`.

    # distribution of the sync error per condition (E1, E2, E4, E5): box plot + every tick
    eval/.venv/bin/python eval/analysis/charts.py distribution eval/results/ticks.csv --experiment E1 \\
        --order delay0,delay50,delay150,delay300,jitter20,loss5 --out eval/results/E1.png
    # sync error over time, one line per condition (E3, E6)
    eval/.venv/bin/python eval/analysis/charts.py timeline eval/results/ticks.csv --labels E3-off-r1,E3-nudge-r1 \\
        --out eval/results/E3.png
    # Markdown table of a summary CSV (clicks.py --summary), for the report
    eval/.venv/bin/python eval/analysis/charts.py table eval/results/summary.csv --experiment E1

Style: light theme for print; categorical colors in fixed order (validated palette, slots 1-3); thin marks; recessive
grid; text in neutral ink, never in series colors.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]  # categorical slots 1-3: validated for all pairs (CVD and normal vision)
SURFACE = "#fcfcfb"
TEXT = "#0b0b0b"
TEXT_SECONDARY = "#52514e"
GRID = "#e4e3df"


def _style() -> None:
    plt.rcParams.update({
        "figure.facecolor": SURFACE, "axes.facecolor": SURFACE, "savefig.facecolor": SURFACE,
        "axes.edgecolor": GRID, "axes.labelcolor": TEXT_SECONDARY, "axes.titlecolor": TEXT,
        "xtick.color": TEXT_SECONDARY, "ytick.color": TEXT_SECONDARY, "text.color": TEXT,
        "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "axes.grid.axis": "y",
        "grid.color": GRID, "grid.linewidth": 0.8, "font.size": 10, "axes.titlesize": 12,
        "axes.titleweight": "bold", "axes.titlelocation": "left", "lines.linewidth": 2,
    })


def load_ticks(path: Path) -> pd.DataFrame:
    ticks = pd.read_csv(path)
    if "outlier" in ticks:
        ticks = ticks[ticks["outlier"] == 0]
    parts = ticks["label"].str.split("-", n=2, expand=True)
    return ticks.assign(experiment=parts[0], condition=parts[1], abs_ms=ticks["delta_ms"].abs())


def distribution(ticks: pd.DataFrame, experiment: str, order: list[str] | None, out: Path, title: str | None) -> None:
    data = ticks[ticks["experiment"] == experiment]
    conditions = order or sorted(data["condition"].unique())
    groups = [data[data["condition"] == c]["abs_ms"].to_numpy() for c in conditions]
    _style()
    fig, ax = plt.subplots(figsize=(max(4.5, 1.1 * len(conditions) + 1.5), 3.6))
    rng = np.random.default_rng(0)
    for i, values in enumerate(groups):
        jitter = rng.uniform(-0.18, 0.18, len(values))
        ax.scatter(np.full(len(values), i) + jitter, values, s=8, color=SERIES[0], alpha=0.35, linewidths=0)
    ax.boxplot(groups, positions=range(len(groups)), widths=0.5, showfliers=False,
               medianprops={"color": TEXT, "linewidth": 2}, boxprops={"color": TEXT_SECONDARY},
               whiskerprops={"color": TEXT_SECONDARY}, capprops={"color": TEXT_SECONDARY})
    for i, values in enumerate(groups):
        if len(values):
            ax.annotate(f"{np.median(values):.1f}", (i + 0.28, np.median(values)), va="center", fontsize=9,
                        color=TEXT)
    ax.set_xticks(range(len(conditions)), conditions)
    ax.set_ylabel("|sync error| between devices (ms)")
    ax.set_ylim(bottom=0)
    ax.set_title(title or f"{experiment}: sync error per tick")
    fig.tight_layout()
    fig.savefig(out, dpi=200)
    print(f"wrote {out}")


def timeline(ticks: pd.DataFrame, labels: list[str], out: Path, title: str | None) -> None:
    if len(labels) > len(SERIES):
        raise SystemExit(f"at most {len(SERIES)} lines per chart: split the rest into another chart")
    _style()
    fig, ax = plt.subplots(figsize=(7, 3.6))
    for color, label in zip(SERIES, labels):
        run = ticks[ticks["label"] == label].sort_values("time_s")
        if run.empty:
            raise SystemExit(f"no ticks for {label}")
        t = run["time_s"] - run["time_s"].iloc[0]
        ax.plot(t, run["delta_ms"], color=color, label=label, marker="o", markersize=3)
        ax.annotate(label.split("-")[1], (t.iloc[-1], run["delta_ms"].iloc[-1]), xytext=(6, 0),
                    textcoords="offset points", va="center", fontsize=9, color=TEXT)
    ax.axhline(0, color=TEXT_SECONDARY, linewidth=0.8)
    ax.set_xlabel("time since the start of the recording (s)")
    ax.set_ylabel("sync error between devices (ms)")
    left, right = ax.get_xlim()
    ax.set_xlim(left, right + 0.1 * (right - left))  # room for the direct labels at the line ends
    if len(labels) > 1:
        # above the plot, so it never covers data
        ax.legend(frameon=False, loc="lower right", bbox_to_anchor=(1, 1), ncol=len(labels), fontsize=9)
    ax.set_title(title or "Sync error over time", pad=22 if len(labels) > 1 else 6)
    fig.tight_layout()
    fig.savefig(out, dpi=200)
    print(f"wrote {out}")


def table(summary: Path, experiment: str | None) -> None:
    data = pd.read_csv(summary)
    if experiment:
        data = data[data["label"].str.startswith(experiment + "-")]
    columns = ["label", "device", "n", "mean_ms", "std_ms", "p95_abs_ms", "max_abs_ms"]
    print("| " + " | ".join(columns) + " |")
    print("|" + "---|" * len(columns))
    for _, row in data.iterrows():
        cells = [f"{row[c]:.2f}" if isinstance(row[c], float) else str(row[c]) for c in columns]
        print("| " + " | ".join(cells) + " |")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    d = sub.add_parser("distribution")
    d.add_argument("ticks", type=Path)
    d.add_argument("--experiment", required=True)
    d.add_argument("--order", help="comma-separated conditions, in display order")
    d.add_argument("--out", type=Path, required=True)
    d.add_argument("--title")
    t = sub.add_parser("timeline")
    t.add_argument("ticks", type=Path)
    t.add_argument("--labels", required=True, help="comma-separated labels, at most 3")
    t.add_argument("--out", type=Path, required=True)
    t.add_argument("--title")
    s = sub.add_parser("table")
    s.add_argument("summary", type=Path)
    s.add_argument("--experiment")
    args = parser.parse_args()

    if args.command == "table":
        table(args.summary, args.experiment)
        return
    args.out.parent.mkdir(parents=True, exist_ok=True)
    ticks = load_ticks(args.ticks)
    if args.command == "distribution":
        distribution(ticks, args.experiment, args.order.split(",") if args.order else None, args.out, args.title)
    else:
        timeline(ticks, args.labels.split(","), args.out, args.title)


if __name__ == "__main__":
    main()
