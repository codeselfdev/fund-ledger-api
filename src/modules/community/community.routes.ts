import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAudit } from "../../core/audit/audit.service.js";
import { badRequest, notFound } from "../../core/http/api-error.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { created, ok } from "../../core/http/response.js";
import { notifyProjectMembers } from "../../core/notifications/notification.service.js";
import { prisma } from "../../core/prisma/client.js";
import { requireProjectContext } from "../../core/security/auth.context.js";
import { requireProject, requireRoles } from "../../core/security/auth.middleware.js";
import { idParamSchema } from "../../core/validation/common.schemas.js";
import { validateBody, validateParams, validateQuery } from "../../core/validation/validate.js";

const pollsRouter = Router();
const eventsRouter = Router();

const pollCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(160)).min(2).max(10),
  expires_at: z.string().datetime({ offset: true }),
});

const pollVoteSchema = z.object({ option_id: z.string().min(1) });
const pollListQuerySchema = z.object({
  status: z.enum(["active", "expired", "closed", "all"]).default("all"),
});

const eventCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  agenda: z.string().trim().min(2).max(2000),
  place: z.string().trim().min(2).max(300),
  starts_at: z.string().datetime({ offset: true }),
});

const eventUpdateSchema = eventCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Provide at least one event field" },
);

const eventListQuerySchema = z.object({
  scope: z.enum(["upcoming", "past", "all"]).default("upcoming"),
});

const pollDetailsInclude = {
  options: { orderBy: { position: "asc" }, include: { _count: { select: { votes: true } } } },
  votes: true,
} satisfies Prisma.PollInclude;

type PollDetails = Prisma.PollGetPayload<{ include: typeof pollDetailsInclude }>;

function pollStatus(poll: Pick<PollDetails, "closedAt" | "expiresAt">, now = new Date()) {
  if (poll.closedAt) return "closed" as const;
  if (poll.expiresAt.getTime() <= now.getTime()) return "expired" as const;
  return "active" as const;
}

function pollPayload(poll: PollDetails, userId: string, includeAnalytics: boolean) {
  const myVote = poll.votes.find((vote) => vote.userId === userId) ?? null;
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    expires_at: poll.expiresAt,
    closed_at: poll.closedAt,
    status: pollStatus(poll),
    has_voted: !!myVote,
    my_vote_option_id: myVote?.optionId ?? null,
    total_votes: includeAnalytics ? poll.votes.length : undefined,
    options: poll.options.map((option) => ({
      id: option.id,
      label: option.label,
      position: option.position,
      vote_count: includeAnalytics ? option._count.votes : undefined,
    })),
    created_by_id: poll.createdById,
    created_at: poll.createdAt,
    updated_at: poll.updatedAt,
  };
}

function eventPayload(event: {
  id: string;
  title: string;
  agenda: string;
  place: string;
  startsAt: Date;
  cancelledAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: event.id,
    title: event.title,
    agenda: event.agenda,
    place: event.place,
    starts_at: event.startsAt,
    status: event.cancelledAt ? "cancelled" : event.startsAt.getTime() <= Date.now() ? "past" : "upcoming",
    cancelled_at: event.cancelledAt,
    created_by_id: event.createdById,
    created_at: event.createdAt,
    updated_at: event.updatedAt,
  };
}

function readableDate(date: Date) {
  return new Intl.DateTimeFormat("en-BD", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Dhaka",
  }).format(date);
}

pollsRouter.get("/active", requireProject, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const now = new Date();
  const polls = await prisma.poll.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, closedAt: null, expiresAt: { gt: now } },
    include: pollDetailsInclude,
    orderBy: { createdAt: "desc" },
  });
  const includeAnalytics = auth.roles.includes("owner") || auth.roles.includes("admin");
  return ok(res, polls.map((poll) => pollPayload(poll, auth.userId, includeAnalytics)));
}));

pollsRouter.get("/", requireProject, requireRoles("any"), validateQuery(pollListQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { status } = req.query as z.infer<typeof pollListQuerySchema>;
  const now = new Date();
  const statusWhere: Prisma.PollWhereInput = status === "active"
    ? { closedAt: null, expiresAt: { gt: now } }
    : status === "expired"
      ? { closedAt: null, expiresAt: { lte: now } }
      : status === "closed"
        ? { closedAt: { not: null } }
        : {};
  const polls = await prisma.poll.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, ...statusWhere },
    include: pollDetailsInclude,
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const includeAnalytics = auth.roles.includes("owner") || auth.roles.includes("admin");
  return ok(res, polls.map((poll) => pollPayload(poll, auth.userId, includeAnalytics)));
}));

