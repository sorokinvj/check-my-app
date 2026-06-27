import { SignIn } from "@clerk/nextjs";

// Clerk-hosted sign-in mounted on a catch-all so every sub-step (factor-two,
// SSO callbacks) resolves under /sign-in. email-code is the agent-walkable path
// used by the dogfood self-check (CHE-35).
export default function SignInPage() {
  return (
    <main className="flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-4 py-16">
      <SignIn />
    </main>
  );
}
