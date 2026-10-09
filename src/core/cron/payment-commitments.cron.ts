import cron, { type ScheduledTask } from "node-cron";
import { breakOverdueCommitments } from "../../modules/follow-ups/followups.service.js";

let task: ScheduledTask | null = null;

export function startPaymentCommitmentsCron() {
  if (task) return task;
  const run = () => void breakOverdueCommitments().catch(error => console.error("[commitments] overdue update failed", error));
  task = cron.schedule("5 0 * * *", run, { timezone: "Asia/Dhaka" });
  run();
  return task;
}

export function stopPaymentCommitmentsCron() {
  if (!task) return;
  task.stop();
  task = null;
}
