# Automatic payment reminders

Owners and admins of **Fund / Shares** and **Billing** projects open *All tools → Communicate → Payment reminders* to decide when people with unpaid dues are reminded: days before the deadline, on the due date, and after it until paid. Accountants can view; custom roles need the `payment_reminders` menu.

- **Rules** (`payment_reminder_rules`): before / due / after, 1–60 days, optional own time, overdue repeats (every 1–30 days, 2–10 sends), a message of up to 240 characters with `{name} {amount} {schedule} {due_date} {days}`. All enabled rules together may send at most **10 times per unpaid due**.
- **Settings** (`payment_reminder_settings`): master switch (off until an admin turns it on), preferred time (Asia/Dhaka), sending days, off-day rule (day before · next sending day · skip), Bangladesh public holidays as off days, and (Fund only) pausing overdue reminders while a Follow-ups payment promise is open. First open seeds the recommended set (−7d, −3d, −1d at 6 PM, due date, +1d, +3d every 3 days × 5).
- **Off days never make a before-deadline or due-date reminder late**, and never pull an overdue reminder back to or before the deadline.
- **Sending** (`core/cron/payment-reminders.cron.ts`, every minute): Fund members get a push + inbox notice; at most one reminder per member per day, recorded in `member_reminders` with `source = 'automatic'`, so a manual *Remind* that day counts too. Several dues on one day are combined, led by the earliest. Billing customers with an email get one queued `billing_messages` email per day (`auto-reminder:<customer>:<date>`), delivered by the existing billing worker.
- **Holidays** live in `src/modules/payment-reminders/holidays.ts`: the official 2026 list plus fixed-date 2027 holidays. Add 2027's moon-dependent dates when the government publishes them.

API: `GET /v1/payment-reminders`, `PUT /v1/payment-reminders/settings`, `POST|PUT|DELETE /v1/payment-reminders/rules[/:id]`, `POST /v1/payment-reminders/preview`.

Release: apply migration `20261101130000_payment_reminders` (additive), deploy the API, then ship the mobile build. Nothing was deployed or migrated as part of this change.
