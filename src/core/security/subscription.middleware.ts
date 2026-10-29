import { subscriptionContext } from "../subscription/subscription.repository.js";
import type { RequestHandler } from "express";
import { ApiError } from "../http/api-error.js";
import { prisma } from "../prisma/client.js";
import { evaluateSubscription } from "../subscription/subscription.service.js";

export const requireActiveSubscription: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.auth?.tenantId) return next();

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.auth.tenantId },
      select: { subscription: true,  contact: true, deletionStartedAt: true }
    });
    if (!tenant) {
      return next(new ApiError(403, "FORBIDDEN", "Tenant not found"));
    }
    if (tenant.deletionStartedAt) return next(new ApiError(403, "ORGANIZATION_CLEANUP_STARTED", "Organization cleanup has started"));

    const subscription = evaluateSubscription(subscriptionContext(tenant));
    if (!subscription.has_access) {
      return next(new ApiError(402, "SUBSCRIPTION_EXPIRED", "Your organization’s subscription and 5-day grace period have ended. Ask the organization owner to upgrade or renew with Fund Nesta to restore access for everyone.", {
        subscription
      }));
    }

    return next();
  } catch (error) {
    return next(error);
  }
};
