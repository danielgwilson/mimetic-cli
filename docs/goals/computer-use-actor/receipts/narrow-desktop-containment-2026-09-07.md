# Narrow desktop containment, September 7, 2026

The 0.83.1 move/resize correction can still refuse a narrow desktop before the participant starts: the window manager adds an offset to a client that Chrome will not shrink further. Observed physical shapes included a 500px client at x10 and a 508px client centered at x-4 on a 500px desktop. These are physical X window measurements, not CSS viewport promises.

The correction attempts move/resize first. If the measured client remains outside the desktop, it checks `_NET_WM_STATE` with `xprop`, activates that exact window and sends F11 only when it is not already fullscreen. It then reads physical bounds again. A failed command or missing read-back never clears known clipping. This uses the desktop template's xprop/xdotool tools without requiring wmctrl.

## Paired hosted checks

Two fresh hosted desktops used 500×896 and 500×740 screen resolutions. On each, the published 0.83.1 geometry function rejected the same real Chrome window. The corrected source then produced a contained 500×896 or 500×740 window at (0, 0). A real physical click on the fixture's bottom-right button was recorded as a trusted browser event and changed the page state to “Task finished.” No actor model was invoked in this conformance proof. Both exact owned resources were independently confirmed absent after cleanup.

The fixture is a local synthetic page with a fixed button. This verifies physical containment and executable input on those two hosted desktop shapes. It does not establish touch fidelity, external-app task completion, or an external maintainer outcome. The before/after pixel counts alone are not a clipping measure; the physical window read-back and trusted click establish the scoped result.

Two earlier repair attempts failed and remain retained with cleanup receipts: an offscreen-origin early return and a fullscreen command that depended on an unavailable tool. All four conformance allocations were confirmed absent. Private retained proof includes paired screenshots, command results, source hashes, resource receipts and cost estimates. Deterministic tests cover positive and negative origins, successful containment, ignored correction and missing read-back.

Concurrent shared-world followup also corrects two separate contracts: an ended host reports its actual failure, while a genuinely expired handoff still reports timeout; the declared `maxTotalUsd` actor-model budget now reaches all concurrent actor loops on both supported shared planes. It is a turn-boundary estimate with in-flight headroom, excludes provider desktop costs and the external lobby-code reader, and is not a provider billing limit. Unknown-priced capped models are rejected before allocation. The operator must still reserve all provider costs outside that estimate.

A subsequent packed-candidate repetition exposed two additional startup defects before a full participant session: fullscreen placement can settle before the client width does, and the concurrent lane builder dropped accepted `reasoningEffort` and `maxOutputTokens` settings. The repair polls physical bounds for up to four 250ms intervals and forwards both settings, including per-lane reasoning overrides. Regression tests exercise the real first-party provider request path on both shared planes using captured wire fixtures. A private request guard refused the missing output cap before that actor request could reach the provider.

## Linux frame control

Waiting longer and resizing again did not resolve every 508px window. The physical size hints showed a 508px minimum with Chrome-drawn decorations. The profile now explicitly sets `browser.custom_chrome_frame: false`, selecting window-manager decorations before launch. Chromium defines this preference in [`chrome/common/pref_names.h`](https://github.com/chromium/chromium/blob/d9687b8cd9866b12d5c553630505fc5fb963f59d/chrome/common/pref_names.h#L858).

Four new hosted controls use the actual source profile builder, alternating 500×896 and 500×740. Each requires measured containment and a trusted physical click before passing. Startup-wait and incorrectly named preference experiments remain separately retained; neither is counted as successful repair evidence. The full application repeat uses a fresh packed candidate and is recorded separately from these synthetic controls.

## Packed-candidate application repeat

The final packed 0.83.2 candidate started all six real computer-use actors across two independently created multiplayer lobbies. All six passed physical geometry startup and used the declared low reasoning effort and 8192 output cap. Five reached final standings; one voluntarily abandoned after four rounds, below its time and spend limits. The failing replica remains failed. All six desktops were independently confirmed absent after cleanup; every recorded provider request has a usage response.

This establishes the repaired startup and request settings under actual concurrent use. It does not establish six-of-six task completion or a controlled timer comparison: the requested timer was unavailable, and the two hosts chose different offered durations. The corrected future study uses an available duration. Four fresh synthetic controls separately passed containment and trusted physical input at both declared desktop heights. Private retained evidence contains the frozen package-file hashes, per-request metadata, all actor traces and screenshots, original failed bundles, and independent cleanup/cost receipts. No external maintainer adoption is claimed.
