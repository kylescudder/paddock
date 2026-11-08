import { UserRound } from "lucide-react";
import { UserButton } from "@/components/auth/user/user-button";
import { BetterAuthUIProvider } from "@/components/BetterAuthUIProvider";

// Loaded only for signed-in owners, keeping the auth UI out of public pages.
export function BetterAuthUserMenu() {
  return (
    <BetterAuthUIProvider>
      <UserButton
        size="icon"
        align="end"
        hideSettings
        className="ring-1 ring-border hover:ring-primary"
        links={[
          {
            label: "Profile",
            href: "/profile",
            icon: <UserRound />,
            visibility: "authenticated",
          },
        ]}
      />
    </BetterAuthUIProvider>
  );
}
