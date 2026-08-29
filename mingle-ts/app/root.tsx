/**
 * Root route — the HTML document and the application shell (P-16).
 *
 * Purpose: renders the document (`Layout`: head with the legacy
 * favicon and touch icon, body with the router scripts) and, inside
 * it, every page within the legacy site chrome (`App`: `SiteChrome`
 * around the outlet). The loader computes the shell's context — user,
 * selected project, tabs — for each request through
 * app/shell/site-context.server.ts. `ErrorBoundary` renders route
 * errors inside the same document.
 *
 * `middleware` enters the request principal (ADR-0021 Decision 4 —
 * the session's strategy kind, or the API marker) for every loader,
 * action, and command of the request, and enforces a project's access
 * constraint on the read side for `/projects/:identifier` pages
 * through the same predicate the checkpoint uses (Decision 3), and
 * records every request's method, status, and latency for `/metrics`
 * (P-15).
 *
 * Public interface: `middleware`, `links`, `meta`, `loader`, `Layout`,
 * default component, `ErrorBoundary`.
 *
 * Owner context: application shell.
 */
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import { eq } from "drizzle-orm";
import { db } from "~/db/client.server";
import { projects } from "~/db/schema/projects";
import { getSessionPrincipal } from "~/auth/session.server";
import { accessRefusal } from "~/domain/identity/access-constraint.server";
import { runWithPrincipal, type RequestPrincipal } from "~/domain/identity/principal.server";
import { recordRequest } from "~/observability/metrics.server";
import { loadSiteContext } from "~/shell/site-context.server";
import { SiteChrome } from "~/components/site-chrome";

/** Route segments under /projects/ that are not project identifiers. */
const NON_PROJECT_SEGMENTS = new Set(["new", "import"]);

/**
 * Refuses a session that fails the project's access constraint with
 * 403 carrying the constraint's message (the page routes read only
 * after this; commands re-check at the checkpoint).
 */
function enforceProjectAccess(pathname: string, principal: RequestPrincipal): void {
  if (principal.via !== "session") return;
  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!match || NON_PROJECT_SEGMENTS.has(match[1])) return;
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.identifier, decodeURIComponent(match[1]))).get();
  if (!project) return;
  const refusal = accessRefusal(db, principal.userId, project.id, principal);
  if (refusal) throw new Response(refusal, { status: 403, statusText: `Forbidden: ${refusal}` });
}

/** Enters the request principal and applies the read-side project gate. */
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request }, next) => {
    const url = new URL(request.url);
    const principal: RequestPrincipal = url.pathname.startsWith("/api/v1/")
      ? { via: "api" }
      : await getSessionPrincipal(request);
    // P-15: every request, whatever it answers, lands in the metrics registry.
    const startedAt = Date.now();
    const observe = (status: number) => recordRequest(request.method, status, Date.now() - startedAt);
    return runWithPrincipal(principal, async () => {
      try {
        enforceProjectAccess(url.pathname, principal);
        const response = await next();
        observe(response.status);
        return response;
      } catch (thrown) {
        observe(thrown instanceof Response ? thrown.status : 500);
        throw thrown;
      }
    });
  },
];

/** Legacy application.rhtml: favicon and apple-touch-icon. */
export const links: Route.LinksFunction = () => [
  { rel: "shortcut icon", href: "/favicon.ico" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
];

/** Legacy `page_title` fallback: routes without a title show "Mingle". */
export const meta: Route.MetaFunction = () => [{ title: "Mingle" }];

/** Computes the shell context (user, project, tabs) for the request. */
export async function loader({ request }: Route.LoaderArgs) {
  return loadSiteContext(db, request);
}

/** The HTML document around every page. */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/** Every page rendered inside the site chrome. */
export default function App() {
  const context = useLoaderData<typeof loader>();
  return (
    <SiteChrome context={context}>
      <Outlet />
    </SiteChrome>
  );
}

/** Route errors, rendered as a page (legacy layouts/error.rhtml). */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main id="error-page" style={{ padding: 16 }}>
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre style={{ overflowX: "auto" }}>
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
