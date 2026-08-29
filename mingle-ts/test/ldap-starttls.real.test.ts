/**
 * Real-path test for LDAP StartTLS (P-7, Phase 10, rule 13a).
 *
 * Purpose: proves the bind path upgrades an ldap:// connection with
 * StartTLS before binding, and verifies the directory's certificate
 * (chain and hostname — the container's certificate names `localhost`)
 * while doing so. The directory is a real OpenLDAP (osixia/openldap in
 * Docker) serving a certificate this suite mints with openssl under its
 * own CA (the image's built-in CA expired in 2026): with that CA
 * configured the sign-in succeeds; with a different CA, or none (the
 * system store),
 * the TLS handshake fails and the strategy reports the directory as
 * unreachable — which is only possible if StartTLS actually ran.
 * Nothing on the app side is stubbed: the app's `ldapts` adapter, the
 * real strategy, the real database.
 *
 * Precondition: a Docker daemon, network access to pull the image the
 * first time, and openssl. Run via `npm run test:ldap-tls` (also part
 * of `npm run test:realpath`).
 *
 * Owner context: Identity & Access verification (infrastructure).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Client } from "ldapts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "mingle-ldap-tls-"));
process.env.DATABASE_FILE = join(dir, "test.db");
process.env.SESSION_SECRET = "ldap-tls-suite-secret";

const { db, sqlite } = await import("../app/db/client.server");
const { openLdapDirectory } = await import("../app/auth/ldap-directory.server");
const { externalIdentities, users } = await import("../app/db/schema/identity");
const { DEFAULT_LDAP_SETTINGS } = await import("../app/domain/identity/auth-configuration.server");
const { authenticateViaLdap } = await import("../app/domain/identity/ldap-strategy.server");

const IMAGE = "osixia/openldap:1.5.0";
const SUFFIX = "dc=example,dc=test";
const ADMIN_DN = `cn=admin,${SUFFIX}`;
const ADMIN_PASSWORD = "admin-secret";
const container = `mingle-ldap-tls-${process.pid}`;
let port = 0;
let ca = "";
let otherCa = "";

function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createTcpServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const found = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? rejectPort(error) : resolvePort(found)));
    });
  });
}

const docker = (args: string[], timeout = 120_000) => execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Waits until slapd answers a StartTLS bind from inside the container.
 * The image runs a bootstrap slapd without TLS first; a plain bind
 * succeeding is not readiness — `-ZZ` (StartTLS required) is.
 */
async function waitForDirectory(): Promise<void> {
  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      docker(["exec", container, "ldapwhoami", "-x", "-ZZ", "-H", "ldap://localhost", "-D", ADMIN_DN, "-w", ADMIN_PASSWORD], 15_000);
      return;
    } catch (error) {
      last = String(error);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`OpenLDAP did not come up with TLS: ${last}`);
}

/** Mints a CA and a `localhost` server certificate signed by it, plus the DH parameters slapd wants, all readable by the container. */
function mintCertificates(): { certsDir: string; ca: string } {
  const certsDir = join(dir, "certs");
  mkdirSync(certsDir);
  const ssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore", timeout: 120_000 });
  ssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certsDir, "ca.key"), "-out", join(certsDir, "ca.crt"), "-days", "2", "-subj", "/CN=mingle-test-ca"]);
  ssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certsDir, "ldap.key"), "-out", join(certsDir, "ldap.csr"), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
  ssl(["x509", "-req", "-in", join(certsDir, "ldap.csr"), "-CA", join(certsDir, "ca.crt"), "-CAkey", join(certsDir, "ca.key"), "-CAcreateserial", "-out", join(certsDir, "ldap.crt"), "-days", "2", "-copy_extensions", "copy"]);
  ssl(["dhparam", "-out", join(certsDir, "dhparam.pem"), "2048"]);
  for (const file of readdirSync(certsDir)) chmodSync(join(certsDir, file), 0o644);
  return { certsDir, ca: readFileSync(join(certsDir, "ca.crt"), "utf8") };
}

