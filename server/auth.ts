import { drizzle } from "drizzle-orm/postgres-js";
import { connection } from "./database.ts";
import * as schema from "./schema.ts";
import { readAuthEnv, readAuthProvider } from "./auth-env.ts";
import { createPaddockAuth, type PaddockAuth } from "./auth-factory.ts";
import { sendLinkEmail, sendLoginEmail } from "./auth-email.ts";

export type AuthAccess = { auth: PaddockAuth; allowedEmails: string[] };

// Paths the app forwards to Better Auth. Everything else is a 404, and so is
// every path while Clerk is the selected provider.
const paths = new Set([
  "/get-session",
  "/sign-out",
  "/update-user",
  "/email-otp/send-verification-otp",
  "/sign-in/email-otp",
  "/sign-in/email",
  "/sign-in/magic-link",
  "/magic-link/verify",
  "/request-password-reset",
  "/reset-password",
  "/change-password",
  "/list-accounts",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
]);
export function isForwardedAuthPath(pathname: string) {
  const path = pathname.slice("/api/auth".length);
  // The emailed reset link lands on /reset-password/<token> before redirecting.
  return (
    pathname.startsWith("/api/auth/") &&
    (paths.has(path) || /^\/reset-password\/[\w-]+$/.test(path))
  );
}

// Shares the app's bounded Postgres.js pool. Created on first use so the
// public gallery never needs auth settings.
const slot = globalThis as unknown as {
  __paddockAuth?: Promise<AuthAccess>;
};
export function betterAuth(): Promise<AuthAccess> {
  slot.__paddockAuth ??= (async () => {
    const env = readAuthEnv();
    if (env.AUTH_PROVIDER !== "better-auth")
      throw new Error("Better Auth is not enabled");
    const origin = env.BETTER_AUTH_URL!;
    const mail = env.BREVO_API_KEY
      ? { apiKey: env.BREVO_API_KEY, from: env.AUTH_EMAIL_FROM! }
      : null;
    const auth = createPaddockAuth(
      drizzle({ client: await connection(), schema }),
      {
        baseURL: origin,
        secret: env.BETTER_AUTH_SECRET!,
        allowedEmails: env.AUTH_ALLOWED_EMAILS,
        dailyEmailLimit: env.AUTH_EMAIL_DAILY_LIMIT,
      },
      // Outside production, mail may be disabled for local checks: nothing is
      // sent and nothing is logged.
      async (email, otp) => {
        if (mail) await sendLoginEmail(mail, origin, email, otp);
      },
      async (email, kind, url) => {
        if (mail) await sendLinkEmail(mail, origin, email, kind, url);
      },
    );
    return { auth, allowedEmails: env.AUTH_ALLOWED_EMAILS };
  })().catch((error) => {
    slot.__paddockAuth = undefined;
    throw error;
  });
  return slot.__paddockAuth;
}

export async function authHandler(request: Request) {
  if (
    readAuthProvider() !== "better-auth" ||
    !isForwardedAuthPath(new URL(request.url).pathname)
  )
    return new Response("Not found", { status: 404 });
  let access: AuthAccess;
  try {
    access = await betterAuth();
  } catch {
    // Missing settings are reported by name at startup, never echoed here.
    return Response.json(
      { message: "Sign-in is not configured on the host." },
      { status: 503 },
    );
  }
  const response = await access.auth.handler(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
