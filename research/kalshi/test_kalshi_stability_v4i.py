from pathlib import Path
import numpy as np
import pandas as pd


V3C = Path("results/v3c_lineup_late_fusion_predictions.csv")
KAL = Path("data/kalshi_f5_market_2026_full.csv")

v3c = pd.read_csv(V3C)
kal = pd.read_csv(KAL)

v3c["game_pk"] = pd.to_numeric(
    v3c["game_pk"],
    errors="coerce"
).astype("Int64")

kal["game_pk"] = pd.to_numeric(
    kal["game_pk"],
    errors="coerce"
).astype("Int64")

kal["game_date"] = pd.to_datetime(
    kal["game_date"]
)

# Clean market snapshots.
kal = kal[
    kal["kalshi_raw_sum"].between(.95, 1.05)
].copy()

df = v3c.merge(
    kal,
    on="game_pk",
    how="inner",
    suffixes=("", "_kalshi"),
    validate="one_to_one",
)

df = df[
    df["f5_result"].isin(["HOME", "AWAY"])
].copy()

df["date"] = pd.to_datetime(
    df["game_date_kalshi"]
)

df["kalshi_pick"] = np.where(
    df["kalshi_home_prob_no_tie"] >= .5,
    "HOME",
    "AWAY"
)

df["kalshi_conf"] = np.maximum(
    df["kalshi_home_prob_no_tie"],
    1-df["kalshi_home_prob_no_tie"]
)

df["kalshi_correct"] = (
    df["kalshi_pick"]
    == df["f5_result"]
)

df["v3c_pick"] = df["fusion_predicted_side"]

df["v3c_correct"] = (
    df["v3c_pick"]
    == df["f5_result"]
)

df["agree"] = (
    df["kalshi_pick"]
    == df["v3c_pick"]
)

# Monday-based weekly buckets.
df["week"] = (
    df["date"]
    .dt.to_period("W-SUN")
    .astype(str)
)

print("=" * 100)
print("V4I — KALSHI F5 STABILITY AUDIT")
print("=" * 100)

print("\nGames:", len(df))
print(
    "Dates:",
    df["date"].min().date(),
    "->",
    df["date"].max().date()
)

print("\nOVERALL THRESHOLDS")
print("-" * 100)

thresholds = [
    .50,
    .52,
    .54,
    .56,
    .58,
    .60,
    .62,
    .64,
    .65,
]

for t in thresholds:

    x = df[
        df["kalshi_conf"] >= t
    ]

    if len(x):

        wins = int(
            x["kalshi_correct"].sum()
        )

        print(
            f">={t:.2f} "
            f"N={len(x):4d} "
            f"Record={wins}-{len(x)-wins} "
            f"ACC={x['kalshi_correct'].mean():6.2%}"
        )


print("\n" + "=" * 100)
print("WEEKLY PERFORMANCE")
print("=" * 100)

for t in [
    .56,
    .58,
    .60,
    .62,
]:

    x = df[
        df["kalshi_conf"] >= t
    ].copy()

    weekly = (
        x.groupby("week")
        .agg(
            N=("kalshi_correct", "size"),
            wins=("kalshi_correct", "sum"),
            accuracy=("kalshi_correct", "mean"),
            avg_conf=("kalshi_conf", "mean"),
        )
    )

    weekly["accuracy"] *= 100
    weekly["avg_conf"] *= 100

    print(f"\nKALSHI >= {t:.2f}")
    print("-" * 75)

    print(
        weekly.round(2).to_string()
    )


print("\n" + "=" * 100)
print("MONTH / HALF-MONTH STABILITY")
print("=" * 100)

df["period"] = np.where(
    df["date"].dt.day <= 15,
    df["date"].dt.strftime("%Y-%m") + " H1",
    df["date"].dt.strftime("%Y-%m") + " H2",
)

for t in [
    .56,
    .58,
    .60,
    .62,
]:

    x = df[
        df["kalshi_conf"] >= t
    ]

    summary = (
        x.groupby("period")
        .agg(
            N=("kalshi_correct", "size"),
            wins=("kalshi_correct", "sum"),
            accuracy=("kalshi_correct", "mean"),
        )
    )

    summary["accuracy"] *= 100

    print(f"\nKALSHI >= {t:.2f}")

    print(
        summary.round(2).to_string()
    )


# ============================================================
# CONFIDENCE CALIBRATION
# ============================================================

print("\n" + "=" * 100)
print("KALSHI CONFIDENCE BANDS")
print("=" * 100)

bins = [
    .50,
    .54,
    .56,
    .58,
    .60,
    .62,
    .65,
    .70,
    1.01,
]

labels = [
    ".50-.54",
    ".54-.56",
    ".56-.58",
    ".58-.60",
    ".60-.62",
    ".62-.65",
    ".65-.70",
    ".70+",
]

df["conf_band"] = pd.cut(
    df["kalshi_conf"],
    bins=bins,
    labels=labels,
    right=False,
)

bands = (
    df.groupby(
        "conf_band",
        observed=True
    )
    .agg(
        N=("kalshi_correct", "size"),
        wins=("kalshi_correct", "sum"),
        accuracy=("kalshi_correct", "mean"),
        avg_conf=("kalshi_conf", "mean"),
    )
)

bands["accuracy"] *= 100
bands["avg_conf"] *= 100

print(
    bands.round(2).to_string()
)


# ============================================================
# AGREEMENT IS SECONDARY ONLY
# ============================================================

print("\n" + "=" * 100)
print("KALSHI PERFORMANCE BY V3C AGREEMENT")
print("=" * 100)

for t in [
    .50,
    .56,
    .58,
    .60,
    .62,
]:

    x = df[
        df["kalshi_conf"] >= t
    ]

    print(f"\nKalshi >= {t:.2f}")

    for agree_value, label in [
        (True, "V3C AGREES"),
        (False, "V3C DISAGREES"),
    ]:

        q = x[
            x["agree"] == agree_value
        ]

        if len(q):

            print(
                f"{label:15s} "
                f"N={len(q):4d} "
                f"Kalshi ACC="
                f"{q['kalshi_correct'].mean():6.2%}"
            )


# ============================================================
# BOOTSTRAP UNCERTAINTY
# ============================================================

print("\n" + "=" * 100)
print("BOOTSTRAP 95% INTERVALS")
print("=" * 100)

rng = np.random.default_rng(42)

for t in [
    .56,
    .58,
    .60,
    .62,
]:

    vals = (
        df.loc[
            df["kalshi_conf"] >= t,
            "kalshi_correct"
        ]
        .astype(int)
        .to_numpy()
    )

    if len(vals) < 10:
        continue

    boot = []

    for _ in range(10000):

        sample = rng.choice(
            vals,
            size=len(vals),
            replace=True
        )

        boot.append(
            sample.mean()
        )

    lo, hi = np.quantile(
        boot,
        [.025, .975]
    )

    print(
        f">={t:.2f} "
        f"N={len(vals):4d} "
        f"ACC={vals.mean():6.2%} "
        f"95% CI="
        f"[{lo:.2%}, {hi:.2%}]"
    )
