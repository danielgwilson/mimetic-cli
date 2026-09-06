# Taskly detection benchmark with a second brain: the local-agent Claude route

**2026-09-04, main at #645 (the 0.79.0 build), `actors[0].type: local-agent` with
`localAgent: claude` (Claude Code 2.1.261, one stream-json session per lane, the operator's own
signed-in agent as the participant), N=3 per arm, E2B only, $0.05 in all; the brain is the
operator's subscription and is not priced.** Same fixture, persona and mission as the four
`openai-computer-use` runs; only the brain changed. The labs are the kept
`detect-taskly-{planted,clean}-claude-live.yaml` copies with the actor block swapped.

## Recall: 14 of 15

| defect | run 1 | run 2 | run 3 |
|---|:-:|:-:|:-:|
| D1 `Clear completed` does nothing | ✓ | ✓ | ✓ |
| D2 text over 30 chars silently truncated | ✓ | ✓ | ✓ |
| D3 `Active` and `Completed` filters swapped | ✓ | ✓ | ✓ |
| D4 empty list renders the literal text `undefined` | ✓ | ✓ | ✓ |
| D5 `Save` in edit mode does nothing; only Enter commits | ✓ | **missed** | ✓ |

Run 2 renamed through Edit and pressed Enter ("Pressing Enter saved the new name") without trying
Save, so it never met D5; the other two clicked Save three times each before guessing Enter. D1,
the recurrent miss under the OpenAI brain, was reported by all three here, each after two clicks.
Every participant verified D2 by opening Edit ("confirmed only the first 30 characters were kept")
rather than trusting the display. Run 3 added a sixth true observation the fixture never planted:
Edit does not focus its text box, so the first keystrokes went to the page.

Cumulative across both brains: 72 of 75 planted defects reported over five benchmark runs.

## Precision: nothing invented, and one thing the clean build does that nobody had typed far enough to see

**Scoring correction — 2026-09-06 ([#652](https://github.com/danielgwilson/humanish/issues/652)):**
The original opening, "No planted-defect class was reported against the clean build," was too
broad: two participants reported silent truncation at the baseline's 120-character cap, the
same class as D2. Clean means the five planted mutations are absent, not that the app is
defect-free. The fixture and observations below are retained unchanged; this is a wording and
[scoring correction](DEFECTS.md#scoring), not a new run or a recount.

What these participants raised is true of the app and verifiable in `bench/taskly-clean`:

- "My long task got cut off without any warning" (2 of 3). The add box carries `maxlength="120"`
  (`index.html:41`); these participants type sentences of 130 characters and more, where the
  fifteen OpenAI clean-arm participants never crossed 120, so the browser's silent stop at the
  attribute had never been met. True of the build, and the same class as the planted D2 at 30.
- "Enter does not save a rename" (2 of 3). The clean edit box saves only through its Save button
  (`app.js:48`, no keydown handler), where the add box saves on Enter. True, and an inconsistency
  the planted build hides behind its own D5.
- Delete and Clear completed act with no confirmation (3 of 3), the single-line edit box (1 of 3).

Eighteen clean runs across both brains, 0 invented. The 120-character attribute is a benchmark
design note: the clean fixture carries a real silent limit that a longer-typing participant
reaches. It stays as it is so the cumulative numbers keep their meaning; a future revision of the
fixture should either drop the attribute or show the limit.
Those historical totals are retained from the original review. They do not supply a complete
finding-level denominator, so this correction makes no numeric precision estimate.

## What differs by brain

| | openai-computer-use (4 runs) | local-agent claude (this run) |
|---|---|---|
| turns per planted lane | 4 to 7 | 13 to 19 |
| cost per lane | $0.12 to $0.30 (model + desktop) | $0.006 to $0.012 (desktop only) |
| verification habit | reads the list | opens Edit to check whether text was lost; presses End |
| report shape | one paragraph | what I did / what worked / what differed / where I hesitated / not verified |
| sentence length typed | under 120 characters | 130 and more |

## Runs

planted: `cua-2026-09-04T21-21-31-598Z-5ffd2fda` (17 turns, $0.012), `cua-2026-09-04T21-22-11-567Z-45afb759`
(13, $0.009), `cua-2026-09-04T21-22-51-574Z-112ff6c1` (19, $0.011); clean:
`cua-2026-09-04T21-23-31-582Z-90d764ca` (12, $0.006), `cua-2026-09-04T21-24-11-576Z-4bb24e7a` (13, $0.006),
`cua-2026-09-04T21-24-51-576Z-da6f2553` (13, $0.009).
