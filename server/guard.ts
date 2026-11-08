import { config } from "./config.ts";
import { errorResponse } from "./errors.ts";
import { services, type Services } from "./services.ts";
import { betterAuth, type AuthAccess } from "./auth.ts";
import { isVerifiedAllowedUser } from "./auth-policy.ts";

export type Identity = { userId: string | null; isAuthenticated: boolean };
export interface GuardOptions {
  // Tests replace the session with a fixed identity; production always uses
  // Better Auth's verified session.
  identity?: (request: Request) => Identity | Promise<Identity>;
  // Tests may supply an isolated Better Auth instance instead of the host's.
  betterAuth?: () => Promise<AuthAccess>;
  config?: Pick<typeof config, "appUrl">;
}
export const guardOverrides: { current?: GuardOptions } = {};

// Identity comes only from Better Auth's verified database session. Better Auth
// only admits allowlisted emails, so any signed-in user may administer.
export function accessDecision(identity: {
  userId: string | null;
  isAuthenticated?: boolean;
}): 200 | 401 {
  return identity.isAuthenticated && identity.userId ? 200 : 401;
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
const notConfigured = () =>
  Response.json(
    {
      error:
        "Sign-in is not configured. Set the Better Auth settings on the host.",
    },
    { status: 503 },
  );
async function ownerGate(request: Request): Promise<Response | null> {
  const options = guardOverrides.current;
  const settings = options?.config ?? config;
  let identity: Identity;
  if (options?.identity) identity = await options.identity(request);
  else {
    let access: AuthAccess;
    try {
      access = await (options?.betterAuth ?? betterAuth)();
    } catch {
      return notConfigured();
    }
    identity = await betterAuthIdentity(request, access);
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
