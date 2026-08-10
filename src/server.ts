import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { stopRecurringSchedulesCron, startRecurringSchedulesCron } from "./core/cron/recurring-schedules.cron.js";
import { prisma } from "./core/prisma/client.js";

const app = createApp();
startRecurringSchedulesCron();

const server = app.listen(env.port, () => {
  console.log(`FundLedger API listening on http://localhost:${env.port}`);
});

async function shutdown() {
  stopRecurringSchedulesCron();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
