from pathlib import Path
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from collections import defaultdict
import re
import time

import numpy as np
import pandas as pd
import requests


# ============================================================
# SETTINGS
# ============================================================

BASE = "https://external-api.kalshi.com/trade-api/v2"
SERIES = "KXMLBF5"

LOCAL_TZ = ZoneInfo("America/Los_Angeles")

PLAY_THRESHOLD = 0.58
STRONG_THRESHOLD = 0.62

MAX_SPREAD = 0.15
MAX_QUOTE_AGE_MINUTES = 180

# Optional live V3C predictions.
#
# Expected minimum columns:
# game_pk
# fusion_home_prob
# fusion_predicted_side
# fusion_confidence
#
V3C_LIVE = Path(
    "results/v3c_live_predictions.csv"
)

OUT_DIR = Path("results/live")
OUT_DIR.mkdir(
    parents=True,
    exist_ok=True
)


# ============================================================
# TEAM MAP
# ============================================================

TEAM_MAP = {
    "AZ": "Arizona Diamondbacks",
    "ATL": "Atlanta Braves",
    "BAL": "Baltimore Orioles",
    "BOS": "Boston Red Sox",
    "CHC": "Chicago Cubs",
    "CWS": "Chicago White Sox",
    "CIN": "Cincinnati Reds",
    "CLE": "Cleveland Guardians",
    "COL": "Colorado Rockies",
    "DET": "Detroit Tigers",
    "HOU": "Houston Astros",
    "KC": "Kansas City Royals",
    "LAA": "Los Angeles Angels",
    "LAD": "Los Angeles Dodgers",
    "MIA": "Miami Marlins",
    "MIL": "Milwaukee Brewers",
    "MIN": "Minnesota Twins",
    "NYM": "New York Mets",
    "NYY": "New York Yankees",
    "ATH": "Athletics",
    "OAK": "Athletics",
    "PHI": "Philadelphia Phillies",
    "PIT": "Pittsburgh Pirates",
    "SD": "San Diego Padres",
    "SEA": "Seattle Mariners",
    "SF": "San Francisco Giants",
    "STL": "St. Louis Cardinals",
    "TB": "Tampa Bay Rays",
    "TEX": "Texas Rangers",
    "TOR": "Toronto Blue Jays",
    "WSH": "Washington Nationals",
}


def norm_team(x):
    x = str(x or "").lower()

    for c in [
        ".",
        ",",
        "'",
        "’",
        "-",
    ]:
        x = x.replace(c, "")

    x = " ".join(
        x.split()
    )

    aliases = {
        "oakland athletics": "athletics",
    }

    return aliases.get(
        x,
        x
    )


# ============================================================
# KALSHI EVENT PARSER
# ============================================================

ALIASES = sorted(
    TEAM_MAP.keys(),
    key=len,
    reverse=True
)


def parse_event(event_ticker):

    tail = event_ticker.split("-")[-1]

    m = re.match(
        r"^(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})([A-Z]+)$",
        tail
    )

    if not m:
        return None

    yy, mon, dd, hh, mm, blob = m.groups()

    away_code = None
    home_code = None

    for away in ALIASES:

        if not blob.startswith(away):
            continue

        home = blob[len(away):]

        if home in TEAM_MAP:
            away_code = away
            home_code = home
            break

    if away_code is None:
        return None

    month_map = {
        "JAN": 1,
        "FEB": 2,
        "MAR": 3,
        "APR": 4,
        "MAY": 5,
        "JUN": 6,
        "JUL": 7,
        "AUG": 8,
        "SEP": 9,
        "OCT": 10,
        "NOV": 11,
        "DEC": 12,
    }

    return {
        "date": pd.Timestamp(
            year=2000 + int(yy),
            month=month_map[mon],
            day=int(dd),
        ).date(),

        "away_code": away_code,
        "home_code": home_code,

        "away_team": TEAM_MAP[
            away_code
        ],

        "home_team": TEAM_MAP[
            home_code
        ],
    }


# ============================================================
# MLB SCHEDULE
# ============================================================

