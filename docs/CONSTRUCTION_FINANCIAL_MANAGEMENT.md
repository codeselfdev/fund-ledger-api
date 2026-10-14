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
