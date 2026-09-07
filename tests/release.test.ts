import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release readiness", () => {
  it("keeps publication gated while exposing package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bugs?: { url?: string };
      files?: string[];
      homepage?: string;
      keywords?: string[];
      license: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      private?: boolean;
      publishConfig?: { access?: string };
      scripts: Record<string, string>;
      version: string;
    };

    expect(packageJson.private).toBeUndefined();
    expect(packageJson.version).toBe("0.83.2");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.dependencies).not.toHaveProperty("@e2b/desktop");
    expect(packageJson.peerDependencies?.["@e2b/desktop"]).toBe("^2.2.3");
    expect(packageJson.peerDependenciesMeta?.["@e2b/desktop"]).toEqual({ optional: true });
    expect(packageJson.homepage).toBe("https://github.com/danielgwilson/humanish#readme");
    expect(packageJson.bugs?.url).toBe("https://github.com/danielgwilson/humanish/issues");
    expect(packageJson.keywords).toContain("persona-simulation");
    expect(packageJson.files).toEqual([
      "AGENTS.md",
      "dist",
      "docs/architecture",
      "docs/assets",
      "docs/contracts",
      "docs/goals/current.md",
      "docs/principles",
      "docs/product",
      "docs/ramp",
      "docs/release",
      "docs/roadmap",
      "skills",
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "CONTRIBUTING.md"
    ]);
    expect(packageJson.scripts.prepack).toBe("pnpm build");
    expect(packageJson.scripts["public-surface:scan"]).toBe("node scripts/public-surface-scan.mjs");
    expect(packageJson.scripts["skill:check"]).toBe("DISABLE_TELEMETRY=1 npx skills add . --list");
    expect(packageJson.scripts["pack:dry-run"]).toBe("npm pack --dry-run");
    expect(packageJson.scripts["release:check"]).toBe("pnpm check && pnpm public-surface:scan && pnpm skill:check && npm pack --dry-run");
  });

  it("documents release gates and human publish decisions", async () => {
    const readiness = await readFile("docs/release/open-source-readiness.md", "utf8");
    const standard = await readFile("docs/release/public-readiness-standard.md", "utf8");

    expect(readiness).toContain("public repository candidate after reviewed history cleanup");
    expect(readiness).toContain("docs/release/public-readiness-standard.md");
    expect(readiness).toContain("License: MIT");
    expect(readiness).toContain("`npm publish` remains a human release action");
    expect(readiness).toContain("GitHub Visibility Gate");
    expect(readiness).toContain("from a fresh clone");
    expect(readiness).toContain("residual platform-cache risk");
    expect(readiness).toContain("reachable commit author and committer emails are GitHub noreply-style");
    expect(readiness).toContain("npm dry-run payload");
    expect(readiness).toContain("explicitly allowlisted by SHA-256");
    expect(readiness).toContain("skills/humanish/SKILL.md");
    expect(readiness).toContain("pnpm skill:check");
    expect(readiness).toContain("Prefer the tag-gated GitHub Actions workflow");
    expect(readiness).toContain("npm version patch --no-git-tag-version");
    expect(readiness).toContain("The release tag must point at a commit already reachable from `origin/main`.");
    expect(readiness).toContain("Trusted Publishing Setup");
    expect(readiness).toContain("Trusted Publishing is configured for GitHub Actions");
    expect(readiness).toContain("re-point them after any repository rename");
    expect(readiness).toContain("workflow filename: `publish.yml`");
    expect(readiness).toContain("npm pack --dry-run");
    expect(readiness).toContain("No agent should run `npm publish` locally without explicit human approval");
    expect(readiness).toContain("`.humanish/`");
    expect(readiness).toContain("`.npmrc`");
    expect(readiness).toContain("unapproved durable commit email metadata");
    expect(readiness).toContain("internal");
    expect(readiness).toContain("operations notes");
    expect(readiness).toContain("Public");
    expect(readiness).toContain("`docs/ramp/`");
    expect(readiness).toContain("`docs/goals/`");
    expect(readiness).toContain("repo-local `AGENTS.md`");
    expect(standard).toContain("A maintainer-approved public commit email");
    expect(standard).toContain("`ID+USERNAME@users.noreply.github.com`");
    expect(standard).toContain("`USERNAME@users.noreply.github.com`");
    expect(standard).toContain("accounts using GitHub's pre-July 18, 2017 privacy form");
    expect(standard).toContain("Do not force-rewrite `main` solely because a known maintainer-approved public");
    expect(standard).toContain("Secret/PHI/private source? Rotate/revoke first");
  });

  it("keeps future-agent ramp and goal docs public-safe and packaged", async () => {
    const readme = await readFile("README.md", "utf8");
    const agents = await readFile("AGENTS.md", "utf8");
    const ramp = await readFile("docs/ramp/README.md", "utf8");
    const goals = await readFile("docs/goals/current.md", "utf8");
    const schemas = await readFile("docs/contracts/schemas.md", "utf8");
    const multiOriginDesign = await readFile("docs/goals/multi-origin-shared-world/design.md", "utf8");
    const multiOriginStatus = await readFile("docs/goals/multi-origin-shared-world/README.md", "utf8");
    const proofRoadmap = await readFile("docs/goals/proof-roadmap/goal.md", "utf8");
    const proofRoadmapStatus = await readFile("docs/goals/proof-roadmap/README.md", "utf8");
    const sequentialSharedWorldFixture = await readFile("humanish/labs/shared-world-demo.yaml", "utf8");
    const concurrentSharedWorldFixture = await readFile("humanish/labs/shared-world-concurrent-demo.yaml", "utf8");
    const program = await readFile("src/program.ts", "utf8");
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };

    expect(readme).toContain("docs/ramp/README.md");
    expect(readme).toContain("docs/goals/current.md");
    expect(readme).toContain("it is not a Humanish adopter or endorser");
    expect(agents).toContain("Assume this repository is public.");
    expect(ramp).toContain("Future agents should be able to continue from the repo");
    expect(ramp).toContain("[`AGENTS.md`](../../AGENTS.md)");
    expect(ramp).toContain(`Package/source version in this tree: \`${packageJson.version}\``);
    expect(ramp).toContain("no first-party deletion");
    expect(goals).toContain("Best Next Work");
    expect(goals).toContain(`Current Program Truth (source \`${packageJson.version}\`)`);
    expect(goals).toContain("No first-party deletion branch");
    expect(goals).toContain("ratified core-design direction");
    expect(goals).toContain("implementation gate is still closed");
    expect(schemas).toContain(`shipped through source version\n\`${packageJson.version}\``);
    expect(multiOriginDesign).toContain("DESIGN-ONLY, HELD");
    expect(multiOriginStatus).toContain("design direction is ratified");
    expect(multiOriginStatus).toMatch(/implementation is not\s+authorized/);
    expect(proofRoadmap).toContain("Genuinely unbuilt");
    expect(proofRoadmapStatus).toContain("ratification-time implementation labels are historical");
    expect(proofRoadmapStatus).toContain("fan-out shipped in `0.9.0`");
    for (const fixture of [sequentialSharedWorldFixture, concurrentSharedWorldFixture]) {
      expect(fixture).toContain("real public-application study");
      expect(fixture).toMatch(/do not imply\s+adoption/);
      expect(fixture).not.toContain("real adopter subjects");
    }
    expect(program).toContain("this run only; no scale or adoption claim");
    expect(program).not.toContain("capability at scale is live-backed only");
    const forbidden = [
      ["", "Users", ""].join("/"),
      ["local", "git"].join("_"),
      ["env", ".env.local"].join("/"),
      ["private", "factory"].join("-")
    ];
    for (const term of forbidden) {
      expect(`${ramp}\n${goals}`).not.toContain(term);
    }
  });

  it("links the version-pinned drawDB study hero and ships it in the npm payload", async () => {
    const readme = await readFile("README.md", "utf8");
    const screenshotPath = "docs/assets/humanish-drawdb-hero.png";
    const screenshotMarkdown =
      `![Humanish Observer grid of a live four-persona drawDB study: four completed lanes, each showing its final full-desktop screenshot and outcome]` +
      `(https://unpkg.com/humanish@0.16.0/${screenshotPath})`;
    const screenshot = await stat(screenshotPath);
    const inventory = JSON.parse(execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000
      }
    )) as Array<{ files?: Array<{ path?: string; size?: number }> }>;

    expect(inventory).toHaveLength(1);
    const packedScreenshot = inventory[0]?.files?.find((file) => file.path === screenshotPath);
    if (!packedScreenshot) {
      throw new Error(`npm pack inventory omitted ${screenshotPath}`);
    }

    expect(readme).toContain(screenshotMarkdown);
    expect(readme).toContain("it is not a Humanish adopter or endorser");
    expect(readme).not.toContain(`https://unpkg.com/humanish@latest/${screenshotPath}`);
    expect(packedScreenshot.size).toBe(screenshot.size);
    expect(packedScreenshot.size).toBeGreaterThan(50_000);
  }, 45_000);

  it("keeps the legacy synthetic hero in the npm payload for older pinned READMEs", async () => {
    const screenshotPath = "docs/assets/humanish-observer-hero.png";
    const screenshot = await stat(screenshotPath);
    const inventory = JSON.parse(execFileSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30_000
      }
    )) as Array<{ files?: Array<{ path?: string; size?: number }> }>;

    expect(inventory).toHaveLength(1);
    const packedScreenshot = inventory[0]?.files?.find((file) => file.path === screenshotPath);
    if (!packedScreenshot) {
      throw new Error(`npm pack inventory omitted ${screenshotPath}`);
    }

    expect(packedScreenshot.size).toBe(screenshot.size);
    expect(packedScreenshot.size).toBeGreaterThan(50_000);
  }, 45_000);

  it("defines tag-gated npm trusted publishing", async () => {
    const publish = await readFile(".github/workflows/publish.yml", "utf8");
    const ci = await readFile(".github/workflows/ci.yml", "utf8");

    expect(publish).toContain("id-token: write");
    expect(publish).toContain("actions/checkout@v6");
    expect(publish).toContain("actions/setup-node@v6");
    expect(publish).toContain("pnpm/action-setup@v6");
    expect(publish).toContain("registry-url: \"https://registry.npmjs.org\"");
    expect(publish).toContain("package-manager-cache: false");
    expect(publish).toContain("if: github.ref_type == 'tag' && startsWith(github.ref_name, 'v')");
    expect(publish).toContain("Verify release tag is on main and matches package version");
    expect(publish).toContain("git merge-base --is-ancestor \"$GITHUB_SHA\" origin/main");
    expect(publish).toContain("[ \"v${PACKAGE_VERSION}\" != \"$GITHUB_REF_NAME\" ]");
    expect(publish).toContain("pnpm release:check");
    expect(publish).toContain("HUMANISH_PUBLIC_DENYLIST_PATTERN: ${{ secrets.HUMANISH_PUBLIC_DENYLIST_PATTERN }}");
    expect(publish).toContain("npm publish --access public");
    expect(ci).toContain("pnpm/action-setup@v6");
    expect(ci).toContain("pnpm release:check");
  });
});
