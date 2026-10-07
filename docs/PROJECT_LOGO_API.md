# Project Logo API

Use the authenticated upload endpoint first, then assign the returned file ID to the project.

## 1. Upload Logo

```http
POST /v1/uploads
Authorization: Bearer <token>
X-Project-Id: <project_id>
Content-Type: multipart/form-data
```

Form fields:

- `file`: image file, required
- `purpose`: `project_logo`, required for logo uploads

Response:

```json
{
  "ok": true,
  "data": {
    "file_id": "upload_123",
    "storage_key": "tenant/project/project_logo/...-logo.png",
    "view_url": "/v1/uploads/upload_123/view",
    "public_url": "https://pub-example.r2.dev/tenant/project/project_logo/...-logo.png"
  }
}
```

Only an owner/admin can upload a project logo. The file must have an `image/*` MIME type.
`public_url` is returned for project logos when `R2_PUBLIC_URL` is configured. Payment proofs and
member documents continue to use authenticated view endpoints.

## 2. Set or Remove Logo

```http
PATCH /v1/projects/<project_id>
Authorization: Bearer <token>
X-Project-Id: <project_id>
Content-Type: application/json
```

Set the logo:

```json
{ "logo_file_id": "upload_123" }
```

Remove the logo:

```json
{ "logo_file_id": null }
```

The upload must belong to the same tenant and project. The update is recorded as
`project.updated` in the audit trail.

## 3. Read Project Details

```http
GET /v1/projects/<project_id>
Authorization: Bearer <token>
X-Project-Id: <project_id>
```

Relevant response fields:

```json
{
  "ok": true,
  "data": {
    "project_id": "project_123",
    "name": "Sunbeam",
    "total_shares": 22,
    "assigned_shares": 18,
    "remaining_shares": 4,
    "logo_file_id": "upload_123",
    "logo_url": "/v1/uploads/upload_123/view",
    "can_edit": true
  }
}
```

Request `logo_url` with the same `Authorization` and `X-Project-Id` headers.
