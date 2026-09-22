# Review fixes

- Primary model-forward and historical backtest win rates include ties. Decided-only rates remain explicitly labeled.
- Existing predictions remain untouched. Prior grade files are archived in data/model-forward/grade-history; outcomes are reclassified by provenance without changing scores.
- September 15 backfill is retrospective. Other existing records lack model/input snapshots and are legacy-unverified. Neither enters the verified primary cohort.
- New picks carry the model, hash, feature vector, feature cutoff, pitcher IDs, imputed-feature list and capture time. A fresh schedule, starter identity and first-pitch check runs after data collection. Grading verifies provenance and rejects changed/resumed game identities.
- Summaries separate model hashes as well as retrospective and legacy cohorts.
- Live missing pitcher DIFFERENCES use explicit neutral-zero imputation, matching existing training. No source pitcher statistics are invented. Model coefficients were not retrained or changed.
- Live pitcher windows span prior seasons back to 2010 to match historical last-ten-start aggregation. Missing/malformed source counts reject the pitcher lookup.
- Kalshi V5 keeps all 58%+ selections regardless of model agreement. Agreement remains diagnostic.
- Original model/backtest artifacts are in data/archive/pre-review-fix-20260919. Only rate/reporting metadata changed.
- Codex heartbeat now points to this web-app directory. User crontab could not be inspected due to OS permission restrictions and was not changed.

Validation: 41 tests passed; Next production build passed; saved 32,291-game backtest independently recomputed at 47.69% including ties. No research experiments were rerun and no new predictive improvement is claimed.
