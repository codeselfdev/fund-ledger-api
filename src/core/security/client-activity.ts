import { tenantAccounts } from "../identity/tenant-accounts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import { prisma } from "../prisma/client.js";

export type ClientPlatform = "android" | "ios" | "web" | "unknown";
const clients = new AsyncLocalStorage<ClientPlatform>();

export function clientPlatform(header?: string, userAgent = ""): ClientPlatform {
  if (header === "android" || header === "ios" || header === "web") return header;
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Mozilla\//i.test(userAgent)) return "web";
  return "unknown";
}

export const clientActivityContext: RequestHandler = (req, _res, next) => {
  clients.run(clientPlatform(req.header("x-client-platform"), req.header("user-agent")), next);
};

export async function recordUserLogin(userId: string) {
  const now = new Date();
  await tenantAccounts(prisma).update({ where: { id: userId }, data: {
    lastLoginAt: now, lastLoginPlatform: clients.getStore() ?? "unknown", lastActiveAt: now
  } });
}

/** The conditional write bounds activity writes to once per user per minute. */
export async function recordUserActivity(userId: string, lastActiveAt?: Date | null) {
  const now = new Date();
  const before = new Date(now.getTime() - 60_000);
  if (lastActiveAt && lastActiveAt > before) return;
  await tenantAccounts(prisma).updateMany({ where: { id: userId, OR: [
    { lastActiveAt: null }, { lastActiveAt: { lte: before } }
  ] }, data: { lastActiveAt: now } });
}
