"""Operational validation for completed one-minute candles, not trading tiers."""
from datetime import datetime, timezone
import math
MAX_QUOTE_AGE_MINUTES = 5
MAX_QUOTE_SKEW_MINUTES = 1

def select_latest_quote(candles, first_pitch, now, max_spread=0.15):
    eligible = []
    for candle in candles:
        try:
            dt = datetime.fromtimestamp(float(candle['end_period_ts']), timezone.utc)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
        if dt <= now and dt < first_pitch:
            eligible.append((dt, candle))
    if now >= first_pitch or not eligible:
        return None
    dt, candle = max(eligible, key=lambda row: row[0])
    age = (now - dt).total_seconds() / 60
    if age > MAX_QUOTE_AGE_MINUTES:
        return None
    try:
        bid = float((candle.get('yes_bid') or {})['close_dollars'])
        ask = float((candle.get('yes_ask') or {})['close_dollars'])
    except (KeyError, TypeError, ValueError):
        return None
    if not all(map(math.isfinite, [bid, ask])) or bid < 0 or ask > 1 or ask <= bid:
        return None
    spread = ask - bid
    if spread > max_spread + 1e-9:
        return None
    return {'time': dt, 'bid': bid, 'ask': ask, 'mid': (bid + ask) / 2,
            'spread': spread, 'age_min': age}

def quote_set_valid(quotes, now):
    if len(quotes) != 3 or any(q is None for q in quotes):
        return False
    times = [q['time'] for q in quotes]
    return (0 <= (now - min(times)).total_seconds() / 60 <= MAX_QUOTE_AGE_MINUTES
            and (max(times) - min(times)).total_seconds() / 60 <= MAX_QUOTE_SKEW_MINUTES)
