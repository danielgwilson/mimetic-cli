# Desktop CLI without a product install: runtime conformance

Date: 2026-09-06. Implementation: `5fa4880a991427821d3698c13505ce9b0fd40455`.
Issue: [#515](https://github.com/danielgwilson/humanish/issues/515).

When `subject.product.install` was omitted, the desktop-CLI route returned before
runtime setup. That contract asks the participant to discover and install the
product, but the stock desktop had no Node/npm for following npm instructions.
The corrected route prepares the runtime and leaves the product uninstalled.
It reuses the pinned archive bootstrap and npm prefix correction from #677/#680.

Two fresh stock E2B desktops ran the real `runLab` desktop-CLI route with
`subject.product.install` absent. A measurement hook replaced participant
dispatch: it inspected ordinary interactive Bash and sudo Bash, then deliberately
threw `CONFORMANCE_STOP`. Both run bundles therefore retain the intentional
failed/stopped result. No model or participant session ran; these are runtime
conformance observations, not product usability or adoption results.

| Measurement | Desktop 1 | Desktop 2 |
| --- | --- | --- |
| Node / npm / npx immediately after create, before route setup | All absent | All absent |
| Runtime phase duration | 3.527 s | 3.520 s |
| Node at participant entry, ordinary and sudo shells | 22.23.2 | 22.23.2 |
| npm / npx at participant entry, ordinary and sudo shells | 10.9.8 / 10.9.8 | 10.9.8 / 10.9.8 |
| Global npm prefix | `/usr/local` | `/usr/local` |
| Executables on both shells' PATH | `/usr/local/bin/node`, `npm`, `npx` | Same |
| Synthetic product executable | Absent | Absent |
| Product-install script or phase | Absent | Absent |
| Exact-ID absence after teardown and a separate fresh readback | Confirmed | Confirmed |

Each allocation had a six-minute kill-on-timeout lifecycle. A host watchdog
bounded the route and cleanup; the second allocation required the first one's
confirmed absence. Actual resource readbacks reported 8 CPU / 8192 MiB for each.
The combined measured host span from before create through initial independent
absence was 37.595 seconds. At the committed resource rates, the supported
compute estimate was $0.00556406, settled against a $2 reservation. This is an
estimate, not an invoice. Provider handles, raw receipts and bundles remain
outside the public repository.

Local proof:

- The focused route regression failed three cases on the previous source while
  the non-Node install control passed. The corrected source passed all four:
  participant-owned installation, declared npm installation, declared Python
  installation, and runtime failure before participant entry with teardown.
- `pnpm exec vitest run tests/cua-actor-lab.test.ts tests/terminal-node-bootstrap.test.ts tests/subject-runtime.test.ts`
  passed 147 tests. The shared bootstrap's actual-shell controls cover working
  runtime preservation, checksum/download/prerequisite failures and npm prefix
  preservation.
- `pnpm release:check` passed: 2,180 core tests and 49 TUI tests, plus typecheck,
  build, smoke, public-surface, skill and package checks.

The hosted observations cover fresh stock Linux x64 desktops. They do not prove
arm64 or custom-template behavior, other package managers, a participant's
product installation, or a completed usability study. Declared non-Node install
commands retain their previous runtime behavior.
