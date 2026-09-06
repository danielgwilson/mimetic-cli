# Failed desktop startup remains inspectable — 2026-09-06

Related: [#708](https://github.com/danielgwilson/humanish/issues/708),
[#581](https://github.com/danielgwilson/humanish/issues/581).

A terminal-product study can fail while E2B starts the desktop, before any
participant runs. The default loader already reclaims an acquired sandbox in
that case. The terminal route discarded that cleanup result, reported
`HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN`, and recorded “no sandbox created.” Its
session message simultaneously said the sandbox had been reclaimed.

The failed-run evidence also did not render: no participant output meant an
existing, zero-byte `terminal-events.ndjson`. The generic artifact check
rejected it even though the terminal evidence contract permits zero records.

The correction preserves the startup guard's confirmed cleanup in the terminal
ledger. The CLI still exits 2 for the startup failure, reports its original
cause, and renders the verified failure evidence. An absent handle does not
prove allocation absence; unknown cleanup remains failed closed. No additional
kill, retry, account listing, provider request, or forced process exit is added.

An empty terminal event file is accepted only when both the embedded and
retained terminal-exec traces declare zero events. The file must exist. Missing
files, positive or absent event counts, nonterminal traces, screenshots, other
empty logs, and another consumer requiring the same file remain rejected.

## Deterministic proof

The tests use installed `@e2b/desktop` 2.3.3 and `e2b` 2.46.1. The SDK's debug
path executes its real constructor and desktop startup code without provider
allocation. Local command and kill method faults follow the existing
`e2b-desktop-create-lease.test.ts` conformance seam; there are no invented
provider HTTP responses.

Six new regressions failed before the correction on source
`5f426c1` (`0.83.0`). The corrected focused suites pass 66 tests, including
startup failure at the first Xvfb command and later XFCE startup, cleanup
returning true or false, cleanup rejection, failure before the lane receives a
handle, and the empty-evidence checks above. The existing guard suite also
checks bounded cleanup timeout and refusal to retry when cleanup is unknown.

```sh
pnpm exec vitest run tests/e2b-terminal-lab.test.ts tests/e2b-desktop-create-lease.test.ts
pnpm build
pnpm cli:startup:test
```

`cli:startup:test`, included in `pnpm check` after build, launches the actual
compiled CLI twice through its default desktop loader. It forces Xvfb and XFCE
startup failures using the installed SDK's debug path, verifies the failed-run
Observer result, and requires natural exit within two seconds of the final JSON
write and receipt. Network and allocator entry points are blocked; synthetic
keys are the only keys available. A parent watchdog fails the proof if the CLI
does not exit; it changes no product behavior.

This is local deterministic evidence with zero model calls and zero hosted
allocations. It does not prove real provider sockets are released after a
failed request, close pre-construction allocation ambiguity, or establish
compatibility with every permitted SDK version. The earlier
[hosted cleanup receipt](desktop-create-cleanup-2026-09-05.md) covers acquired
handle cleanup; #581's remaining live CLI timing and provider uncertainty stay
open.