def get_mlb_schedule(date):

    url = (
        "https://statsapi.mlb.com/"
        "api/v1/schedule"
    )

    r = requests.get(
        url,
        params={
            "sportId": 1,
            "date": str(date),
        },
        timeout=(5, 15),
    )

    r.raise_for_status()

    data = r.json()

    rows = []

    for date_block in data.get(
        "dates",
        []
    ):

        for g in date_block.get(
            "games",
            []
        ):

            away = (
                g.get("teams", {})
                .get("away", {})
                .get("team", {})
                .get("name")
            )

            home = (
                g.get("teams", {})
                .get("home", {})
                .get("team", {})
                .get("name")
            )

            game_date = pd.to_datetime(
                g.get("gameDate"),
                utc=True,
                errors="coerce"
            )

            rows.append({
                "game_pk": g.get(
                    "gamePk"
                ),

                "away_team": away,
                "home_team": home,

                "away_norm":
                    norm_team(away),

                "home_norm":
                    norm_team(home),

                "first_pitch_utc":
                    game_date,

                "status":
                    (
                        g.get(
                            "status",
                            {}
                        )
                        .get(
                            "detailedState"
                        )
                    ),
            })

    return pd.DataFrame(rows)


# ============================================================
# CURRENT KALSHI MARKETS
# ============================================================

def get_live_markets():

    markets = []
    cursor = None

    while True:

        params = {
            "series_ticker": SERIES,
            "limit": 1000,
        }

        if cursor:
            params["cursor"] = cursor

        r = requests.get(
            f"{BASE}/markets",
            params=params,
            timeout=(5, 15),
        )

        r.raise_for_status()

        data = r.json()

        markets.extend(
            data.get(
                "markets",
                []
            )
        )

        cursor = data.get(
            "cursor"
        )

        if not cursor:
            break

    return markets


# ============================================================
# LATEST PREGAME QUOTE
# ============================================================

def get_latest_quote(
    ticker,
    first_pitch,
    now_utc,
):

    # Never retrieve data at or after first pitch.
    cutoff = min(
        now_utc,
        first_pitch
        - pd.Timedelta(seconds=1)
    )

    # If already started, we don't issue a pick.
    if now_utc >= first_pitch:
        return None

    start = cutoff - pd.Timedelta(
        hours=6
    )

    url = (
        f"{BASE}/series/{SERIES}/"
        f"markets/{ticker}/candlesticks"
    )

    params = {
        "start_ts":
            int(start.timestamp()),

        "end_ts":
            int(cutoff.timestamp()),

        "period_interval":
            1,
    }

    try:

        r = requests.get(
            url,
            params=params,
            timeout=(5, 12),
        )

    except requests.RequestException:

        return None

    if r.status_code != 200:
        return None

    candles = (
        r.json()
        .get(
            "candlesticks",
            []
        )
    )

    usable = []

    for c in candles:

        ts = c.get(
            "end_period_ts"
        )

        if ts is None:
            continue

        dt = pd.to_datetime(
            ts,
            unit="s",
            utc=True
        )

        if dt >= first_pitch:
            continue

        bid_raw = (
            c.get(
                "yes_bid",
                {}
            )
            or {}
        ).get(
            "close_dollars"
        )

        ask_raw = (
            c.get(
                "yes_ask",
                {}
            )
            or {}
        ).get(
            "close_dollars"
        )

        try:
            bid = float(
                bid_raw
            )

            ask = float(
                ask_raw
            )

        except:
            continue

        if (
            bid < 0
            or ask > 1
            or ask <= bid
        ):
            continue

        spread = ask - bid

        if spread > MAX_SPREAD:
            continue

        mid = (
            bid + ask
        ) / 2

        age_min = (
            now_utc - dt
        ).total_seconds() / 60

        usable.append({
            "time": dt,
            "bid": bid,
            "ask": ask,
            "mid": mid,
            "spread": spread,
            "age_min": age_min,

            "trade":
                (
                    c.get(
                        "price",
                        {}
                    )
                    or {}
                ).get(
                    "close_dollars"
                ),

            "volume":
                c.get(
                    "volume_fp"
                ),
        })

    if not usable:
        return None

    usable.sort(
        key=lambda x: x["time"]
    )

    return usable[-1]


# ============================================================
# RUN
# ============================================================

now_utc = pd.Timestamp.now(
    tz="UTC"
)

now_local = now_utc.tz_convert(
    LOCAL_TZ
)

today = now_local.date()

print("=" * 108)
print("LIVE MLB F5 SELECTOR — KALSHI V5")
print("=" * 108)

print(
    "\nCurrent local time:",
    now_local.strftime(
        "%Y-%m-%d %I:%M:%S %p %Z"
    )
)


# Get today + tomorrow because late games can
# straddle UTC dates.
schedule = pd.concat(
    [
        get_mlb_schedule(today),
        get_mlb_schedule(
            today
            + timedelta(days=1)
        ),
    ],
    ignore_index=True
)

print(
    "MLB schedule games loaded:",
    len(schedule)
)


