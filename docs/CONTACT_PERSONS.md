# Contact persons and quotation mapping

Customers and dealers can have multiple contact persons. A person can be reused
across several customers and dealers within the same project. Dealers continue
to use existing vendor/supplier records.

## Mobile workflow

- Open a saved customer or dealer in the business directory. **Contact persons**
  lists linked people with name, designation, mobile and email.
- **Add or link contact person** searches the project's people. Select one to
  link it, or choose **New contact** to create and link a person atomically.
- **Edit** changes the reusable person. **Unlink** removes only that relationship;
  it preserves the person, other links and document history. Contact actions save
  independently of the customer's or dealer's basic details.
- Save new customers/dealers before adding links. A quotation's newly saved
  customer can immediately have people created or linked through its picker.
- Quotations have an optional **Quotation person** field after the customer.
  It initially lists only that customer's linked, active people. **Link existing**
  and **New contact** let writers reuse or create a person in the editor.
- Changing the customer clears the selection. Draft reopening, document details,
  conversion to an order/invoice, and PDF output retain the saved contact snapshot.
  Renaming, archiving or unlinking a directory contact does not rewrite historical
  documents. Explicitly clearing the person removes it from an editable draft.

## API and data

Implemented in the sibling `fund-ledger` repository. All endpoints use the
existing bearer session, active subscription, tenant and project scope.

| Method and path | Behavior |
| --- | --- |
| `GET /v1/contact-persons` | Search active people by name, designation, mobile or email; optional `entity` (customer/dealer) plus `record_id`; offset/limit pagination, maximum 50 |
| `POST /v1/contact-persons` | Create `{name, designation?, mobile?, email?, link?: {entity, record_id}}` |
| `PATCH /v1/contact-persons/:id` | Save contact fields; optional `is_active`; changes affect all links |
| `POST /v1/contact-persons/:id/links` | Link `{entity, record_id}`; repeating the link is idempotent |
| `DELETE /v1/contact-persons/:id/links/:entity/:recordId` | Remove only that scoped relationship |

`contact_persons` stores people; `customer_contact_persons` and
`dealer_contact_persons` provide many-to-many relationships with composite primary
keys preventing duplicate links. Foreign keys preserve reference integrity.
Mutations and audit entries run in one serializable transaction. No hard-delete
endpoint is exposed.

Accounting document create/edit accepts `quotation_person_id: string | null`.
Responses contain `quotationPersonId` and `quotationPersonSnapshot`. The server
resolves details and rejects active selections not linked to the chosen customer.
An unchanged selection keeps its historical snapshot even after unlinking;
explicit `null` clears it. Older clients omitting the field preserve the selection
when the customer stays the same and clear it when the customer changes.
Conversions copy the snapshot. PDFs render name, designation, mobile and email.

Owners, admins and accountants can manage all contacts. Cashiers can manage
ordinary customer contacts but cannot change dealer links, people shared with a
dealer, or billing-customer contacts. Approver/auditor/staff access is read-only;
members cannot access this API.

## Rollout

Apply backend migration **`20261021200000_contact_persons`** and deploy the matching
API before releasing the mobile update. The additive migration leaves existing
records unchanged. No contact backfill assumes that a business phone belongs to
a particular person. Prisma Client was regenerated locally; no live migration
or deployment was performed.

```sh
# In fund-ledger, using the intended deployment environment:
npx prisma migrate deploy
npm run prisma:generate
npm run build

# Local feature checks (mocked storage):
node --test tests/contact-persons.routes.test.mjs tests/accounting.routes.test.mjs

# In FundLedgerMobile:
npm run typecheck
node --test tests/contact-persons.test.cjs tests/accounting-ui.test.cjs
```

## Verification — 21 October 2026

All 630 mobile tests and all 52 contact/accounting route tests passed. Both
TypeScript builds and the Android Metro export passed. Synthetic mobile UI checks
exercised contact creation, reuse and quotation selection at 320 px.

The full backend run had 461 passing tests, 18 opt-in skips and seven failures.
All seven also reproduced against an unchanged baseline: fixed-assets member
authentication, Google redirect configuration, mailer recipient filtering and
membership activity persistence. The Docker daemon was stopped; a real PostgreSQL
migration/integration run remains to be performed in a disposable database before
rollout.
