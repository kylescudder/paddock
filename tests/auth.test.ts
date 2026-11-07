import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "../server/migrations.ts";
import * as schema from "../server/schema.ts";
import { createPaddockAuth } from "../server/auth-factory.ts";
import { authHandler, type AuthAccess } from "../server/auth.ts";
import { readAuthEnv } from "../server/auth-env.ts";
import { guardOverrides } from "../server/guard.ts";
import { owner } from "../server/api.ts";
import { useServices, type Services } from "../server/services.ts";
import { closeConnection } from "../server/database.ts";

// A disposable database only: these tests delete every auth_* row.
const databaseUrl =
  process.env.TEST_DATABASE_URL ||
  "postgres://postgres:paddock@127.0.0.1:55432/paddock_test";
if (!new URL(databaseUrl).pathname.endsWith("_test"))
  throw new Error("TEST_DATABASE_URL must name a database ending in _test");
await migrate(databaseUrl);
const sql = postgres(databaseUrl, {
  max: 4,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: () => {},
});
const db = drizzle({ client: sql, schema });
afterAll(() => sql.end());

const origin = "https://paddock.auth.test";
const secret = "paddock-test-secret-that-is-at-least-32-chars";
let fixtureNumber = 0;

async function authFixture() {
  await sql`DELETE FROM auth_user`;
  await sql`DELETE FROM auth_verification`;
  await sql`DELETE FROM auth_rate_limit`;
  await sql`DELETE FROM auth_email_limit`;
  const sent = new Map<string, string>();
  const links: { email: string; kind: string; url: string }[] = [];
  const allowedEmails = ["owner@thescudders.test", "second@thescudders.test"];
  const auth = createPaddockAuth(
    db,
    { baseURL: origin, secret, allowedEmails, dailyEmailLimit: 40 },
    async (email, otp) => {
      sent.set(email, otp);
    },
    async (email, kind, url) => {
      links.push({ email, kind, url });
    },
  );
  const ip = `203.0.113.${++fixtureNumber}`;
  const request = (
    path: string,
    body?: unknown,
    cookie = "",
    extra: Record<string, string> = {},
  ) =>
    auth.handler(
      new Request(origin + "/api/auth" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "CF-Connecting-IP": ip,
          Cookie: cookie,
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const access: AuthAccess = { auth, allowedEmails };
  return { auth, access, request, sent, links, allowedEmails };
}
type Fixture = Awaited<ReturnType<typeof authFixture>>;

function mergeCookies(response: Response, prior = "") {
  const values = new Map(
    prior
      .split("; ")
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), part.slice(index + 1)];
      }),
  );
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0];
    const index = pair.indexOf("=");
    values.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...values].map(([key, value]) => key + "=" + value).join("; ");
}

