import { createServerFn } from "@tanstack/react-start";

// Clerk keys and the auth provider are runtime environment on the host, so
// they are read per request rather than baked into the client bundle at build
// time. Only public values leave the server.
export const getAppConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const { authConfigured, config } = await import("../../server/config.ts");
    return {
      authProvider: config.authProvider,
      clerkPublishableKey:
        config.authProvider === "clerk"
          ? process.env.CLERK_PUBLISHABLE_KEY || ""
          : "",
      authConfigured,
    };
  },
);
