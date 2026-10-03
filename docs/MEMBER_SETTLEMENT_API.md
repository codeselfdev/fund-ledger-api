# Member Settlement API

This document covers only member balance review and settlement. It does not cover member removal
or membership transfer.

## Authentication

Send these headers with every request:

```http
Authorization: Bearer <access_token>
X-Project-Id: <project_id>
Content-Type: application/json
```

All amounts are integers in the project's currency.

## Settlement Workflow

1. Read the current balance with `GET /v1/members/:id/settlement`.
2. Approve, reject, or cancel any pending deposits.
3. Record actual money received through the normal deposit API.
4. Use `POST /v1/members/:id/settle` for advance application, authorized write-off, or advance refund.
5. Read the returned settlement and confirm the remaining balances.

## Get Settlement Summary

```http
GET /v1/members/{member_id}/settlement
```

### Permission

The member themselves, owner, admin, accountant, approver, or auditor.

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
      "principal": 2000,
      "penalty": 500,
      "total": 2500,
      "count": 1
    },
    "unused_advance": 3000,
    "pending_deposits": {
      "count": 0,
      "amount": 0,
      "items": []
    },
    "net_balance": -500,
    "can_exit": false,
    "blockers": [
      "outstanding_due",
      "unused_advance"
    ]
  }
}
```

### Response Fields

| Field | Meaning |
| --- | --- |
| `outstanding_due.principal` | Principal still owed after payments and write-offs |
| `outstanding_due.penalty` | Penalty still owed |
| `outstanding_due.total` | Total outstanding principal and penalty |
| `unused_advance` | Confirmed advance not allocated or refunded |
| `pending_deposits` | Deposits still waiting for approval, rejection, or cancellation |
| `net_balance` | Outstanding total minus unused advance, for display only |
| `can_exit` | `true` only when dues, advances, and pending deposits are all cleared |
| `blockers` | `outstanding_due`, `unused_advance`, and/or `pending_deposits` |

Do not use `net_balance === 0` as proof that settlement is complete. Dues and advances must be
resolved individually.

## Settle Member Balance

```http
POST /v1/members/{member_id}/settle
```

### Permission

Owner, admin, or accountant.

### Request Body

```json
{
  "reason": "Final balance settlement approved by management",
  "apply_advance_to_dues": true,
  "write_off_remaining_dues": false,
  "refund_remaining_advance": true
}
```

| Field | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `reason` | string | yes | none | Audit reason, 3-500 characters |
| `apply_advance_to_dues` | boolean | no | `true` | Applies unused advance to oldest dues, penalty first |
| `write_off_remaining_dues` | boolean | no | `false` | Waives remaining principal and penalty |
| `refund_remaining_advance` | boolean | no | `false` | Refunds unused advance from the account that received it |

At least one settlement action must be `true`. Actions run in this order:

1. Apply advance to dues.
2. Write off the remaining dues when authorized.
3. Refund any remaining unused advance.

## Accounting Rules

### Apply Advance to Dues

Applying advance is a non-cash reclassification:

- Reduces the member's unused advance.
- Increases paid principal and/or paid penalty on the due.
- Creates or updates the deposit allocation.
- Does not change the bank/cash account balance.
- Creates a `member.advance_applied` audit activity.

The account is not reduced because it already increased when the advance deposit was confirmed.
Reducing it again would count the same money twice.

### Write Off Dues

A write-off:

- Stores waived principal separately from paid principal.
- Waives the remaining penalty.
- Does not create a cash transaction.
- Creates a `member.due_written_off` audit activity.

A write-off is not a payment. Actual money received must use the normal deposit workflow.

### Refund Advance

An advance refund:

- Deducts money from the bank/cash account that originally received the advance.
- Increases the deposit's refunded amount.
- Creates a `money_out` account transaction.
- Uses `referenceType: "advance_refund"` and the advance deposit ID as the reference.
- Creates `member.advance_refunded` and `account_transaction.created` audit activities.

The account deduction, deposit adjustment, ledger transaction, and audit activities commit in one
database transaction. If any operation fails, none of them are saved.

## Complete Success Response

```json
{
  "ok": true,
  "data": {
    "adjustment": {
      "applied_advance": 2500,
      "written_off_principal": 0,
      "written_off_penalty": 0,
      "refunded_advance": 500,
      "advance_applications": [
        {
          "deposit_id": "dep_advance_01",
          "due_id": "due_01",
          "amount": 2500,
          "principal_amount": 2000,
          "penalty_amount": 500
        }
      ],
      "write_offs": [],
      "refunds": [
        {
          "deposit_id": "dep_advance_01",
          "account_id": "acc_main_01",
          "account_name": "Main Bank Account",
          "account_is_default": true,
          "transaction_id": "txn_refund_01",
          "amount": 500,
          "account_balance_before": 25000,
          "account_balance_after": 24500
        }
      ],
      "reason": "Final balance settlement approved by management"
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

The response can still have `can_exit: false` when the selected actions do not clear every balance.

## Common Payloads

### Apply Advance Only

```json
{
  "reason": "Apply available advance to outstanding dues",
  "apply_advance_to_dues": true,
  "write_off_remaining_dues": false,
  "refund_remaining_advance": false
}
```

### Refund Advance Only

```json
{
  "reason": "Refund unused member advance",
  "apply_advance_to_dues": false,
  "write_off_remaining_dues": false,
  "refund_remaining_advance": true
}
```

### Apply Advance and Write Off Remaining Due

```json
{
  "reason": "Management-approved final settlement",
  "apply_advance_to_dues": true,
  "write_off_remaining_dues": true,
  "refund_remaining_advance": false
}
```

### Complete All Available Actions

```json
{
  "reason": "Complete member balance settlement",
  "apply_advance_to_dues": true,
  "write_off_remaining_dues": true,
  "refund_remaining_advance": true
}
```

## Errors

### Pending Deposits

Pending deposits must be approved, rejected, or cancelled before settlement.

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

### Insufficient Refund Account Balance

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
      "account_id": "acc_main_01",
      "available": 1000,
      "required": 3000
    }
  }
}
```

### Missing Advance Account

```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "A confirmed advance has no account and cannot be refunded"
  }
}
```

### Invalid Settlement Actions

```json
{
  "reason": "Final settlement",
  "apply_advance_to_dues": false,
  "write_off_remaining_dues": false,
  "refund_remaining_advance": false
}
```

This returns `400 VALIDATION` because at least one action must be enabled.

## Audit Trail

Settlement activity is available through:

```http
GET /v1/activity
Authorization: Bearer <access_token>
X-Project-Id: <project_id>
```

| Action | Meaning |
| --- | --- |
| `member.balance_settled` | Aggregate before/after settlement and adjustment summary |
| `member.advance_applied` | Advance allocated to a due; account balance unchanged |
| `member.advance_refunded` | Advance refunded and receiving account reduced |
| `member.due_written_off` | Principal or penalty waived with the settlement reason |
| `account_transaction.created` | Money-out account transaction created for an advance refund |

Each activity includes the actor, project, affected entity, reason, amounts, and timestamp.
