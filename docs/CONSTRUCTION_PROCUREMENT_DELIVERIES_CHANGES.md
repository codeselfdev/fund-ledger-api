# Construction procurement, deliveries and scope changes

These optional workflows implement gaps **10, 11 and 16** inside **More → Work tools → Site controls** (desktop: **Site planning & control**). On phones, choose the workflow from **Site control section**; desktop uses tabs.

An owner/admin enables **Requisitions & supplier quotations**, **Partial deliveries & invoice matching**, and/or **Coordinated scope, cost & time changes** in Setup. Procurement awards require checked deliveries, so enabling procurement also enables receipt checks. All three flags default off, including projects with older saved settings. Existing controlled orders retain their checks if flags are later switched off; flags stop new requisitions/enrollment/change submissions without releasing approved records.

## Site workflow

1. **Request:** choose an approved cost head, required-by date, urgency and independent approver. Add catalog materials, whole stock quantities, specifications and optional evidence. The assigned person approves the need.
2. **Compare:** record supplier quotations for every requested material using the same quantities/stock units/project currency. Enter each unit price, additional charges, promised delivery, expiry, terms and optional supplier documents. Comparison shows line prices, delivered totals, the lowest valid offer and days later than required. Select the offer and explain the award; a separate assigned approver authorizes the resulting PO. The cheapest quote is not automatically awarded.
3. **Deliver:** record each challan against its controlled PO, with date, receiving store, delivered quantities, note and attachments. No stock or cash changes at this step. The assigned independent checker records quality-passed accepted quantity, rejected quantity, quantity/specification/damage checks and rejection reasons. Only accepted units enter stock. Leave the challan pending while inspection is incomplete. Rejected units remain recorded and outstanding for replacement. The PO stays `ordered` with an explicit outstanding balance until all ordered quantities are accepted, then becomes `received`.
4. **Match:** record supplier invoice lines, quantities, prices, charges and evidence. The screen compares each line against PO quantities/prices, independently accepted receipts and previously approved invoice quantities. Mismatches remain pending and cannot be approved. Approval requires exact PO unit prices, sufficient accepted quantity, remaining ordered quantity and cumulative charges/amount within the PO. A final charges-only invoice is supported after all ordered quantities are accepted. Pay approved supplier bills separately from the existing supplier payment screen.
5. **Correct:** reject an erroneous unposted challan or incorrect invoice, then submit its corrected version with the same original document number. Revision numbers retain the prior submission and decision. Posted accepted receipts and approved invoices remain immutable. The supplier-payable list distinguishes corrected invoice revisions while the matching record retains the original invoice number.

Supplier quotes are recorded after collection; the workflow does not contact suppliers or send RFQs/messages. Review the quoted specifications, terms and evidence yourself. Charges are explicit amounts in the project's currency; newly awarded quotes do not configure tax rates. Existing tax snapshots on enrolled POs are apportioned across approved invoices with conserved rounding. A PO with net total below its material subtotal needs tax/withholding reconciliation before enrollment.

## Existing purchase orders

Use **Deliveries → Use checked deliveries for an existing PO** to enroll an unreceived order with a supplier, approved cost head and required-by date. Resolve a legacy supplier bill first; pending/approved legacy-linked bills cannot be mixed with line-matched partial invoices. Orders without enrollment keep their existing flow. Enrolled orders and newly awarded orders use checked deliveries exclusively: generic full receipt and legacy supplier-bill approval cannot bypass matching. Purchase screens direct these orders to Site controls. Accepted or pending delivery/invoice records prevent generic cancellation; short-closing a partly fulfilled order and reversing accepted goods require separate workflows.

A challan receives into one inventory store; later challans can use another store. Work locations (building/floor/zone) and inventory stores retain their separate meanings. Whole stock units remain required. Receiving or accepting a delivery never posts a bank payment.

## Routing and permissions

Each requisition, award, quality check, invoice and coordinated scope change is routed to one named active project approver (Owner/Admin/Approver or a custom role with Site planning & control Write). The requester cannot be their own reviewer. Only the assigned person with current approval access can decide it; an administrator does not bypass that assignment. **Show your site approvals** lists the user's assigned pending work.

For a pending request, its requester or an actual owner/admin can use **Change pending approval route**, enter a reason and select another independent authorized person. The server checks the previous assignee to reject stale changes and records the reassignment in the audit trail. Custom menu Write alone does not grant authority to reroute someone else's request. No external notifications are sent by this workflow. Multi-stage routing, amount thresholds and organization-wide approval rules remain part of gap 15.

