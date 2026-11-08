import path from "node:path";
import { readAuthEnv, readAuthProvider } from "./auth-env.ts";

export const config = {
  port: Number(process.env.PORT || 3000),
  appUrl: new URL(process.env.APP_URL || "http://localhost:3000").origin,
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  root: process.cwd(),
  // `clerk` (default) or `better-auth`; an unknown value fails at startup.
  authProvider: readAuthProvider(),
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY || "",
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  embyUrl: (process.env.EMBY_URL || "").replace(/\/$/, ""),
  embyKey: process.env.EMBY_API_KEY || "",
};
function betterAuthConfigured() {
  try {
    readAuthEnv();
    return true;
  } catch {
    return false;
  }
}
// Administration (and scheduled inference) stay closed until the selected
// provider is fully configured.
export const authConfigured =
  config.authProvider === "better-auth"
    ? betterAuthConfigured()
    : Boolean(config.clerkPublishableKey && config.clerkSecretKey);
