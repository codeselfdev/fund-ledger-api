# Notices, WhatsApp, Receipts, and Expense Groups

Send `Authorization: Bearer <token>` and `X-Project-Id: <project_id>` on every request.
JSON responses use `{ "ok": true, "data": ... }`.

## Project Notice

`POST /v1/notifications/broadcast` - owner, admin, or accountant

```json
{
  "title": "Monthly meeting",
  "body": "The project meeting starts Friday at 7 PM.",
  "send_whatsapp": false
}
```

Omit targeting to notify every active project participant. Alternatively, send either `roles` or
`member_ids`, but not both.

```json
{
  "ok": true,
  "data": {
    "sent": true,
    "recipient_count": 24,
    "whatsapp": { "sent": true, "message_id": "wamid..." }
  }
}
```

Register the current device for push delivery with
`POST /v1/notifications/device-token` and `{ "fcm_token": "..." }`.

## WhatsApp Connection

`PUT /v1/integrations/whatsapp` - owner or admin

```json
{
  "waba_id": "123456789",
  "phone_number_id": "987654321",
  "access_token": "permanent-system-user-token",
  "graph_api_version": "v22.0"
}
```

The API verifies the business phone number before encrypting and storing the token. Configure
`WHATSAPP_CREDENTIALS_KEY` in production.

`PUT /v1/integrations/whatsapp/group` - owner or admin

```json
{
  "group_id": "eligible-groups-api-id",
  "group_name": "Sunbeam announcements"
}
```

Use an eligible group created/managed through Meta's official Groups API. Consumer groups and invite
links cannot be mapped. Read status with `GET /v1/integrations/whatsapp`; disconnect with
`DELETE /v1/integrations/whatsapp`.

The integration is disabled by default. Enable it later with `WHATSAPP_ENABLED=true` on the API and
`EXPO_PUBLIC_WHATSAPP_ENABLED=true` in the mobile build.

Manual and recurring schedule starts, final payment posting, and final expense posting automatically
notify active project devices. When WhatsApp is enabled, they also notify the mapped group. Payment
messages include member and amount. Expense messages include title, amount, and expense head.

## Member Receipts

`GET /v1/members/:member_id/receipts` - owner or staff

Returns confirmed payment receipts newest first, including the related deposit.

`GET /v1/receipts/:receipt_id/pdf` - receipt owner, project owner, or staff

Returns binary `application/pdf` with an attachment filename. The mobile app downloads or shares this
file from the member profile's **Approved payment receipts** section.

## Expenses by Category

`GET /v1/expenses/by-category?status=paid` - owner or staff

```json
{
  "ok": true,
  "data": [
    {
      "category_id": "category_id",
      "category_key": "category_id",
      "category_name": "Construction",
      "total_amount": 87000,
      "expense_count": 3,
      "items": [
        {
          "id": "expense_id",
          "title": "Foundation materials",
          "amount": 42000,
          "status": "paid",
          "occurred_at": "2026-10-06T09:30:00.000Z"
        }
      ]
    }
  ]
}
```

The optional `status` filter accepts `draft`, `pending`, `approved`, `paid`, or `rejected`. Groups are
ordered by total amount; breakdown items are ordered by payment time, then creation time.
