"""Refresh split-adjusted TSLA training bars, using Alpaca by default."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server import DB_PATH, DEFAULT_FROM, DEFAULT_TIMEFRAME, DEFAULT_TO, sync_symbol  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed explicitly split-adjusted TSLA price bars in SQLite")
    parser.add_argument("--from", dest="start", default=DEFAULT_FROM)
    parser.add_argument("--to", dest="end", default=DEFAULT_TO)
    parser.add_argument("--database", type=Path, default=DB_PATH)
    parser.add_argument("--provider", choices=("alpaca", "yahoo"), default="alpaca")
    parser.add_argument("--feed", choices=("iex", "sip", "delayed_sip"))
    parser.add_argument("--timeframe", choices=("1Min", "1Day"), default=DEFAULT_TIMEFRAME)
    args = parser.parse_args()
    try:
        count = sync_symbol(
            "TSLA", args.start, args.end, args.database,
            provider=args.provider, feed=args.feed, timeframe=args.timeframe,
        )
    except (RuntimeError, ValueError) as error:
        parser.exit(1, f"Data sync failed: {error}\n")
    print(
        f"Stored {count} explicitly split-adjusted TSLA {args.timeframe} bars "
        f"from {args.provider} ({args.start} through {args.end}) in {args.database}"
    )


if __name__ == "__main__":
    main()
