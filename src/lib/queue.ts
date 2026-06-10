import { Queue } from "bullmq";
import IORedis from "ioredis";
import { RUN_QUEUE_NAME, type RunJobData } from "./types";

// A single shared Redis connection for producing jobs. BullMQ requires
// maxRetriesPerRequest: null for blocking commands.
const globalForQueue = globalThis as unknown as {
  connection?: IORedis;
  runQueue?: Queue<RunJobData>;
};

export const connection =
  globalForQueue.connection ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

export const runQueue =
  globalForQueue.runQueue ??
  new Queue<RunJobData>(RUN_QUEUE_NAME, { connection });

if (process.env.NODE_ENV !== "production") {
  globalForQueue.connection = connection;
  globalForQueue.runQueue = runQueue;
}

// Enqueue a run for the worker to pick up.
export async function enqueueRun(runId: string) {
  await runQueue.add(
    "run",
    { runId },
    {
      jobId: runId, // dedupe: one queued job per run
      removeOnComplete: 1000,
      removeOnFail: 5000,
      attempts: 1, // a 2h agent run shouldn't blindly auto-retry; handle in pipeline
    },
  );
}
