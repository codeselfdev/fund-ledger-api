# Member Settlement, Removal, and Transfer API

This document covers the member exit workflow for mobile and web clients.

## Authentication

All four endpoints require an authenticated session and an active project.

```http
Authorization: Bearer <access_token>
X-Project-Id: <project_id>
Content-Type: application/json
```

Successful responses use:

```json
{
  "ok": true,
  "data": {}
}
```

Failed responses use:

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "Member balance must be zero and pending deposits must be resolved before removal or transfer",
    "fields": {}
  }
}
```

All accounting amounts are integers in the project's currency.

## Required Workflow

1. Call `GET /v1/members/:id/settlement`.
2. Resolve pending deposits through the normal approval or rejection workflow.
3. Record real payments through the deposits API.
4. When authorized, call `POST /v1/members/:id/settle` to apply advances, write off dues, or refund advances.
5. Confirm that `can_exit` is `true`.
6. Call either `POST /v1/members/:id/remove` or `POST /v1/members/:id/transfer`.

Removal and transfer are blocked when the member has outstanding dues, unused advance credit,
pending deposits, or active management roles.

## 1. Get Exit Settlement

Returns the member's current balance and exit blockers.

```http
GET /v1/members/{member_id}/settlement
```

### Permission

The member themselves, owner, admin, accountant, approver, or auditor can read the settlement.

### Request Body

No request body.

### Success Response

```json
{
  "ok": true,
  "data": {
    "member": {
      "id": "mem_01",
      "name": "Imran Hossain",
      "mobile": "+8801911553300",
      "status": "active",
      "shares": 2
    },
    "outstanding_due": {
      "principal": 8000,
      "penalty": 500,
      "total": 8500,
      "count": 1
    },
    "unused_advance": 3000,
    "pending_deposits": {
      "count": 0,
      "amount": 0,
      "items": []
    },
    "net_balance": 5500,
    "can_exit": false,
    "blockers": [
      "outstanding_due",
      "unused_advance"
    ]
  }
}
```

### Field Meanings

| Field | Meaning |
| --- | --- |
| `outstanding_due.principal` | Unpaid principal after payments and write-offs |
| `outstanding_due.penalty` | Unpaid penalty |
| `outstanding_due.total` | Principal plus penalty still owed |
| `unused_advance` | Confirmed advance not yet allocated or refunded |
| `pending_deposits` | Submitted payments that still require approval, rejection, or cancellation |
| `net_balance` | `outstanding_due.total - unused_advance` for display only |
| `can_exit` | The authoritative flag for enabling remove or transfer |
| `blockers` | Any of `outstanding_due`, `unused_advance`, or `pending_deposits` |

Do not use `net_balance === 0` as permission to exit. Both dues and advances must be individually
resolved, and `can_exit` must be `true`.

## 2. Settle Member Balance

Applies unused advance to dues, writes off an authorized remainder, and/or refunds remaining
advance credit.

```http
POST /v1/members/{member_id}/settle
```

### Permission

Owner, admin, or accountant.

### Request Body

```json
{
  "reason": "Final settlement approved before membership transfer",
  "apply_advance_to_dues": true,
  "write_off_remaining_dues": true,
  "refund_remaining_advance": true
}
```

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `reason` | string | yes | none | Audit reason, 3-500 characters |
| `apply_advance_to_dues` | boolean | no | `true` | Applies available advance to oldest dues, penalty first |
| `write_off_remaining_dues` | boolean | no | `false` | Waives remaining principal and penalty |
| `refund_remaining_advance` | boolean | no | `false` | Refunds unused advance from its original account |

At least one action must be `true`. Actions execute in this order: apply advance, write off
remaining dues, then refund remaining advance.

### Success Response

```json
{
  "ok": true,
  "data": {
    "adjustment": {
      "applied_advance": 3000,
      "written_off_principal": 5500,
      "written_off_penalty": 0,
      "refunded_advance": 0,
      "advance_applications": [
        {
          "deposit_id": "dep_advance_01",
          "due_id": "due_01",
          "amount": 3000,
          "principal_amount": 2500,
          "penalty_amount": 500
        }
      ],
      "write_offs": [
        {
          "due_id": "due_01",
          "principal_amount": 5500,
          "penalty_amount": 0
        }
      ],
      "refunds": [],
      "reason": "Final settlement approved before membership transfer"
    },
    "settlement": {
      "member": {
        "id": "mem_01",
        "name": "Imran Hossain",
        "mobile": "+8801911553300",
        "status": "active",
        "shares": 2
      },
      "outstanding_due": {
        "principal": 0,
        "penalty": 0,
        "total": 0,
        "count": 0
      },
      "unused_advance": 0,
      "pending_deposits": {
        "count": 0,
        "amount": 0,
        "items": []
      },
      "net_balance": 0,
      "can_exit": true,
      "blockers": []
    }
  }
}
```

An advance refund also creates a `money_out` account transaction. A write-off is recorded as a
waiver and is not counted as a payment. If the member pays money, submit and approve a normal
deposit instead of using `write_off_remaining_dues`.

### Pending Deposit Error

```http
HTTP/1.1 409 Conflict
```

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "Resolve pending deposits before adjusting this member's balance",
    "fields": {
      "pending_deposits": 1
    }
  }
}
```

