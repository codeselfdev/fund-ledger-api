# Construction Financial Management

Project type `construction` supports building developers, landowner groups, project accountants, contractors and member-funded projects. This is a construction finance workspace: site setup, approved budgets, saved BOQ, supplier/labor liabilities, certified running bills, payments, materials and member funding. It does not add an engineering/design document editor, full payroll or a general construction ERP.

All `/v1/construction` requests use the existing bearer session, active organization subscription and `X-Project-Id`. The project must be active and of type construction. Queries and related IDs are scoped by tenant and project. Existing expenses, accounts, vendors, purchases, inventory, members, schedules, deposits and settlements remain scoped to this same project.

## Menus and roles

Project discovery/details/creation return `construction_menus`; `GET /v1/construction/configuration` also returns menus. Construction accountant shortcut defaults include Budgets, BOQ, Running Bills, Member Funding, Expenses and Accounts. Mobile More exposes Building & Site Setup, Budget Estimation, BOQ & Cost Allocation, Contractors & Contracts, Suppliers & Bills, Materials & Site Movements, Daily Labor & Wages, Contractor Running Bills, Member Funding, Construction Expenses, Change Orders, Reports and Construction Payments, with shared income, accounts, ledger and management-only project roles.

Owner/admin/accountant enter construction records and execute authorized payments. Owner/admin/approver approve or reject budgets, running bills, supplier invoices, labor records and change orders. A different person must review the request, including requests entered by management. Auditors/cashiers can read construction records but cannot mutate them through these APIs. Only management edits site setup or closes/suspends contracts. Members retain their own contribution/receipt portal and shared finance views; customer/contractor contact and construction-wide financial records remain staff-only.

## Endpoint reference

| Method / path under /v1/construction | Use |
| --- | --- |
| GET/PUT /configuration | Read/update building, site, project dates, financial target and total member shares |
| GET /overview | Approved budget, actual cost, liabilities, cash, forecasts, phase comparisons, BOQ balances and contractor balances |
| GET/POST /cost-heads | List / submit phase-category budgets for independent approval |
| PATCH /cost-heads/:id/forecast | `{forecast_remaining}`; current remaining-cost estimate |
| POST /cost-heads/:id/decision | `{decision:approve\|reject}` |
| GET/POST /boq | List/save quantities, units, rates and estimates |
| PATCH /boq/:id | Update estimate or archive; cost head stays immutable |
| GET/POST /allocations | Read / associate approved or paid existing expenses with cost heads/BOQ items |
| GET/POST /contractors | Contractor profiles |
| PATCH /contractors/:id | Full profile fields and active status |
| GET/POST /contracts | Contracts, original/revised amounts, advances, certifications and retention |
| PATCH /contracts/:id/status | `{status:active\|suspended\|closed}`; management only |
| GET/POST /running-bills | List / submit cumulative certified work and advance recovery |
| POST /running-bills/:id/decision | Independently certify or reject current work |
| GET/POST/PATCH /suppliers[/\:id] | Existing vendor profiles through construction menus |
| GET/POST /supplier-bills | Supplier invoices with cost head, optional BOQ and purchase links |
| POST /supplier-bills/:id/decision | Approve/reject invoice liability |
| POST /supplier-bills/:id/receive | Receive a linked approved purchase into stock without a cash posting |
| GET/POST /labor | Daily attendance units, wages and work date |
| POST /labor/:id/decision | Approve/reject wages |
| GET/POST /materials | Consumption, source-linked unused returns and wastage |
| GET/POST /payments | Contractor advance, certified bill, retention, supplier or wage disbursement |
| GET/POST /change-orders | Request budget and/or contract revisions |
| POST /change-orders/:id/decision | Approve/reject revisions |
| GET /funding | Current project member shares, contributions, arrears and schedule links |

Dates use valid `YYYY-MM-DD`. Bills, labor, movement and payment dates cannot be future dates. Money uses the existing whole-currency integer convention with a maximum of 2,147,483,647 per stored amount. Quantities support three decimals; inventory movement quantities remain whole units to match the existing stock ledger. Percentage fields use basis points (500 = 5%). Server calculations are authoritative.

## Site setup and member funding

Configuration: `{building,site,start_date?,end_date?,financial_target,total_shares?,note?}`. The financial target is informational; it is not an approved budget. Setup updates the normal project name/address and optional total shares atomically. Shares cannot be reduced below shares assigned to active members.

