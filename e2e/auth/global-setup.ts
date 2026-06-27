import { clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/backend";

// Global setup for the auth dogfood (CHE-35). Fetches a Clerk Testing Token
// (bypasses bot detection in the UI) and ensures the test user exists so the
// sign-in spec is self-contained. Uses a `+clerk_test` email → Clerk test mode.
export default async function globalSetup() {
  await clerkSetup({
    publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    secretKey: process.env.CLERK_SECRET_KEY,
  });

  const email = process.env.E2E_CLERK_USER_EMAIL;
  const password = process.env.E2E_CLERK_USER_PASSWORD;
  if (!email || !password) {
    throw new Error("E2E_CLERK_USER_EMAIL / E2E_CLERK_USER_PASSWORD must be set");
  }

  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const existing = await clerk.users.getUserList({ emailAddress: [email] });
  const user =
    existing.totalCount > 0
      ? existing.data[0]
      : await clerk.users.createUser({ emailAddress: [email], password });

  // The instance requires an organization, so a fresh user is otherwise gated on
  // a "Setup your organization" task before reaching /dashboard. Give them one.
  const memberships = await clerk.users.getOrganizationMembershipList({ userId: user.id });
  if (memberships.totalCount === 0) {
    await clerk.organizations.createOrganization({
      name: "Dogfood Org",
      createdBy: user.id,
    });
  }
}
