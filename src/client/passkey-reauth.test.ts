// Runs in its own Bun process (see package.json) so DOM globals and auth-client
// modules do not share a module cache with the server and database tests.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";

const browser = new Window({ url: "https://paddock.auth.test/profile" });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let registerOptionsRequests = 0;
let signOuts = 0;
let createRoot: typeof import("react-dom/client").createRoot;
let AuthUIProvider: typeof import("../components/auth/auth-provider").AuthProvider;
let AddPasskeyDialog: typeof import("../components/auth/passkey/add-passkey-dialog").AddPasskeyDialog;
let passkeyUI: typeof import("../lib/auth/passkey-plugin");
let authClient: typeof import("../lib/auth-client").authClient;
let queryTools: typeof import("@tanstack/react-query");

beforeAll(async () => {
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    Node: browser.Node,
    Element: browser.Element,
    Image: browser.Image,
    Event: browser.Event,
    InputEvent: browser.InputEvent,
    CustomEvent: browser.CustomEvent,
    FocusEvent: browser.FocusEvent,
    KeyboardEvent: browser.KeyboardEvent,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    HTMLDivElement: browser.HTMLDivElement,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    sessionStorage: browser.sessionStorage,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      browser.location.origin,
    );
    if (url.pathname === "/api/auth/passkey/generate-register-options") {
      registerOptionsRequests++;
      // What production returned: the session is older than freshAge (1 h).
      return Response.json(
        { message: "Session is not fresh", code: "SESSION_NOT_FRESH" },
        { status: 403, statusText: "Forbidden" },
      );
    }
    if (url.pathname === "/api/auth/sign-out") {
      signOuts++;
      return Response.json({ success: true });
    }
    if (url.pathname === "/api/auth/get-session")
      return Response.json({
        user: {
          id: "owner",
          name: "Owner",
          email: "owner@example.com",
          emailVerified: true,
          image: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        session: {
          id: "disposable-session",
          userId: "owner",
          expiresAt: "2030-01-01T00:00:00Z",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      });
    if (url.pathname === "/api/auth/passkey/list-user-passkeys")
      return Response.json([]);
    throw new Error("Unexpected test request: " + url.pathname);
  }) as unknown as typeof fetch;
  ({ createRoot } = await import("react-dom/client"));
  ({ AuthProvider: AuthUIProvider } =
    await import("../components/auth/auth-provider"));
  ({ AddPasskeyDialog } =
    await import("../components/auth/passkey/add-passkey-dialog"));
  passkeyUI = await import("../lib/auth/passkey-plugin");
  ({ authClient } = await import("../lib/auth-client"));
  queryTools = await import("@tanstack/react-query");
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test('adding a passkey with a stale session offers "Sign in again" and returns to the profile', async () => {
  const navigations: string[] = [];
  const queryClient = new queryTools.QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    await act(async () => {
      root.render(
        createElement(
          AuthUIProvider,
          {
            authClient,
            queryClient,
            navigate: ({ to }: { to: string }) => {
              navigations.push(to);
            },
            emailAndPassword: { enabled: false },
            plugins: [passkeyUI.passkeyPlugin()],
          } as never,
          createElement(AddPasskeyDialog, {
            open: true,
            onOpenChange: () => {},
          }),
        ),
      );
      await wait();
    });
    // The dialog renders in a portal on document.body.
    const dialog = () => document.querySelector('[role="dialog"]')!;
    expect(dialog()).toBeTruthy();
    const name =
      dialog().querySelector<HTMLInputElement>('input[name="name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        browser.HTMLInputElement.prototype,
        "value",
      )!.set!.call(name, "1Password");
      name.dispatchEvent(
        new browser.Event("input", { bubbles: true }) as unknown as Event,
      );
    });
    await act(async () => {
      dialog()
        .querySelector("form")!
        .dispatchEvent(
          new browser.Event("submit", {
            bubbles: true,
            cancelable: true,
          }) as unknown as Event,
        );
      await wait();
    });
    expect(registerOptionsRequests).toBe(1);
    // Before the fix the 403 resolved as { error }, so the form stayed put
    // with no message and no way forward.
    expect(dialog().querySelector('input[name="name"]')).toBeNull();
    const signInAgain = Array.from(dialog().querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Sign in again",
    );
    expect(signInAgain).toBeTruthy();
    await act(async () => {
      signInAgain!.click();
      await wait();
    });
    expect(signOuts).toBe(1);
    expect(navigations).toEqual([
      "/auth/sign-in?reauthenticate=true&redirectTo=%2Fprofile",
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
