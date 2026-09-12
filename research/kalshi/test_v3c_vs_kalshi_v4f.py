from pathlib import Path
import numpy as np
import pandas as pd


V3C = Path("results/v3c_lineup_late_fusion_predictions.csv")
KALSHI = Path("data/kalshi_f5_market_2026_sample500.csv")

OUT = Path("results/v4f_v3c_vs_kalshi.csv")


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


# ============================================================
# MERGE SAME GAMES ONLY
# ============================================================

df = v3c.merge(
    kal,
    on="game_pk",
    how="inner",
    suffixes=("", "_kalshi"),
    validate="one_to_one",
)

print("=" * 100)
print("V4F — V3C vs KALSHI F5 MARKET")
print("=" * 100)

print("\nMatched games:", len(df))

if not len(df):
    raise RuntimeError("No matched games.")


# ============================================================
# KEEP NON-TIE OUTCOMES
# V3C is a binary HOME/AWAY model.
# ============================================================

df = df[
    df["f5_result"].isin(["HOME", "AWAY"])
].copy()

print("Non-tie games:", len(df))


# ============================================================
# V3C
# ============================================================

df["v3c_pick"] = df["fusion_predicted_side"]

df["v3c_correct_test"] = (
    df["v3c_pick"]
    == df["f5_result"]
)


# ============================================================
# KALSHI
# ============================================================

df["kalshi_pick_test"] = np.where(
    df["kalshi_home_prob_no_tie"] >= .5,
    "HOME",
    "AWAY"
)

df["kalshi_correct"] = (
    df["kalshi_pick_test"]
    == df["f5_result"]
)

df["kalshi_conf_test"] = np.maximum(
    df["kalshi_home_prob_no_tie"],
    1-df["kalshi_home_prob_no_tie"]
)


# ============================================================
# AGREEMENT
# ============================================================

df["agree"] = (
    df["v3c_pick"]
    == df["kalshi_pick_test"]
)


# ============================================================
# OVERALL
# ============================================================

print("\n" + "=" * 100)
print("OVERALL — SAME GAMES")
print("=" * 100)

print(
    "V3C:",
    f"N={len(df):4d}",
    f"ACC={df['v3c_correct_test'].mean():6.2%}"
)

print(
    "KALSHI:",
    f"N={len(df):4d}",
    f"ACC={df['kalshi_correct'].mean():6.2%}"
)


# ============================================================
# KALSHI CONFIDENCE
# ============================================================

print("\n" + "=" * 100)
print("KALSHI CONFIDENCE")
print("=" * 100)

for t in [
    .50,
    .52,
    .54,
    .55,
    .56,
    .58,
    .60,
    .62,
    .65,
    .70,
]:

    x = df[
        df["kalshi_conf_test"] >= t
    ]

    if len(x):

        print(
            f">={t:.2f}: "
            f"N={len(x):4d} "
            f"coverage={len(x)/len(df):6.1%} "
            f"ACC={x['kalshi_correct'].mean():6.2%}"
        )


# ============================================================
# V3C SAME SAMPLE
# ============================================================

print("\n" + "=" * 100)
print("V3C CONFIDENCE — SAME SAMPLE")
print("=" * 100)

for t in [
    .55,
    .56,
    .57,
    .58,
    .59,
    .60,
    .62,
]:

    x = df[
        df["fusion_confidence"] >= t
    ]

    if len(x):

        print(
            f">={t:.2f}: "
            f"N={len(x):4d} "
            f"ACC={x['v3c_correct_test'].mean():6.2%}"
        )


# ============================================================
# AGREEMENT / DISAGREEMENT
# ============================================================

print("\n" + "=" * 100)
print("V3C × KALSHI AGREEMENT")
print("=" * 100)

a = df[df["agree"]]
d = df[~df["agree"]]

print(
    "AGREE:",
    f"N={len(a):4d}",
    f"ACC={a['v3c_correct_test'].mean():6.2%}"
)

print(
    "DISAGREE:",
    f"N={len(d):4d}",
    f"V3C_ACC={d['v3c_correct_test'].mean():6.2%}",
    f"KALSHI_ACC={d['kalshi_correct'].mean():6.2%}"
)


# ============================================================
# V3C THRESHOLD + KALSHI AGREEMENT
# ============================================================

print("\n" + "=" * 100)
print("V3C CONFIDENCE + KALSHI CONFIRMATION")
print("=" * 100)

for vt in [
    .55,
    .56,
    .57,
    .58,
    .59,
    .60,
]:

    base = df[
        df["fusion_confidence"] >= vt
    ]

    agree = base[
        base["agree"]
    ]

    disagree = base[
        ~base["agree"]
    ]

    print(f"\nV3C >= {vt:.2f}")

    if len(base):
        print(
            f"ALL:      "
            f"N={len(base):4d} "
            f"ACC={base['v3c_correct_test'].mean():6.2%}"
        )

    if len(agree):
        print(
            f"AGREE:    "
            f"N={len(agree):4d} "
            f"ACC={agree['v3c_correct_test'].mean():6.2%}"
        )

    if len(disagree):
        print(
            f"DISAGREE: "
            f"N={len(disagree):4d} "
            f"ACC={disagree['v3c_correct_test'].mean():6.2%}"
        )


# ============================================================
# BOTH CONFIDENT + AGREE
# ============================================================

print("\n" + "=" * 100)
print("BOTH CONFIDENT + AGREE")
print("=" * 100)

for vt in [
    .55,
    .56,
    .58,
    .60,
]:

    for kt in [
        .52,
        .54,
        .55,
        .56,
        .58,
        .60,
        .62,
        .65,
    ]:

        x = df[
            df["agree"]
            &
            (df["fusion_confidence"] >= vt)
            &
            (df["kalshi_conf_test"] >= kt)
        ]

        if len(x) < 5:
            continue

        print(
            f"V3C>={vt:.2f} "
            f"KALSHI>={kt:.2f} "
            f"N={len(x):3d} "
            f"ACC={x['v3c_correct_test'].mean():6.2%}"
        )


# ============================================================
# MARKET SUPPORT FOR V3C PICK
# ============================================================

df["kalshi_prob_for_v3c_pick"] = np.where(
    df["v3c_pick"] == "HOME",
    df["kalshi_home_prob_no_tie"],
    1-df["kalshi_home_prob_no_tie"]
)

print("\n" + "=" * 100)
print("KALSHI SUPPORT FOR V3C PICK")
print("=" * 100)

for kp in [
    .50,
    .52,
    .54,
    .55,
    .56,
    .58,
    .60,
    .62,
    .65,
]:

    x = df[
        (df["fusion_confidence"] >= .58)
        &
        (df["kalshi_prob_for_v3c_pick"] >= kp)
    ]

    if len(x) >= 5:

        print(
            f"V3C>=.58 + "
            f"Kalshi pick prob>={kp:.2f}: "
            f"N={len(x):3d} "
            f"ACC={x['v3c_correct_test'].mean():6.2%}"
        )


# ============================================================
# SAVE
# ============================================================

OUT.parent.mkdir(exist_ok=True)

df.to_csv(
    OUT,
    index=False
)

print("\nSaved:")
print(OUT)