pollsRouter.post("/", requireProject, requireRoles("owner", "admin"), validateBody(pollCreateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof pollCreateSchema>;
  const expiresAt = new Date(body.expires_at);
  const now = new Date();
  if (expiresAt.getTime() <= now.getTime() + 60_000) {
    throw badRequest("Poll expiry must be at least one minute in the future");
  }
  const normalizedOptions = body.options.map((option) => option.trim());
  if (new Set(normalizedOptions.map((option) => option.toLowerCase())).size !== normalizedOptions.length) {
    throw badRequest("Poll options must be unique");
  }

  const poll = await prisma.poll.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      title: body.title.trim(),
      description: body.description?.trim() || null,
      expiresAt,
      lastReminderAt: now,
      createdById: auth.userId,
      options: {
        create: normalizedOptions.map((label, position) => ({
          tenantId: auth.tenantId,
          projectId: auth.projectId,
          label,
          position,
        })),
      },
    },
    include: pollDetailsInclude,
  });

  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    type: "poll.created",
    title: "New poll",
    body: `${poll.title} · Vote before ${readableDate(poll.expiresAt)}.`,
    entityType: "poll",
    entityId: poll.id,
  });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "poll.created",
    entityType: "poll",
    entityId: poll.id,
    after: poll,
  });
  return created(res, pollPayload(poll, auth.userId, true));
}));

pollsRouter.post("/:id/vote", requireProject, requireRoles("any"), validateParams(idParamSchema), validateBody(pollVoteSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const { option_id: optionId } = req.body as z.infer<typeof pollVoteSchema>;
  const now = new Date();
  const poll = await prisma.poll.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: { options: { select: { id: true } } },
  });
  if (!poll) throw notFound("Poll not found");
  if (poll.closedAt || poll.expiresAt.getTime() <= now.getTime()) throw badRequest("This poll is no longer accepting votes");
  if (!poll.options.some((option) => option.id === optionId)) throw badRequest("Choose a valid poll option");

  const before = await prisma.pollVote.findUnique({
    where: { pollId_userId: { pollId: poll.id, userId: auth.userId } },
  });
  const vote = await prisma.pollVote.upsert({
    where: { pollId_userId: { pollId: poll.id, userId: auth.userId } },
    create: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      pollId: poll.id,
      optionId,
      userId: auth.userId,
    },
    update: { optionId },
  });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: before ? "poll.vote_changed" : "poll.voted",
    entityType: "poll",
    entityId: poll.id,
    before,
    after: vote,
  });

  const refreshed = await prisma.poll.findUniqueOrThrow({ where: { id: poll.id }, include: pollDetailsInclude });
  const includeAnalytics = auth.roles.includes("owner") || auth.roles.includes("admin");
  return ok(res, pollPayload(refreshed, auth.userId, includeAnalytics));
}));

pollsRouter.get("/:id/analytics", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const poll = await prisma.poll.findFirst({
    where: { id, tenantId: auth.tenantId, projectId: auth.projectId },
    include: {
      ...pollDetailsInclude,
      votes: { include: { user: { select: { id: true, name: true } }, option: { select: { id: true, label: true } } } },
    },
  });
  if (!poll) throw notFound("Poll not found");
  const memberships = await prisma.projectMembership.findMany({
    where: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      isActive: true,
      user: { isActive: true },
    },
    select: { userId: true },
    distinct: ["userId"],
  });
  const eligibleCount = memberships.length;
  const totalVotes = poll.votes.length;
  return ok(res, {
    ...pollPayload(poll, auth.userId, true),
    eligible_count: eligibleCount,
    pending_count: Math.max(0, eligibleCount - totalVotes),
    response_rate: eligibleCount === 0 ? 0 : Math.round((totalVotes / eligibleCount) * 100),
    voters: poll.votes.map((vote) => ({
      user_id: vote.user.id,
      user_name: vote.user.name,
      option_id: vote.option.id,
      option_label: vote.option.label,
      voted_at: vote.updatedAt,
    })),
  });
}));

pollsRouter.post("/:id/close", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const before = await prisma.poll.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
  if (!before) throw notFound("Poll not found");
  const poll = before.closedAt ? before : await prisma.poll.update({ where: { id }, data: { closedAt: new Date() } });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "poll.closed",
    entityType: "poll",
    entityId: id,
    before,
    after: poll,
  });
  return ok(res, { id, status: "closed", closed_at: poll.closedAt });
}));

