/**
 * Behavioral tests for /logout — the session ends on GET (legacy
 * "Sign out" link parity) and on POST (the profile page's form).
 *
 * Derived from the rule 12 Behavior Statement: each test asserts on
 * the response's Set-Cookie header (the state a browser would keep),
 * not merely on the redirect status.
 *
 * Owner context: Identity & Access verification.
 */
import { describe, expect, it } from "vitest";
import { createUserSession, getUserId } from "../app/auth/session.server";
import * as logoutRoute from "../app/routes/logout";

async function signedInCookie(): Promise<string> {
  return (await createUserSession(42, "/")).headers.get("Set-Cookie")!.split(";")[0];
}

async function expectSignedOut(response: Response, cookieBefore: string) {
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/login");
  const cleared = response.headers.get("Set-Cookie")!;
  expect(cleared).toMatch(/^mingle_session=;/);
  expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  // The cookie the browser would now hold resolves to no user.
  const after = new Request("http://localhost/profile", { headers: { Cookie: cleared.split(";")[0] } });
  expect(await getUserId(after)).toBeNull();
  // …whereas the one it held before did.
  const before = new Request("http://localhost/profile", { headers: { Cookie: cookieBefore } });
  expect(await getUserId(before)).toBe(42);
}

describe("/logout", () => {
  it("GET ends the session and redirects to /login (legacy Sign out link)", async () => {
    const cookie = await signedInCookie();
    const request = new Request("http://localhost/logout", { headers: { Cookie: cookie } });
    const response = (await logoutRoute.loader({ request, params: {}, context: {} } as never)) as Response;
    await expectSignedOut(response, cookie);
  });

  it("POST ends the session and redirects to /login (profile page form)", async () => {
    const cookie = await signedInCookie();
    const request = new Request("http://localhost/logout", { method: "POST", headers: { Cookie: cookie } });
    const response = (await logoutRoute.action({ request, params: {}, context: {} } as never)) as Response;
    await expectSignedOut(response, cookie);
  });

  it("GET with no session still redirects to /login with a cleared cookie", async () => {
    const request = new Request("http://localhost/logout");
    const response = (await logoutRoute.loader({ request, params: {}, context: {} } as never)) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
    expect(response.headers.get("Set-Cookie")).toMatch(/^mingle_session=;/);
  });
});
