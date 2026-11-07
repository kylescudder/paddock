import { expect, test } from "bun:test";
import { renderCodeEmail, renderLinkEmail } from "../server/auth-email.ts";

const origin = "https://paddock.auth.test";

test("auth emails are branded, escape links and only link to this site", () => {
  const code = renderCodeEmail(origin, "123456");
  expect(code.subject).toBe("123456 is your Paddock sign-in code");
  expect(code.html).toContain(`src="${origin}/email-logo.png"`);
  expect(code.html).toContain('width="40" height="40"');
  expect(code.html).toContain("paddock<span");
  expect(code.html).toContain(">123456<");
  expect(code.html).toContain("10 minutes");
  expect(code.text).toContain("123456");
  expect(() => renderCodeEmail(origin, "12345<")).toThrow();

  const url = `${origin}/api/auth/magic-link/verify?token=abc&callbackURL=%2F"x`;
  const link = renderLinkEmail(origin, "magic-link", url);
  expect(link.subject).toBe("Your Paddock sign-in link");
  // URL parsing percent-encodes the quote; & is HTML-escaped in attributes.
  expect(link.html).toContain("token=abc&amp;callbackURL=%2F%22x");
  expect(link.html).not.toContain('callbackURL=%2F"x');
  expect(link.text).toContain(new URL(url).href);

  const reset = renderLinkEmail(
    origin,
    "reset-password",
    `${origin}/api/auth/reset-password/t`,
  );
  expect(reset.subject).toBe("Set your Paddock password");
  expect(reset.html).toContain("30 minutes");
  expect(reset.html).toContain("paddock.auth.test");

  expect(() =>
    renderLinkEmail(origin, "magic-link", "https://attacker.example/verify"),
  ).toThrow("Unexpected sign-in link origin");
});