A construction project can use existing financial members, share ownership, contribution schedules, recurring installments, dues, collections, receipts, penalties, member statements and final settlements within its own project scope. No cross-project balances are silently copied. The mobile Funding menu opens these existing member and schedule flows. Management/approver permissions for schedule creation remain enforced by the existing APIs. Owner financial membership is created only with explicit opt-in. Construction onboarding can skip initial shareholder allocation; members and schedules can be added later.

`funding_collected` includes confirmed deposits minus refunds, not pending submissions. Contribution arrears include unpaid principal after waivers and unpaid penalties. Expected future collections are shown separately from available cash. Use new contribution schedules for additional funding requests. Member-wise investment/settlement uses existing member detail and settlement APIs, preserving authorization and the original fund ledger.

## Budgets, BOQ and expense allocation

Cost head: `{name,phase,category,budget,forecast_remaining?}`. Categories: materials, labor, transport, machinery, overhead, contractor, professional, other. Each budget begins pending. Once approved, its original budget is immutable; approved change orders update revised budget. Remaining-cost forecasts are estimates maintained by accountants with an audit trail.

BOQ: `{cost_head_id,name,unit,quantity,rate,is_active?}`. The cost head must be approved. Estimated cost is rounded quantity × whole-currency rate. For the supplied example, Cement 500 × 520 = 260,000; Rod 10 × 90,000 = 900,000; Sand 2,000 × 60 = 120,000; Bricks 50,000 × 12 = 600,000; total = **1,880,000**. Saved BOQ estimates remain separate from approved phase budgets.

Allocation: `{expense_id,cost_head_id,boq_id?,amount,request_key}`. Only approved/paid existing expenses can be classified. An expense may be split across BOQ/cost heads, but all allocations together cannot exceed its amount. BOQ and cost head must match. Allocation does not post another expense or debit cash. Reports show estimated, actual and remaining amounts per BOQ item. Supplier invoices may also point directly at BOQ items. Unallocated approved expenses and received purchases are explicitly shown in project actual costs.

## Contractor running bills

Contract: `{contractor_id,cost_head_id,title,amount,retention_bps?,request_key}`. The cost head must be approved. Original contract amount is retained. Revised amounts change only through approved change orders. Request keys are UUIDs and full payload fingerprints prevent duplicates on network retries.

Running bill: `{contract_id,cumulative_certified,advance_recovery?,bill_date,note?,request_key}`. The server reads previously approved certification from the contract, computes current work = cumulative − previously certified, then calculates current retention and advance recovery. The caller cannot supply previously certified or net payable values. A prior recorded advance is required before it can be recovered.

For a 2,000,000 contract with 100,000 already advanced:

- Cumulative first certification: 800,000.
- Current certification: 800,000; retention at 5%: 40,000; advance recovery: 100,000.
- Net payable: **660,000**.
- A subsequent cumulative certification of 1,200,000 recognizes only **400,000** of new work, with 20,000 retention and no repeat recovery unless unrecovered advance remains.

Approval checks the saved previous certification and contract policy again. If another bill was certified first, the stale request cannot be approved; submit a new request. Competing approvals cannot duplicate certified work. Approved work adds its **gross current value** to actual cost. Retention remains a liability and advance recovery clears advance assets; neither deduction is a discount to construction cost. Certification never pays cash automatically.

Advances cannot exceed unexecuted contract value after unrecovered advances. Contract closure requires full certification and recovery of all advances. Retention can be paid only after management closes the contract, and never above unreleased held retention. Approved running bills can be paid partially or fully, never above their unpaid net value.

## Supplier invoices, labor and materials

Supplier bill: `{vendor_id,cost_head_id,boq_id?,purchase_id?,number,description,amount,bill_date,request_key}`. The supplier must be active in the project. Approval recognizes cost and payable; payment is a separate action.

A linked purchase must still be ordered, use the same supplier and have the same total. After approval, `/supplier-bills/:id/receive` adds stock without paying cash. The linked supplier bill handles payment. The normal purchase Receive/Cancel routes reject an active construction bill link to prevent extra payments or cancellation of a billed obligation. Reject an unapproved bill first to cancel its unreceived purchase. Purchase receipt and supplier bill costs are never counted twice. Received legacy/direct purchases without an approved construction bill are included as unallocated costs; ordered purchases are commitments.

