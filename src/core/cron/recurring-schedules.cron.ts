import cron, { type ScheduledTask } from "node-cron";
import { runRecurringSchedules } from "../../modules/recurring-schedules/recurring-schedules.service.js";

let task: ScheduledTask | null = null;

export function startRecurringSchedulesCron() {
  if (task) return task;
  task = cron.schedule("*/30 * * * *", () => {
    void runRecurringSchedules();
  });

  void runRecurringSchedules();
  return task;
}

export function stopRecurringSchedulesCron() {
  if (!task) return;
  task.stop();
  task = null;
}
