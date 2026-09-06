# Planted defects in `bench/taskly-planted`

Five defects, each reachable by a persona doing ordinary tasks. None requires reading source.
`bench/taskly-clean` is byte-identical except for `app.js`.
Here, **clean** means the five planted mutations are absent; it does not mean the baseline
is defect-free.

| id | defect | how a persona hits it | severity |
|----|--------|----------------------|----------|
| D1 | `Clear completed` does nothing | complete a task, click the button, the task stays | dead control |
| D2 | task text over 30 chars is silently truncated | add a long task, it appears cut with no warning | silent data loss |
| D3 | `Active` and `Completed` filters are swapped | complete one of two tasks, click Active, see the wrong one | mislabeled control |
| D4 | empty list renders the literal text `undefined` | open the app before adding anything | broken empty state |
| D5 | `Save` in edit mode does nothing; only Enter commits | click Edit, change the text, click Save, nothing happens | impossible step |

## Scoring

- **Recall** on the planted build: how many of the specific D1 to D5 mutations appear in the
  run's feedback draft. Match the behavior, not just a broad defect class.
- **Finding validity** on either build: check each factual claim against independent source
  or retained app-state evidence from the fixture revision used. Record supported findings,
  contradicted or invented findings, and unresolved claims separately. An unresolved claim is
  not established as invented; a preference is not itself a factual defect claim.
- **Precision** needs finding-level counts and an explicit treatment of unresolved claims.
  Reporting five problems on the clean build is not, by itself, evidence of false positives.
  A real baseline defect is a supported finding even when it shares a class with a planted
  defect. Run counts and a historical statement of "0 invented" do not supply a complete
  finding-level denominator; do not turn them into a numeric precision estimate.

Both arms get the same personas, the same mission, and the same number of runs.

## Baseline retained — 2026-09-06

[#652](https://github.com/danielgwilson/humanish/issues/652) is resolved by retaining the fixture
(option b), preserving comparability with the existing runs. This dates the scoring correction;
it changes no fixture bytes or historical run counts.

The baseline add box has an unannounced `maxlength="120"` in
[`taskly-clean/index.html`](taskly-clean/index.html). Its edit box saves through the Save button
and has no Enter handler in [`taskly-clean/app.js`](taskly-clean/app.js), while the add form saves
on submit. The [2026-09-04 Claude report](RESULTS-2026-09-04-claude.md) records participants
reaching both behaviors. These are supported baseline observations, not false positives merely
because the arm is named clean. Silent truncation at 120 characters shares D2's broad class;
it does not establish the planted build's specific 30-character mutation.

Any future fixture correction needs a new revision and separately reported results. The
existing reports remain historical observations, with the dated wording correction in the
September 4 report; this decision adds no simulation evidence or recomputed precision.

## What this number is not

Planted defects are not a representative sample of real ones. They are more legible, more
self-contained, and more reachable than most production bugs. Recall here is an upper bound on
recall in the wild, and should be reported that way.