Labor: `{cost_head_id,worker_name,work_date,units,rate,note?,request_key}`. Units represent manually recorded days/hours or an attendance quantity. Wages = rounded units × rate. Each entry is pending until independently approved, then may be paid partially. A dedicated worker roster, biometric attendance, tax payroll and overtime engine are outside this initial financial module. Subcontract labor may use contractor running bills.

Material movement: `{item_id,boq_id?,kind,quantity,entry_date,reason,source_id?,request_key}`. Kinds consume and waste reduce stock; returns increase it. Return requires a previous consumption entry for the same item/BOQ and cannot exceed its unreturned quantity or precede its date. Movements post to the existing stock ledger atomically. Material bills/expenses already recognize acquisition cost, so consumption/wastage do not add that cost again. This is quantity tracking, not a second inventory valuation/accrual system.

## Payments, change orders and reporting

Payment: `{kind,contract_id?|running_bill_id?|supplier_bill_id?|labor_entry_id?,account_id,amount,payment_date,reference?,request_key}`. Supply exactly the ID matching kind (`advance`, `retention`, `running_bill`, `supplier_bill`, `labor`). Only approved payables can be settled. Accounts must belong to the same tenant/project, with enough cash. Payments, payable balances, account transaction and audit commit together. Reference types use `construction_` plus the kind. Retry keys compare the complete payload.

Change order: `{cost_head_id?,contract_id?,budget_change?,contract_change?,reason,request_key}`. Changes are signed whole-currency amounts. A different admin/approver must approve them. Revised budgets cannot become negative; contracts cannot shrink below certified work or advances. Original budgets/contracts and historical bill calculations remain available.

The dashboard and reports show:

- Approved/revised budget by phase and cost head.
- Actual cost: approved/paid shared expenses, certified gross work, approved supplier bills/labor, and received purchases without a linked approved supplier bill.
- Cash paid separately, including contractor advances and retention payments.
- Approved unpaid liabilities and unreleased retention.
- Unexecuted contract and unbilled procurement commitments.
- Cost to complete: the larger of each cost head's manual remaining estimate and its unexecuted contract commitments, plus unlinked purchase commitments.
- Projected final cost = actual + cost to complete. Projected variance = approved budget − projected final cost.
- Forecast cash to complete deducts already-paid unrecovered contractor advances from forecast future cost. Cash requirement = max(0, unpaid liabilities + forecast cash to complete − available cash).

**Unspent budget is not the final saving.** A forecast must include relevant remaining work and unallocated costs. These are management estimates, not guaranteed cash or automatic engineering progress measurements. Accountants should use one cost source for an obligation rather than separately recording the same invoice as both a supplier bill and generic expense.

## Rollout and checks

Apply `20261014110000_construction_financial_management` after earlier migrations, including Billing Management, through the normal deployment process (`prisma migrate deploy`). Regenerate Prisma and deploy the backend before shipping the mobile screens. No live migration is run during implementation. Construction rows are additive; historical transactions are not reclassified automatically.

Build, Prisma validation, isolated API regressions and mobile TypeScript/tests verify setup, permissions, tenant/project scope, BOQ estimates and allocation limits, the sample running bill, subsequent/competing certifications, advances, retention, revised budgets, stock receipts/returns/wastage, labor/supplier payables, cash rollback and member funding. The Expo web bundle builds. Real PostgreSQL concurrency, migration rollout, native UI interactions and project accounting reconciliation should be verified in staging before production use.


## Phase plans (October 26)

Construction budgets now share first-class phase plans. `GET /v1/construction/phases` lists their planned/actual dates, responsible project staff user, manually reported status and revision. Durations include both dates in calendar days; overdue days apply to unfinished phases and completed delay uses actual versus planned end. Nothing marks itself complete when its deadline passes.

`POST /phases` accepts `{name, planned_start, planned_end, actual_start, actual_end, responsible_user_id, status, request_key}`. Date/assignee values are nullable. Status is draft, planned, active, on_hold or completed. All scheduled states require both planned dates; active/on_hold/completed require actual start; completed requires actual end; other states must omit actual end. Actual dates cannot be future dates. A planned phase cannot already have an actual start. Create request keys are payload- and actor-bound. Names are immutable to preserve legacy phase references.