beforeAll(async () => {
  port = await freePort();
  const minted = mintCertificates();
  ca = minted.ca;
  docker(
    [
      "run", "-d", "--rm", "--name", container, "--hostname", "localhost",
      "-e", "LDAP_DOMAIN=example.test", "-e", "LDAP_ORGANISATION=Example", "-e", `LDAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
      "-e", "LDAP_TLS=true", "-e", "LDAP_TLS_VERIFY_CLIENT=never",
      "-v", `${minted.certsDir}:/container/service/slapd/assets/certs`,
      "-p", `127.0.0.1:${port}:389`,
      IMAGE,
    ],
    10 * 60 * 1000,
  );
  await waitForDirectory();
  // A CA the directory's certificate does not chain to.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "other.key"), "-out", join(dir, "other.crt"), "-days", "1", "-subj", "/CN=other-ca"], { stdio: "ignore" });
  otherCa = readFileSync(join(dir, "other.crt"), "utf8");

  // Seed one person over a plain connection as the admin.
  const admin = new Client({ url: `ldap://localhost:${port}` });
  await admin.bind(ADMIN_DN, ADMIN_PASSWORD);
  await admin.add(`ou=people,${SUFFIX}`, { objectClass: ["organizationalUnit"], ou: "people" });
  await admin.add(`uid=alice,ou=people,${SUFFIX}`, {
    objectClass: ["inetOrgPerson"],
    uid: "alice",
    cn: "Alice Example",
    sn: "Example",
    mail: "alice@example.test",
    userPassword: "alice-pw!1",
  });
  await admin.unbind();
}, 12 * 60 * 1000);

afterAll(() => {
  try {
    docker(["rm", "-f", container]);
  } catch {
    // best effort
  }
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function settings(overrides: Partial<typeof DEFAULT_LDAP_SETTINGS>) {
  return {
    ...DEFAULT_LDAP_SETTINGS,
    enabled: true,
    url: `ldap://localhost:${port}`,
    bindDn: ADMIN_DN,
    bindPassword: ADMIN_PASSWORD,
    baseDn: `ou=people,${SUFFIX}`,
    loginAttribute: "uid",
    objectClass: "inetOrgPerson",
    nameAttribute: "cn",
    mailAttribute: "mail",
    autoEnroll: true,
    ...overrides,
  };
}

async function signIn(overrides: Partial<typeof DEFAULT_LDAP_SETTINGS>) {
  const config = settings(overrides);
  let directory;
  try {
    directory = await openLdapDirectory(config);
  } catch (error) {
    return { ok: false as const, errors: { login: [`The directory server could not be reached (${String(error)})`] } };
  }
  return authenticateViaLdap(db, config, directory, { login: "alice", password: "alice-pw!1" });
}

describe("LDAP StartTLS against a real OpenLDAP", () => {
  it("upgrades with StartTLS and signs the user in when the directory's CA is trusted", async () => {
    const result = await signIn({ startTls: true, tlsCaCert: ca });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const user = db.select().from(users).where(eq(users.login, "alice")).get();
    expect(user?.name).toBe("Alice Example");
    expect(user?.email).toBe("alice@example.test");
  }, 60_000);

  it("refuses the upgrade — no bind, no sign-in — when the directory's certificate does not chain to the configured CA, or to the system store", async () => {
    db.delete(externalIdentities).run();
    db.delete(users).run();
    const wrongCa = await signIn({ startTls: true, tlsCaCert: otherCa });
    expect(wrongCa.ok).toBe(false);
    if (!wrongCa.ok) expect(wrongCa.errors.login?.[0]).toMatch(/could not be reached/);
    const systemStore = await signIn({ startTls: true, tlsCaCert: "" });
    expect(systemStore.ok).toBe(false);
    expect(db.select().from(users).where(eq(users.login, "alice")).all()).toEqual([]);
  }, 60_000);

  it("still signs in over a plain connection when StartTLS is off — the flag is what changes the wire", async () => {
    // Step by step through the adapter first, so a failing step names itself.
    const directory = await openLdapDirectory(settings({ startTls: false }));
    expect(await directory.bind(ADMIN_DN, ADMIN_PASSWORD)).toBe(true);
    const entries = await directory.search(`ou=people,${SUFFIX}`, "(&(objectClass=inetOrgPerson)(uid=alice))", ["uid", "cn", "mail"]);
    expect(entries.map((e) => e.dn)).toEqual([`uid=alice,ou=people,${SUFFIX}`]);
    expect(await directory.bind(`uid=alice,ou=people,${SUFFIX}`, "alice-pw!1")).toBe(true);
    await directory.close();
    const plain = await signIn({ startTls: false });
    expect(plain.ok, JSON.stringify(plain)).toBe(true);
  }, 60_000);
});
