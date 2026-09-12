import assert from "node:assert/strict";
import type { PrismaClient } from "@/generated/prisma/client";
import { appSlugFromUrl } from "@/lib/utils";
import { parseExtensionLink, readExtensionOptions } from "@/lib/extension-target";
import { createCheckSchema, extensionOptionsSchema } from "@/lib/validation";
import { startCheck } from "@/lib/start-check";
import { startPaidCheck } from "@/lib/one-check";
import { startSavedApp } from "@/lib/start-saved-app";
import { enableWatchForRun } from "@/lib/watch-enable";

async function main() {
const id = "hafhjepjihcimcljkdphpinannbdmnhf";
const url = `https://chromewebstore.google.com/detail/joblander/${id}`;
const alias = `https://chrome.google.com/webstore/detail/renamed/${id}?hl=en`;
assert.equal(parseExtensionLink(alias)?.id, id);
assert.equal(appSlugFromUrl(url), appSlugFromUrl(alias));
assert.notEqual(appSlugFromUrl(url), appSlugFromUrl(`https://chromewebstore.google.com/detail/${"a".repeat(32)}`));
for (const bad of [
  `https://chromewebstore.google.com.evil.test/detail/${id}`,
  `https://somebody@chromewebstore.google.com/detail/${id}`,
  `https://chromewebstore.google.com:8080/detail/${id}`,
  `https://chromewebstore.google.com/detail/${id}/extra`,
  "https://chromewebstore.google.com/detail/not-an-id",
]) assert.equal(parseExtensionLink(bad), null, bad);
assert.equal(createCheckSchema.safeParse({url:"https://chromewebstore.google.com/detail/bad"}).success, false);
assert.equal(extensionOptionsSchema.safeParse({companionUrl:"bad address"}).success, false);
assert.equal(extensionOptionsSchema.safeParse({companionUrl:"http://app.test"}).success, false);
assert.equal(readExtensionOptions('{"allowSessions":"true"}').allowSessions, false);
assert.equal(readExtensionOptions('{"maxSessionSeconds":9000}').maxSessionSeconds, 600);

const config = { companionUrl: "https://companion.test", expectedOutcome: "Show a fresh result", allowSessions: true, maxSessionSeconds: 180 };
const rows: Record<string, unknown>[] = [];
const triggered: string[] = [];
let serial = 0;
const pending = { id: "pending", targetUrl: url, extensionConfig: JSON.stringify(config), checkoutSessionId: "fixture-payment", runId: null, testPasswordEnc: null };
const app = { id: "app", ownerId: "owner", appSlug: appSlugFromUrl(url), targetUrl: url, targetKind: "extension", extensionId: id, extensionConfig: JSON.stringify(config), testPasswordEnc: null };
const db = {
  counter: { upsert: async () => ({value: ++serial}) },
  run: {
    findUnique: async () => null,
    findFirst: async () => null,
    create: async ({data}: {data: Record<string, unknown>}) => {rows.push(data); return {id: `r${serial}`, publicId: `p${serial}`};},
  },
  pendingCheck: { findUnique: async () => pending, update: async () => pending },
  app: { findFirst: async ({where}: {where: {ownerId: string}}) => where.ownerId === "owner" ? app : null },
} as unknown as PrismaClient;
const deps = { trigger: async (runId: string) => {triggered.push(runId);} };
await startCheck(db, {input: createCheckSchema.parse({url,extension:config}), ownerId:null,anonKeyHash:"fixture"},deps);
await startPaidCheck(db, "pending", "fixture-payment", deps);
await startSavedApp(db,{id:"owner",plan:"business"},"app",{...deps,siteCap:()=>20});
for (const row of rows) {
  assert.equal(row.targetKind, "extension");
  assert.equal(row.extensionId, id);
  assert.equal(row.appSlug, `extension:${id}`);
  assert.deepEqual(JSON.parse(String(row.extensionConfig)), config);
}
assert.equal(rows.length, 3);
assert.equal(triggered.length, 3);
assert.equal(rows[2].appId, "app");
assert.deepEqual(await startSavedApp(db,{id:"other-owner",plan:"business"},"app",{...deps,siteCap:()=>20}),{error:"App not found."});
assert.equal(rows.length, 3, "A different owner must not start a run with saved credentials");
const watchDb = {run:{findUnique: async()=>({...app,ownerId:"owner",ephemeral:false})}} as unknown as PrismaClient;
assert.equal((await enableWatchForRun(watchDb,{id:"owner",plan:"business",clerkOrgId:null},{runPublicId:"p",frequency:"daily",notifyOnChangeOnly:true})).kind,"gated");
console.log("Extension targets: stable identity, validation, public/paid/dashboard starts and ownership verified");

}
main().catch(error => { console.error(error); process.exitCode = 1; });
