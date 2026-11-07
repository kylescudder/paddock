import { createClerkClient } from "@clerk/backend";
import { config } from "./config.ts";
import { errorResponse } from "./errors.ts";
import { services, type Services } from "./services.ts";
import type { AuthProvider } from "./auth-env.ts";
import { betterAuth, type AuthAccess } from "./auth.ts";
import { isVerifiedAllowedUser } from "./auth-policy.ts";

export type Identity = { userId: string | null; isAuthenticated: boolean };
export interface GuardOptions {
  // Tests replace the provider with a fixed identity; production always uses
  // the selected provider's verified session.
  identity?: (request: Request) => Identity | Promise<Identity>;
  // Tests may supply an isolated Better Auth instance instead of the host's.
  betterAuth?: () => Promise<AuthAccess>;
  config?: Pick<
    typeof config,
    "clerkPublishableKey" | "clerkSecretKey" | "appUrl"
  > & { authProvider?: AuthProvider };
}
export const guardOverrides: { current?: GuardOptions } = {};

// Identity comes only from a cryptographically verified session (Clerk's
// token, or Better Auth's database session). Clerk is invite-only and Better
// Auth only admits allowlisted emails, so any signed-in user may administer.
export function accessDecision(identity: {
  userId: string | null;
  isAuthenticated?: boolean;
}): 200 | 401 {
  return identity.isAuthenticated && identity.userId ? 200 : 401;
}
async function clerkIdentity(
  request: Request,
  settings: NonNullable<GuardOptions["config"]>,
): Promise<Identity> {
  const state = await createClerkClient({
    publishableKey: settings.clerkPublishableKey,
    secretKey: settings.clerkSecretKey,
  }).authenticateRequest(request, {
    authorizedParties: [settings.appUrl],
    acceptsToken: "session_token",
  });
  // A handshake or signed-out state is never treated as an identity.
  if (!state.isAuthenticated) return { userId: null, isAuthenticated: false };
  return { userId: state.toAuth().userId, isAuthenticated: true };
}
async function betterAuthIdentity(
  request: Request,
  access: AuthAccess,
): Promise<Identity> {
  const session = await access.auth.api.getSession({
    headers: request.headers,
  });
  // The email must be verified and still allowlisted: removing an address
  // from AUTH_ALLOWED_EMAILS revokes access to existing sessions too.
  if (!session || !isVerifiedAllowedUser(session.user, access.allowedEmails))
    return { userId: null, isAuthenticated: false };
  return { userId: session.user.id, isAuthenticated: true };
}
const notConfigured = (provider: AuthProvider) =>
  Response.json(
    {
      error:
        provider === "better-auth"
          ? "Sign-in is not configured. Set the Better Auth settings on the host."
          : "Sign-in is not configured. Set the Clerk keys on the host.",
    },
    { status: 503 },
  );
async function ownerGate(request: Request): Promise<Response | null> {
  const options = guardOverrides.current;
  const settings = options?.config ?? config;
  const provider = settings.authProvider ?? "clerk";
  let identity: Identity;
  if (provider === "better-auth") {
    let access: AuthAccess | undefined;
    if (!options?.identity)
      try {
        access = await (options?.betterAuth ?? betterAuth)();
      } catch {
        return notConfigured(provider);
      }
    identity = options?.identity
      ? await options.identity(request)
      : await betterAuthIdentity(request, access!);
  } else {
    const configured = Boolean(
      settings.clerkPublishableKey && settings.clerkSecretKey,
    );
    if (!configured && !options?.identity) return notConfigured(provider);
    identity = options?.identity
      ? await options.identity(request)
      : await clerkIdentity(request, settings);
  }
  if (accessDecision(identity) !== 200)
    return Response.json(
      { error: "Sign in to manage your library." },
      { status: 401 },
    );
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers.get("origin") !== settings.appUrl
  )
    return Response.json(
      { error: "This request must come from your own Paddock site." },
      { status: 403 },
    );
  return null;
}

// Wraps a signed-in-only handler: authenticate, then run it.
export function admin(
  handler: (
    request: Request,
    context: { params: Record<string, string>; services: Services },
  ) => Response | Promise<Response>,
) {
  return async ({
    request,
    params,
  }: {
    request: Request;
    params?: Record<string, string>;
  }) => {
    try {
      const denied = await ownerGate(request);
      const response =
        denied ??
        (await handler(request, {
          params: params ?? {},
          services: await services(),
        }));
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };
}