markets = get_live_markets()

print(
    "Current KXMLBF5 markets:",
    len(markets)
)


# ============================================================
# GROUP KALSHI BY EVENT
# ============================================================

by_event = defaultdict(list)

for m in markets:

    e = m.get(
        "event_ticker"
    )

    if e:
        by_event[e].append(m)


rows = []


for event, ms in by_event.items():

    if len(ms) < 3:
        continue

    parsed = parse_event(
        event
    )

    if not parsed:
        continue

    # Include today and tomorrow.
    # This allows the evening run to preview tomorrow's board.
    allowed_dates = {
        today,
        today + timedelta(days=1),
    }

    if parsed["date"] not in allowed_dates:
        continue

    away_norm = norm_team(
        parsed["away_team"]
    )

    home_norm = norm_team(
        parsed["home_team"]
    )

    matches = schedule[
        (schedule["away_norm"] == away_norm)
        &
        (schedule["home_norm"] == home_norm)
    ]

    if len(matches) != 1:
        continue

    game = matches.iloc[0]

    game_pk = int(
        game["game_pk"]
    )

    first_pitch = pd.to_datetime(
        game["first_pitch_utc"],
        utc=True
    )

    # Do not produce picks on started games.
    if now_utc >= first_pitch:
        continue

    outcomes = {}

    for m in ms:

        ticker = m.get(
            "ticker",
            ""
        )

        suffix = (
            ticker
            .split("-")[-1]
        )

        if suffix == "TIE":
            label = "TIE"

        elif suffix == parsed[
            "away_code"
        ]:
            label = "AWAY"

        elif suffix == parsed[
            "home_code"
        ]:
            label = "HOME"

        else:
            continue

        q = get_latest_quote(
            ticker,
            first_pitch,
            now_utc
        )

        if q is not None:
            outcomes[label] = q

        time.sleep(
            0.02
        )


    if not all(
        x in outcomes
        for x in [
            "AWAY",
            "HOME",
            "TIE",
        ]
    ):
        continue


    away = outcomes[
        "AWAY"
    ]["mid"]

    home = outcomes[
        "HOME"
    ]["mid"]

    tie = outcomes[
        "TIE"
    ]["mid"]

    raw_sum = (
        away
        + home
        + tie
    )

    if raw_sum <= 0:
        continue


    # Normalize three-way probabilities.
    away_3 = (
        away / raw_sum
    )

    home_3 = (
        home / raw_sum
    )

    tie_3 = (
        tie / raw_sum
    )


    # Conditional on no tie.
    nt = away + home

    if nt <= 0:
        continue

    away_nt = (
        away / nt
    )

    home_nt = (
        home / nt
    )


    if home_nt >= away_nt:

        pick_side = "HOME"
        pick_team = parsed[
            "home_team"
        ]

        confidence = home_nt

    else:

        pick_side = "AWAY"
        pick_team = parsed[
            "away_team"
        ]

        confidence = away_nt


    if confidence >= STRONG_THRESHOLD:
        tier = "STRONG"

    elif confidence >= PLAY_THRESHOLD:
        tier = "PLAY"

    else:
        tier = "PASS"


    quote_time = max(
        outcomes["AWAY"]["time"],
        outcomes["HOME"]["time"],
        outcomes["TIE"]["time"],
    )

    minutes_to_pitch = (
        first_pitch - now_utc
    ).total_seconds() / 60

    quote_age = (
        now_utc - quote_time
    ).total_seconds() / 60


    rows.append({
        "game_pk":
            game_pk,

        "event_ticker":
            event,

        "away_team":
            parsed["away_team"],

        "home_team":
            parsed["home_team"],

        "first_pitch_utc":
            first_pitch,

        "first_pitch_local":
            first_pitch.tz_convert(
                LOCAL_TZ
            ),

        "minutes_to_pitch":
            minutes_to_pitch,

        "kalshi_away_raw":
            away,

        "kalshi_home_raw":
            home,

        "kalshi_tie_raw":
            tie,

        "kalshi_raw_sum":
            raw_sum,

        "kalshi_away_3way":
            away_3,

        "kalshi_home_3way":
            home_3,

        "kalshi_tie_prob":
            tie_3,

        "kalshi_away_prob_no_tie":
            away_nt,

        "kalshi_home_prob_no_tie":
            home_nt,

        "kalshi_pick_side":
            pick_side,

        "kalshi_pick_team":
            pick_team,

        "kalshi_confidence":
            confidence,

        "tier":
            tier,

        "quote_time":
            quote_time,

        "quote_age_minutes":
            quote_age,

        "away_spread":
            outcomes[
                "AWAY"
            ]["spread"],

        "home_spread":
            outcomes[
                "HOME"
            ]["spread"],

        "tie_spread":
            outcomes[
                "TIE"
            ]["spread"],

        "market_status":
            game["status"],
    })


