/**
 * Behavioral tests for the profile time-zone setting (P-14, Phase 13 —
 * ADR-0023 Decision 6).
 *
 * Derived from `updateUserProfile` in app/domain/identity/
 * commands.server.ts (persists `time_zone`, names `timeZone` in the
 * UserProfileUpdated payload, rejects a zone the runtime does not
 * know) and the `profile` intent of app/routes/profile.tsx (carries
 * the form's `timeZone` field into the command; an absent field means
 * UTC).
 *
 * Runs against a real, file-backed SQLite database opened through the
 * app's own client module with the real migrations.
 *
 * Owner context: Identity & Access verification.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-profile-tz-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "profile-tz-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { createUserSession } = await import("../app/auth/session.server");
const profileRoute = await import("../app/routes/profile");
const { users } = await import("../app/db/schema/identity");
const { domainEvents } = await import("../app/db/schema/events");
const { registerUser, updateUserProfile } = await import("../app/domain/identity/commands.server");

type CommandResult<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string[]> };

afterAll(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function mustOk<T>(result: CommandResult<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${JSON.stringify(result.errors)}`);
  return result.value;
}

let userId: number;
const row = () => db.select().from(users).where(eq(users.id, userId)).get()!;
const events = (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type)).all();

beforeEach(() => {
  for (const table of [domainEvents, users]) db.delete(table).run();
  userId = mustOk(registerUser(db, { login: "zed", name: "Zed", email: "zed@example.test", password: "profile-tz-1!" }), "zed").id;
  db.delete(domainEvents).run();
});

describe("UpdateUserProfile time zone", () => {
  it("defaults to UTC, persists a known zone, and names timeZone among the changed fields", () => {
    expect(row().timeZone).toBe("UTC");
    const updated = mustOk(updateUserProfile(db, { userId, name: "Zed", email: "zed@example.test", timeZone: "America/Chicago" }), "update");
    expect(updated.timeZone).toBe("America/Chicago");
    expect(row().timeZone).toBe("America/Chicago");
    const [event] = events("UserProfileUpdated");
    expect(JSON.parse(String(event.payload)).changed).toEqual(["timeZone"]);
    // Omitting the field keeps the stored zone; a blank one means UTC.
    mustOk(updateUserProfile(db, { userId, name: "Zed", email: "zed@example.test" }), "keep");
    expect(row().timeZone).toBe("America/Chicago");
    mustOk(updateUserProfile(db, { userId, name: "Zed", email: "zed@example.test", timeZone: "  " }), "blank");
    expect(row().timeZone).toBe("UTC");
  });

  it("rejects a zone the runtime does not know and leaves the row unchanged", () => {
    const result = updateUserProfile(db, { userId, name: "Zed", email: "zed@example.test", timeZone: "Mars/Olympus_Mons" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.timeZone).toEqual(["is not a known time zone"]);
    expect(row().timeZone).toBe("UTC");
    expect(events("UserProfileUpdated")).toEqual([]);
  });

  it("is set from the profile page's profile intent, which carries the form's timeZone field", async () => {
    const cookie = (await createUserSession(userId, "/", "password")).headers.get("Set-Cookie")!.split(";")[0];
    const post = async (fields: Record<string, string>) => {
      const request = new Request("http://localhost/profile", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });
      return (await profileRoute.action({ request, params: {}, context: {} } as never)) as Record<string, unknown>;
    };
    expect(await post({ intent: "profile", name: "Zed", email: "zed@example.test", timeZone: "Europe/Berlin" })).toEqual({ saved: "profile" });
    expect(row().timeZone).toBe("Europe/Berlin");
    const refused = await post({ intent: "profile", name: "Zed", email: "zed@example.test", timeZone: "Nowhere/Land" });
    expect((refused.errors as Record<string, string[]>).timeZone).toEqual(["is not a known time zone"]);
    expect(row().timeZone).toBe("Europe/Berlin");
    // The loader reports it.
    const loaded = (await profileRoute.loader({ request: new Request("http://localhost/profile", { headers: { Cookie: cookie } }), params: {}, context: {} } as never)) as { timeZone: string };
    expect(loaded.timeZone).toBe("Europe/Berlin");
  });
});
