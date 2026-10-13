import type { Request } from "express";
import { getAuth } from "@clerk/express";
import { verifiedIdentity } from "./verifiedIdentity";

/**
 * Identity abstraction for the public Express edge.
 *
 * The original app authenticated users with Clerk (managed by Replit) and
 * verified the account server-side before forwarding trusted identity headers
 * to the loopback-only FastAPI service. Outside Replit there is no Clerk
 * instance, and `clerkMiddleware` throws on a missing secret key, so the whole
 * gateway failed to start.
 *
 * This module keeps the same trust model — identity is resolved on the public
 * server and forwarded to FastAPI as `x-msb-user-*` — but selects the provider
 * from the environment:
 *
 *   - `genspark` (default): read the signed-in Genspark visitor from the
 *     `X-Genspark-User-*` headers. The Genspark edge strips any client-supplied
 *     copies and re-injects them for the authenticated visitor, so they are
 *     trustworthy and cannot be spoofed (same guarantee Clerk gave us).
 *   - `clerk`: the original behaviour, unchanged, for anyone who keeps Clerk.
 *
 * No login screen is added: on the deployed site the "Sign in with Genspark"
 * access mode authenticates the visitor and the app just reads the identity.
 */

export type Identity = { userId: string; email: string; name: string };

function provider(): "clerk" | "genspark" {
  return (process.env.MSB_IDENTITY_PROVIDER ?? "genspark").trim().toLowerCase() === "clerk"
    ? "clerk"
    : "genspark";
}

/** Percent-encoded header values are decoded; malformed input is used verbatim. */
function decode(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Dev-only mock so the app is testable in the local sandbox before deploying
 * (where no Genspark edge injects headers). Guarded by an explicit flag that a
 * deployed site never sets, so production always returns the real user or null.
 */
function devIdentity(): Identity | null {
  const on = process.env.MSB_IDENTITY_DEV;
  if (on !== "1" && on !== "true") return null;
  return {
    userId: process.env.MSB_IDENTITY_DEV_USER_ID ?? "genspark-dev-user",
    email: process.env.MSB_IDENTITY_DEV_EMAIL ?? "assistante@msb-bat.com",
    name: process.env.MSB_IDENTITY_DEV_NAME ?? "Sonia OLINDA",
  };
}

function gensparkIdentity(req: Request): Identity | null {
  const userId = decode(req.headers["x-genspark-user-id"]);
  if (!userId) return devIdentity();
  return {
    userId,
    email: decode(req.headers["x-genspark-user-email"]),
    name: decode(req.headers["x-genspark-user-name"]),
  };
}

export async function getIdentity(req: Request): Promise<Identity | null> {
  if (provider() === "clerk") {
    const userId = getAuth(req).userId;
    if (!userId) return null;
    const identity = await verifiedIdentity(userId);
    return { userId, email: identity.email, name: identity.name };
  }
  return gensparkIdentity(req);
}

export function isClerkProvider(): boolean {
  return provider() === "clerk";
}