`PUT /phases/:id` accepts the same plan fields without name/request key, plus the expected revision. It atomically increments the revision, rejects competing edits, and audits the before/after. An unchanged inactive assignee may be retained; a new assignment must be an active same-project staff user. `GET /phases/assignees` returns only distinct staff IDs/names, requires budget Write or a built-in financial writer, and never grants membership management. Phases follow the existing construction_budgets menu; approval-only users cannot edit plans. Completion is reported manually and does not constitute verified engineering measurements or inspections.

New cost heads may pass phase_id; existing clients may still pass phase. The service resolves or creates a draft shared phase and keeps the legacy phase name for financial reports. A conflicting name/ID is rejected. Apply `20261026150000_construction_phases`, regenerate Prisma and deploy the API before releasing the matching app. The migration groups existing names per project, links their cost heads, preserves every budget/approval value, and invents no dates, assignment or progress. The migration file is prepared; no production migration is applied by this change. Scheduling dependencies, work packages, working-day calendars and measured progress are later features.


## Feature 2: work structure and optional work context

Migration `20261026170000_construction_work_structure` adds construction_work_locations, construction_work_packages, construction_tasks and nullable cost-head context references. A work package belongs to one phase; a task belongs to one work package. Locations are a separate optional Building → Block → Floor → Zone tree, with skipped levels allowed. Parent IDs, kind and package location are immutable. Updates change names/descriptions/activity with optimistic revision checks; all actions audit before/after. Children must be archived before parents. No hard-delete route exists.

Endpoints under /v1/construction:

| Method/path | Contract |
| --- | --- |
| GET /structure | Minimal phase IDs/names and all project locations/packages/tasks, including archived records; no financial amounts or staff contact data |
| POST /locations | `{name,kind,parent_id:null|id,request_key}` |
| POST /work-packages | `{name,description,phase_id,location_id:null|id,request_key}` |
| POST /tasks | `{name,description,work_package_id,request_key}` |
| PUT /locations/:id, /work-packages/:id, /tasks/:id | `{name,description,is_active,revision}`; location description must be empty |

Management is scoped to construction_budgets Write. GET /structure accepts construction_budgets, construction_boq, construction_site_log, construction_materials or construction_labor Read as lookup access. Relationship IDs are validated against the active tenant/project inside serializable transactions. Create keys bind actor and payload, and revision checks prevent competing updates. Parent/assignment references cannot be changed by supplying extra update fields.

Cost-head creation additionally accepts optional work_package_id/task_id/location_id. The server infers task → package → phase and package → location, rejects mismatched explicit phase/package references, and restricts selected locations to the package location or its descendants. work_scope_key is derived on the server so the same budget name may be used in different work scopes. Existing names retain the original empty scope key, preserving duplicate protection and every budget/approval amount. Existing financial reports carry these references through their cost-head rows; downstream BOQ/contracts/bills inherit classification through that cost head. work_context_label snapshots the readable classification when a budget is created.

siteContentSchema accepts optional phase_id/work_package_id/task_id/location_id. Draft save canonicalizes them and overwrites context_label with a server-generated snapshot. Both draft save and submission validate active parents and compatibility with labor cost heads and material BOQ cost heads, before posting. Submission does not rewrite the saved label after names change, and retries retain existing one-time posting rules. Already linked expenses keep their separate classifications/approvals. Legacy logs without scope remain supported; a day spanning unrelated scopes can leave context blank.

The schema/migration is additive except that the old unique cost-head name index is replaced by the equivalent index including work_scope_key. Apply the preceding phase migration first, regenerate Prisma, deploy the API, then release mobile/web. No production migration or deployment is applied here. Dates/dependencies/progress for tasks are later features, not inferred from these structural records.

Validation includes API/menu-access and client regressions, TypeScript builds, Prisma validation, web export and fictional local browser fixtures. `tests/construction-structure-migration.test.mjs` optionally uses PGLITE_MODULE_PATH to run both real migrations against isolated embedded PostgreSQL; it never reads DATABASE_URL. It verifies legacy phase grouping/budget preservation, sibling-location uniqueness, scoped budget names, foreign keys, and preserved references after archival. Native-device and production concurrency verification remains part of staging rollout.

## Optional site planning & control — Features 3–6

