import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { App } from "../components/App";
import { Auth } from "@/components/auth/auth";
import { BetterAuthUIProvider } from "@/components/BetterAuthUIProvider";

export const Route = createFileRoute("/auth/$path")({ component: AuthPage });

function AuthPage() {
  const { app } = Route.useRouteContext();
  const { path } = Route.useParams();
  // Clerk keeps its own sign-in in the owner workspace; these are Better Auth only.
  if (app.authProvider !== "better-auth") return <Navigate to="/admin" />;
  // Accounts are never self-registered: only allowlisted emails can sign in.
  if (path === "sign-up")
    return <Navigate to="/auth/$path" params={{ path: "sign-in" }} replace />;
  const signingOut = path === "sign-out";
  return (
    <App admin>
      {() => (
        <main className="sign-in-page auth-page">
          <div className="eyebrow">OWNER WORKSPACE</div>
          <h1>{signingOut ? "See you next lap." : "Welcome back."}</h1>
          <p>
            {signingOut
              ? "Signing you out of Paddock…"
              : "Sign in with your approved account to manage Paddock."}
          </p>
          <div className="paddock-auth">
            <BetterAuthUIProvider>
              <Auth path={path} className="w-full max-w-none text-left" />
            </BetterAuthUIProvider>
          </div>
          <p className="auth-note">
            The collection is public; you only need to sign in to manage it.{" "}
            <Link to="/">Back to the collection</Link>
          </p>
        </main>
      )}
    </App>
  );
}
