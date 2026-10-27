# Contractor work agreements and measured billing

This optional workflow manages subcontracted parts of a construction project: labour gangs, reinforcement cutting/bending/binding, masonry, plumbing, finishing or other agreed work. It extends the existing Contractors and Running bills screens. Existing lump-sum contracts remain available.

## Site workflow

1. In **Contractors & contracts**, add the contractor's contact details, then choose **Assign contractor work**.
2. Select an approved cost head. Its existing phase, work package, task and building/floor/zone context identifies the assigned scope. Create a separate cost head first when a smaller part of the project needs its own scope.
3. Enter the agreement title, trade, scope and responsibilities. Choose **Project supplies materials** for labour-only work, or **Contractor supplies labour and materials** when those costs are included in the rates.
4. Add each work item, measurement unit, agreed quantity and rate. Examples: 10 tonnes of reinforcement binding at 10,000 per tonne; 2,000 sqft of plastering at an agreed rate. For fixed-price work or a milestone, use unit `job`, quantity `1` and its agreed price; fractional completion can be billed against that item.
5. Set retention and optionally attach the agreement, drawings, photographs and planned start/finish dates. Another administrator or approver must approve the agreement before it becomes active, permits advances or enters committed costs.
6. In **Contractor running bills**, choose **Bill measured contractor work** and select the approved agreement. Enter **total completed quantity to date** for every item, including unchanged items. The form shows previously certified quantities, quantities in this bill and the calculated value.
7. Enter advance recovery and a measurement basis; optionally attach signed measurement sheets/photos and select recorded chargeable material losses. A different administrator or approver checks the certificate and approves or rejects it.
8. Pay approved bills through **Pay certified bill**, using the existing account/payment form. The contractor account shows approved contract value, certified work, outstanding advances, held retention and unpaid approved bills when Running bills access is available.

For example, an agreement for 10 tonnes at 10,000 per tonne has a value of 100,000. If 2.5 tonnes were previously certified and total completed quantity is now 4 tonnes, this bill certifies 1.5 tonnes worth 15,000. With 5% retention and 5,000 advance recovery, the payable is 9,250 before any selected recorded wastage.

## Accounting and approvals

- Draft submissions are pending approval. Pending or rejected agreements do not add commitments, recognized costs or cash payments.
- Agreement value is derived by the server from immutable agreed work items. Measured bills cannot use the manual amount-based running-bill endpoint, and amount-only change orders cannot change their agreed ceiling.
- Only approved measured certificates advance the contract's saved quantities and certified amount. Bills reuse the existing running-bill, payment, liability and account-transaction records. No duplicate daily-wage entry or supplier invoice is generated.
- For labour-only agreements, project materials remain in their normal purchase/stock/WIP workflow. For contractor-supplied materials, the agreed work rate includes that contractor scope. Do not separately enter the same subcontract service as a daily wage or expense.
- Quantities support three decimals; agreed rates support two. Fixed-point calculations round each item's cumulative value to the app's existing whole-currency ledger. A bill recognizes the difference from previously rounded cumulative value. A final quantity-only certificate can therefore have zero additional value; it still needs independent approval.
- Retention for measured agreements uses cumulative certified value less retention already held. Recoverable advances reserve the remaining retention so they can be recovered through future bills. Legacy lump-sum bill calculations are unchanged.
- One pending measured bill is allowed per contract. Repeated identical submissions return the original record; changed requests need a new key. Scoped lookups, independent review, current-quantity revalidation and serializable transactions protect certification and payment from duplicate or stale updates. Audit failures roll back the same transaction.
- Reject a pending bill and submit a corrected bill when measurements are wrong. Rejection leaves certified quantities unchanged and releases proposed wastage reservations. Approved certificates are immutable.
- Closing a measured agreement requires every agreed quantity to be certified and all advances recovered. Retention can then be released through the existing payment action.
- The existing Contractors, Running bills, Approvals and Payments menu permissions apply. Approval-only custom roles gain Contractors read dependency when their permissions are saved; they do not gain creation or payment rights. Attachment access remains project-scoped.

## Current boundaries

- This is an internal project-team workflow. A contractor login/portal, self-submitted claims, electronic signatures and automatic messages are not included.
- Work items belong to one agreement and inherit its cost-head work context. They are not automatically linked to BOQ quantity certification. Record independent project physical progress in Site controls where required; subcontract billing does not certify the same physical quantity there a second time.
- Agreed quantities/rates are locked after submission. For extra scope, create an independently approved supplementary work agreement. Editing/reducing an approved schedule, cancelling its unused balance and reversing approved measured certificates need a separate final-account/amendment workflow. Suspension retains the existing commitment.
- Planned agreement dates are informational; they do not create schedule-baseline tasks automatically.
- Statutory withholding, VAT calculations on subcontract bills, multi-stage certification and printable/exported measurement books remain separate work.

## Release and validation

Apply additive migration `20261027150000_construction_contractor_work` after `20261027100000_construction_procurement_receipts_scope`, regenerate Prisma, deploy the API, then release the matching mobile/web app. No production migration, deployment, cash transaction or contractor communication was performed during development.

Validation: 199 tests passed (87 client and 112 API/engine/migration/permission tests), TypeScript checks and Expo web export; isolated API tests covering approvals, scope, precision, repeated/concurrent bills, advance/retention accounting, rejected losses, stale measurements, final quantity-only certification, change-order bypasses and audit rollback; embedded PostgreSQL migration checks; client form tests covering failed lookup, preserved drafts/retry keys, stable measurement snapshots and double-submit locking. Desktop and 390px phone-width layouts were checked with fictional local records. Native-device keyboard/file-picker behaviour and live multi-connection PostgreSQL staging checks remain release QA.
