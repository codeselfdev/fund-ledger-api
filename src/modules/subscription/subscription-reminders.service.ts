import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../core/prisma/client.js";
import { organizationBillingProject, isOrganizationOwner } from "../../core/security/organization-access.js";
import { subscriptionReminder } from "../../core/subscription/reminder-policy.js";
import { sendMail } from "../../core/mail/mailer.service.js";
import { sendPushMessage } from "../../core/notifications/fcm.service.js";
const type = "subscription.payment_reminder";

export function createSubscriptionReminderWorker(db = prisma, transports = {push:sendPushMessage,email:sendMail}) {
  async function queue(now = new Date()) {
    let cursor: string | undefined;
    do {
      const tenants = await db.tenant.findMany({where:{deletionStartedAt:null},select:{id:true},orderBy:{id:"asc"},take:100,...(cursor?{cursor:{id:cursor},skip:1}:{})});
      if (!tenants.length) break;
      for (const item of tenants) await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${item.id} FOR NO KEY UPDATE`;
        const tenant = await tx.tenant.findUnique({where:{id:item.id}});
        if (!tenant || tenant.deletionStartedAt) return;
        const reminder = subscriptionReminder(tenant.contact,tenant.name,now);
        if (!reminder) return;
        const projectId = await organizationBillingProject(tenant.id,tx);
        if (!projectId) return;
        const owners = await tx.projectMembership.findMany({where:{tenantId:tenant.id,projectId,role:"owner",isActive:true,user:{isActive:true}},select:{userId:true},distinct:["userId"]});
        for (const owner of owners) {
          const id = "subscription:"+createHash("sha256").update(JSON.stringify([tenant.id,owner.userId,reminder.periodEndsAt,reminder.stage])).digest("hex");
          await tx.notification.upsert({where:{id},update:{},create:{id,tenantId:tenant.id,projectId,recipientUserId:owner.userId,type,title:reminder.title,body:reminder.body,entityType:"subscription",entityId:tenant.id,actionUrl:"fundnesta://open?screen=billing"}});
          await tx.subscriptionReminderDelivery.createMany({skipDuplicates:true,data:["push","email"].map(channel=>({tenantId:tenant.id,notificationId:id,periodEndsAt:reminder.periodEndsAt,stage:reminder.stage,channel}))});
        }
      });
      cursor = tenants[tenants.length-1]!.id;
    } while (cursor);
  }
  async function deliver(now = new Date()) {
    await db.subscriptionReminderDelivery.updateMany({where:{status:"pending",attempts:{gte:5},OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]},data:{status:"failed",leaseUntil:null,leaseToken:null,lastError:"retry_limit_reached"}});
    const available = {status:"pending",attempts:{lt:5},nextAttemptAt:{lte:now},OR:[{leaseUntil:null},{leaseUntil:{lt:now}}]};
    const rows = await db.subscriptionReminderDelivery.findMany({where:available,orderBy:[{createdAt:"asc"},{id:"asc"}],take:30});
    for (const row of rows) {
      const leaseToken = randomUUID();
      const claimed = await db.subscriptionReminderDelivery.updateMany({where:{id:row.id,...available},data:{leaseToken,leaseUntil:new Date(now.getTime()+300000),attempts:{increment:1}}});
      if (!claimed.count) continue;
      const finish = (data: Record<string,unknown>) => db.subscriptionReminderDelivery.updateMany({where:{id:row.id,leaseToken},data:{...data,leaseToken:null,leaseUntil:null}});
      try {
        const notification = await db.notification.findFirst({where:{id:row.notificationId,tenantId:row.tenantId,type},include:{recipient:true,tenant:true}});
        const user = notification?.recipient, tenant = notification?.tenant;
        const current = tenant && subscriptionReminder(tenant.contact,tenant.name,now);
        if (!notification || !user?.isActive || user.tenantId !== row.tenantId || tenant?.deletionStartedAt || !current || current.stage !== row.stage || current.periodEndsAt.getTime() !== row.periodEndsAt.getTime() || !await isOrganizationOwner(row.tenantId,user.id,db)) {
          await finish({status:"skipped",lastError:"subscription_or_owner_changed"}); continue;
        }
        if (row.channel === "push") {
          const token = user.deviceId?.trim();
          if (!token) {await finish({status:"skipped",lastError:"no_registered_device"});continue;}
          const result = await transports.push({tokens:[token],title:notification.title,body:notification.body,data:{type,tenant_id:row.tenantId,project_id:notification.projectId??"",entity_type:"subscription",entity_id:row.tenantId,app_screen:"billing"}});
          if (result.invalid_tokens.includes(token)) {
            await db.user.updateMany({where:{id:user.id,tenantId:row.tenantId,deviceId:token},data:{deviceId:null}});
            await finish({status:"skipped",lastError:"invalid_device_token"});continue;
          }
          if (result.sent_count !== 1) throw new Error("push_unavailable");
        } else if (row.channel === "email") {
          if (!user.email?.trim()) {await finish({status:"skipped",lastError:"no_email_address"});continue;}
          if (!await transports.email({to:user.email,fromName:"Fund Nesta",subject:notification.title,text:`Hello ${user.name},\n\n${notification.body}\n\nOpen Fund Nesta: https://fundnesta.appnesta.com/auth\nThis reminder concerns your organization’s subscription. Members do not need individual paid plans.`})) throw new Error("email_unavailable");
        } else {await finish({status:"skipped",lastError:"unsupported_channel"});continue;}
        await finish({status:"sent",sentAt:now,lastError:null});
      } catch {await finish({status:row.attempts+1>=5?"failed":"pending",lastError:"provider_unavailable",nextAttemptAt:new Date(now.getTime()+Math.min(3600000,60000*2**row.attempts))});}
    }
  }
  return {queue,deliver};
}
const worker = createSubscriptionReminderWorker();
let timer: ReturnType<typeof setInterval> | undefined, running=false, nextQueue=0;
export function startSubscriptionReminders() {
  if (timer) return;
  const run = async () => {
    if (running) return; running=true;
    try {if(Date.now()>=nextQueue){await worker.queue();nextQueue=Date.now()+1800000;}await worker.deliver();}
    catch {console.error("[subscription-reminders] worker failed");}
    finally {running=false;}
  };
  timer=setInterval(()=>void run(),15000);timer.unref();void run();
}
export function stopSubscriptionReminders(){if(timer)clearInterval(timer);timer=undefined;nextQueue=0;}
