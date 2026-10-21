# Quotation templates, branding and prepared-by profiles

Open **Accounting → More → Quotation templates** as an owner/admin. The backend
also enforces admin access on settings changes and template previews. Accountants
and cashiers can change an individual quotation's wording, but cannot choose or
change the shared layout or brand color.

## Five layouts and brand colors

| Layout | Appearance |
| --- | --- |
| Classic Blue | Traditional letterhead, blue table headings and shaded sections |
| Executive | Teal accents, a left rule and structured information blocks |
| Minimal | White space, fine rules and a restrained table |
| Corporate | A full-width branded masthead with a logo panel |
| Elegant | Burgundy accents, a double rule and subtle section bands |

Choose a layout, use the hue buttons and saturation/brightness panel, or enter
an exact six-digit HEX brand color. **Use template color** restores that layout's
preset. Custom colors apply consistently to the preview and exported PDF. Light
colors use dark table/masthead text; colored text on white is darkened to remain
readable. No new mobile package or font dependency was added.

**Preview selected template** renders unsaved admin settings with sample items.
It does not save settings, allocate document numbers, create documents or affect
stock/cash. Save document settings to make the selection the default for future
documents. Existing documents retain their layout/color/profile snapshots.

## Project logo

PDF generation reads the project's saved logo through the scoped upload/storage
service. The logo is fitted without stretching and repeated on each page. PNG and
JPEG project logos produced by the app's normal image upload flow are supported.
No arbitrary image URL is fetched and private upload URLs/tokens are not embedded.
Missing, deleted, unreadable or unsupported logos fall back to the company
letterhead. New documents retain the selected logo file ID; changing the project
logo does not silently substitute a different file in those saved documents.

## Professional profile

Open **More → My professional profile** (or Professional profile on the Profile
page). Maintain your full name, designation, work mobile and work email. Phone
entry includes the shared country-code and device-contact controls. These work
contact details are separate from verified sign-in identities.

Prepared-by fields were removed from Business setup/document company settings.
New quotations take the preparing user's full name and professional contact
profile, with existing user mobile/email as the initial fallback. Signature details
are saved with the quotation and copied through order/invoice conversion.
Historical saved documents keep their original prepared-by snapshot. Editing a
legacy document upgrades its missing user signature from the current user's profile.

The self-profile API resolves the current authenticated user and tenant; clients
cannot submit another user ID or roles. Changes are audited and revision checked.

## Wording for each quotation

In the quotation editor, enable **Terms and Conditions** and **DISCLAIMER**
independently. Each section has its own editable paragraph and formatted preview.
Use the toolbar for bold, italic, numbered lists and HTTP(S) links; newlines and
spacing are preserved. Enabled sections need nonblank text. Wording changes are
included in the unsaved PDF preview, saved with the quotation, retained when it
is reopened/revised after sending, and copied during conversion.

Admin paragraph defaults are not modified by quotation edits. Saving admin settings
from within a quotation preserves that quotation's current wording. **Apply latest
defaults & wording** explicitly replaces it with current defaults. Older clients
that omit custom text keep the saved text. Layout/color IDs cannot be injected
through the individual quotation presentation payload.

## Missing PDF values

Empty values and their labels are omitted in both the PDF and its preview,
including billing/delivery address, contact details, designation and due date.
Empty optional sections are hidden. Item code, model and UOM columns disappear
when all items lack those values; mixed rows retain the column with blank cells.
Zero quantities/prices/totals remain visible.

## API and rollout

- `GET/PATCH /v1/auth/profile`: own professional profile, including its revision.
- `GET/PUT /v1/accounting/document-settings`: `templateId` and nullable
  `accentColor`, in addition to company identity, defaults and numbering.
- `POST /v1/accounting/document-settings/preview`: admin-only unsaved preview.
- Document presentation selections accept optional `terms_text` and
  `disclaimer_text` (16,000 characters each). Layout, color, logo and prepared-by
  identity are resolved by the server.

Deploy the matching backend before the mobile app and apply migrations in normal
order, including `20261021200000_contact_persons`,
`20261022000000_document_workflow`, and
`20261022010000_quotation_profiles`. The last migration adds the user's professional
profile JSON field. No production migration or deployment was performed during
this work. A real PostgreSQL migration check remains necessary; the local Docker
daemon was unavailable.

Validation: mobile typecheck and 656 tests; backend build/Prisma validation and 71
focused accounting/contact/profile/layout tests; Android/iOS/web exports. The full
backend suite had 480 passes, 18 opt-in skips and the same seven pre-existing
failures (asset authorization, Google signup fixtures, mail filtering and sign-in
activity fixtures). Five sample layouts and a nine-page logo stress case were
rendered and checked for text bounds and repeated logos. Browser checks used
synthetic data with the real PDF renderer, including touch color selection,
light-color contrast and quotation-specific wording.
