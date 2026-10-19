# Independent NumPy, SciPy, statsmodels, and lifelines golden references.
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy==2.2.6", "scipy==1.15.3", "lifelines==0.30.0", "statsmodels==0.14.4"]
# ///
from itertools import product
from pathlib import Path
import json
import platform

import lifelines
import numpy as np
import scipy
import statsmodels
from lifelines import AalenJohansenFitter, KaplanMeierFitter
from scipy import stats
from statsmodels.stats.multitest import multipletests


def survival_reference(times, causes):
    """Use lifelines, expanding tied events before censoring without changing group hazards."""
    times_array = np.array(times, dtype=float)
    causes_array = np.array(causes)
    timeline = np.unique(times_array)
    km = KaplanMeierFitter().fit(times_array, causes_array != 0)
    steps = []
    for t in timeline:
        row = km.event_table.loc[t]
        steps.append({"t": float(t), "survival": float(km.predict(t)),
                      "atRisk": int(row.at_risk), "events": int(row.observed),
                      "censored": int(row.censored)})

    # AJ in lifelines 0.30.0 jitters ties between distinct causes randomly, potentially
    # moving events after same-time censors. Instead, expand ALL tied events into
    # distinct times immediately before t, leaving censors at t. At each substep,
    # S_j / Y_j = S_before / Y_before, so summing cause-specific increments gives
    # exactly S_before * d_cause / Y_before, independent of within-tie event order.
    # Evaluate at the original times to collapse the expansion. No jitter is used.
    expanded = times_array.copy()
    gap = min(np.diff(timeline), default=1.0) / 4
    for t in timeline:
        indexes = np.flatnonzero((times_array == t) & (causes_array != 0))
        if len(indexes) > 1:
            for rank, index in enumerate(indexes):
                expanded[index] = t - gap * (len(indexes) - rank) / (len(indexes) + 1)
    # Keep every event strictly after lifelines' time-zero baseline, even for t=0.
    offset = max(1.0, 1.0 - float(min(expanded)))
    expanded += offset
    cif = {}
    for cause in sorted(set(causes) - {0}):
        aj = AalenJohansenFitter(calculate_variance=False).fit(
            expanded, causes_array, event_of_interest=cause)
        series = aj.cumulative_density_.iloc[:, 0]
        cif[str(cause)] = [float(series.asof(t + offset)) for t in timeline]

    # Independently verify that deterministic expansion equals the joint product integral.
    survival = 1.0
    expected = {cause: 0.0 for cause in cif}
    for i, t in enumerate(timeline):
        risk = int(np.sum(times_array >= t))
        for cause in cif:
            expected[cause] += survival * int(np.sum((times_array == t) & (causes_array == int(cause)))) / risk
            assert abs(expected[cause] - cif[cause][i]) < 1e-12, (times, causes, cause, t, expected[cause], cif[cause][i])
        survival *= 1 - int(np.sum((times_array == t) & (causes_array != 0))) / risk
        assert abs(survival - steps[i]["survival"]) < 1e-12
    return {"times": times, "causes": causes, "km": steps,
            "aj": {"times": timeline.tolist(), "cif": cif,
                   "survival": [step["survival"] for step in steps]}}


