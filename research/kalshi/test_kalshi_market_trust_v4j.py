from pathlib import Path
import itertools
import numpy as np
import pandas as pd


V3C = Path("results/v3c_lineup_late_fusion_predictions.csv")
KAL = Path("data/kalshi_f5_market_2026_full.csv")

OUT_RULES = Path("results/v4j_market_trust_rules.csv")
OUT_GAMES = Path("results/v4j_market_trust_games.csv")


# ============================================================
# HELPERS
# ============================================================

def lower90(acc, n):
    if n <= 0:
        return np.nan

    se = np.sqrt(
        max(acc * (1-acc), 1e-9) / n
    )

    return acc - 1.645 * se


def find_col(df, names):
    for c in names:
        if c in df.columns:
            return c
    return None


# ============================================================
# LOAD
# ============================================================

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


# ============================================================
# CLEAN KALSHI SNAPSHOTS
# ============================================================

kal = kal[
    kal["kalshi_raw_sum"].between(.95, 1.05)
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

df = df[
    df["f5_result"].isin(
        ["HOME", "AWAY"]
    )
].copy()

df["date"] = pd.to_datetime(
    df["game_date_kalshi"]
)

df = df.sort_values(
    ["date", "game_pk"]
).reset_index(drop=True)


# ============================================================
# KALSHI
# ============================================================

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


# ============================================================
# V3C
# ============================================================

df["v3c_pick"] = df["fusion_predicted_side"]

df["v3c_correct"] = (
    df["v3c_pick"]
    == df["f5_result"]
)

df["v3c_agrees"] = (
    df["v3c_pick"]
    == df["kalshi_pick"]
)


# Probability V3C assigns to Kalshi's selected side.
df["v3c_prob_for_kalshi"] = np.where(
    df["kalshi_pick"] == "HOME",
    df["fusion_home_prob"],
    1-df["fusion_home_prob"]
)

df["v3c_support_margin"] = (
    df["v3c_prob_for_kalshi"] - .5
)


# ============================================================
# MARKET QUALITY FEATURES
# ============================================================

df["max_spread"] = df[
    [
        "away_spread",
        "home_spread",
        "tie_spread",
    ]
].max(axis=1)

df["mean_spread"] = df[
    [
        "away_spread",
        "home_spread",
        "tie_spread",
    ]
].mean(axis=1)

df["raw_sum_error"] = (
    df["kalshi_raw_sum"] - 1.0
).abs()


# ============================================================
# COMPONENT PROBABILITIES
#
# Detect whichever names exist in your V3C output.
# ============================================================

component_candidates = {
    "pitch": [
        "pitch_home_prob",
        "v21c_pitch_home_prob",
    ],

    "hand": [
        "hand_home_prob",
    ],

    "stat": [
        "stat_home_prob",
        "statcast_home_prob",
    ],

    "lineup": [
        "lineup_home_prob",
    ],
}

component_cols = {}

for name, candidates in component_candidates.items():

    c = find_col(df, candidates)

    if c is not None:
        component_cols[name] = c


print("=" * 105)
print("V4J — KALSHI MARKET TRUST AUDIT")
print("=" * 105)

print("\nDetected component probabilities:")

if component_cols:
    for name, col in component_cols.items():
        print(f"{name:10s} -> {col}")
else:
    print("None found — audit will use V3C aggregate + market quality.")


for name, col in component_cols.items():

    support_col = f"{name}_prob_for_kalshi"

    df[support_col] = np.where(
        df["kalshi_pick"] == "HOME",
        df[col],
        1-df[col]
    )

    df[f"{name}_agrees"] = (
        df[support_col] >= .5
    )


if component_cols:

    agree_cols = [
        f"{name}_agrees"
        for name in component_cols
    ]

    df["component_agree_count"] = (
        df[agree_cols]
        .astype(int)
        .sum(axis=1)
    )

    df["component_agree_fraction"] = (
        df["component_agree_count"]
        / len(agree_cols)
    )


# ============================================================
# PRIMARY MARKET REGION
# ============================================================

plays = df[
    df["kalshi_conf"] >= .58
].copy()

print("\nTotal clean games:", len(df))
print("Kalshi >= .58:", len(plays))

print(
    "Baseline:",
    f"{plays['kalshi_correct'].mean():.2%}",
    f"record={int(plays['kalshi_correct'].sum())}-"
    f"{len(plays)-int(plays['kalshi_correct'].sum())}"
)


# ============================================================
# CHRONOLOGICAL DISCOVERY / CONFIRMATION SPLIT
# ============================================================

cut = int(len(plays) * .60)

dev = plays.iloc[:cut].copy()
val = plays.iloc[cut:].copy()

print("\nDiscovery:")
print(
    len(dev),
    dev["date"].min().date(),
    "->",
    dev["date"].max().date()
)

print("Later confirmation:")
print(
    len(val),
    val["date"].min().date(),
    "->",
    val["date"].max().date()
)


# ============================================================
# WINNERS VS LOSERS — DISCOVERY ONLY
# ============================================================

features = [
    "kalshi_conf",
    "kalshi_tie_prob",
    "max_spread",
    "mean_spread",
    "raw_sum_error",
    "minutes_before_first_pitch",
    "v3c_prob_for_kalshi",
    "v3c_support_margin",
]

if "component_agree_fraction" in df.columns:
    features.append(
        "component_agree_fraction"
    )


print("\n" + "=" * 105)
print("DISCOVERY — WINNERS VS LOSERS")
print("=" * 105)

summary_rows = []

for feature in features:

    good = dev.loc[
        dev["kalshi_correct"],
        feature
    ].dropna()

    bad = dev.loc[
        ~dev["kalshi_correct"],
        feature
    ].dropna()

    if not len(good) or not len(bad):
        continue

    row = {
        "feature": feature,

        "win_mean":
            good.mean(),

        "loss_mean":
            bad.mean(),

        "win_median":
            good.median(),

        "loss_median":
            bad.median(),

        "mean_diff":
            good.mean() - bad.mean(),
    }

    summary_rows.append(row)


summary = pd.DataFrame(summary_rows)

print(
    summary.round(4).to_string(
        index=False
    )
)


# ============================================================
# UNIVARIATE MARKET QUALITY AUDIT
# ============================================================

print("\n" + "=" * 105)
print("DISCOVERY — SIMPLE FILTERS")
print("=" * 105)


tests = []


def add_test(name, mask):

    x = dev[mask]

    if len(x) < 20:
        return

    acc = x["kalshi_correct"].mean()

    tests.append({
        "rule": name,
        "N": len(x),
        "coverage": len(x) / len(dev),
        "accuracy": acc,
        "lower90": lower90(
            acc,
            len(x)
        ),
    })


# Spread quality
for t in [
    .01,
    .02,
    .03,
    .04,
    .05,
    .07,
    .10,
]:

    add_test(
        f"max_spread <= {t:.2f}",
        dev["max_spread"] <= t
    )


# Quote freshness
for t in [
    1,
    2,
    3,
    5,
    10,
]:

    add_test(
        f"minutes_before <= {t}",
        dev["minutes_before_first_pitch"] <= t
    )


# Raw sum quality
for t in [
    .005,
    .010,
    .015,
    .020,
    .030,
]:

    add_test(
        f"raw_sum_error <= {t:.3f}",
        dev["raw_sum_error"] <= t
    )


# Tie probability
for low, high in [
    (.00, .12),
    (.10, .15),
    (.12, .18),
    (.15, .20),
    (.10, .20),
    (.12, .22),
]:

    add_test(
        f"tie {low:.2f}-{high:.2f}",
        dev["kalshi_tie_prob"].between(
            low,
            high
        )
    )


# V3C relationship
add_test(
    "V3C agrees",
    dev["v3c_agrees"]
)

add_test(
    "V3C disagrees",
    ~dev["v3c_agrees"]
)


for p in [
    .40,
    .45,
    .48,
    .50,
    .52,
    .54,
    .56,
]:

    add_test(
        f"V3C prob for Kalshi >= {p:.2f}",
        dev["v3c_prob_for_kalshi"] >= p
    )


if "component_agree_fraction" in dev.columns:

    for t in [
        .25,
        .50,
        .75,
        1.00,
    ]:

        add_test(
            f"component agree >= {t:.2f}",
            dev["component_agree_fraction"] >= t
        )


tests_df = pd.DataFrame(tests)

tests_df = tests_df.sort_values(
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


print(
    tests_df.head(40).to_string(
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


# ============================================================
# LIMITED TWO-FACTOR MARKET QUALITY SEARCH
#
# No team names.
# No months.
# No individual pitcher filters.
# ============================================================

print("\n" + "=" * 105)
print("DISCOVERY — TWO-FACTOR TRUST RULES")
print("=" * 105)


spread_limits = [
    .02,
    .03,
    .04,
    .05,
]

tie_ranges = [
    (.10, .20),
    (.12, .20),
    (.12, .22),
    (.00, .22),
]

v3c_modes = [
    "ANY",
    "AGREE",
    "DISAGREE",
]

rule_rows = []


for spread_max, tie_range, vmode in itertools.product(
    spread_limits,
    tie_ranges,
    v3c_modes
):

    low, high = tie_range

    mask = (
        (dev["max_spread"] <= spread_max)
        &
        dev["kalshi_tie_prob"].between(
            low,
            high
        )
    )

    if vmode == "AGREE":
        mask &= dev["v3c_agrees"]

    elif vmode == "DISAGREE":
        mask &= ~dev["v3c_agrees"]


    x = dev[mask]

    if len(x) < 30:
        continue

    acc = x["kalshi_correct"].mean()

    rule_rows.append({
        "spread_max":
            spread_max,

        "tie_low":
            low,

        "tie_high":
            high,

        "v3c_mode":
            vmode,

        "N":
            len(x),

        "coverage":
            len(x) / len(dev),

        "accuracy":
            acc,

        "lower90":
            lower90(
                acc,
                len(x)
            ),
    })


rules = pd.DataFrame(rule_rows)

if len(rules):

    rules = rules.sort_values(
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

    print(
        rules.head(30).to_string(
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


# ============================================================
# FREEZE TOP SIMPLE TWO-FACTOR RULE
# ============================================================

if len(rules):

    winner = rules.iloc[0]

    spread_max = float(
        winner["spread_max"]
    )

    tie_low = float(
        winner["tie_low"]
    )

    tie_high = float(
        winner["tie_high"]
    )

    vmode = winner["v3c_mode"]

    print("\n" + "=" * 105)
    print("FROZEN DISCOVERY RULE")
    print("=" * 105)

    print(
        "Kalshi >= 0.58"
    )

    print(
        "max spread <=",
        spread_max
    )

    print(
        "tie probability:",
        tie_low,
        "to",
        tie_high
    )

    print(
        "V3C relationship:",
        vmode
    )

    print(
        "Discovery:",
        f"N={int(winner['N'])}",
        f"ACC={winner['accuracy']:.2%}",
        f"lower90={winner['lower90']:.2%}"
    )


    mask = (
        (val["max_spread"] <= spread_max)
        &
        val["kalshi_tie_prob"].between(
            tie_low,
            tie_high
        )
    )

    if vmode == "AGREE":
        mask &= val["v3c_agrees"]

    elif vmode == "DISAGREE":
        mask &= ~val["v3c_agrees"]


    q = val[mask].copy()


    print("\n" + "=" * 105)
    print("LATER-PERIOD CONFIRMATION")
    print("=" * 105)

    print(
        "Baseline Kalshi >=.58:",
        f"N={len(val)}",
        f"ACC={val['kalshi_correct'].mean():.2%}"
    )

    print(
        "Qualified:",
        len(q)
    )

    if len(q):

        wins = int(
            q["kalshi_correct"].sum()
        )

        print(
            "Record:",
            f"{wins}-{len(q)-wins}"
        )

        print(
            "Accuracy:",
            f"{q['kalshi_correct'].mean():.2%}"
        )

        print(
            "Coverage:",
            f"{len(q)/len(val):.2%}"
        )


# ============================================================
# SPECIFIC FADE-V3C AUDIT
# ============================================================

print("\n" + "=" * 105)
print("FADE V3C AUDIT")
print("=" * 105)

for t in [
    .58,
    .60,
    .62,
]:

    x = df[
        df["kalshi_conf"] >= t
    ]

    for agrees, label in [
        (True, "V3C AGREES"),
        (False, "V3C DISAGREES"),
    ]:

        q = x[
            x["v3c_agrees"] == agrees
        ]

        if not len(q):
            continue

        wins = int(
            q["kalshi_correct"].sum()
        )

        print(
            f"Kalshi>={t:.2f} "
            f"{label:15s} "
            f"N={len(q):3d} "
            f"Record={wins}-{len(q)-wins} "
            f"KalshiACC="
            f"{q['kalshi_correct'].mean():6.2%}"
        )


# ============================================================
# DIRECTIONAL FADE
# ============================================================

print("\n" + "=" * 105)
print("DIRECTIONAL DISAGREEMENT")
print("=" * 105)

dis = df[
    ~df["v3c_agrees"]
    &
    (df["kalshi_conf"] >= .58)
].copy()


for market_pick in [
    "HOME",
    "AWAY",
]:

    q = dis[
        dis["kalshi_pick"] == market_pick
    ]

    if not len(q):
        continue

    wins = int(
        q["kalshi_correct"].sum()
    )

    print(
        f"Kalshi {market_pick:4s} / "
        f"V3C opposite "
        f"N={len(q):3d} "
        f"Record={wins}-{len(q)-wins} "
        f"ACC={q['kalshi_correct'].mean():6.2%}"
    )


# ============================================================
# SAVE
# ============================================================

OUT_RULES.parent.mkdir(
    exist_ok=True
)

if len(rules):
    rules.to_csv(
        OUT_RULES,
        index=False
    )

df.to_csv(
    OUT_GAMES,
    index=False
)

print("\nSaved:")
print(OUT_RULES)
print(OUT_GAMES)
