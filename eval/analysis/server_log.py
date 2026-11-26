"""Reads the server's JSON-lines event log (server: logs/events-<date>.jsonl, written by EventLog.java).

    eval/.venv/bin/python eval/analysis/server_log.py logs/events-2026-11-24.jsonl --room k3x9qa [--csv out.csv]

Prints, per member: name, strategies, clock offset/RTT statistics, the position error the client measured itself
(driftMs), nudging and resyncs, reconnects and outages. With --csv, writes one row per stats message, for charts.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd


def load(paths: list[Path], room: str | None = None) -> pd.DataFrame:
    """All events as a table; `t_s` is server time in seconds (monotonic, comparable within one server run)."""
    rows = []
    for path in paths:
        with path.open() as lines:
            rows.extend(json.loads(line) for line in lines if line.strip())
    events = pd.DataFrame(rows)
    if events.empty:
        return events
    if room is not None:
        events = events[events["roomId"] == room]
    events = events.assign(t_s=events["serverTime"] / 1000)
    return events.sort_values("serverTime").reset_index(drop=True)


def members(events: pd.DataFrame) -> pd.DataFrame:
    """One row per member: its name and evaluation settings (from its latest stats)."""
    joins = events[events["event"] == "join"][["memberId", "name"]].drop_duplicates("memberId", keep="last")
    stats = events[events["event"] == "stats"]
    settings_columns = [c for c in ("clockStrategy", "driftStrategy", "naive", "evalChannel") if c in stats]
    latest = stats.groupby("memberId")[settings_columns].last().reset_index()
    return joins.merge(latest, on="memberId", how="outer")


def summary(events: pd.DataFrame) -> pd.DataFrame:
    stats = events[events["event"] == "stats"]
    if stats.empty:
        return pd.DataFrame()

    def per_member(group: pd.DataFrame) -> pd.Series:
        drift = group["driftMs"].dropna() if "driftMs" in group else pd.Series(dtype=float)
        rate = group["playbackRate"].dropna() if "playbackRate" in group else pd.Series(dtype=float)
        return pd.Series({
            "stats": len(group),
            "offset_range_ms": group["offsetMs"].max() - group["offsetMs"].min(),
            "rtt_median_ms": group["rttMs"].median(),
            "drift_mean_ms": drift.mean() if len(drift) else None,
            "drift_abs_p95_ms": drift.abs().quantile(0.95) if len(drift) else None,
            "nudging_share": float((rate != 1).mean()) if len(rate) else None,
            "resyncs": group["resyncs"].max() if "resyncs" in group else None,
            "reconnects": group["reconnects"].max() if "reconnects" in group else None,
            "last_outage_ms": group["lastOutageMs"].dropna().iloc[-1]
            if "lastOutageMs" in group and group["lastOutageMs"].notna().any() else None,
            "synced_after_ms": group["syncedAfterMs"].dropna().iloc[0]
            if "syncedAfterMs" in group and group["syncedAfterMs"].notna().any() else None,
        })

    table = stats.groupby("memberId").apply(per_member, include_groups=False).reset_index()
    return members(events).merge(table, on="memberId", how="right")


def reconnects(events: pd.DataFrame) -> pd.DataFrame:
    """Disconnects and reconnects as the server saw them (gapMs undercounts half-open outages: see protocol §6.1)."""
    columns = [c for c in ("t_s", "memberId", "event", "gapMs", "replacedOpenConnection") if c in events]
    return events[events["event"].isin(["disconnect", "reconnect"])][columns]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("logs", type=Path, nargs="+")
    parser.add_argument("--room")
    parser.add_argument("--csv", type=Path, help="write all stats rows here")
    args = parser.parse_args()

    events = load(args.logs, args.room)
    if events.empty:
        raise SystemExit("no events")
    with pd.option_context("display.width", 200, "display.max_columns", 30, "display.float_format", "{:.2f}".format):
        print(summary(events).to_string(index=False))
        changes = reconnects(events)
        if not changes.empty:
            print("\nconnection changes:")
            print(changes.to_string(index=False))
    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        events[events["event"] == "stats"].to_csv(args.csv, index=False)
        print(f"\nwrote {args.csv}")


if __name__ == "__main__":
    main()