def main():
    """Write reproducible independent references beside the unit tests."""
    rng = np.random.default_rng(20261019)
    result = {
        "versions": {"python": platform.python_version(), "numpy": np.__version__,
                     "scipy": scipy.__version__, "lifelines": lifelines.__version__,
                     "statsmodels": statsmodels.__version__},
        "notes": {
            "ajTies": "lifelines AJ uses deterministic event-only expansion before same-time censoring, collapsed at original times; verified against joint product integral. Random default jitter is never used.",
            "signFlip": "Absolute mean, inclusive ties; exhaustive signs checked against scipy permutation_test(samples), two-sided.",
            "mde": "Approximation (t.ppf(1-alpha/2, n-1) + t.ppf(power, n-1)) * sdDiff/sqrt(n), not exact noncentral-t inversion.",
        },
    }
    result["tQuantiles"] = [{"p": p, "df": df, "value": float(stats.t.ppf(p, df))}
                            for df in [1, 2, 4, 9, 19, 29, 100, 1000]
                            for p in [0.0001, 0.005, 0.025, 0.5, 0.8, 0.975, 0.995, 0.9999]]
    result["paired"] = []
    for n in [2, 3, 5, 10, 30]:
        for alpha in [0.05, 0.05 / 3]:
            diffs = rng.normal(0.2, 1.7, size=n)
            interval = stats.ttest_1samp(diffs, 0).confidence_interval(confidence_level=1-alpha)
            result["paired"].append({"diffs": diffs.tolist(), "alpha": alpha,
                                     "n": n, "mean": float(np.mean(diffs)), "sd": float(np.std(diffs, ddof=1)),
                                     "se": float(stats.sem(diffs)), "df": n-1,
                                     "lo": float(interval.low), "hi": float(interval.high)})
    result["signFlip"] = []
    for diffs in [[1, 2], [1, -2, 3], [0, 0, 0], [1, 1, 1, 1, 1],
                  [1, -1, 2, -2, 0], rng.normal(size=10).tolist()]:
        observed = abs(float(np.mean(diffs)))
        permutations = [abs(float(np.mean(np.array(diffs) * signs)))
                        for signs in product([-1, 1], repeat=len(diffs))]
        p = sum(value >= observed - 100 * np.finfo(float).eps * observed for value in permutations) / len(permutations)
        reference = stats.permutation_test((np.array(diffs),), np.mean,
                                           permutation_type="samples", n_resamples=np.inf,
                                           alternative="two-sided")
        assert abs(p - reference.pvalue) < 1e-12
        result["signFlip"].append({"diffs": diffs, "p": p})
    result["multiplicity"] = []
    for pvalues in [[0.01, 0.04, 0.03, 0.002, 0.8], [1, 0, 0.05, 0.05],
                    [0.9], rng.uniform(size=20).tolist()]:
        result["multiplicity"].append({"pvalues": pvalues,
                                       "holm": multipletests(pvalues, method="holm")[1].tolist(),
                                       "bh": multipletests(pvalues, method="fdr_bh")[1].tolist()})
    result["quantiles"] = []
    for values in [[1], [1, 2], [0, 0, 1, 4, 9], sorted(rng.normal(size=17).tolist())]:
        for q in [0, 0.01, 0.25, 0.5, 0.75, 0.9, 0.99, 1]:
            for method, numpy_method in [("linear", "linear"), ("lower", "lower"), ("nearest-rank", "inverted_cdf")]:
                result["quantiles"].append({"sorted": values, "q": q, "method": method,
                                             "value": float(np.quantile(values, q, method=numpy_method))})
    result["survival"] = [survival_reference(times, causes) for times, causes in [
        ([1, 2, 3, 4, 5], [1, 2, 0, 1, 3]),
        ([1, 1, 1, 2, 2, 3, 4], [1, 1, 0, 2, 0, 1, 0]),
        ([1, 1, 1, 2, 2, 2, 3, 4], [1, 2, 0, 1, 3, 0, 0, 1]),
        ([1, 1, 2, 3], [0, 0, 0, 0]),
        ([1, 1, 1, 1], [1, 2, 3, 0]),
        ([1, 2, 2, 3], [1, 1, 1, 1]),
        ([0, 0, 1, 2], [1, 2, 0, 1]),
    ]]
    result["mde"] = [{"sdDiff": 2.3, "n": n, "alpha": alpha, "power": power,
                       "value": float((stats.t.ppf(1-alpha/2, n-1) + stats.t.ppf(power, n-1)) * 2.3 / np.sqrt(n))}
                      for n in [2, 5, 10, 30] for alpha in [0.05, 0.05/3] for power in [0.8, 0.9]]
    destination = Path(__file__).resolve().parents[2] / "test/fixtures/golden-stats.json"
    destination.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"path": str(destination), "versions": result["versions"]}))


if __name__ == "__main__":
    main()
