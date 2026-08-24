/**
 * Real-path test for /healthz (rule 13a — Phase 1 acceptance gate).
 *
 * Purpose: proves the running app completes a genuine round-trip to the
 * live Postgres container. No stubs, no injection: it drives the real
 * HTTP endpoint of a stack started with `docker compose up`.
 *
 * Precondition: the compose stack is up (`docker compose up -d` in
 * mingle-ts/). Run via `npm run test:realpath`. HEALTHZ_URL overrides
 * the default endpoint (http://localhost:3000/healthz).
 *
 * Owner context: infrastructure verification.
 */
import { describe, expect, it } from "vitest";
import type { HealthzResponse } from "../app/shared/wire-types";

const HEALTHZ_URL = process.env.HEALTHZ_URL ?? "http://localhost:3000/healthz";

describe("GET /healthz against the live compose stack", () => {
  it("answers 200 with a real database round-trip", async () => {
    const res = await fetch(HEALTHZ_URL);
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthzResponse;
    expect(body.status).toBe("ok");
    expect(body.db).toBe("connected");
    // checkedAt must be a fresh, parseable server timestamp — a canned
    // response would fail the staleness bound.
    const checkedAt = Date.parse(body.checkedAt);
    expect(Number.isNaN(checkedAt)).toBe(false);
    expect(Math.abs(Date.now() - checkedAt)).toBeLessThan(60_000);
  });
});