eventsRouter.get("/upcoming", requireProject, requireRoles("any"), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const events = await prisma.projectEvent.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, cancelledAt: null, startsAt: { gt: new Date() } },
    orderBy: { startsAt: "asc" },
    take: 10,
  });
  return ok(res, events.map(eventPayload));
}));

eventsRouter.get("/", requireProject, requireRoles("any"), validateQuery(eventListQuerySchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { scope } = req.query as z.infer<typeof eventListQuerySchema>;
  const now = new Date();
  const scopeWhere: Prisma.ProjectEventWhereInput = scope === "upcoming"
    ? { startsAt: { gt: now }, cancelledAt: null }
    : scope === "past"
      ? { startsAt: { lte: now } }
      : {};
  const events = await prisma.projectEvent.findMany({
    where: { tenantId: auth.tenantId, projectId: auth.projectId, ...scopeWhere },
    orderBy: { startsAt: scope === "past" ? "desc" : "asc" },
    take: 100,
  });
  return ok(res, events.map(eventPayload));
}));

eventsRouter.post("/", requireProject, requireRoles("owner", "admin"), validateBody(eventCreateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const body = req.body as z.infer<typeof eventCreateSchema>;
  const startsAt = new Date(body.starts_at);
  if (startsAt.getTime() <= Date.now() + 60_000) throw badRequest("Event must start at least one minute in the future");
  const event = await prisma.projectEvent.create({
    data: {
      tenantId: auth.tenantId,
      projectId: auth.projectId,
      title: body.title.trim(),
      agenda: body.agenda.trim(),
      place: body.place.trim(),
      startsAt,
      createdById: auth.userId,
    },
  });
  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    type: "event.created",
    title: event.title,
    body: `${readableDate(event.startsAt)} at ${event.place}. ${event.agenda}`,
    entityType: "event",
    entityId: event.id,
  });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "event.created",
    entityType: "event",
    entityId: event.id,
    after: event,
  });
  return created(res, eventPayload(event));
}));

eventsRouter.patch("/:id", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), validateBody(eventUpdateSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const body = req.body as z.infer<typeof eventUpdateSchema>;
  const before = await prisma.projectEvent.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
  if (!before) throw notFound("Event not found");
  if (before.cancelledAt) throw badRequest("Cancelled events cannot be edited");
  const startsAt = body.starts_at ? new Date(body.starts_at) : undefined;
  if (startsAt && startsAt.getTime() <= Date.now() + 60_000) throw badRequest("Event must start at least one minute in the future");
  const event = await prisma.projectEvent.update({
    where: { id },
    data: {
      title: body.title?.trim(),
      agenda: body.agenda?.trim(),
      place: body.place?.trim(),
      startsAt,
      ...(startsAt ? { reminderOneHourSentAt: null, reminderTenMinSentAt: null } : {}),
    },
  });
  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    type: "event.updated",
    title: "Event updated",
    body: `${event.title} · ${readableDate(event.startsAt)} at ${event.place}.`,
    entityType: "event",
    entityId: event.id,
  });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "event.updated",
    entityType: "event",
    entityId: id,
    before,
    after: event,
  });
  return ok(res, eventPayload(event));
}));

eventsRouter.post("/:id/cancel", requireProject, requireRoles("owner", "admin"), validateParams(idParamSchema), asyncHandler(async (req, res) => {
  const auth = requireProjectContext(req);
  const { id } = req.params as z.infer<typeof idParamSchema>;
  const before = await prisma.projectEvent.findFirst({ where: { id, tenantId: auth.tenantId, projectId: auth.projectId } });
  if (!before) throw notFound("Event not found");
  const event = before.cancelledAt ? before : await prisma.projectEvent.update({ where: { id }, data: { cancelledAt: new Date() } });
  await notifyProjectMembers({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    type: "event.cancelled",
    title: "Event cancelled",
    body: `${event.title}, scheduled for ${readableDate(event.startsAt)}, has been cancelled.`,
    entityType: "event",
    entityId: event.id,
  });
  await writeAudit({
    tenantId: auth.tenantId,
    projectId: auth.projectId,
    actorUserId: auth.userId,
    action: "event.cancelled",
    entityType: "event",
    entityId: id,
    before,
    after: event,
  });
  return ok(res, eventPayload(event));
}));

export { eventsRouter, pollsRouter };
