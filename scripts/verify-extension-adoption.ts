import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function main() {
  const mocks: Record<string, string> = {
    'next/server': 'export const NextResponse = { json: (value, init) => new Response(JSON.stringify(value), init) };',
    '@/lib/db': 'export const getDbFromContext = async () => fixture.db;',
    // CHE-253: routes resolve the team the caller acts for alongside the user.
    '@/lib/auth': 'export const getOptionalUser = async () => fixture.user; export const optionalTeamContext = async (_db, user) => user ? { team: { id: `team_${user.id}`, name: user.email ?? user.id, isPersonal: true, plan: fixture.plan ?? "free", stripeCustomerId: null, stripeSubscriptionId: null }, scope: "admin" } : null;',
    // CHE-255: the route asks the scope table whether this caller may connect
    // an integration. The stub answers as an admin of the caller's own team —
    // and refuses when there is no caller, which is the behaviour the route
    // relies on for its 401.
    '@/lib/team-auth': 'export const requireScope = async (_db, _req, _action) => fixture.user ? { ok: true, grant: { user: fixture.user, team: { id: `team_${fixture.user.id}`, name: fixture.user.id, isPersonal: true, plan: fixture.plan ?? "free", stripeCustomerId: null, stripeSubscriptionId: null }, scope: "admin", via: "clerk" } } : { ok: false, response: new Response(JSON.stringify({ error: "Sign in to do that" }), { status: 401 }) };',
    '@/lib/crypto': 'export const encryptSecret = () => "encrypted-fixture";',
    '@/lib/github': 'export class GitHubError extends Error {} export const validateRepoAccess = async () => { fixture.validations++; return { defaultBranch: "main" }; };',
  };
  const bundle = await build({ entryPoints: ['src/app/api/integrations/github/route.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'external-boundaries', setup(build) {
      build.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'fixture' } : undefined);
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }],
  });
  const extension = { targetKind: 'extension', extensionId: 'a'.repeat(32), extensionConfig: JSON.stringify({ allowSessions: true, maxSessionSeconds: 180 }) };
  let created: Record<string, unknown> = {}, adopted: Record<string, unknown> = {};
  const run = { id: 'run', ownerId: null as string | null, appId: null as string | null, ephemeral: false, appSlug: `extension:${extension.extensionId}`, targetUrl: `https://chromewebstore.google.com/detail/${extension.extensionId}`, ...extension };
  const fixture = { user: { id: 'owner', clerkOrgId: null }, validations: 0, db: {
    run: { findUnique: async () => run, update: async ({ data }: { data: Record<string, unknown> }) => { adopted = data; } },
    app: { upsert: async ({ create, update }: { create: Record<string, unknown>; update: object }) => {
      assert.deepEqual(update, {}, 'Connecting a repo must preserve existing owner settings'); created = create; return { id: 'saved-extension' };
    } }, repoIntegration: { upsert: async () => {} },
  } };
  const mod = { exports: {} as { POST(request: Request): Promise<Response> } };
  new Function('module', 'exports', 'fixture', bundle.outputFiles[0].text)(mod, mod.exports, fixture);
  const request = () => new Request('https://check.example.test/api/integrations/github', { method: 'POST', body: JSON.stringify({ runId: 'public-run', token: 'fixture-only-token-not-a-real-secret', repo: 'fixture/example' }) });
  assert.equal((await mod.exports.POST(request())).status, 201);
  for (const [key, value] of Object.entries(extension)) assert.equal(created[key], value);
  assert.deepEqual(adopted, { ownerId: 'owner', appId: 'saved-extension' });
  run.ownerId = 'owner'; adopted = {};
  assert.equal((await mod.exports.POST(request())).status, 201);
  assert.deepEqual(adopted, { ownerId: 'owner', appId: 'saved-extension' }, 'An owned one-off run must link the newly saved app for later settings recovery');
  run.ownerId = 'another-owner';
  assert.equal((await mod.exports.POST(request())).status, 403);
  assert.equal(fixture.validations, 2, 'A stranger is refused before the repository token is used');
  run.ownerId = null; run.ephemeral = true;
  assert.equal((await mod.exports.POST(request())).status, 409);
  assert.equal(fixture.validations, 2);
  console.log('GitHub adoption: extension identity/settings, owner isolation and preview refusal pass');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
