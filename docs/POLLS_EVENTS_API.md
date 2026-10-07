# Polls and Events API

All routes require `Authorization: Bearer <token>` and `X-Project-Id: <project_id>`.
Dates use ISO-8601 with an offset, for example `2026-10-10T18:30:00+06:00`.

## Create Poll

`POST /v1/polls` - owner or admin

```json
{
  "title": "Which date works for the member meeting?",
  "description": "Choose one option before Friday.",
  "options": ["Friday evening", "Saturday morning", "Saturday evening"],
  "expires_at": "2026-10-09T20:00:00+06:00"
}
```

Response `201`:

```json
{
  "data": {
    "id": "poll_id",
    "title": "Which date works for the member meeting?",
    "description": "Choose one option before Friday.",
    "expires_at": "2026-10-09T14:00:00.000Z",
    "closed_at": null,
    "status": "active",
    "has_voted": false,
    "my_vote_option_id": null,
    "total_votes": 0,
    "options": [
      { "id": "option_id", "label": "Friday evening", "position": 0, "vote_count": 0 }
    ]
  }
}
```

## Vote

`POST /v1/polls/:id/vote` - any project user

```json
{ "option_id": "option_id" }
```

The response is the refreshed poll. Posting again before expiry changes that user's vote. One user
still counts as one vote.

## Active Polls and History

- `GET /v1/polls/active`
- `GET /v1/polls?status=active|expired|closed|all`

Both return a `data` array. Owners/admins receive `total_votes` and each option's `vote_count`.
Other users receive their own `has_voted` and `my_vote_option_id` without group vote counts.

## Poll Analytics

`GET /v1/polls/:id/analytics` - owner or admin

```json
{
  "data": {
    "id": "poll_id",
    "total_votes": 18,
    "eligible_count": 24,
    "pending_count": 6,
    "response_rate": 75,
    "options": [
      { "id": "option_id", "label": "Friday evening", "position": 0, "vote_count": 11 }
    ],
    "voters": [
      {
        "user_id": "user_id",
        "user_name": "Member Name",
        "option_id": "option_id",
        "option_label": "Friday evening",
        "voted_at": "2026-10-07T12:20:00.000Z"
      }
    ]
  }
}
```

Close early with `POST /v1/polls/:id/close`.

## Create Event

`POST /v1/events` - owner or admin

```json
{
  "title": "October member meeting",
  "place": "Project office, meeting room",
  "agenda": "Construction update, collections, and member questions.",
  "starts_at": "2026-10-12T18:30:00+06:00"
}
```

Response `201`:

```json
{
  "data": {
    "id": "event_id",
    "title": "October member meeting",
    "agenda": "Construction update, collections, and member questions.",
    "place": "Project office, meeting room",
    "starts_at": "2026-10-12T12:30:00.000Z",
    "status": "upcoming",
    "cancelled_at": null
  }
}
```

## List, Update, and Cancel Events

- `GET /v1/events/upcoming`
- `GET /v1/events?scope=upcoming|past|all`
- `PATCH /v1/events/:id` with any create-event field
- `POST /v1/events/:id/cancel`

Changing `starts_at` clears earlier reminder markers so reminders follow the new time. Cancelling
an event sends an immediate project notification and prevents future reminders.

## Automatic Notifications

- Publishing a poll sends an immediate announcement.
- Unvoted active members receive a reminder every two hours until they vote, the poll expires, or it closes.
- Publishing or updating an event sends an immediate announcement.
- Every active project user receives event reminders at one hour and ten minutes before start.
- In-app notification and FCM push delivery use the same recipient set.