### Refund Balance Error

```http
HTTP/1.1 400 Bad Request
```

```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Advance account has insufficient balance for refund",
    "fields": {
      "account_id": "acc_bank_01",
      "available": 1000,
      "required": 3000
    }
  }
}
```

## 3. Remove Member

Soft-removes a settled member. The member is retained for accounting history, but their shares
become zero and their project member role is deactivated.

```http
POST /v1/members/{member_id}/remove
```

### Permission

Owner or admin.

### Request Body

```json
{
  "reason": "Member resigned and final settlement was completed"
}
```

### Success Response

```json
{
  "ok": true,
  "data": {
    "member": {
      "id": "mem_01",
      "tenantId": "tenant_01",
      "projectId": "project_01",
      "userId": "user_01",
      "name": "Imran Hossain",
      "mobile": "+8801911553300",
      "email": "imran@gmail.com",
      "address": "Flat B-4",
      "shares": 0,
      "status": "inactive",
      "createdAt": "2026-01-10T08:30:00.000Z",
      "updatedAt": "2026-10-04T09:30:00.000Z"
    },
    "settlement": {
      "member": {
        "id": "mem_01",
        "name": "Imran Hossain",
        "mobile": "+8801911553300",
        "status": "active",
        "shares": 2
      },
      "outstanding_due": {
        "principal": 0,
        "penalty": 0,
        "total": 0,
        "count": 0
      },
      "unused_advance": 0,
      "pending_deposits": {
        "count": 0,
        "amount": 0,
        "items": []
      },
      "net_balance": 0,
      "can_exit": true,
      "blockers": []
    },
    "reason": "Member resigned and final settlement was completed"
  }
}
```

Historical dues, deposits, receipts, account transactions, and activity records are not deleted.

## 4. Transfer Membership

Transfers all source shares and active member access to another member. The source member becomes
inactive with zero shares. Historical accounting records stay on the source member.

```http
POST /v1/members/{source_member_id}/transfer
```

### Permission

Owner or admin.

### Transfer to a New Member

```json
{
  "reason": "Ownership transferred under signed agreement",
  "new_member": {
    "name": "Nadia Rahman",
    "mobile": "+8801711000022",
    "email": "nadia@gmail.com",
    "address": "Dhaka"
  }
}
```

`name` and `mobile` are required. `email` and `address` are optional. The API creates or links the
user, creates the target member, activates the member role, issues an OTP, and sends the app
invitation email when an email address is available.

### Transfer to an Existing Member

