-- Outbound webhooks + Slack preset (CHE-53): per-app endpoints notified after
-- every completed watch run. Additive and nullable — existing apps stay silent
-- until the owner configures a URL. The webhook secret is encrypted at rest
-- like every other secret (src/lib/crypto.ts).

-- AlterTable
ALTER TABLE "App" ADD COLUMN "webhookUrl" TEXT;
ALTER TABLE "App" ADD COLUMN "webhookSecretEnc" TEXT;
ALTER TABLE "App" ADD COLUMN "slackWebhookUrl" TEXT;