Open **More → Work tools → Site controls**, the desktop **Site planning & control** menu, or the shortcut from Budget / Daily site log. The workspace has Setup, Schedule, BOQ, Progress and Materials & WIP. All planning flags default off; opening the page does not create settings or change accounting. Owners/admins configure it; authorized writers prepare records; a different approver or a custom Site planning & control writer reviews submissions. Members cannot browse project-wide controls. An independent reviewer may be given a custom role named Site Engineer; the app records their user identity, note and review time, not an external engineering qualification.

1. **Setup:** enable just the required controls and choose working weekdays and holiday dates. Verified progress also enables approved BOQ baselines. Settings use optimistic revisions; a stale save retains edits and requires refresh. Turning flags off stops new submissions; approved baselines and history remain. Material valuation has its own activation flow.
2. **Schedule:** use the phase/package/task hierarchy from Budget. Add task durations in working days, optional earliest starts, dependencies (FS/SS/FF/SF), positive lag or negative overlap, and delay/change reasons. Submit the entire plan for an independent review. The approved timeline displays task dates, zero-float critical tasks and working-day float; later schedules compare their finish against the original approved baseline. Each revision retains its calendar, so changing holidays does not rewrite approved dates. Cycles, foreign/archived tasks and stale baselines are rejected. This is a working-day dependency schedule, without resource leveling or automatic weather forecasting.
3. **BOQ:** reuse current work items or import CSV/Excel. The first visible worksheet supports up to 500 work items, 30 columns and a 5 MB file. Use `id,name,cost_head,task,unit,quantity,rate`, or `cost_head_id` / `task_id`; IDs resolve repeated names. Preview errors reference spreadsheet rows. Existing unique names within a cost head reuse their IDs, including blank ID cells. Review the preview, explicitly merge it into the local draft, validate/compare and submit for independent baseline approval. CSV imports use manual unit rates; resource recipes are edited in the work-item form. Material recipes use catalog stock units; labor recipes use named trades. Recipes only estimate quantities/rates; they do not issue stock or post costs. BOQ estimates do not replace approved budget/change-order limits. After the first approved BOQ, ordinary BOQ editing is protected and all changes use revisions. Already certified work cannot be removed, reassigned, reduced below certified quantity, or have its units changed.
4. **Progress:** choose a baseline work item, enter new completed quantity/date/note and optionally attach project photos. Only independently approved measurements count. Pending submissions never increase completion. Corrections are separate source-linked negative measurements with their own independent review. Project, phase and task percentages use approved BOQ planned-value weights. Planned quantities assume uniform output over the linked task's approved working days; an unscheduled item makes the corresponding aggregate planned percentage unavailable. A phase/task completion certificate requires all its quantities to be certified. A later BOQ baseline or later certified quantity change invalidates the prior current-completion indicator while preserving history. Financial budget usage continues to measure cost.
5. **Materials & WIP:** keep expense recognition, or have an owner review every existing item/store balance, opening unit value and previously recognized source cost. Complete historical cost allocations first. Activation verifies a stock/source preview hash, available source value, every reviewed store quantity and the setup revision. It reclassifies reviewed stock value from old cost into inventory without posting cash. BOQ opening credits are fixed at activation. If an unallocated source is used, further allocations of the historical source expenses are locked to preserve the reviewed reconciliation. Start with reconciled balances; the system does not reconstruct historical FIFO batches from old quantity-only movements. The chosen **weighted average or FIFO method is fixed after activation**.

With valuation active, purchase-linked approved supplier bills capitalize their material subtotal into goods awaiting receipt; receipt moves it into the chosen store. Ordinary paid purchase receipts capitalize their material value once. Actual usage, from the daily log or material form, requires a BOQ or approved material cost head and transfers inventory value into construction WIP. Optional store selection uses current item/store balances; blank means Main store. Wastage and other issues remain separate costs. Returns restore the original issue's exact value into its original store, including partial FIFO/weighted-average returns. A return from before valuation activation requires reconciliation and is rejected rather than inventing an original cost. Stock tracking cannot be disabled after valuation activation.

Inventory quantities remain whole stock units; BOQ/physical work quantities support three decimals and recipe consumption factors six. Currency input uses existing whole-currency conventions; the subledger stores value in exact millionths and conserves rounding on final pool drains and returns. FIFO order follows recorded receipt order; backdating an entry does not replay prior inventory valuations. New opening stock and positive manual inventory adjustments are valued at their entered/current catalog cost; reconcile their acquisition source separately. Extra acquisition charges remain in their original cost category. Stock transfers, decimal stock, batch management, partial deliveries and completed-asset capitalization remain separate features. WIP here is the construction inventory/cost subledger; it does not introduce a statutory general ledger.

