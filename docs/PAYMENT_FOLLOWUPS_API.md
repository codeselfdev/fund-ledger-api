# Payment follow-ups API

Deploy migration `20261010090000_add_payment_followups` before releasing the API or mobile app. The API container runs `prisma migrate deploy` at startup.

All endpoints require authentication and `X-Project-Id`. Read access is limited to owner, admin and auditor. Write access is limited to owner and admin. Members cannot read reliability or other members' follow-up data.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/follow-ups?tab=need\|upcoming\|settled` | Follow-up queue, counts and promised unpaid total |
| GET | `/v1/follow-ups/reliability?tier=all\|reliable\|watch\|at_risk` | Ranked active members and tier counts |
| GET | `/v1/members/:id/follow-up?cursor=30` | Member summary, reminder state, reliability and timeline |
| POST | `/v1/members/:id/call-logs` | Log a call and optionally create a commitment |
| POST | `/v1/commitments/:id/resolve` | Manually resolve an open commitment without changing accounting |
| POST | `/v1/members/:id/reminders` | Send the once-per-Dhaka-day payment push |

## Log a commitment

```json
{
  "outcome": "committed",
  "summary": "Salary is delayed; will pay by bKash.",
  "commitment": { "promised_date": "2026-10-12", "amount": 80000 }
}
```

Outcomes are `committed`, `no_answer`, `claims_paid`, and `dispute`. Summary is required except for `no_answer`. Promise dates are Dhaka calendar dates from today through 90 days, and amount cannot exceed outstanding dues. A current pending promise becomes `rescheduled`; an already broken promise remains broken.

## Manual resolution

```json
{ "status": "kept_late", "reason": "Cash received and deposit entry will follow" }
```

Statuses are `kept`, `kept_late`, and `cancelled`. This endpoint never changes dues or deposits. Confirmed deposits are the primary resolution path and resolve a sufficient open promise atomically using the deposit submission date, not approval time.

## Reminder errors

- `422 NO_OUTSTANDING_DUE`: the member has no due balance.
- `409 REMINDER_ALREADY_SENT_TODAY`: another reminder already exists for the member on the current Dhaka day. `fields.sent_today_at` contains its timestamp.
- A successful response with `delivered_count: 0` means the reminder was recorded but the member has no linked app account.

## Reliability

The score starts at 100. Each `broken`, `kept_late`, or `rescheduled` commitment subtracts 15; each missed due deadline subtracts 10. `reliable` is 85+, `watch` is 60-84, and `at_risk` is below 60. Ranking is score descending, breaks ascending, then member name.

All date boundaries, reminder uniqueness, and the nightly 00:05 commitment update use `Asia/Dhaka`. The database stores promise and reminder days as PostgreSQL `DATE` values.

Validation:

```sh
npm run prisma:generate
npm run build
node --test dist/modules/follow-ups/followups.policy.test.js dist/modules/follow-ups/followups.service.test.js
node --import dotenv/config --test tests/followups.routes.test.mjs
```
