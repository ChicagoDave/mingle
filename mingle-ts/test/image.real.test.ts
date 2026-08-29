/**
 * Real-path test for the registry-pull install (Phase 3 acceptance gate,
 * ADR-0022 Decision 4, rule 13a — deploy-shaped, nothing stubbed).
 *
 * Purpose: proves that the documented install — `docker compose up`
 * with the plain compose.yaml and NO build override — runs the
 * published image: the container's image reference is
 * `ghcr.io/chicagodave/mingle` at the minor tag compose.yaml names, the
 * container reports `healthy`, `/healthz` answers `db: connected` over
 * plain HTTP, and the image's `org.opencontainers.image.version` label
 * is a version inside that minor line. A compose.yaml that silently
 * reverted to `build:`, or an image published without its labels, fails
 * here.
 *
 * The registry is an EXTERNAL dependency: with no local copy of the
 * image, `docker compose up` pulls it from ghcr.io and this test needs
 * network and a published release. A local image carrying the same
 * reference (built with `docker compose -f compose.yaml -f
 * compose.build.yaml build` and tagged) satisfies the same assertions,
 * which is how the harness itself is verified before the first tag.
 *
 * Isolation: a random compose project name and host port; the stack and
 * its volume are removed at the end. Run via `npm run test:image` (also
 * part of `npm run test:realpath`).
 *
 * Owner context: infrastructure verification (packaging).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const IMAGE = "ghcr.io/chicagodave/mingle";
const projectName = `mingle-image-${randomBytes(3).toString("hex")}`;
let port = 0;
let baseUrl = "";

/** The minor tag compose.yaml pins — read from the file, not assumed. */
function composeImageTag(): string {
  const compose = readFileSync(resolve("compose.yaml"), "utf8");
  const match = new RegExp(`^\\s*image:\\s*${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\S+)\\s*$`, "m").exec(compose);
  if (!match) throw new Error(`compose.yaml does not pull ${IMAGE}`);
  return match[1];
}

/** Runs docker compose for this test's isolated project — plain compose.yaml only. */
function compose(args: string[], timeoutMs = 120_000): string {
  return execFileSync("docker", ["compose", "-p", projectName, "-f", "compose.yaml", ...args], {
    cwd: resolve("."),
    env: { ...process.env, MINGLE_PORT: String(port), SITE_URL: baseUrl },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    encoding: "utf8",
  });
}

function inspect(target: string, format: string): string {
  return execFileSync("docker", ["inspect", "--format", format, target], { encoding: "utf8" }).trim();
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(found)));
    });
  });
}

beforeAll(async () => {
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  try {
    compose(["up", "-d", "--wait", "--wait-timeout", "300"], 15 * 60 * 1000);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`docker compose up failed: ${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`);
  }
}, 16 * 60 * 1000);

afterAll(() => {
  try {
    compose(["down", "-v", "--remove-orphans"]);
  } catch {
    // best effort: the volume is named after the random project, so a leak is visible in `docker volume ls`
  }
}, 180_000);

describe("docker compose up with the published image", () => {
  it("runs ghcr.io/chicagodave/mingle at the minor tag compose.yaml names, not a local build", () => {
    const tag = composeImageTag();
    expect(tag).toMatch(/^\d+\.\d+$/);
    const containerId = compose(["ps", "-q", "app"]).trim();
    expect(containerId).not.toBe("");
    expect(inspect(containerId, "{{.Config.Image}}")).toBe(`${IMAGE}:${tag}`);
    // The service must not carry a build definition: `docker compose config`
    // renders the effective file, and a build key there means the override leaked in.
    const effective = compose(["config"]);
    expect(effective).toContain(`image: ${IMAGE}:${tag}`);
    expect(effective).not.toMatch(/^\s+build:/m);
  }, 60_000);

  it("is healthy and /healthz round-trips the database on the volume", async () => {
    const containerId = compose(["ps", "-q", "app"]).trim();
    expect(inspect(containerId, "{{.State.Health.Status}}")).toBe("healthy");
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { db: string }).db).toBe("connected");
  }, 60_000);

  it("carries an org.opencontainers.image.version label inside the pinned minor line", () => {
    const tag = composeImageTag();
    const version = inspect(`${IMAGE}:${tag}`, '{{index .Config.Labels "org.opencontainers.image.version"}}');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.startsWith(`${tag}.`)).toBe(true);
    expect(inspect(`${IMAGE}:${tag}`, '{{index .Config.Labels "org.opencontainers.image.source"}}')).toBe(
      "https://github.com/ChicagoDave/mingle",
    );
  }, 60_000);
});
