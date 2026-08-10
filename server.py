"""Local API and static server for the TSLA Physics Lab.

The project intentionally uses only the Python standard library. Historical bars
are persisted in SQLite and served to the browser from the same origin.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "market.db"
OUTPUT_DIR = ROOT / "output"
DEFAULT_SYMBOL = "TSLA"
DEFAULT_FROM = "2018-01-01"
DEFAULT_TO = "2024-12-31"
DEFAULT_TIMEFRAME = "1Min"
MAX_API_CANDLES = 10_000
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
ALPACA_BARS_URL = "https://data.alpaca.markets/v2/stocks/{symbol}/bars"
EXPECTED_TSLA_SPLITS = (
    {"effective_date": "2020-08-31", "ratio": 5},
    {"effective_date": "2022-08-25", "ratio": 3},
)


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    return connection


def init_db(db_path: Path = DB_PATH) -> None:
    with connect(db_path) as connection:
        connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS market_candles (
                symbol TEXT NOT NULL,
                trading_date TEXT NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                adjusted_close REAL NOT NULL,
                source TEXT NOT NULL,
                adjustment_mode TEXT NOT NULL DEFAULT 'unknown',
                feed TEXT,
                timeframe TEXT NOT NULL DEFAULT '1Day',
                fetched_at TEXT NOT NULL,
                PRIMARY KEY (symbol, trading_date)
            );

            CREATE INDEX IF NOT EXISTS market_candles_symbol_date
            ON market_candles(symbol, trading_date);

            CREATE TABLE IF NOT EXISTS agent_profiles (
                id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                mode TEXT NOT NULL,
                config_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dataset_imports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,
                provider TEXT NOT NULL,
                feed TEXT,
                adjustment_mode TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                row_count INTEGER NOT NULL,
                request_ids_json TEXT NOT NULL,
                validation_json TEXT NOT NULL,
                fetched_at TEXT NOT NULL
            );
            """
        )
        candle_columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(market_candles)").fetchall()
        }
        if "adjustment_mode" not in candle_columns:
            connection.execute(
                "ALTER TABLE market_candles ADD COLUMN adjustment_mode TEXT NOT NULL DEFAULT 'unknown'"
            )
        if "feed" not in candle_columns:
            connection.execute("ALTER TABLE market_candles ADD COLUMN feed TEXT")
        if "timeframe" not in candle_columns:
            connection.execute(
                "ALTER TABLE market_candles ADD COLUMN timeframe TEXT NOT NULL DEFAULT '1Day'"
            )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS market_candles_window
            ON market_candles(symbol, timeframe, trading_date)
            """
        )
        if "volume" in candle_columns:
            connection.execute("ALTER TABLE market_candles DROP COLUMN volume")
        # The bundled Yahoo seed used adjusted-close factors. TSLA paid no cash
        # dividends in this range, so its corporate-action adjustment is splits.
        connection.execute(
            """
            UPDATE market_candles
            SET adjustment_mode='split'
            WHERE source='Yahoo Finance chart API' AND adjustment_mode='unknown'
            """
        )
        profile = {
            "starting_equity": 500,
            "risk_fraction": 0.005,
            "cash_cap": 0.50,
            "entry": "Calibrated 15m motif odds plus bounded pullback and one-minute turn",
            "entry_min_median_return": 0.0015,
            "entry_min_up_odds": 0.60,
            "entry_min_net_odds": 0.22,
            "entry_min_rsi": 35,
            "entry_max_rsi": 68,
            "initial_stop_atr": 1.35,
            "trailing_stop_atr": 2.0,
            "time_exit_bars": 60,
            "cooldown_bars": 20,
            "max_trades_per_session": 2,
            "manual_min_net_profit": 0.001,
            "anchor_min_horizon_agreement": 2,
            "anchor_max_downside_odds": 0.38,
            "anchor_max_downside_ratio": 1.80,
            "anchor_max_physics_energy": 1.10,
            "anchor_overbought_rsi": 72,
            "anchor_min_veto_trials": 12,
            "anchor_min_save_rate": 0.55,
            "fee_rate": 0.0005,
            "slippage_rate": 0.0005,
        }
        connection.execute(
            """
            INSERT INTO agent_profiles(id, display_name, mode, config_json, updated_at)
            VALUES(?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                display_name=excluded.display_name,
                mode=excluded.mode,
                config_json=excluded.config_json,
                updated_at=excluded.updated_at
            """,
            (
                "compound-01",
                "Embrace / Compound 01",
                "historical-paper",
                json.dumps(profile, separators=(",", ":")),
                datetime.now(timezone.utc).isoformat(),
            ),
        )


def _unix_seconds(day: str) -> int:
    parsed = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def fetch_yahoo_history(symbol: str, start: str, end: str) -> list[dict[str, Any]]:
    """Fetch daily Yahoo chart data, adjusting OHLC with adjusted-close factor."""

    end_exclusive = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    query = urllib.parse.urlencode(
        {
            "period1": _unix_seconds(start),
            "period2": _unix_seconds(end_exclusive),
            "interval": "1d",
            "events": "history",
            "includeAdjustedClose": "true",
        }
    )
    url = f"{YAHOO_CHART_URL.format(symbol=urllib.parse.quote(symbol.upper()))}?{query}"
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 TSLA-Physics-Lab/1.0",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.URLError as error:
        raise RuntimeError(f"Yahoo Finance request failed: {error}") from error

    chart = payload.get("chart", {})
    if chart.get("error"):
        raise RuntimeError(f"Yahoo Finance returned: {chart['error']}")
    results = chart.get("result") or []
    if not results:
        raise RuntimeError("Yahoo Finance returned no chart result")

    result = results[0]
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    quotes = (indicators.get("quote") or [{}])[0]
    adjusted = (indicators.get("adjclose") or [{}])[0].get("adjclose") or []
    output: list[dict[str, Any]] = []

    for index, timestamp in enumerate(timestamps):
        try:
            raw_open = quotes["open"][index]
            raw_high = quotes["high"][index]
            raw_low = quotes["low"][index]
            raw_close = quotes["close"][index]
        except (IndexError, KeyError):
            continue
        if None in (raw_open, raw_high, raw_low, raw_close):
            continue
        adjusted_close = adjusted[index] if index < len(adjusted) and adjusted[index] is not None else raw_close
        factor = adjusted_close / raw_close if raw_close else 1.0
        output.append(
            {
                "date": datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat(),
                "open": round(raw_open * factor, 6),
                "high": round(raw_high * factor, 6),
                "low": round(raw_low * factor, 6),
                "close": round(raw_close * factor, 6),
                "adjusted_close": round(adjusted_close, 6),
            }
        )
    if not output:
        raise RuntimeError("Yahoo Finance returned no usable daily candles")
    return output


def fetch_yahoo_intraday(
    symbol: str,
    range_name: str = "5d",
    start: str | None = None,
    end: str | None = None,
) -> list[dict[str, Any]]:
    """Fetch one recent real 1-minute Yahoo window (seven days or less)."""

    query_values: dict[str, str | int] = {
        "interval": "1m",
        "events": "history",
        "includeAdjustedClose": "true",
    }
    start_timestamp: int | None = None
    end_timestamp: int | None = None
    if start and end:
        start_date = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_exclusive = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
        if end_exclusive <= start_date or end_exclusive - start_date > timedelta(days=7):
            raise ValueError("A Yahoo 1-minute chunk must cover one to seven calendar days.")
        start_timestamp = int(start_date.timestamp())
        end_timestamp = int(end_exclusive.timestamp())
        query_values.update({"period1": start_timestamp, "period2": end_timestamp})
    else:
        query_values["range"] = range_name
    query = urllib.parse.urlencode(query_values)
    url = f"{YAHOO_CHART_URL.format(symbol=urllib.parse.quote(symbol.upper()))}?{query}"
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 TSLA-Physics-Lab/2.0", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.URLError as error:
        raise RuntimeError(f"Yahoo Finance intraday request failed: {error}") from error

    chart = payload.get("chart", {})
    if chart.get("error"):
        raise RuntimeError(f"Yahoo Finance returned: {chart['error']}")
    results = chart.get("result") or []
    if not results:
        raise RuntimeError("Yahoo Finance returned no intraday chart result")
    result = results[0]
    timestamps = result.get("timestamp") or []
    quotes = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    output: list[dict[str, Any]] = []
    for index, timestamp in enumerate(timestamps):
        # Yahoo sometimes appends one current quote outside an explicit period.
        if start_timestamp is not None and not (start_timestamp <= timestamp < end_timestamp):
            continue
        try:
            values = {
                "open": quotes["open"][index],
                "high": quotes["high"][index],
                "low": quotes["low"][index],
                "close": quotes["close"][index],
            }
        except (IndexError, KeyError):
            continue
        if any(value is None for value in values.values()):
            continue
        close = float(values["close"])
        output.append(
            {
                "date": datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z"),
                "open": round(float(values["open"]), 6),
                "high": round(float(values["high"]), 6),
                "low": round(float(values["low"]), 6),
                "close": round(close, 6),
                "adjusted_close": round(close, 6),
            }
        )
    if not output:
        raise RuntimeError("Yahoo Finance returned no usable 1-minute bars")
    return output


def fetch_yahoo_intraday_history(symbol: str, start: str, end: str) -> list[dict[str, Any]]:
    """Assemble Yahoo's recent 1-minute history from causal seven-day chunks."""

    cursor = datetime.strptime(start, "%Y-%m-%d").date()
    final_day = datetime.strptime(end, "%Y-%m-%d").date()
    if final_day < cursor:
        raise ValueError("Yahoo intraday end date must not precede its start date.")
    output: dict[str, dict[str, Any]] = {}
    while cursor <= final_day:
        chunk_end = min(cursor + timedelta(days=6), final_day)
        rows = fetch_yahoo_intraday(symbol, start=cursor.isoformat(), end=chunk_end.isoformat())
        for row in rows:
            output[row["date"]] = row
        cursor = chunk_end + timedelta(days=1)
    rows = [output[key] for key in sorted(output)]
    if not rows:
        raise RuntimeError("Yahoo Finance returned no usable chunked 1-minute bars")
    return rows


def _alpaca_credentials() -> tuple[str, str]:
    key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY")
    secret = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY")
    if not key or not secret:
        raise RuntimeError(
            "Alpaca credentials are required. Set APCA_API_KEY_ID and "
            "APCA_API_SECRET_KEY, then run scripts/sync_tsla.py."
        )
    return key, secret


def fetch_alpaca_history(
    symbol: str,
    start: str,
    end: str,
    adjustment: str = "split",
    feed: str | None = None,
    timeframe: str = DEFAULT_TIMEFRAME,
) -> tuple[list[dict[str, Any]], list[str], str]:
    """Fetch paginated daily bars with an explicit Alpaca adjustment mode."""

    if adjustment != "split":
        raise ValueError("This training dataset requires Alpaca adjustment='split'.")
    if timeframe not in {"1Min", "1Day"}:
        raise ValueError("Timeframe must be 1Min or 1Day.")
    key, secret = _alpaca_credentials()
    selected_feed = feed or os.environ.get("ALPACA_DATA_FEED", "iex")
    if selected_feed not in {"iex", "sip", "delayed_sip"}:
        raise ValueError("ALPACA_DATA_FEED must be iex, sip, or delayed_sip for stock bars.")

    page_token: str | None = None
    request_ids: list[str] = []
    output: list[dict[str, Any]] = []
    while True:
        query_values = {
            "timeframe": timeframe,
            "start": f"{start}T00:00:00Z",
            "end": f"{end}T23:59:59Z",
            "adjustment": adjustment,
            "feed": selected_feed,
            "sort": "asc",
            "limit": "10000",
        }
        if page_token:
            query_values["page_token"] = page_token
        url = (
            f"{ALPACA_BARS_URL.format(symbol=urllib.parse.quote(symbol.upper()))}"
            f"?{urllib.parse.urlencode(query_values)}"
        )
        request = urllib.request.Request(
            url,
            headers={
                "APCA-API-KEY-ID": key,
                "APCA-API-SECRET-KEY": secret,
                "Accept": "application/json",
                "User-Agent": "TSLA-Physics-Lab/2.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                request_id = response.headers.get("X-Request-ID")
                if request_id:
                    request_ids.append(request_id)
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Alpaca Market Data returned HTTP {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"Alpaca Market Data request failed: {error}") from error

        for bar in payload.get("bars") or []:
            output.append(
                {
                    "date": str(bar["t"]) if timeframe == "1Min" else str(bar["t"])[:10],
                    "open": round(float(bar["o"]), 6),
                    "high": round(float(bar["h"]), 6),
                    "low": round(float(bar["l"]), 6),
                    "close": round(float(bar["c"]), 6),
                    "adjusted_close": round(float(bar["c"]), 6),
                }
            )
        page_token = payload.get("next_page_token")
        if not page_token:
            break

    if not output:
        raise RuntimeError("Alpaca Market Data returned no usable bars")
    return output, request_ids, selected_feed


def validate_split_adjustment(
    rows: list[dict[str, Any]],
    start: str,
    end: str,
) -> dict[str, Any]:
    """Reject data that still contains TSLA's raw 5:1 or 3:1 price cliffs."""

    if not rows:
        raise RuntimeError("Cannot validate an empty candle set")
    def row_date(row: dict[str, Any]) -> str:
        value = row.get("date") or row.get("time")
        if not value:
            raise RuntimeError("A candle is missing its trading date")
        return str(value)[:10]

    for row in rows:
        if not (0 < row["low"] <= row["high"] and row["low"] <= row["open"] <= row["high"]):
            raise RuntimeError(f"Invalid OHLC relationship on {row_date(row)}")
        if not row["low"] <= row["close"] <= row["high"]:
            raise RuntimeError(f"Close is outside the daily range on {row_date(row)}")

    checks: list[dict[str, Any]] = []
    for split in EXPECTED_TSLA_SPLITS:
        effective = split["effective_date"]
        if not (start <= effective <= end):
            continue
        before = [row for row in rows if row_date(row) < effective]
        after = [row for row in rows if row_date(row) >= effective]
        if not before or not after:
            raise RuntimeError(f"Missing bars around TSLA's {effective} split boundary")
        prior_bar = before[-1]
        next_bar = after[0]
        boundary_ratio = next_bar["open"] / prior_bar["close"]
        # Raw data would be near 1/5 or 1/3 at these boundaries. A broad band
        # allows genuine overnight moves but rejects an unadjusted split cliff.
        passed = 0.55 <= boundary_ratio <= 1.80
        checks.append(
            {
                "effective_date": effective,
                "split_ratio": split["ratio"],
                "prior_session": row_date(prior_bar),
                "next_session": row_date(next_bar),
                "boundary_open_to_prior_close": round(boundary_ratio, 6),
                "passed": passed,
            }
        )
        if not passed:
            raise RuntimeError(
                f"Split validation failed at {effective}: boundary ratio {boundary_ratio:.4f} "
                "looks like unadjusted data"
            )
    return {"adjustment": "split", "checks": checks, "passed": all(item["passed"] for item in checks)}


def sync_symbol(
    symbol: str = DEFAULT_SYMBOL,
    start: str = DEFAULT_FROM,
    end: str = DEFAULT_TO,
    db_path: Path = DB_PATH,
    provider: str = "alpaca",
    feed: str | None = None,
    timeframe: str = DEFAULT_TIMEFRAME,
) -> int:
    init_db(db_path)
    if provider == "alpaca":
        rows, request_ids, selected_feed = fetch_alpaca_history(
            symbol, start, end, adjustment="split", feed=feed, timeframe=timeframe
        )
        source = "Alpaca Market Data API"
    elif provider == "yahoo":
        rows = (
            fetch_yahoo_intraday_history(symbol, start, end)
            if timeframe == "1Min"
            else fetch_yahoo_history(symbol, start, end)
        )
        request_ids = []
        selected_feed = "consolidated"
        source = "Yahoo Finance chart API"
    else:
        raise ValueError("Provider must be 'alpaca' or 'yahoo'.")
    validation = validate_split_adjustment(rows, start, end) if timeframe == "1Day" else {
        "adjustment": "split",
        "checks": [],
        "passed": True,
        "note": "Recent minute bars are entirely post-split; Alpaca adjustment=split remains explicit.",
    }
    fetched_at = datetime.now(timezone.utc).isoformat()
    with connect(db_path) as connection:
        connection.execute(
            "DELETE FROM market_candles WHERE symbol=? AND timeframe=?",
            (symbol.upper(), timeframe),
        )
        connection.executemany(
            """
            INSERT INTO market_candles(
                symbol, trading_date, open, high, low, close,
                adjusted_close, source, adjustment_mode, feed, timeframe, fetched_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, trading_date) DO UPDATE SET
                open=excluded.open,
                high=excluded.high,
                low=excluded.low,
                close=excluded.close,
                adjusted_close=excluded.adjusted_close,
                source=excluded.source,
                adjustment_mode=excluded.adjustment_mode,
                feed=excluded.feed,
                timeframe=excluded.timeframe,
                fetched_at=excluded.fetched_at
            """,
            [
                (
                    symbol.upper(),
                    row["date"],
                    row["open"],
                    row["high"],
                    row["low"],
                    row["close"],
                    row["adjusted_close"],
                    source,
                    "split",
                    selected_feed,
                    timeframe,
                    fetched_at,
                )
                for row in rows
            ],
        )
        connection.execute(
            """
            INSERT INTO dataset_imports(
                symbol, provider, feed, adjustment_mode, start_date, end_date,
                row_count, request_ids_json, validation_json, fetched_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                symbol.upper(),
                provider,
                selected_feed,
                "split",
                rows[0]["date"],
                rows[-1]["date"],
                len(rows),
                json.dumps(request_ids, separators=(",", ":")),
                json.dumps(validation, separators=(",", ":")),
                fetched_at,
            ),
        )
    return len(rows)


def ensure_seeded(db_path: Path = DB_PATH) -> None:
    init_db(db_path)
    with connect(db_path) as connection:
        count = connection.execute(
            "SELECT COUNT(*) FROM market_candles WHERE symbol=? AND timeframe=?",
            (DEFAULT_SYMBOL, DEFAULT_TIMEFRAME),
        ).fetchone()[0]
    if count == 0:
        provider = "alpaca" if (
            os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY")
        ) else "yahoo"
        sync_symbol(db_path=db_path, provider=provider, timeframe=DEFAULT_TIMEFRAME)


def candle_payload(
    symbol: str,
    start: str,
    end: str,
    db_path: Path = DB_PATH,
    timeframe: str = DEFAULT_TIMEFRAME,
    limit: int | None = None,
) -> dict[str, Any]:
    conditions = ["symbol=?", "timeframe=?"]
    parameters: list[Any] = [symbol.upper(), timeframe]
    if start:
        conditions.append("trading_date>=?")
        parameters.append(start)
    if end:
        conditions.append("trading_date<=?")
        parameters.append(end)

    # An end-bounded or unbounded limited request means "the latest N bars".
    # A start-only request means "the next N bars", which is what prefetch uses.
    newest_first = limit is not None and (bool(end) or not start)
    direction = "DESC" if newest_first else "ASC"
    query = f"""
        SELECT trading_date, open, high, low, close, adjusted_close,
               source, adjustment_mode, feed, fetched_at
        FROM market_candles
        WHERE {' AND '.join(conditions)}
        ORDER BY trading_date {direction}
    """
    if limit is not None:
        query += " LIMIT ?"
        parameters.append(limit)

    with connect(db_path) as connection:
        rows = connection.execute(query, parameters).fetchall()
    if newest_first:
        rows.reverse()
    data = [
        {
            "time": int(datetime.fromisoformat(row["trading_date"].replace("Z", "+00:00")).timestamp())
            if "T" in row["trading_date"]
            else row["trading_date"],
            "isoTime": row["trading_date"],
            "open": row["open"],
            "high": row["high"],
            "low": row["low"],
            "close": row["close"],
            "adjustedClose": row["adjusted_close"],
        }
        for row in rows
    ]
    source = rows[0]["source"] if rows else None
    adjustment_mode = rows[0]["adjustment_mode"] if rows else None
    feed = rows[0]["feed"] if rows else None
    validation = (
        validate_split_adjustment(data, start, end)
        if data and timeframe == "1Day"
        else {"adjustment": "split", "checks": [], "passed": True}
    )
    return {
        "symbol": symbol.upper(),
        "interval": timeframe,
        "adjustment": adjustment_mode,
        "source": source,
        "feed": feed,
        "source_url": (
            "https://docs.alpaca.markets/us/reference/stockbars"
            if source == "Alpaca Market Data API"
            else "https://finance.yahoo.com/quote/TSLA/history/"
        ),
        "split_validation": validation,
        "from": data[0]["isoTime"] if data else None,
        "to": data[-1]["isoTime"] if data else None,
        "count": len(data),
        "data": data,
    }


def data_status_payload(
    symbol: str,
    timeframe: str = DEFAULT_TIMEFRAME,
    db_path: Path = DB_PATH,
) -> dict[str, Any]:
    with connect(db_path) as connection:
        summary = connection.execute(
            """
            SELECT COUNT(*) AS total, MIN(trading_date) AS earliest,
                   MAX(trading_date) AS latest
            FROM market_candles
            WHERE symbol=? AND timeframe=?
            """,
            (symbol.upper(), timeframe),
        ).fetchone()
        latest_row = connection.execute(
            """
            SELECT source, feed, adjustment_mode
            FROM market_candles
            WHERE symbol=? AND timeframe=?
            ORDER BY trading_date DESC
            LIMIT 1
            """,
            (symbol.upper(), timeframe),
        ).fetchone()

    total = int(summary["total"])
    return {
        "symbol": symbol.upper(),
        "timeframe": timeframe,
        "earliest": summary["earliest"],
        "latest": summary["latest"],
        "total": total,
        "source": latest_row["source"] if latest_row else None,
        "feed": latest_row["feed"] if latest_row else None,
        "adjustment": latest_row["adjustment_mode"] if latest_row else None,
    }


def agent_payload(db_path: Path = DB_PATH) -> dict[str, Any]:
    with connect(db_path) as connection:
        row = connection.execute(
            "SELECT id, display_name, mode, config_json, updated_at FROM agent_profiles WHERE id=?",
            ("compound-01",),
        ).fetchone()
    if not row:
        raise RuntimeError("Compound agent profile is missing")
    return {
        "id": row["id"],
        "displayName": row["display_name"],
        "mode": row["mode"],
        "config": json.loads(row["config_json"]),
        "updatedAt": row["updated_at"],
    }


def agent_grind_payload() -> dict[str, Any]:
    summary_path = OUTPUT_DIR / "agent-grind-summary.json"
    trades_path = OUTPUT_DIR / "agent-grind-best-trades.json"
    if not summary_path.exists() or not trades_path.exists():
        raise RuntimeError("No agent grind output found. Run test_agent_sources/grind-agent-core.js first.")
    return {
        "summary": json.loads(summary_path.read_text(encoding="utf-8")),
        "trades": json.loads(trades_path.read_text(encoding="utf-8")),
    }


class LabHandler(SimpleHTTPRequestHandler):
    server_version = "TSLAPhysicsLab/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib callback name
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            if parsed.path == "/":
                self.path = "/index.html"
            return super().do_GET()

        try:
            if parsed.path == "/api/health":
                with connect() as connection:
                    rows = connection.execute("SELECT COUNT(*) FROM market_candles").fetchone()[0]
                return self._json({"ok": True, "database": str(DB_PATH.name), "candles": rows})

            if parsed.path == "/api/data/status":
                query = urllib.parse.parse_qs(parsed.query)
                symbol = query.get("symbol", [DEFAULT_SYMBOL])[0].upper()
                timeframe = query.get("timeframe", [DEFAULT_TIMEFRAME])[0]
                if symbol != DEFAULT_SYMBOL:
                    return self._json(
                        {"error": "This training database is currently seeded for TSLA only."},
                        HTTPStatus.BAD_REQUEST,
                    )
                return self._json(data_status_payload(symbol, timeframe))

            if parsed.path == "/api/candles":
                query = urllib.parse.parse_qs(parsed.query)
                symbol = query.get("symbol", [DEFAULT_SYMBOL])[0].upper()
                start = query.get("from", query.get("start", [""]))[0]
                end = query.get("to", query.get("end", [""]))[0]
                timeframe = query.get("timeframe", [DEFAULT_TIMEFRAME])[0]
                limit_text = query.get("limit", [""])[0]
                try:
                    limit = int(limit_text) if limit_text else None
                except ValueError:
                    return self._json({"error": "limit must be an integer."}, HTTPStatus.BAD_REQUEST)
                if limit is not None and not 1 <= limit <= MAX_API_CANDLES:
                    return self._json(
                        {"error": f"limit must be between 1 and {MAX_API_CANDLES}."},
                        HTTPStatus.BAD_REQUEST,
                    )
                if symbol != DEFAULT_SYMBOL:
                    return self._json(
                        {"error": "This training database is currently seeded for TSLA only."},
                        HTTPStatus.BAD_REQUEST,
                    )
                payload = candle_payload(symbol, start, end, timeframe=timeframe, limit=limit)
                if not payload["data"]:
                    return self._json({"error": "No candles in the requested range."}, HTTPStatus.NOT_FOUND)
                return self._json(payload)

            if parsed.path == "/api/agent":
                return self._json(agent_payload())

            if parsed.path == "/api/agent/grind":
                return self._json(agent_grind_payload())

            return self._json({"error": "Unknown API route"}, HTTPStatus.NOT_FOUND)
        except (RuntimeError, sqlite3.Error, ValueError) as error:
            return self._json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def log_message(self, message: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {message % args}")


def run(host: str = "127.0.0.1", port: int = 8000) -> None:
    ensure_seeded()
    mimetypes.add_type("application/javascript", ".js")
    server = ThreadingHTTPServer((host, port), LabHandler)
    print(f"TSLA Physics Lab running at http://{host}:{port}")
    print(f"SQLite: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Serve the TSLA Physics Lab")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    run(args.host, args.port)
