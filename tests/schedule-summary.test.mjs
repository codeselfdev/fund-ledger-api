import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import express from "express";
import { prisma } from "../dist/core/prisma/client.js";
import { schedulesRouter } from "../dist/modules/schedules/schedules.routes.js";
import {
  pendingByDue,
  dueRemaining,
  summarizeSchedule,
} from "../dist/modules/schedules/schedule-summary.service.js";
const date = new Date("2026-10-06T00:00:00Z");
const due = (id, scheduleId, amount, extra = {}) => ({
  id,
  scheduleId,
  memberId: "member",
  amount,
  paidAmount: 0,
  waivedAmount: 0,
  penaltyDue: 0,
  penaltyPaid: 0,
  dueDate: date,
  tenantId: "tenant",
  projectId: "project",
  ...extra,
});
test("pending deposits are distributed across selected schedules instead of duplicated", () => {
  const dues = [
    due("d1", "s1", 2000),
    due("d2", "s2", 4000, { dueDate: new Date("2026-12-31") }),
  ];
  const deposits = [
    {
      id: "pending",
      memberId: "member",
      scheduleId: null,
      amount: 3000,
      createdAt: date,
      allocations: dues.map((due) => ({ due })),
    },
  ];
  const result = pendingByDue(deposits, dues);
  assert.equal(result.get("d1").amount, 2000);
  assert.equal(result.get("d2").amount, 1000);
  assert.equal(
    [...result.values()].reduce((sum, r) => sum + r.amount, 0),
    3000,
  );
});
test("multiple pending deposits reserve each balance once and legacy single-schedule requests remain visible", () => {
  const dues = [due("d1", "s1", 2000, { paidAmount: 1000 })];
  const deposits = [1, 2].map((n) => ({
    id: "p" + n,
    memberId: "member",
    scheduleId: "s1",
    amount: 700,
    createdAt: new Date(date.getTime() + n),
    allocations: [],
  }));
  const result = pendingByDue(deposits, dues);
  assert.equal(result.get("d1").amount, 1000);
  assert.deepEqual(result.get("d1").depositIds, ["p1", "p2"]);
});
test("penalties and waivers affect remaining; pending is never collected and empty schedules do not divide by zero", () => {
  const row = due("d1", "s1", 2000, {
    paidAmount: 1000,
    waivedAmount: 500,
    penaltyDue: 200,
    penaltyPaid: 50,
  });
  assert.equal(dueRemaining(row), 650);
  assert.deepEqual(summarizeSchedule([row], 900), {
    total: 1700,
    collected: 1050,
    remaining: 650,
    pending: 650,
    waived: 500,
    paid_count: 0,
    dues_count: 1,
    collected_percent: 62,
  });
  assert.equal(summarizeSchedule([], 0).collected_percent, 0);
});
let server,
  url,
  queries = [];
before(async () => {
  const rows = [due("d1", "schedule", 2000)];
  prisma.schedule.findFirst = async ({ where }) => {
    queries.push(where);
    return where.id === "schedule"
      ? {
          id: "schedule",
          tenantId: "tenant",
          projectId: "project",
          name: "October",
          dueDate: date,
          status: "active",
          purpose: "contribution",
        }
      : null;
  };
  prisma.schedule.findMany = async ({ where }) => {
    queries.push(where);
    return [{ id: "schedule", dues: rows }];
  };
  prisma.due.findMany = async ({ where }) => {
    queries.push(where);
    return rows;
  };
  prisma.deposit.findMany = async ({ where }) => {
    queries.push(where);
    return [
      {
        id: "pending",
        memberId: "member",
        scheduleId: "schedule",
        amount: 1000,
        createdAt: date,
        allocations: [{ due: rows[0] }],
      },
    ];
  };
  prisma.member.findMany = async ({ where }) => {
    queries.push(where);
    return [
      {
        id: "member",
        name: "Member",
        mobile: "+8801711000000",
        shares: 2,
        status: "active",
        profile: { photo_file_id: "photo", nid: "private" },
      },
    ];
  };
  const app = express();
  app.use((req, _res, next) => {
    req.auth = {
      tenantId: "tenant",
      projectId: "project",
      userId: "actor",
      roles: [req.header("x-role") ?? "admin"],
    };
    next();
  });
  app.use("/schedules", schedulesRouter);
  app.use((error, _req, res, _next) =>
    res.status(error.statusCode ?? 500).json({ error: error.message }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});
test("staff member-summary is project scoped, supplies photos and excludes other profile fields", async () => {
  queries = [];
  const res = await fetch(url + "/schedules/schedule/member-summary");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.collection.pending, 1000);
  assert.equal(data.collection.collected, 0);
  assert.equal(data.items[0].payment_state, "pending");
  assert.deepEqual(data.items[0].member.profile, { photo_file_id: "photo" });
  assert.equal(data.items[0].due.outstanding, 2000);
  assert.ok(
    queries.every((q) => q.tenantId === "tenant" && q.projectId === "project"),
  );
  assert.equal(
    (await fetch(url + "/schedules/foreign/member-summary")).status,
    404,
  );
});
test("ordinary member cannot access schedule-wide identities; list stays backward compatible", async () => {
  assert.equal(
    (
      await fetch(url + "/schedules/schedule/member-summary", {
        headers: { "x-role": "member" },
      })
    ).status,
    403,
  );
  const res = await fetch(url + "/schedules");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data[0].dues.length, 1);
  assert.equal(data[0].collection.pending, 1000);
  assert.equal(data[0].collected_percent, 0);
});
