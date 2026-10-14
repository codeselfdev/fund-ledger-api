# Account setup

New bank accounts require `bank_name`, `account_name` (bank's account-holder name), `account_number` and `branch_name`. Both `POST /accounts` and `POST /onboarding/accounts` use the shared account schema. Whitespace-only and omitted fields fail with 400/VALIDATION before any account/default/opening-balance writes.

`name` is the project account-list label, distinct from `account_name`. Bank callers can omit `name`; the API suggests `bank · branch · last four digits` (at most 64 characters). A custom label must be 2–64 characters. Cash accounts require `name` and ignore bank-only fields. Account numbers remain strings, including leading zeros and any bank formatting. Opening balance is an optional whole BDT amount from 0 through 2,147,483,647, defaulting to zero.

Responses return `bankName`, `accountName`, `accountNumber`, `branchName`. The additive migration keeps these nullable so pre-existing accounts keep their IDs, balances and history; new bank writes enforce all four through API validation. Old bank accounts remain readable even without metadata.

## Rollout

Apply `prisma/migrations/20261014140000_account_bank_details/migration.sql` using `npx prisma migrate deploy`, then regenerate Prisma (`npm run prisma:generate`), build and deploy the API. Release the mobile app after the updated API is active; older APIs strip unknown fields and would not persist bank details. This source change does not itself migrate or deploy a database.

Validate with `npm run build` and `node --test tests/account-bank-setup.test.mjs`. The route tests use an isolated Prisma fixture and exercise both create endpoints, required fields, cash isolation, exact account numbers, labels, defaults, opening entries, authorization, workspace scope and legacy reads.
