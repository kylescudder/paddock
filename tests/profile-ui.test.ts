import { afterEach, expect, test } from "bun:test";
import { profileAvatar } from "../src/lib/profile-ui.ts";
import { prepareAvatar } from "../src/lib/profile.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("the profile UI uploads and removes the photo through the private endpoint", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json({
      image: init?.method === "PUT" ? "/api/profile/avatar?v=abc" : null,
    });
  }) as typeof fetch;
  expect(profileAvatar.enabled).toBe(true);
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "avatar.jpg", {
    type: "image/jpeg",
  });
  expect(await profileAvatar.upload(file)).toBe("/api/profile/avatar?v=abc");
  await profileAvatar.delete();
  expect(calls.map(({ url, init }) => [url, init?.method])).toEqual([
    ["/api/profile/avatar", "PUT"],
    ["/api/profile/avatar", "DELETE"],
  ]);
  expect(new Headers(calls[0]!.init?.headers).get("Content-Type")).toBe(
    "image/jpeg",
  );
  expect(calls[0]!.init?.body).toBe(file);
});

test("server refusals reach the user, and unsupported files are refused before upload", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: "This photo is too large." },
      { status: 413 },
    )) as unknown as typeof fetch;
  const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
  await expect(profileAvatar.upload(file)).rejects.toThrow(
    "This photo is too large.",
  );
  await expect(
    prepareAvatar(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })),
  ).rejects.toThrow("Choose a JPEG, PNG or WebP photo.");
});