Project cost, cost-head/phase cost and BOQ costs use valuation reclassifications plus net consumed/issued value, preventing purchase cost from being counted again on use. Supplier liabilities, payments, accounts and bank balances remain separate. Opening BOQ credits are apportioned once using the selected cost-head source's saved acquisition allocations. Remaining material inventory/goods in transit offset future material cash needs within the saved material cost-to-complete forecast. Forecasts still require explicit updates; physical progress does not automatically change a forecast or certify a contractor invoice.

All writes run in transactions with scoped lookups, audit records, stale-state checks and safe retries. Separate project and tenant IDs are checked for every task, work item, evidence file and stock source. New controls use the **Site planning & control** menu grant; the older financial Approvals inbox grant does not bypass it. Evidence remains private to the project. Draft BOQ/schedule edits stay in memory while switching tabs; submit before leaving the workspace or refreshing the app.

### API and rollout

The scoped root is `/v1/construction/control`. `GET` returns configuration, schedule/BOQ revision history, measured progress and valuation. `PUT /settings` takes `{revision,config}`. `POST /schedule` / `/boq` take a complete snapshot, `base_id`, reason note and UUID request key. `/boq/preview` validates a draft; `/boq/import-preview` validates normalized file rows. `/versions/:id/decision` independently approves/rejects a revision. `/measurements`, `/completions` and `/measurements/:id/decision` manage independent progress certification. `/valuation/activate` requires owner access, method, settings revision, preview hash, reviewed opening rows and a UUID request key. Material and daily-log entries accept optional `cost_head_id` and `stock_location_id` alongside their existing BOQ references.

Deploy the matching backend after `20261026200000_construction_site_control` and all earlier migrations, then regenerate Prisma and release the matching mobile/web app. Migrations are additive: existing projects retain `expense` recognition and all planning controls remain off. Do not activate controls until matching clients are available. Take the normal database backup and reconcile opening quantities/costs in staging before activation. Disabling planning flags preserves the audit history; switching valuation method or undoing activated inventory requires a separately designed reconciliation, not deleting journals or reverting only the app.

Validation: 72 relevant client regressions (construction, permissions and contextual guides); 77 backend tests covering route workflows, pure schedule/cost calculations, menu security and both embedded PostgreSQL migration suites; mobile typecheck; API build; Prisma validation; Expo web export. Browser checks use fictional localhost data on desktop and a 390-pixel phone frame. Physical-device gallery/camera, keyboards and real PostgreSQL transaction contention remain staging/device QA. No live migrations, inventory activation, payments or deployment were performed.

Future inventoried material acquisitions must use purchase orders and receipts, optionally linked to supplier invoices. Expense-only records and unlinked supplier invoices remain direct costs; they do not identify a stock item or create inventory value. Do not pair an expense-only acquisition with an unrelated manual stock increase for the same materials. Reconcile opening source costs before activation.

## Optional procurement, checked deliveries and coordinated scope changes

See [workflow, accounting behavior, endpoints and rollout](CONSTRUCTION_PROCUREMENT_DELIVERIES_CHANGES.md). Migration `20261027100000_construction_procurement_receipts_scope` adds controlled POs and immutable workflow records with named independent routing. Existing purchase/receipt and budget changes remain available for uncontrolled records. No production migration or deployment was performed.

## Optional procurement, checked deliveries and coordinated scope changes

See [workflow, accounting behavior, endpoints and rollout](CONSTRUCTION_PROCUREMENT_DELIVERIES_CHANGES.md). Migration `20261027100000_construction_procurement_receipts_scope` adds controlled POs and immutable workflow records with named independent routing. Existing purchase/receipt and budget changes remain available for uncontrolled records. No production migration or deployment was performed.


## Contractor work agreements and measured billing

Optional labour-only or labour-and-material subcontract work, fixed agreed item quantities/rates, independent agreement and measurement approval, contractor account summaries and existing advance/retention/payment accounting are implemented. See [workflow, accounting rules and release notes](CONSTRUCTION_CONTRACTOR_WORK.md). Apply `20261027150000_construction_contractor_work` after the procurement/scope migration and deploy the API before the matching app. No production migration or deployment has been performed.
