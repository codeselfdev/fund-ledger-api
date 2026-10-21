# Quotations and sales documents

## Quoting and later procurement

The document editor accepts inventory items, custom services, and **Import external items**. Import reads CSV, XLSX or XLS, previews the rows, then adds them to the current document. It does not create catalog records, purchase receipts, stock movements or ledger entries.

Download the sample from the import sheet. Supported headings are Description, Quantity, Unit, Unit price, Item code, Model, Brand and Country. Description and Unit price are required; quantity defaults to 1 and unit to pcs. Limits are 5 MB and 100 document lines. External quantities must be positive whole numbers. Metadata is retained through saving, reopening, conversion and PDF export.

Unit prices are directly editable for each quotation line, including inventory items. Changing a quotation price leaves the catalog selling price unchanged. Existing financial storage uses whole taka: `1,250.00` is accepted as 1250, while `1250.50` needs correction. This release does not migrate ledger currency units.

After confirming a sales order, choose **Prepare external items for purchase**. Link each external line to an existing catalog item, or create a catalog item with zero opening stock. Record and receive the supplier purchase using that item and the intended sales stock location. Convert the order to an invoice, then issue it. A draft invoice also supports item linking. Linking alone never receives stock. With stock tracking enabled, issuance rejects unlinked external lines and uses the existing stock availability and deduction rules for linked items. Services remain available for non-stock charges.

## Contacts and referrals

Contact persons can be linked to multiple customers and dealers. The quotation person picker offers contacts linked to the selected customer and saves their details as a document snapshot.

**Referred by** selects any active contact in the current project. It is separate from the quotation recipient and is available on quotations, sales orders and invoices. Conversion carries the referrer forward. Admin document settings include a referral summary: confirmed/fulfilling/completed work orders, issued invoices, invoiced value and collected value. Orders and invoices are counted separately; no commission is calculated or paid automatically.

## Admin templates and PDF preview

The latest [template and branding upgrade](QUOTATION_TEMPLATES.md) adds five admin-only
layouts, logo support, custom colors, user signature profiles and per-quotation text.

Open **Business setup → PDF templates, numbering & referrals** as an accounting admin. Configure company identity/contact details, footer, and independent Terms and Conditions and DISCLAIMER templates. The company profile and paragraph templates belong to the project; the numbering prefix belongs to the organization.

Each paragraph supports newlines, blank lines, spaces, typed numbered lists, `**bold**`, `*italic*`, `***bold italic***`, bare HTTP(S) URLs and `[link label](https://example.com)`. Toolbar actions apply to the current selection; a live formatted preview appears below the input. HTML is treated as text. Enabling an empty template is rejected.

Document creators independently switch each optional section on or off and edit its wording for the current quotation. Saved documents retain snapshots of the profile and paragraphs. Later admin changes do not silently rewrite them. **Apply latest templates** explicitly adopts current settings. Revision checks reject stale settings saves.

**Preview PDF** renders the current unsaved form without saving a document, consuming a serial, changing status or posting stock/cash. Web, Android and iOS display an HTML/SVG rendition using the same page coordinates, fonts and line wrapping as the PDF, without requiring a browser PDF plugin. Shared/downloaded files use the server PDF renderer. The layout includes customer/recipient information, billing/delivery details, an eight-column items table, tax/discount totals, optional paragraphs, signature details, repeated letterhead and page numbers. Backend font files are embedded in PDFs and are not added to the mobile application bundle.

## Sent quotation negotiation

Drafts and **sent quotations** can be edited. Sent quotation saves keep their number and sent status, increment the revision, and record a quotation revision event. Server audit records preserve before/after contents. A stale editor receives a conflict and must reload. Accepted/rejected/expired quotations and finalized orders/invoices keep their existing workflow restrictions.

## Monthly document numbers

Format: `PREFIX + TYPE + YY + MM + 1 + SERIAL`.

| Document | Example for October 2026 |
| --- | --- |
| Quotation | `ABCQ26101001` |
| Sales order | `ABCSO26101001` |
| Sales invoice | `ABCSI26101001` |

The prefix is 1–3 ASCII letters/digits, normalized to uppercase. The server initially derives it from the organization name, falling back to ORG. Serial counters restart monthly and are separate per organization and document type, shared across that organization's projects. The document date determines the month. Counters increment transactionally; retrying the same creation key does not allocate another number. Conversion allocates the target type's number. Editing dates or changing the prefix does not rename existing documents. Each type supports 001–999 per month; exhaustion returns a conflict rather than wrapping or reusing numbers.

## Backend and rollout

Matching API changes are in the sibling `fund-ledger` backend. Added endpoints (under `/v1/accounting`) are `GET/PUT /document-settings`, `GET /referrals`, `POST /documents/preview`, and `POST /documents/:id/source-items`. Document writes accept presentation choices, referrer ID and expected revision. All operations retain tenant/project authorization and the existing financial transaction mechanism.

Apply migrations in normal migration order, including `20261021200000_contact_persons` and `20261022000000_document_workflow`, regenerate Prisma, and deploy the backend before releasing the mobile app. The document migration adds settings, presentation/referrer snapshots, revisions and a monthly sequence table. Existing document numbers remain unchanged. This development work has not applied migrations to production or deployed either app.

Verification on 22 October 2026:

- Mobile typecheck and all 640 tests passed; Android, iOS and web exports succeeded.
- Backend build and all 60 focused accounting/contact tests passed. The complete suite had 469 passes, 18 opt-in skips and the same seven pre-existing failures in unrelated asset authorization, Google onboarding, mail filtering and sign-in fixtures.
- A two-page sample and ten-page stress document were rendered and inspected; text bounds, embedded fonts and repeated letterhead were checked.
- Browser checks used synthetic API fixtures to verify external import/review, editable prices, section switches and selection-based rich-text formatting. These checks did not write production business records.
- No live PostgreSQL migration check ran for this document migration: the local Docker daemon was unavailable. Run the normal isolated database checks before deployment.
