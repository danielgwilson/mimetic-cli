# Public output limit: four live constructor checks

Date: 2026-09-06. Source candidate: `5dfa8cb87a638a946958d9b21160485e6c140bb5`
on PR #700, including the sequential reasoning-effort correction from #704.
This receipt proves source behavior; npm `0.82.1` does not include the public
`maxOutputTokens` setting.

## Question and method

Does actor-level `maxOutputTokens` reach the first-party OpenAI provider through
both independent CUA lanes and sequential shared-world roles, and does provider
truncation remain an incomplete participant outcome?

Two independent lanes and two sequential roles used the same synthetic local-tree
subject, with three hosted desktops in total. The public lab declared
`model: gpt-5.6-sol` and `maxOutputTokens: 16`. Independent lanes omitted reasoning
effort. The shared actor declared `low`; its second lane overrode that with `high`.
Each mission requested a long text response and no computer actions. These were
four integration attempts, with no retries or replacement participants.

The runner called public `parseLabConfig` and `runLab` with default provider and
session construction. A host transport guard checked the actual request's
`max_output_tokens` and forwarded it unchanged. It separately restricted the
study to four initial requests, pinned the composed instructions, required
Standard service tier, and bounded provider requests and desktop allocations.
Those study controls are separate from the product's output-token setting.

## Observed result

| Route / role | Effective effort, request and trace | Output limit | Provider result | Trace result |
| --- | --- | ---: | --- | --- |
| Independent A | medium, omitted in lab | 16 | incomplete / max_output_tokens | incomplete / budget_reached |
| Independent B | medium, omitted in lab | 16 | incomplete / max_output_tokens | incomplete / budget_reached |
| Shared A | low, actor declaration | 16 | incomplete / max_output_tokens | incomplete / budget_reached |
| Shared B | high, lane override | 16 | incomplete / max_output_tokens | incomplete / budget_reached |

All four responses used exactly 16 output tokens, all reported as reasoning
tokens. Every trace recorded one turn, zero actions, and the explicit provider
token-limit reason. No closing request followed. Both sequential roles ran.
The effective `modelSettings` agreed with the actual request fields on all four
traces.

Both run bundles passed `verify`; both remain `local_only` because full-fidelity
screenshots were retained. No screenshot or raw response is published here.
The parent process independently confirmed all three exact owned desktop IDs
absent after cleanup. There were three create requests and four model requests,
with no missing usage or unresolved cleanup.

The retained token estimate is $0.022668, including cache-write charges. A
conservative desktop estimate, extending through the parent's later absence
readback, is $0.024086556. The combined estimate is $0.046754556; these are
token/resource cost estimates, not invoices.

## Evidence and limits

Retained live runs: `output-limit-independent` and `output-limit-shared`, executed
on the frozen candidate above on 2026-09-06. The archived 25-file bundle has
SHA-256 `b6aa9e6ef7844392253802ef5898dbd991ebb0ad33744bd8a157516b46f5bcaa`.
The private evidence includes parsed labs, exact request/response receipts,
traces, verification results, resource readbacks, and cleanup receipts.

This is configuration and interruption proof. It does not measure usability,
persona efficacy, task success, or a behavioral effect from reasoning effort.
No participant completed a task. The output limit includes reasoning tokens;
it does not bound input tokens, cumulative requests, total dollars, or desktop
time. Continuation, retry, fallback, closing-report clamping, omission, and
unsupported-route rejection have deterministic tests; this live protocol covers
only the four initial requests above.
