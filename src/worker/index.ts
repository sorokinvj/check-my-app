// Worker entrypoint. Run separately from the Next.js app:
//   npm run worker        (watch mode)
//   npm run worker:start  (once)
//
// It consumes the runs queue and drives each check through the 6-phase agent
// pipeline. A check can take up to ~2h, so concurrency is deliberately low.

import "dotenv/config";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { RUN_QUEUE_NAME, type RunJobData } from "@/lib/types";
import { runPipeline } from "./agent/pipeline";

const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

const worker = new Worker<RunJobData>(
  RUN_QUEUE_NAME,
  async (job) => {
    console.log(`[worker] starting run ${job.data.runId}`);
    await runPipeline(job.data.runId);
    console.log(`[worker] finished run ${job.data.runId}`);
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    // A run is long-lived; give the lock plenty of headroom and renew often.
    lockDuration: 60_000,
  },
);

worker.on("failed", (job, err) => {
  console.error(`[worker] run ${job?.data.runId} failed:`, err);
});

console.log(`[worker] listening on "${RUN_QUEUE_NAME}"`);

async function shutdown() {
  console.log("[worker] shutting down…");
  await worker.close();
  await connection.quit();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
