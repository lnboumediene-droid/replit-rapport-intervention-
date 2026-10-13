import { clerkClient } from "@clerk/express";

type VerifiedIdentity = { email: string; name: string };
const identities = new Map<string, { identity: VerifiedIdentity; expires: number }>();

/** Identity is read from Clerk, never from caller-controlled request headers. */
export async function verifiedIdentity(userId: string): Promise<VerifiedIdentity> {
  const cached = identities.get(userId);
  if (cached && cached.expires > Date.now()) return cached.identity;
  const user = await clerkClient.users.getUser(userId);
  const primary = user.emailAddresses.find(
    (address) =>
      address.id === user.primaryEmailAddressId &&
      address.verification?.status === "verified",
  );
  const identity = {
    email: primary?.emailAddress ?? "",
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
  };
  if (identities.size >= 1000) identities.clear();
  identities.set(userId, { identity, expires: Date.now() + 60_000 });
  return identity;
}
