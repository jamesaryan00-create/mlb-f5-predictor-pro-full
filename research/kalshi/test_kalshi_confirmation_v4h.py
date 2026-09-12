from pathlib import Path

import numpy as np
import pandas as pd


V3C = Path("results/v3c_lineup_late_fusion_predictions.csv")
KALSHI = Path("data/kalshi_f5_market_2026_full.csv")

OUT_DEV = Path("results/v4h_kalshi_rule_search_dev.csv")
OUT_VAL = Path("results/v4h_kalshi_validation.csv")


# ============================================================
# LOAD
# ============================================================

v3c = pd.read_csv(V3C)
kal = pd.read_csv(KALSHI)

v3c["game_pk"] = pd.to_numeric(
    v3c["game_pk"],
    errors="coerce"
).astype("Int64")

kal["game_pk"] = pd.to_numeric(
    kal["game_pk"],
    errors="coerce"
).astype("Int64")

kal["game_date"] = pd.to_datetime(kal["game_date"])


# ============================================================
# QUALITY FILTER
#
# Raw 3-way prices should be close to 1.
# Allow a fairly generous 0.95-1.05 band.
# ============================================================

kal = kal[
    kal["kalshi_raw_sum"].between(
        .95,
        1.05
    )
].copy()


# ============================================================
# MERGE
# ============================================================

df = v3c.merge(
    kal,
    on="game_pk",
    how="inner",
    suffixes=("", "_kalshi"),
    validate="one_to_one",
)

# Binary model evaluation excludes F5 ties.
df = df[
    df["f5_result"].isin(
        ["HOME", "AWAY"]
    )
].copy()

df = df.sort_values(
    ["game_date_kalshi", "game_pk"]
).reset_index(drop=True)


# ============================================================
# DERIVED FIELDS
# ============================================================

df["v3c_pick"] = df["fusion_predicted_side"]

df["v3c_correct_test"] = (
    df["v3c_pick"]
    == df["f5_result"]
)

df["kalshi_pick_test"] = np.where(
    df["kalshi_home_prob_no_tie"] >= .5,
    "HOME",
    "AWAY"
)

df["kalshi_conf"] = np.maximum(
    df["kalshi_home_prob_no_tie"],
    1-df["kalshi_home_prob_no_tie"]
)

df["kalshi_correct"] = (
    df["kalshi_pick_test"]
    == df["f5_result"]
)

df["agree"] = (
    df["v3c_pick"]
    == df["kalshi_pick_test"]
)


# ============================================================
# CHRONOLOGICAL SPLIT
#
# First 60% = development
# Last 40%  = untouched validation
# ============================================================

cut = int(
    len(df) * .60
)

dev = df.iloc[:cut].copy()
val = df.iloc[cut:].copy()

print("=" * 100)
print("V4H — KALSHI CONFIRMATION")
print("=" * 100)

print("\nTotal clean non-tie games:", len(df))

print(
    "Development:",
    len(dev),
    dev["game_date_kalshi"].min().date(),
    "->",
    dev["game_date_kalshi"].max().date()
)

print(
    "Validation:",
    len(val),
    val["game_date_kalshi"].min().date(),
    "->",
    val["game_date_kalshi"].max().date()
)


# ============================================================
# DEVELOPMENT BASELINES
# ============================================================

print("\n" + "=" * 100)
print("DEVELOPMENT BASELINES")
print("=" * 100)

print(
    "V3C overall:",
    f"{dev['v3c_correct_test'].mean():.2%}"
)

print(
    "Kalshi overall:",
    f"{dev['kalshi_correct'].mean():.2%}"
)

a = dev[dev["agree"]]
d = dev[~dev["agree"]]

print(
    "Agreement:",
    f"N={len(a)}",
    f"ACC={a['v3c_correct_test'].mean():.2%}"
)

print(
    "Disagreement:",
    f"N={len(d)}",
    f"V3C={d['v3c_correct_test'].mean():.2%}",
    f"Kalshi={d['kalshi_correct'].mean():.2%}"
)


# ============================================================
# VERY LIMITED RULE SEARCH
#
# We deliberately keep this small:
#
# Require:
#   V3C and Kalshi agree
#   V3C confidence >= threshold
#   Kalshi confidence >= threshold
#
# No team filters.
# No month filters.
# No hand-picked exceptions.
# ============================================================

V_THRESHOLDS = [
    .54,
    .55,
    .56,
    .57,
    .58,
]

K_THRESHOLDS = [
    .54,
    .56,
    .58,
    .60,
    .62,
]

