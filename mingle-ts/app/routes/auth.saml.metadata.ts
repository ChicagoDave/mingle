/**
 * /auth/saml/metadata — this site's SAML service-provider metadata
 * (resource route, GET, XML).
 *
 * Purpose: the document an identity-provider administrator registers
 * so the IdP knows this site's entity id and assertion consumer URL.
 * Public, like every SP's metadata; 404 when SAML is not enabled.
 *
 * Public interface: `loader`.
 * Owner context: Identity & Access (HTTP adapter).
 */
import type { Route } from "./+types/auth.saml.metadata";
import { db } from "~/db/client.server";
import { samlCallbackUrl, SamlSignInError, serviceProviderMetadata } from "~/auth/saml-client.server";
import { sealer } from "~/auth/sealer.server";
import { loadAuthenticationConfiguration } from "~/domain/identity/auth-configuration.server";

/** GET: the SP metadata XML. */
export async function loader({ request }: Route.LoaderArgs) {
  const { saml } = loadAuthenticationConfiguration(db, sealer);
  if (!saml.enabled) throw new Response("Not Found", { status: 404 });
  try {
    return new Response(serviceProviderMetadata(saml, samlCallbackUrl(request)), {
      headers: { "Content-Type": "application/samlmetadata+xml; charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof SamlSignInError) throw new Response(error.message, { status: 503 });
    throw error;
  }
}