board = pd.DataFrame(
    rows
)


if not len(board):

    print(
        "\nNo complete upcoming Kalshi F5 "
        "markets are currently available."
    )

    raise SystemExit


# ============================================================
# OPTIONAL V3C MERGE
# ============================================================

if V3C_LIVE.exists():

    v = pd.read_csv(
        V3C_LIVE
    )

    v["game_pk"] = pd.to_numeric(
        v["game_pk"],
        errors="coerce"
    ).astype("Int64")

    keep = [
        x
        for x in [
            "game_pk",
            "fusion_home_prob",
            "fusion_predicted_side",
            "fusion_confidence",
        ]
        if x in v.columns
    ]

    board = board.merge(
        v[keep],
        on="game_pk",
        how="left",
        validate="one_to_one",
    )


    if (
        "fusion_predicted_side"
        in board.columns
    ):

        board["v3c_agrees"] = (
            board[
                "fusion_predicted_side"
            ]
            ==
            board[
                "kalshi_pick_side"
            ]
        )

        board["fade_v3c_flag"] = (
            (board["tier"] != "PASS")
            &
            board[
                "fusion_predicted_side"
            ].notna()
            &
            ~board[
                "v3c_agrees"
            ]
        )

else:

    board[
        "fade_v3c_flag"
    ] = False


# ============================================================
# SORT
# ============================================================

tier_rank = {
    "STRONG": 0,
    "PLAY": 1,
    "PASS": 2,
}

board["tier_rank"] = (
    board["tier"]
    .map(tier_rank)
)

board = board.sort_values(
    [
        "tier_rank",
        "kalshi_confidence",
        "first_pitch_utc",
    ],
    ascending=[
        True,
        False,
        True,
    ]
).reset_index(drop=True)


# ============================================================
# OUTPUT
# ============================================================

print("\n" + "=" * 108)
print("TODAY'S F5 BOARD")
print("=" * 108)


for r in board.itertuples():

    fp = pd.Timestamp(
        r.first_pitch_local
    ).strftime(
        "%I:%M %p"
    )

    print(
        "\n"
        + "-" * 108
    )

    print(
        f"{r.away_team} @ "
        f"{r.home_team} | "
        f"{fp}"
    )

    print(
        f"Kalshi: "
        f"{r.kalshi_pick_team} "
        f"{r.kalshi_confidence:.2%}"
    )

    print(
        f"3-way: "
        f"AWAY={r.kalshi_away_3way:.2%} "
        f"HOME={r.kalshi_home_3way:.2%} "
        f"TIE={r.kalshi_tie_prob:.2%}"
    )

    print(
        f"Decision: {r.tier}"
    )

    print(
        f"Quote age: "
        f"{r.quote_age_minutes:.1f} min | "
        f"First pitch in "
        f"{r.minutes_to_pitch:.1f} min"
    )

    if hasattr(
        r,
        "fusion_predicted_side"
    ):

        if pd.notna(
            r.fusion_predicted_side
        ):

            print(
                f"V3C: "
                f"{r.fusion_predicted_side} "
                f"{r.fusion_confidence:.2%}"
            )

            if getattr(
                r,
                "fade_v3c_flag",
                False
            ):

                print(
                    "FLAG: FADE-V3C "
                    "(experimental)"
                )


# ============================================================
# SAVE
# ============================================================

stamp = today.strftime(
    "%Y%m%d"
)

out = (
    OUT_DIR
    / f"kalshi_f5_board_{stamp}.csv"
)

board.drop(
    columns=[
        "tier_rank"
    ],
    errors="ignore"
).to_csv(
    out,
    index=False
)

print("\n" + "=" * 108)

plays = board[
    board["tier"].isin(
        [
            "PLAY",
            "STRONG",
        ]
    )
]

print(
    f"Playable games: "
    f"{len(plays)} / {len(board)}"
)

print(
    "STRONG:",
    int(
        (board["tier"] == "STRONG")
        .sum()
    )
)

print(
    "PLAY:",
    int(
        (board["tier"] == "PLAY")
        .sum()
    )
)

print(
    "PASS:",
    int(
        (board["tier"] == "PASS")
        .sum()
    )
)

print("\nSaved:")
print(out)