rows = []

for vt in V_THRESHOLDS:

    for kt in K_THRESHOLDS:

        mask = (
            dev["agree"]
            &
            (dev["fusion_confidence"] >= vt)
            &
            (dev["kalshi_conf"] >= kt)
        )

        x = dev[mask]

        # Avoid choosing tiny lucky samples.
        if len(x) < 40:
            continue

        acc = x["v3c_correct_test"].mean()

        # Approximate 90% lower confidence bound.
        se = np.sqrt(
            max(
                acc * (1-acc),
                1e-9
            )
            / len(x)
        )

        lower90 = (
            acc
            - 1.645 * se
        )

        rows.append({
            "v3c_min": vt,
            "kalshi_min": kt,
            "N": len(x),
            "coverage": len(x) / len(dev),
            "accuracy": acc,
            "lower90": lower90,
        })


res = pd.DataFrame(rows)

res = res.sort_values(
    [
        "lower90",
        "accuracy",
        "N",
    ],
    ascending=[
        False,
        False,
        False,
    ]
).reset_index(drop=True)


print("\n" + "=" * 100)
print("DEVELOPMENT RULE SEARCH")
print("=" * 100)

print(
    res.to_string(
        index=False,
        formatters={
            "coverage":
                lambda x: f"{x:.1%}",
            "accuracy":
                lambda x: f"{x:.2%}",
            "lower90":
                lambda x: f"{x:.2%}",
        }
    )
)


if len(res) == 0:
    raise RuntimeError(
        "No development rules met minimum sample size."
    )


winner = res.iloc[0]

VT = float(winner["v3c_min"])
KT = float(winner["kalshi_min"])


print("\n" + "=" * 100)
print("FROZEN WITHOUT LOOKING AT VALIDATION")
print("=" * 100)

print("V3C >=", VT)
print("Kalshi >=", KT)
print("Must agree: YES")

print(
    "Development:",
    f"N={int(winner['N'])}",
    f"ACC={winner['accuracy']:.2%}",
    f"lower90={winner['lower90']:.2%}"
)


# ============================================================
# UNTOUCHED VALIDATION
# ============================================================

qualify = (
    val["agree"]
    &
    (val["fusion_confidence"] >= VT)
    &
    (val["kalshi_conf"] >= KT)
)

q = val[qualify].copy()


print("\n" + "=" * 100)
print("UNTOUCHED VALIDATION")
print("=" * 100)

print(
    "Validation games:",
    len(val)
)

print(
    "V3C overall:",
    f"{val['v3c_correct_test'].mean():.2%}"
)

print(
    "Kalshi overall:",
    f"{val['kalshi_correct'].mean():.2%}"
)


# Same-period standalone confidence checks for context.
print("\nKalshi validation thresholds:")

for t in [
    .54,
    .56,
    .58,
    .60,
    .62,
]:

    x = val[
        val["kalshi_conf"] >= t
    ]

    if len(x):
        print(
            f">={t:.2f}: "
            f"N={len(x):3d} "
            f"ACC={x['kalshi_correct'].mean():6.2%}"
        )


print("\nFROZEN RULE RESULT")

print(
    "Qualified:",
    len(q)
)

print(
    "Coverage:",
    f"{len(q)/len(val):.2%}"
)

if len(q):

    wins = int(
        q["v3c_correct_test"].sum()
    )

    losses = len(q) - wins

    print(
        "Record:",
        f"{wins}-{losses}"
    )

    print(
        "Accuracy:",
        f"{q['v3c_correct_test'].mean():.2%}"
    )


# ============================================================
# AGREEMENT AUDIT IN VALIDATION
# ============================================================

print("\nVALIDATION AGREEMENT AUDIT")

a = val[val["agree"]]
d = val[~val["agree"]]

print(
    "Agree:",
    f"N={len(a):3d}",
    f"ACC={a['v3c_correct_test'].mean():6.2%}"
)

print(
    "Disagree:",
    f"N={len(d):3d}",
    f"V3C={d['v3c_correct_test'].mean():6.2%}",
    f"Kalshi={d['kalshi_correct'].mean():6.2%}"
)


# ============================================================
# SAVE
# ============================================================

OUT_DEV.parent.mkdir(
    exist_ok=True
)

res.to_csv(
    OUT_DEV,
    index=False
)

val["v4h_qualified"] = qualify

val.to_csv(
    OUT_VAL,
    index=False
)

print("\nSaved:")
print(OUT_DEV)
print(OUT_VAL)
