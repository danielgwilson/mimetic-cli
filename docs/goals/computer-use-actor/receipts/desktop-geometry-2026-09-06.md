# Physical browser containment — 2026-09-06

Issue: [#702](https://github.com/danielgwilson/humanish/issues/702).
Measured implementation: `9703050`.
Evidence class: two hosted desktop conformance probes with an injected positioning fault;
no participant model calls. This proves the instrument correction on the tested desktop,
not an application defect or a human completion rate.

## What was tested

Each fresh E2B desktop rendered a synthetic loopback page with a magenta button fixed to the
bottom of the CSS viewport. The captured desktop was 1280×720. The probe moved the physical
browser to `(0, 250)` and deliberately ignored the first fill command's move once, reproducing
an initial positioning request that does not take effect. Humanish's subsequent correction
used the real X window manager and measured the resulting client bounds.

The old dimension-only predicate accepts the initial 1280×720 window even though its bottom
edge is at 970. The changed capture detects the clipping, moves the window once, and fits its
client dimensions to the observed origin. The window manager kept a 27-pixel top inset, so the
usable physical client became 1280×693 at `(0, 27)`, with its bottom exactly at 720.

| Retained probe | Initial bottom | Corrected bottom | Button pixels before → after | Real desktop click |
|---|---:|---:|---:|---|
| `desktop-geometry-2026-09-06-replica-1` | 970 | 720 | 0 → 48,084 | trusted click; task finished |
| `desktop-geometry-2026-09-06-replica-2` | 970 | 720 | 0 → 48,084 | trusted click; task finished |

The pixel count measured the button's distinctive color in the actual desktop screenshot.
The click used that physical screen region through the desktop SDK, and the page recorded
`isTrusted: true` and changed its result text. All four before/after screenshots were visually
reviewed. An unrelated stock Chrome update prompt was visible at the top right after resizing;
it did not cover the button.

The screenshot artifacts remain in the retained probe evidence, outside committed source.
Their SHA-256 identities are:

```text
replica-1-before  701be2a2a5ad4d956940aab812182130ea0b422e18436be4f8e19e5f801b12c6
replica-1-after   bf91a6e18662ad76f843896586d3f300701ade826a4cad45f8d29742683d94f5
replica-2-before  701be2a2a5ad4d956940aab812182130ea0b422e18436be4f8e19e5f801b12c6
replica-2-after   2c6ee3255a509d8b79c5d3817d2d2840c4761ac8d56169d1d20175356290a8c2
```

## Deterministic regression and route proof

```bash
pnpm test tests/cua-desktop-window-fill.test.ts
pnpm test tests/cua-actor-lab.test.ts tests/shared-world-lab.test.ts tests/concurrent-shared-world-lab.test.ts tests/external-public-shared-world.test.ts
pnpm release:check
```

The focused geometry suite had 11 failing cases and four passing command-contract cases before
the fix; all 15 passed afterward. It covers positive and negative origins, right/bottom overflow,
a fully contained smaller window, one successful repair, an ignored repair, a missing repair
read-back, and emulated CSS dimensions that must not stand in for physical measurements.

Separate per-lane, sequential shared-world, and concurrent shared-world regressions prove
zero participant sessions start on uncorrectable clipping, while each route still reclaims
its owned desktops. The full release gate passed: 2,141 core tests and 49 TUI tests, with ten
explicitly skipped core tests, plus builds, public-surface scan, skill discovery and dry pack.

## Bounds and limitations

- SDKs: `@e2b/desktop` 2.3.3 and `e2b` 2.46.1. Two allocations, no model calls or create retries.
- Both observed desktops had 8 CPUs and 8,192 MiB RAM. Each had a 300-second kill timeout,
  plus a process watchdog and signal cleanup. The shared simulation reservation was $2.
- Both exact owned IDs returned successful kill results and were absent in a separate
  verification process. The reservation settled at a $0.003927 standard compute estimate
  based on observed resources and bounded create-to-cleanup spans; this is not an invoice.
- This is fault-injected correction proof. It does not measure how frequently real initial
  placement fails, or establish a defect in any application.
- The hosted probes used desktop Chrome. Mobile-emulation separation and all three route
  guards have deterministic coverage; these probes are not live mobile or Firefox proof.
- Missing physical X measurements remain explicitly unverified. Startup performs the bounded
  correction; final capture reports geometry without moving or resizing the participant's app.
