# Member profiles

Apply `prisma migrate deploy` and deploy the API before using the mobile profile editor.
The migration adds a nullable JSONB `members.profile` column for identity, occupation, nominee and photo metadata.
Existing financial/member fields keep their existing semantics.

All endpoints require bearer authentication and an active project (`X-Project-Id`).

- `GET /v1/members/:id` returns the member profile and contribution summary.
- `GET /v1/members/:id/dues` returns assigned schedules, penalties and outstanding amounts.
- `GET /v1/members/:id/payments` returns confirmed, pending and rejected payment submissions.
- `PATCH /v1/members/:id/profile` updates contact/profile fields.
- `POST /v1/members/:id/photo` accepts multipart `file`, JPG or PNG, strictly below 2 MB (2,000,000 bytes). The app resizes photos to at most 1,600 pixels on the longest side and compresses them before upload. The API rejects oversized images before writing to R2.
- `GET /v1/members/:id/photo` returns the authorized member photo.
- `GET /v1/members/:id/receipts` allows authorized staff or the member themselves to view approved receipts.
- Existing member-document endpoints provide document upload and viewing.

Owners/admins may edit any member within their active tenant/project. A member may edit only their own email, address, occupation, permanent address, nominee fields, and photo. Name, login mobile, father/spouse name, birth date and NID are admin-managed. Shares and status must use the existing membership/settlement endpoints and cannot be changed through profile updates. Other staff retain read access but cannot edit another profile.

Nominee fields: `nominee_name`, `nominee_relation`, `nominee_mobile`, `nominee_nid`, `nominee_share_percent` (0–100).
Identity fields: `father_name`, `date_of_birth` (YYYY-MM-DD), `nid`. Optional fields accept null to clear.
Profile/photo updates serialize on the member row and audit changed field names without recording identity values.
No document verification status is implied by uploading a file.

Validation: `npx tsx --test src/modules/members/member-profile.policy.test.ts`; `npm run build`.