async function signIn(fixture: Fixture, email = "owner@thescudders.test") {
  const sent = await fixture.request("/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  assert.equal(sent.status, 200, await sent.clone().text());
  const response = await fixture.request("/sign-in/email-otp", {
    email,
    otp: fixture.sent.get(email),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return {
    cookie: mergeCookies(response),
    user: (await response.clone().json()).user as { id: string },
  };
}

// The real admin guard, using this fixture's Better Auth instance.
async function adminMe(fixture: Fixture, cookie: string, method = "GET") {
  guardOverrides.current = {
    betterAuth: async () => fixture.access,
    config: {
      authProvider: "better-auth",
      clerkPublishableKey: "",
      clerkSecretKey: "",
      appUrl: origin,
    },
  };
  useServices({} as Services);
  try {
    return await owner.me({
      request: new Request(origin + "/api/admin/me", {
        method,
        headers: { Cookie: cookie, Origin: origin },
      }),
    });
  } finally {
    guardOverrides.current = undefined;
    useServices(undefined);
  }
}

test("email codes are allowlisted, hashed, single-use and authorize the owner workspace", async () => {
  const fixture = await authFixture();
  const outsider = await fixture.request("/email-otp/send-verification-otp", {
    email: "stranger@example.com",
    type: "sign-in",
  });
  assert.equal(outsider.status, 200);
  assert.deepEqual(await outsider.json(), { success: true });
  assert.equal(fixture.sent.size, 0);
  assert.equal((await sql`SELECT id FROM auth_verification`).length, 0);

  const sent = await fixture.request("/email-otp/send-verification-otp", {
    email: " OWNER@thescudders.test",
    type: "sign-in",
  });
  assert.equal(sent.status, 200);
  const otp = fixture.sent.get("owner@thescudders.test")!;
  assert.match(otp, /^\d{6}$/);
  const [stored] = await sql`SELECT identifier, value FROM auth_verification`;
  assert.equal(stored.identifier, "sign-in-otp-owner@thescudders.test");
  assert.match(stored.value, /^[a-f0-9]{64}:0$/);
  assert.notEqual(stored.value.split(":")[0], otp, "Raw code was persisted");

  // Signed out (and a forged cookie) cannot reach the admin API.
  assert.equal((await adminMe(fixture, "")).status, 401);
  assert.equal(
    (await adminMe(fixture, "paddock-auth.session_token=forged")).status,
    401,
  );

  const wrong = otp === "000000" ? "111111" : "000000";
  assert.equal(
    (
      await fixture.request("/sign-in/email-otp", {
        email: "owner@thescudders.test",
        otp: wrong,
      })
    ).status,
    400,
  );
  const signedIn = await fixture.request("/sign-in/email-otp", {
    email: "owner@thescudders.test",
    otp,
  });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  assert.equal((await signedIn.clone().json()).user.emailVerified, true);
  const cookies = signedIn.headers.getSetCookie().join(";");
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /Secure/i);
  assert.match(cookies, /SameSite=Lax/i);
  assert.match(cookies, /paddock-auth\.session_token/);
  assert.ok(!/Domain=/i.test(cookies), "Session cookie escaped the hostname");
  const cookie = mergeCookies(signedIn);

  const me = await adminMe(fixture, cookie);
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { owner: true });
  assert.equal(me.headers.get("Cache-Control"), "no-store");

  // Codes are single use.
  assert.equal(
    (
      await fixture.request("/sign-in/email-otp", {
        email: "owner@thescudders.test",
        otp,
      })
    ).status,
    400,
  );

  // Removing an address from the allowlist revokes its existing session.
  fixture.allowedEmails.splice(0, 1);
  assert.equal((await adminMe(fixture, cookie)).status, 401);
  fixture.allowedEmails.unshift("owner@thescudders.test");
  assert.equal((await adminMe(fixture, cookie)).status, 200);

  // An unverified account is never an owner, even when allowlisted.
  await sql`UPDATE auth_user SET email_verified = false`;
  assert.equal((await adminMe(fixture, cookie)).status, 401);
  await sql`UPDATE auth_user SET email_verified = true`;

  assert.equal((await fixture.request("/sign-out", {}, cookie)).status, 200);
  assert.equal(
    await (await fixture.request("/get-session", undefined, cookie)).json(),
    null,
  );
  assert.equal((await adminMe(fixture, cookie)).status, 401);
});

test("a recipient's resend cooldown keeps the previous code and cross-site requests are refused", async () => {
  const fixture = await authFixture();
  const email = "owner@thescudders.test";
  const send = (extra: Record<string, string> = {}) =>
    fixture.request(
      "/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      "",
      extra,
    );
  assert.equal((await send()).status, 200);
  const first = fixture.sent.get(email)!;
  const tooSoon = await send();
  assert.equal(tooSoon.status, 429);
  assert.equal(fixture.sent.get(email), first);
  // The minute window is persistent, not per-process.
  const [limit] =
    await sql`SELECT count FROM auth_email_limit WHERE key LIKE 'recipient:%:minute'`;
  assert.equal(limit.count, 1);
  // Three sends a minute per IP; clear that window to test the origin checks.
  await sql`DELETE FROM auth_rate_limit`;
  assert.equal(
    (await send({ Origin: "https://attacker.example" })).status,
    403,
  );
  assert.equal((await send({ "Sec-Fetch-Site": "cross-site" })).status, 403);
  // Only the sign-in type is accepted.
  assert.equal(
    (
      await fixture.request("/email-otp/send-verification-otp", {
        email,
        type: "forget-password",
      })
    ).status,
    400,
  );
  const signedIn = await fixture.request("/sign-in/email-otp", {
    email,
    otp: first,
  });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
});

test("password, reset and magic links are allowlisted, single-use, same-site and sign-up stays closed", async () => {
  const fixture = await authFixture();
  const password = "pit lane to parc ferme";
  const signUp = await fixture.request("/sign-up/email", {
    email: "owner@thescudders.test",
    password,
    name: "Owner",
  });
  assert.equal(signUp.status, 400, await signUp.clone().text());
  assert.equal((await sql`SELECT id FROM auth_user`).length, 0);

  const { user } = await signIn(fixture);
  // An account created by email code has no password until a reset sets one.
  assert.equal(
    (
      await fixture.request("/sign-in/email", {
        email: "owner@thescudders.test",
        password,
      })
    ).status,
    401,
  );
  // The code above used this address's one-email-a-minute allowance.
  assert.equal(
    (
      await fixture.request("/request-password-reset", {
        email: "owner@thescudders.test",
        redirectTo: "/auth/reset-password",
      })
    ).status,
    429,
  );
  assert.equal(fixture.links.length, 0);
  await sql`DELETE FROM auth_email_limit`;

  for (const email of ["stranger@example.com", "OWNER@thescudders.test "])
    assert.equal(
      (
        await fixture.request("/request-password-reset", {
          email,
          redirectTo: "/auth/reset-password",
        })
      ).status,
      200,
    );
  assert.deepEqual(
    fixture.links.map(({ email, kind }) => [email, kind]),
    [["owner@thescudders.test", "reset-password"]],
  );
  const resetUrl = new URL(fixture.links[0].url);
  assert.equal(resetUrl.origin, origin);
  const token = resetUrl.pathname.split("/").at(-1)!;
  const [stored] =
    await sql`SELECT identifier FROM auth_verification WHERE identifier LIKE 'reset-password:%'`;
  assert.equal(stored.identifier, "reset-password:" + token);
  assert.equal(
    (await fixture.request("/reset-password", { newPassword: "short", token }))
      .status,
    400,
  );
  const reset = await fixture.request("/reset-password", {
    newPassword: password,
    token,
  });
  assert.equal(reset.status, 200, await reset.clone().text());
  assert.equal(
    (
      await fixture.request("/reset-password", {
        newPassword: password + "!",
        token,
      })
    ).status,
    400,
    "Reset tokens are single-use",
  );
  const [credential] = await sql`
    SELECT password FROM auth_account
    WHERE user_id = ${user.id} AND provider_id = 'credential'`;
  assert.ok(credential.password && !credential.password.includes(password));

  assert.equal(
    (
      await fixture.request("/sign-in/email", {
        email: "owner@thescudders.test",
        password: "not the password at all",
      })
    ).status,
    401,
  );
  const signedIn = await fixture.request("/sign-in/email", {
    email: "owner@thescudders.test",
    password,
  });
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const passwordCookie = mergeCookies(signedIn);
  const session = await fixture.request(
    "/get-session",
    undefined,
    passwordCookie,
  );
  assert.equal((await session.json()).user.id, user.id);
  assert.equal((await adminMe(fixture, passwordCookie)).status, 200);

  // Magic links: allowlisted only, same-site callbacks only, single use.
  fixture.links.length = 0;
  assert.equal(
    (
      await fixture.request("/sign-in/magic-link", {
        email: "stranger@example.com",
        callbackURL: "/admin",
      })
    ).status,
    200,
  );
  assert.equal(fixture.links.length, 0);
  for (const callbackURL of [
    "https://attacker.example/",
    "//attacker.example/",
    "/.//attacker.example/",
    "/\t/attacker.example/",
    "/\\attacker.example/",
  ]) {
    await sql`DELETE FROM auth_rate_limit`;
    assert.equal(
      (
        await fixture.request("/sign-in/magic-link", {
          email: "second@thescudders.test",
          callbackURL,
        })
      ).status,
      403,
      JSON.stringify(callbackURL),
    );
  }
  await sql`DELETE FROM auth_rate_limit`;
  assert.equal(
    (
      await fixture.request("/request-password-reset", {
        email: "owner@thescudders.test",
        redirectTo: "https://attacker.example/reset",
      })
    ).status,
    403,
  );
  assert.equal(fixture.links.length, 0);
  const requested = await fixture.request("/sign-in/magic-link", {
    email: "second@thescudders.test",
    callbackURL: origin + "/admin",
  });
  assert.equal(requested.status, 200, await requested.clone().text());
  assert.deepEqual(
    fixture.links.map(({ email, kind }) => [email, kind]),
    [["second@thescudders.test", "magic-link"]],
  );
  const magic = new URL(fixture.links[0].url);
  assert.equal(magic.origin, origin);
  const verify = () =>
    fixture.auth.handler(
      new Request(magic, {
        headers: { "CF-Connecting-IP": "203.0.113.250" },
        redirect: "manual",
      }),
    );
  const verified = await verify();
  assert.equal(verified.status, 302);
  assert.equal(verified.headers.get("location"), origin + "/admin");
  const magicSession = await fixture.request(
    "/get-session",
    undefined,
    mergeCookies(verified),
  );
  const magicUser = (await magicSession.json()).user;
  assert.equal(magicUser.email, "second@thescudders.test");
  assert.equal(magicUser.emailVerified, true);
  const replay = await verify();
  assert.equal(mergeCookies(replay).includes("session_token"), false);
  const [strangers] = await sql`
    SELECT count(*)::int AS users FROM auth_user
    WHERE email = 'stranger@example.com'`;
  assert.equal(strangers.users, 0);
});

test("profile updates accept names only, from this site, for an owner", async () => {
  const fixture = await authFixture();
  const { cookie, user } = await signIn(fixture);
  const update = (body: unknown, from = origin) =>
    fixture.request("/update-user", body, cookie, { Origin: from });
  assert.equal(
    (await update({ name: "Kyle" }, "https://attacker.example")).status,
    403,
  );
  assert.equal((await update({ email: "evil@example.com" })).status, 400);
  assert.equal(
    (await update({ image: "https://x.example/a.png" })).status,
    400,
  );
  assert.equal((await update({ emailVerified: false })).status, 400);
  const saved = await update({
    name: "Kyle",
    givenName: " Kyle ",
    familyName: "Scudder",
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const [row] =
    await sql`SELECT name, given_name, family_name, email, email_verified, image FROM auth_user WHERE id = ${user.id}`;
  assert.deepEqual(row, {
    name: "Kyle",
    given_name: "Kyle",
    family_name: "Scudder",
    email: "owner@thescudders.test",
    email_verified: true,
    image: null,
  });
  // A non-allowlisted account could not exist; a forged session is refused.
  assert.equal(
    (
      await fixture.request(
        "/update-user",
        { name: "x" },
        "paddock-auth.session_token=forged",
      )
    ).status,
    401,
  );
  // Passkey enrolment needs a signed-in owner.
  assert.equal(
    (await fixture.request("/passkey/generate-register-options", undefined, ""))
      .status,
    401,
  );
});

test("the app's auth route forwards only allowlisted endpoints, and nothing while Clerk is selected", async () => {
  const keys = [
    "AUTH_PROVIDER",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "AUTH_ALLOWED_EMAILS",
    "BREVO_API_KEY",
    "AUTH_EMAIL_FROM",
    "DATABASE_URL",
    "DATABASE_PASSWORD_FILE",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const call = (path: string, method = "POST") =>
    authHandler(
      new Request(origin + "/api/auth" + path, {
        method,
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.200",
        },
        body: method === "GET" ? undefined : "{}",
      }),
    );
  try {
    await authFixture();
    Object.assign(process.env, {
      AUTH_PROVIDER: "clerk",
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: secret,
      AUTH_ALLOWED_EMAILS: "owner@thescudders.test",
      DATABASE_URL: databaseUrl,
    });
    delete process.env.BREVO_API_KEY;
    delete process.env.AUTH_EMAIL_FROM;
    delete process.env.DATABASE_PASSWORD_FILE;
    // Clerk (the default and rollback) exposes none of Better Auth.
    for (const path of ["/get-session", "/sign-in/email", "/sign-up/email"])
      assert.equal(
        (await call(path, path === "/get-session" ? "GET" : "POST")).status,
        404,
        path,
      );

    process.env.AUTH_PROVIDER = "better-auth";
    for (const path of [
      "/sign-up/email",
      "/email-otp/get-verification-otp",
      "/email-otp/verify-email",
      "/delete-user",
      "/change-email",
      "/list-sessions",
    ])
      assert.equal((await call(path)).status, 404, path);
    for (const [path, method] of [
      ["/get-session", "GET"],
      ["/list-accounts", "GET"],
      ["/email-otp/send-verification-otp", "POST"],
      ["/sign-in/email-otp", "POST"],
      ["/sign-in/email", "POST"],
      ["/sign-in/magic-link", "POST"],
      ["/magic-link/verify", "GET"],
      ["/request-password-reset", "POST"],
      ["/reset-password", "POST"],
      ["/reset-password/token-value", "GET"],
      ["/change-password", "POST"],
      ["/passkey/generate-authenticate-options", "GET"],
    ]) {
      const response = await call(path, method);
      assert.notEqual(response.status, 404, path);
      assert.equal(response.headers.get("Cache-Control"), "no-store", path);
    }
  } finally {
    await closeConnection();
    (globalThis as { __paddockAuth?: unknown }).__paddockAuth = undefined;
    for (const key of keys)
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  }
});

test("Better Auth settings are validated by name and required only when selected", () => {
  assert.equal(readAuthEnv({}).AUTH_PROVIDER, "clerk");
  assert.throws(() => readAuthEnv({ AUTH_PROVIDER: "auth0" }), /AUTH_PROVIDER/);
  assert.throws(
    () => readAuthEnv({ AUTH_PROVIDER: "better-auth" }),
    /BETTER_AUTH_URL, BETTER_AUTH_SECRET, AUTH_ALLOWED_EMAILS/,
  );
  const local = {
    AUTH_PROVIDER: "better-auth",
    BETTER_AUTH_URL: "http://localhost:3922",
    BETTER_AUTH_SECRET: secret,
    AUTH_ALLOWED_EMAILS: " Owner@TheScudders.test, second@thescudders.test ",
  };
  assert.deepEqual(readAuthEnv(local).AUTH_ALLOWED_EMAILS, [
    "owner@thescudders.test",
    "second@thescudders.test",
  ]);
  assert.throws(
    () => readAuthEnv({ ...local, AUTH_ALLOWED_EMAILS: "not-an-email" }),
    /AUTH_ALLOWED_EMAILS/,
  );
  // Production requires HTTPS and mail delivery; no values are ever echoed.
  const production = { ...local, NODE_ENV: "production" };
  assert.throws(
    () => readAuthEnv(production),
    (error: Error) =>
      /BREVO_API_KEY, AUTH_EMAIL_FROM/.test(error.message) &&
      !error.message.includes(secret),
  );
  assert.throws(
    () =>
      readAuthEnv({
        ...production,
        BREVO_API_KEY: "key",
        AUTH_EMAIL_FROM: "paddock@thescudders.test",
      }),
    /BETTER_AUTH_URL/,
  );
  assert.equal(
    readAuthEnv({
      ...production,
      BETTER_AUTH_URL: "https://paddock.thescudders.org",
      BREVO_API_KEY: "key",
      AUTH_EMAIL_FROM: "paddock@thescudders.test",
    }).AUTH_EMAIL_DAILY_LIMIT,
    40,
  );
});

test("an unconfigured Better Auth keeps the owner workspace closed", async () => {
  guardOverrides.current = {
    betterAuth: async () => {
      throw new Error("Invalid environment variables: BETTER_AUTH_SECRET");
    },
    config: {
      authProvider: "better-auth",
      clerkPublishableKey: "pk_test_unused",
      clerkSecretKey: "sk_test_unused",
      appUrl: origin,
    },
  };
  useServices({} as Services);
  try {
    const response = await owner.me({
      request: new Request(origin + "/api/admin/me"),
    });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /SECRET/);
  } finally {
    guardOverrides.current = undefined;
    useServices(undefined);
  }
});
