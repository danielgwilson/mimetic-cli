# Narrow desktop containment, September 7, 2026

The 0.83.1 move/resize correction can still refuse a narrow desktop before the participant starts: the window manager adds an offset to a client that Chrome will not shrink further. Observed physical shapes included a500px client at x10 and a508px client centered at x-4 on a500px desktop. These are physical X window measurements, not CSS viewport promises.

The correction attempts move/resize first. If the measured client remains outside the desktop, it checks `_NET_WM_STATE` with `xprop`, activates that exact window and sends F11 only when it is not already fullscreen. It then reads physical bounds again. A failed command or missing read-back never clears known clipping. This uses the desktop template's xprop/xdotool tools without requiring wmctrl.

## Paired hosted checks

Two fresh hosted desktops used500×896 and500×740 screen resolutions. On each, the published0.83.1 geometry function rejected the same real Chrome window. The corrected source then produced a contained500×896 or500×740 window at(0,0). A real physical click on the fixture's bottom-right button was recorded as a trusted browser event and changed the page state to “Task finished.” No actor model was invoked in this conformance proof. Both exact owned resources were independently confirmed absent after cleanup.

The fixture is a local synthetic page with a fixed button. This verifies physical containment and executable input on those two hosted desktop shapes. It does not establish touch fidelity, external-app task completion, or an external maintainer outcome. The before/after pixel counts alone are not a clipping measure; the physical window read-back and trusted click establish the scoped result.

Two earlier repair attempts failed and remain retained with cleanup receipts: an offscreen-origin early return and a fullscreen command that depended on an unavailable tool. All four conformance allocations were confirmed absent. Private retained proof includes paired screenshots, command results, source hashes, resource receipts and cost estimates. Deterministic tests cover positive and negative origins, successful containment, ignored correction and missing read-back.

Concurrent shared-world followup also corrects two separate contracts: an ended host reports its actual failure, while a genuinely expired handoff still reports timeout; the declared `maxTotalUsd` actor-model budget now reaches all concurrent actor loops on both supported shared planes. It is a turn-boundary estimate with in-flight headroom, excludes provider desktop costs and the external lobby-code reader, and is not a provider billing limit. Unknown-priced capped models are rejected before allocation. The operator must still reserve all provider costs outside that estimate.