Site controls Read permits inspection. Write permits preparation; current independent approval access and assignment are also checked at decision time. Drawings/challans/evidence remain project-private. The old financial Approvals inbox cannot independently approve matched supplier invoices or a coordinated change's child financial/BOQ/schedule records. Payment permissions remain separate. Draft editors retain values after failures; submit before leaving the workspace or refreshing the app.

## Coordinated scope, cost and time

Use **Scope changes** to prepare a request for one approved cost head, with an optional contract belonging to it. Enter the drawing revision/title, scope justification, signed budget/contract amount changes, optional revised totals/rates for existing approved BOQ work items, optional working-day duration/start impacts for scheduled tasks, and PDF/image drawing evidence. Quantity and schedule sections are optional and collapsed on phones/forms until needed. Drawing-only requests are also allowed. New work items are prepared through BOQ management; multi-head changes use separate requests.

The saved request includes the original budget/contract amounts, original BOQ/schedule baselines, proposed quantity/estimate comparisons and recomputed schedule. Review shows the project finish and propagation through other affected tasks, calendar and critical tasks. Budget and contract adjustments are explicit reviewed amounts; estimates do not automatically increase approved budgets.

A single assigned independent approval applies all linked BOQ, schedule, budget and contract revisions in one transaction. Separate child approvals are blocked. A changed baseline, changed budget/contract, protected certified quantity, invalid duration, archived scope, contract below certified work/advances, or failed audit rolls the whole approval back. Rejection rejects linked pending revisions together. Older simple budget/contract changes remain available independently and are included in stale-state checks.

## Accounting behavior

Controlled PO receipt does not become a paid generic purchase. Accepted goods awaiting an approved invoice appear as **received, awaiting approved invoices** and in outstanding liabilities/cash forecasts. With expense recognition, their accepted material value is accrued to the cost head; matched invoice approval replaces that accrual and adds approved charges once. With FIFO/weighted-average valuation, accepted materials enter inventory, usage enters WIP, and matched invoices reclassify acquisition value without duplicating consumption cost. Supplier payments remain separate. Finish source-invoice approval before activating valuation on existing checked stock so opening values reconcile.

Supplier quote/budget comparisons are review aids; this workflow does not introduce a new hard budget spending limit, automate contract certification, close a partly fulfilled order, convert units or handle post-acceptance vendor returns. It also does not create a statutory general ledger or automatically approve a tax return.

## API and release

Endpoints under `/v1/construction/control`:

| Path | Action |
| --- | --- |
| `GET /workflows` | Scoped requests, quote comparisons, awards, orders/receipt balances, challans, invoice matches, scope changes and reviewer options |
| `POST /requisitions`, `/quotes`, `/awards` | Prepare procurement records with safe submission keys |
| `POST /requisitions/:id/decision`, `/awards/:id/decision` | Assigned independent review |
| `POST /orders/:id/enroll` | Enable controlled receipts on an eligible unreceived PO |
| `POST /deliveries`, `/deliveries/:id/check` | Log challan; independently check and post accepted units |
| `POST /invoices`, `/invoices/:id/decision` | Record partial invoice; independently approve matched lines |
| `POST /scope-changes`, `/scope-changes/:id/decision` | Submit and atomically decide coordinated changes |
| `POST /routes/:kind/:id` | Audited reassignment of pending work |

Deploy migration **`20261027100000_construction_procurement_receipts_scope`** after all prior construction migrations, regenerate Prisma, deploy the API, then release the matching mobile/web app. Existing purchases default to uncontrolled; no legacy quantities, bills, bank balances or approvals are rewritten. Existing app releases must not enable the new workflows before the matching UI is available. No production migration, live receipt, invoice approval, payment or deployment was performed during this implementation.

Validation: **78 client tests and 98 backend tests passed**, mobile typecheck, API build, Prisma validation, Expo web export, desktop browser checks and a 390-pixel phone preview using fictional local data. The backend suite includes independent routing, retries, competing receipts/invoices, corrected document versions, tax apportionment, accrual/WIP conservation, late financial/audit rollback, protected certification, and actual additive migration SQL run in disposable embedded PostgreSQL. Native-device attachment/keyboard behavior and real multi-connection PostgreSQL contention remain staging/device QA.
