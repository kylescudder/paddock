import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { authUser } from "./auth-schema.ts";
import { userProfile } from "./profile-schema.ts";
import type { AuthDatabase } from "./auth-email.ts";
import type { AuthUser } from "./auth-factory.ts";
import { isVerifiedAllowedUser } from "./auth-policy.ts";

export const avatarPath = "/api/profile/avatar";
export const avatarUrl = (version: string) => avatarPath + "?v=" + version;
export const avatarLimit = 2 * 1024 * 1024;

type ProfileSettings = {
  origin: string;
  allowedEmails: readonly string[];
  getSession: (headers: Headers) => Promise<{ user: AuthUser } | null>;
};

// Photos are personal: never cached by the browser or a proxy, never sniffed
// as another type and never embedded by another site.
const privateHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};
class ProfileError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Stream the body and stop at the limit, so a missing or false
// Content-Length cannot make the server buffer an oversized upload.
async function readBody(request: Request, limit: number) {
  if (Number(request.headers.get("content-length")) > limit)
    throw new ProfileError(413, "This photo is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new ProfileError(400, "Choose a photo to upload.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProfileError(413, "This photo is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

// Recognise the file by its signature before any decoder sees it.
function signature(body: Buffer) {
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "jpeg";
  if (body.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  return null;
}

// Same sharp steps as gallery uploads (bounded decode, EXIF orientation), with
// a tighter pixel bound for a small photo, then a 256 px square JPEG. Re-encoding drops all metadata, including EXIF
// location, and means uploaded bytes are never served back as-is.
async function processAvatar(body: Buffer) {
  const format = signature(body);
  if (!format)
    throw new ProfileError(400, "Choose a valid JPEG, PNG or WebP photo.");
  try {
    const image = sharp(body, {
      failOn: "error",
      limitInputPixels: 4_000_000,
      animated: false,
    });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) > 1)
      throw new Error("Unsupported image");
    return await image
      .rotate()
      .resize(256, 256, { fit: "cover" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ProfileError(
      400,
      "This photo could not be read. Choose a different JPEG, PNG or WebP image.",
    );
  }
}

// The current server-owned image value for a user: the versioned photo URL,
// or null. Better Auth's update-user accepts only this value for `image`.
export async function currentAvatarUrl(database: AuthDatabase, userId: string) {
  const [row] = await database
    .select({ version: userProfile.avatarVersion })
    .from(userProfile)
    .where(eq(userProfile.userId, userId));
  return row?.version ? avatarUrl(row.version) : null;
}

// GET, PUT and DELETE on /api/profile/avatar, always for the signed-in user's
// own photo: there is no user id in the URL, so nobody can read another's.
export function createProfileHandler(
  database: AuthDatabase,
  settings: ProfileSettings,
) {
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: privateHeaders });
  return async (request: Request) => {
    try {
      if (new URL(request.url).pathname !== avatarPath)
        return json({ error: "Not found" }, 404);
      if (
        request.method !== "GET" &&
        (request.headers.get("origin") !== settings.origin ||
          request.headers.get("sec-fetch-site") === "cross-site")
      )
        return json({ error: "Cross-site request refused" }, 403);
      const session = await settings.getSession(request.headers);
      if (!session)
        return json({ error: "Please sign in to manage your profile." }, 401);
      // Same rule as the owner workspace: verified and still allowlisted.
      if (!isVerifiedAllowedUser(session.user, settings.allowedEmails))
        return json(
          { error: "Sign in with an approved, verified email first." },
          403,
        );
      const userId = session.user.id;
      if (request.method === "GET") {
        const [row] = await database
          .select({ avatar: userProfile.avatar })
          .from(userProfile)
          .where(eq(userProfile.userId, userId));
        if (!row?.avatar) return json({ error: "No profile photo" }, 404);
        return new Response(new Uint8Array(row.avatar), {
          headers: {
            ...privateHeaders,
            "Content-Type": "image/jpeg",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          },
        });
      }
      if (request.method === "PUT") {
        const type = request.headers.get("content-type")?.split(";")[0];
        if (!["image/jpeg", "image/png", "image/webp"].includes(type ?? ""))
          throw new ProfileError(415, "Choose a JPEG, PNG or WebP photo.");
        const avatar = await processAvatar(
          await readBody(request, avatarLimit),
        );
        // A new version on every upload, so cached copies never go stale.
        const avatarVersion = randomUUID();
        await database.transaction(async (tx) => {
          await tx
            .insert(userProfile)
            .values({ userId, avatar, avatarVersion })
            .onConflictDoUpdate({
              target: userProfile.userId,
              set: { avatar, avatarVersion, updatedAt: new Date() },
            });
          await tx
            .update(authUser)
            .set({ image: avatarUrl(avatarVersion), updatedAt: new Date() })
            .where(eq(authUser.id, userId));
        });
        return json({ image: avatarUrl(avatarVersion) });
      }
      if (request.method === "DELETE") {
        await database.transaction(async (tx) => {
          await tx
            .update(userProfile)
            .set({ avatar: null, avatarVersion: null, updatedAt: new Date() })
            .where(eq(userProfile.userId, userId));
          await tx
            .update(authUser)
            .set({ image: null, updatedAt: new Date() })
            .where(eq(authUser.id, userId));
        });
        return json({ image: null });
      }
      return json({ error: "Method not allowed" }, 405);
    } catch (error) {
      if (error instanceof ProfileError)
        return json({ error: error.message }, error.status);
      // Never expose database or authentication details.
      return json(
        { error: "Unable to update your profile photo. Please try again." },
        500,
      );
    }
  };
}
