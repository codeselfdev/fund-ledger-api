import { evaluateSubscription } from "./subscription.service.js";
const DAY = 86400000;
const day = (value: string) => new Date(value).toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric",timeZone:"Asia/Dhaka"});
export function subscriptionReminder(contact: unknown, name: string, now = new Date()) {
  const summary = evaluateSubscription(contact, now), end = summary.billing_period_end_at;
  if (!end || summary.reason === "subscription_explicitly_expired") return null;
  const trial = !summary.current_period_end_at, term = trial ? "free trial" : "subscription";
  let stage: string, title: string, body: string;
  if (summary.in_grace_period) {
    stage = summary.grace_days_left <= 1 ? "grace_last_day" : "grace_started";
    title = stage === "grace_last_day" ? "Final day to keep your organization open" : "Payment due: your organization is in its grace period";
    body = `${name}: Your ${term} ended on ${day(end)}. Access continues until ${day(summary.grace_ends_at!)} during the 5-day grace period. Pay in Fund Nesta before then to keep all projects and members connected.`;
  } else if (!summary.has_access && summary.grace_ends_at && now.getTime() < new Date(summary.grace_ends_at).getTime() + DAY) {
    stage = "access_paused"; title = "Your organization’s access is paused";
    body = `${name}: Your ${term} and 5-day grace period have ended. Upgrade or renew with Fund Nesta to restore access to all your projects and members. Your records are retained.`;
  } else if (summary.has_access && [7,3,1].includes(summary.days_left)) {
    stage = `before_${summary.days_left}`; title = `Your Fund Nesta ${term} ends in ${summary.days_left} ${summary.days_left === 1 ? "day" : "days"}`;
    body = `${name}: Your ${term} ends on ${day(end)}. ${trial ? "Choose a paid plan" : "Renew your organization’s plan"} in Fund Nesta to keep your whole team connected. A 5-day payment grace period ends on ${day(summary.grace_ends_at!)}.`;
  } else return null;
  return {stage,title,body,periodEndsAt:new Date(end)};
}
