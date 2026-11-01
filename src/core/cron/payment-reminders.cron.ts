import cron, { type ScheduledTask } from "node-cron";
import { runPaymentReminders } from "../../modules/payment-reminders/reminders.service.js";

let task: ScheduledTask | null = null;
let warnedMissingTables = false;
async function tick() {
  try { await runPaymentReminders(); warnedMissingTables = false; }
  catch (error) {
    if ((error as { code?: string }).code === "P2021") {
      if (!warnedMissingTables) { warnedMissingTables = true; console.warn("[payment-reminders] tables missing; run prisma migrations to enable automatic reminders"); }
      return;
    }
    console.error("[payment-reminders] run failed", error);
  }
}
/** Checks every minute; each project's reminders go out once their Dhaka send time arrives. */
export function startPaymentRemindersCron() {
  if (task) return task;
  task = cron.schedule("* * * * *", () => { void tick(); });
  void tick();
  return task;
}
export function stopPaymentRemindersCron() {
  if (!task) return;
  task.stop();
  task = null;
}
