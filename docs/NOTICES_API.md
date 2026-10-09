# Project notice board

Deploy migration `20261009010000_add_project_notices` before starting the updated API or releasing the updated mobile app. Use the standard release process with `prisma migrate deploy`, regenerate Prisma, and rebuild the API.

The migration imports older project-wide manual announcements, deduplicating recipient notifications. Imported notices expire seven days after publication and remain in admin history. Role/member-targeted announcements are excluded from the shared board.

All endpoints require authentication and the active project header. Tenant/project isolation applies to notices and images.

| Method | Endpoint | Access |
| --- | --- | --- |
| GET | `/v1/notices?scope=active` | All project roles; unexpired and undeleted |
| GET | `/v1/notices?scope=all` | Owner/admin; full history, newest first |
| POST | `/v1/notices` | Owner/admin; publish and notify members |
| PATCH | `/v1/notices/:id` | Owner/admin; edit |
| DELETE | `/v1/notices/:id` | Owner/admin; hide from dashboards, retain deleted history |
| GET | `/v1/notices/:id/image` | Members for active notices; owner/admin for history |

Create requires title (2–120 characters), body (2–2000), and expires_at (ISO datetime at least one minute in the future). image_file_id is optional/nullable; send_whatsapp defaults false.

Patch accepts a nonempty subset of title, body, expiry, and image ID. Set image_file_id to null to remove an image. Omit unchanged expiry when editing an expired notice. Changed expiry must be in the future. Deleted notices cannot be edited. Editing updates existing notification text without resending push or WhatsApp messages.

Upload JPEG/PNG images with purpose notice_image. Owner/admin access, content signatures, project ownership, and size strictly below 2,000,000 bytes are validated. Mobile resizes/compresses images before upload.

Lists return at most 200 newest records. Responses include id, title, body, expires_at, image_file_id, image_url, status (active/expired/deleted), deleted_at, created_at, and updated_at.

Validation commands:

```sh
npm run build
node --test dist/modules/community/notices.policy.test.js
node --import dotenv/config --test tests/notices.routes.test.mjs
```

Route tests use isolated Prisma fixtures and send no real notifications or WhatsApp messages.
