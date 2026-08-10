import type { RequestHandler } from "express";
import { ApiError } from "../http/api-error.js";
import { prisma } from "../prisma/client.js";
import { evaluateSubscription } from "../subscription/subscription.service.js";

export const requireActiveSubscription: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.auth?.tenantId) return next();

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.auth.tenantId },
      select: { contact: true }
    });
    if (!tenant) {
      return next(new ApiError(403, "FORBIDDEN", "Tenant not found"));
    }

    const subscription = evaluateSubscription(tenant.contact);
    if (!subscription.has_access) {
      return next(new ApiError(402, "SUBSCRIPTION_EXPIRED", "Subscription has expired. Renew subscription to continue.", {
        subscription
      }));
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
