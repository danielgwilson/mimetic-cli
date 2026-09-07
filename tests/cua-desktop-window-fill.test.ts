import { describe, expect, it } from "vitest";
import type { E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";

import { buildFillDesktopWindowCommand, captureDesktopBrowserGeometry } from "../src/cua-actor-lab.js";

describe("buildFillDesktopWindowCommand", () => {
  it("moves the window to the origin and sizes it to the exact desktop resolution", () => {
    const cmd = buildFillDesktopWindowCommand("0x2200003", 1440, 900);
    expect(cmd).toContain('xdotool windowmove "$win" 0 0');
    expect(cmd).toContain('xdotool windowsize "$win" 1440 900');
    expect(cmd).toContain("win='0x2200003'");
  });

  it("uses the lane resolution verbatim (no default 1024x768 fallback)", () => {
    const cmd = buildFillDesktopWindowCommand("0x1", 375, 812);
    expect(cmd).toContain('xdotool windowsize "$win" 375 812');
  });

  it("single-quotes the window id so shell metacharacters stay inert", () => {
    const cmd = buildFillDesktopWindowCommand("0x1; rm -rf /tmp", 800, 600);
    expect(cmd).toContain("win='0x1; rm -rf /tmp'");
    expect(cmd).not.toMatch(/win=0x1;\s*rm/);
  });

  it("tolerates its own failure by design (each xdotool call is guarded)", () => {
    const cmd = buildFillDesktopWindowCommand("0x1", 1920, 1080);
    // every xdotool invocation is suffixed with `|| true` so a resize failure
    // never fails the lane (the actor can still run on a smaller window).
    for (const line of cmd.split("\n").filter((l) => l.startsWith("xdotool"))) {
      expect(line).toMatch(/\|\| true$/);
    }
  });
});


type Bounds = { x: number; y: number; width: number; height: number };
const screen = [1280, 720] as const;
const full: Bounds = { x: 0, y: 0, width: 1280, height: 720 };

function geometryDesktop(reads: Array<Bounds | undefined>, pageWindow: Bounds = full) {
  const commands: string[] = [];
  let read = 0;
  const desktop = {
    wait: async () => undefined,
    commands: { run: async (command: string) => {
      commands.push(command);
      if (command.includes("getwindowgeometry --shell")) {
        const bounds = reads[Math.min(read++, reads.length - 1)];
        return { stdout: bounds === undefined ? "" : `X=${bounds.x}\nY=${bounds.y}\nWIDTH=${bounds.width}\nHEIGHT=${bounds.height}\n` };
      }
      if (command.includes("browserWindow: { x: window.screenX")) {
        return { stdout: JSON.stringify({ browserWindow: pageWindow, viewport: { width: 414, height: 896, deviceScaleFactor: 3 } }) };
      }
      return { stdout: "" };
    } }
  } as unknown as E2BDesktopSandbox;
  return { desktop, commands };
}

function capture(desktop: E2BDesktopSandbox, resize = true) {
  return captureDesktopBrowserGeometry({
    desktop, browserFamily: "chromium", browserWindowId: "123", laneId: "synthetic-lane",
    targetUrl: "http://127.0.0.1:8080/", requestedScreen: screen, requestTimeoutMs: 1000, resize
  });
}

describe("physical browser containment", () => {
  it.each([
    { x: 10, y: 85, width: 500, height: 811 },
    { x: -4, y: 27, width: 508, height: 869 }
  ])("removes decorations when the minimum-width client cannot fit: %j", async (clipped) => {
    // Physical shapes retained from the September 7 hosted desktop failures.
    const contained = { x: 0, y: 0, width: 500, height: 896 };
    const reads = clipped.x < 0 ? [clipped, clipped, contained] : [clipped, clipped, clipped, contained];
    const { desktop, commands } = geometryDesktop(reads);
    const result = await captureDesktopBrowserGeometry({
      desktop, browserFamily: "chromium", browserWindowId: "123", laneId: "narrow-screen",
      targetUrl: "http://127.0.0.1:8080/", requestedScreen: [500, 896], requestTimeoutMs: 1000
    });
    expect(result.unusable).toBeUndefined();
    expect(result.browserWindow).toEqual({ ...contained, source: "xdotool" });
    expect(commands.filter((command) => command.includes('key --clearmodifiers F11'))).toHaveLength(1);
  });

  it("keeps known clipping when the fullscreen read-back is missing", async () => {
    const clipped = { ...full, y: 32 };
    const { desktop } = geometryDesktop([clipped, clipped, clipped, undefined]);
    expect((await capture(desktop)).unusable).toContain("could not be verified after correction");
  });

  it.each([
    ["positive y with bottom overflow", { ...full, y: 32 }],
    ["positive x with right overflow", { ...full, x: 16 }],
    ["negative x", { ...full, x: -1 }],
    ["negative y", { ...full, y: -1 }],
    ["excess width", { ...full, width: 1281 }],
    ["excess height", { ...full, height: 721 }]
  ])("names unusable %s even when CSS geometry looks contained", async (_name, bounds) => {
    const { desktop, commands } = geometryDesktop([bounds]);
    const result = await capture(desktop, false);
    expect(result.unusable).toContain("outside the captured 1280x720 desktop");
    expect(result.warnings).toContain(result.unusable);
    expect(result.browserWindow).toEqual({ ...bounds, source: "xdotool" });
    expect(commands.some((command) => command.includes("windowmove"))).toBe(false);
  });

  it("accepts a fully visible window at a nonzero origin and keeps CSS emulation distinct", async () => {
    const bounds = { x: 8, y: 32, width: 1264, height: 688 };
    const { desktop } = geometryDesktop([bounds], { x: -500, y: -500, width: 414, height: 896 });
    const result = await capture(desktop, false);
    expect(result.unusable).toBeUndefined();
    expect(result.browserWindow).toEqual({ ...bounds, source: "xdotool" });
    expect(result.viewport).toEqual({ width: 414, height: 896, deviceScaleFactor: 3, source: "cdp" });
  });

  it("fits once to the measured client origin and checks the resulting physical edges", async () => {
    const before = { ...full, y: 32 };
    const after = { ...before, height: 688 };
    const { desktop, commands } = geometryDesktop([before, before, after]);
    const result = await capture(desktop);
    expect(result.unusable).toBeUndefined();
    expect(result.browserWindow).toEqual({ ...after, source: "xdotool" });
    expect(result.warnings.join(" ")).toContain("corrected");
    expect(commands.filter((command) => command.includes('windowsize "$win" 1280 688'))).toHaveLength(1);
  });

  it("refuses a window manager that ignores the bounded correction", async () => {
    const { desktop, commands } = geometryDesktop([{ ...full, y: 32 }]);
    const result = await capture(desktop);
    expect(result.unusable).toContain("outside the captured 1280x720 desktop");
    expect(commands.filter((command) => command.includes('windowsize "$win" 1280 688'))).toHaveLength(1);
  });

  it("does not clear known clipping when the repair read-back is missing", async () => {
    const before = { ...full, y: 32 };
    const { desktop } = geometryDesktop([before, before, undefined]);
    const result = await capture(desktop);
    expect(result.unusable).toContain("could not be verified after correction");
  });

  it("does not treat an emulated page outer size as measured physical containment", async () => {
    const { desktop } = geometryDesktop([undefined], { x: 0, y: 0, width: 414, height: 896 });
    const result = await capture(desktop);
    expect(result.unusable).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("Physical browser containment is unverified");
    expect(result.warnings.join(" ")).not.toContain("outside the captured");
  });
});
