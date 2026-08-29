/**
 * Request principal — how the current request was authenticated, made
 * visible to the authorization checkpoint (ADR-0021 Decision 4).
 *
 * Purpose: the checkpoint judges a project's access constraint by how
 * *this* session was opened (its strategy kind) or, for an API
 * request, by the caller's linked identities — never by re-deriving
 * from the user row. That fact is per-request state and lives in the
 * HTTP layer, so the adapter hands it in explicitly: root middleware
 * enters the principal for the request and every loader, action, and
 * command inside it can read it. Code that runs outside a request
 * (background jobs, tests calling commands directly) sees no
 * principal, and the checkpoint treats that as in-process work not
 * subject to a session constraint; tests that exercise the constraint
 * enter one with `runWithPrincipal`.
 *
 * Invariant: the store is entered only by `runWithPrincipal`; nothing
 * mutates it afterwards.
 *
 * Public interface: `RequestPrincipal`, `runWithPrincipal`,
 * `currentPrincipal`.
 *
 * Owner context: Identity & Access (request context, infrastructure-
 * neutral: node:async_hooks only).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { StrategyKind } from "~/shared/wire-types";

/** How the request in flight was authenticated. */
export type RequestPrincipal =
  | {
      via: "session";
      userId: number;
      /**
       * The strategy that opened the session, or null for a cookie
       * issued before sessions recorded it — such a session satisfies
       * no constraint until the user signs in again (ADR-0021).
       */
      strategyKind: StrategyKind | null;
    }
  | { via: "api" }
  | { via: "anonymous" };

const store = new AsyncLocalStorage<RequestPrincipal>();

/**
 * Runs `fn` with `principal` as the request principal for everything
 * it calls, synchronously or after awaits.
 *
 * @param principal - how the request was authenticated
 * @param fn - the work to run inside the principal's scope
 */
export function runWithPrincipal<T>(principal: RequestPrincipal, fn: () => T): T {
  return store.run(principal, fn);
}

/** The principal of the request in flight, or undefined outside a request. */
export function currentPrincipal(): RequestPrincipal | undefined {
  return store.getStore();
}