```json
{
  "reason": "Shares merged into the existing member account",
  "target_member_id": "mem_02"
}
```

Send exactly one of `new_member` or `target_member_id`.

### Success Response

```http
HTTP/1.1 201 Created
```

```json
{
  "ok": true,
  "data": {
    "source_member": {
      "id": "mem_01",
      "tenantId": "tenant_01",
      "projectId": "project_01",
      "userId": "user_01",
      "name": "Imran Hossain",
      "mobile": "+8801911553300",
      "email": "imran@gmail.com",
      "address": "Flat B-4",
      "shares": 0,
      "status": "inactive",
      "createdAt": "2026-01-10T08:30:00.000Z",
      "updatedAt": "2026-10-04T09:40:00.000Z"
    },
    "target_member": {
      "id": "mem_02",
      "tenantId": "tenant_01",
      "projectId": "project_01",
      "userId": "user_02",
      "name": "Nadia Rahman",
      "mobile": "+8801711000022",
      "email": "nadia@gmail.com",
      "address": "Dhaka",
      "shares": 2,
      "status": "active",
      "createdAt": "2026-10-04T09:40:00.000Z",
      "updatedAt": "2026-10-04T09:40:00.000Z"
    },
    "transferred_shares": 2,
    "user_created": true,
    "invitation_link": "fundledger://invite?tenant_id=tenant_01&project_id=project_01&role=member&mobile=%2B8801711000022&email=nadia%40gmail.com&member_id=mem_02",
    "app_download_link": "https://example.com/download-fundledger",
    "invitation_email": {
      "sent": true,
      "to": "nadia@gmail.com"
    },
    "sign_in_options": [
      {
        "method": "google",
        "label": "Sign in with Google",
        "description": "Use the Gmail or Google account email on the invitation"
      },
      {
        "method": "otp",
        "label": "Sign in with OTP",
        "description": "Enter the OTP sent to your phone or email"
      }
    ]
  }
}
```

For an existing target member, `target_member.shares` is their previous shares plus
`transferred_shares`, and `user_created` is normally `false`.

## Common Exit Errors

### Balance Is Not Zero

Returned by remove or transfer when dues, advances, or pending deposits remain.

```http
HTTP/1.1 409 Conflict
```

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "Member balance must be zero and pending deposits must be resolved before removal or transfer",
    "fields": {
      "settlement": {
        "member": {
          "id": "mem_01",
          "name": "Imran Hossain",
          "mobile": "+8801911553300",
          "status": "active",
          "shares": 2
        },
        "outstanding_due": {
          "principal": 8000,
          "penalty": 500,
          "total": 8500,
          "count": 1
        },
        "unused_advance": 3000,
        "pending_deposits": {
          "count": 0,
          "amount": 0,
          "items": []
        },
        "net_balance": 5500,
        "can_exit": false,
        "blockers": [
          "outstanding_due",
          "unused_advance"
        ]
      }
    }
  }
}
```

### Active Management Roles

```http
HTTP/1.1 409 Conflict
```

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "Reassign or deactivate the member's management roles before removal or transfer",
    "fields": {
      "active_roles": [
        {
          "id": "membership_01",
          "role": "accountant"
        }
      ]
    }
  }
}
```

### Validation Error

```http
HTTP/1.1 400 Bad Request
```

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION",
    "message": "Invalid request",
    "fields": {
      "reason": "String must contain at least 3 character(s)"
    }
  }
}
```

## Audit Actions

The APIs create activity records available from `GET /v1/activity`:

| Action | Created When |
| --- | --- |
| `member.balance_settled` | Advance application, write-off, or refund is posted |
| `account_transaction.created` | An advance refund creates a money-out transaction |
| `member.removed` | A settled member is removed |
| `member.membership_transferred` | Shares and member access are transferred |

Settlement audit data includes affected deposit IDs, due IDs, account IDs, refund transaction
IDs, amounts, the actor, reason, and before/after settlement snapshots.
