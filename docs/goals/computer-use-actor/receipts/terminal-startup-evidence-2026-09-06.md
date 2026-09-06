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

The local checks above use zero model calls and zero hosted allocations. They
isolate the evidence and process-exit contract; the hosted controls below test
two acquired-desktop cases with real provider transports. The earlier
[hosted cleanup receipt](desktop-create-cleanup-2026-09-05.md) separately covers
acquired handle cleanup.

## Hosted startup failures through the compiled CLI

Two additional, model-free hosted controls ran the compiled CLI at
`a85baa67505cd7f7f2234700e363371e13a7671f`, through its default desktop loader,
on Node 24.12.0 with `@e2b/desktop` 2.3.3 and `e2b` 2.46.1. Each allocated one
stock desktop. Faults were injected only at local SDK command boundaries;
allocation, resource inspection, command transport and cleanup used the real
SDK. No provider HTTP response was fabricated.

| Startup fault | Real commands before fault | Final JSON write → natural CLI exit | Parent JSON receipt → child close | Result |
| --- | --- | ---: | ---: | --- |
| Xvfb | None | 0.79 ms | 11.92 ms | Verified failed bundle; sandbox absent |
| XFCE | Xvfb, xdpyinfo | 1.03 ms | 13.37 ms | Verified failed bundle; sandbox absent |

Both children exited naturally with code 2 and
`HUMANISH_TERMINAL_LAB_FAILED`, preserving the injected startup cause. Their
terminal ledgers recorded `killed: true, remaining: 0`; Observer rendering and
a separate `humanish verify` invocation passed. Both existing zero-byte
terminal event files were accepted under the typed zero-event contract.

The SDK returned each exact sandbox ID before desktop construction; the
constructor supplied the same ID. Each observed desktop had 8 CPUs and
8192 MiB memory. The startup guard's single kill returned true, and a separate
post-exit SDK lookup confirmed that exact ID absent. Neither parent fallback
cleanup nor a process watchdog was needed. The later fault exercised the real
Xvfb background-command path, including the SDK's normal handle disconnect.
No participant or model call ran.

An earlier instrumented attempt failed before SDK construction because the
optional SDK logger rejected its transport-specific `Response`. It returned
no sandbox ID and remains an unknown-cleanup result, excluded from the two
passing controls. A network-free reproduction isolated the logger error; the
revised controls omitted that optional logger. Upstream already corrected its
middleware in [E2B #1794](https://github.com/e2b-dev/E2B/pull/1794).

These observations establish prompt natural CLI exit and inspectable failed
bundles for the two acquired-desktop startup cases on the pinned build. They
do not establish behavior after every provider/network failure, prove absence
when allocation fails before an ID returns, or cover every allowed SDK
version. #581 remains open for those boundaries. The seven files changed
by #710 are identical in merge `e4ee149`; this hosted run did not test the entire
later release artifact or its intervening desktop CLI changes.
