# Fund Nesta privacy and Google Play release

Prepared 11 October 2026 for Appsnesta, Mirpur DOHS, Dhaka, Bangladesh. Privacy contact: hello@appnesta.com. Verified deletion requests must be fulfilled within 30 days under the policy approved by the owner.

## Deliverables

- `Fund-Nesta-Privacy-Policy-and-Terms.docx` contains the privacy policy, terms of service, and account deletion instructions.
- `src/legal/policies.json` is the shared policy source used inside the app and to generate the website pages and Word document.
- The website files are in `/Users/octolaneai/Desktop/codebase/appsnesta/appnesta/fund-nesta/`; the homepage links to them.
- The app exposes policies before sign-in, in every profile, during onboarding, and when a subscription is blocked. Policies can be read without a network connection.
- The API records authenticated deletion requests in a durable queue. It does not automatically erase an account. A responsible operator must process the queue and email requests and perform actual deletion.

## URLs for Play Console after deployment

| Field | URL |
| --- | --- |
| Privacy policy | https://appnesta.com/fund-nesta/privacy-policy.html |
| Account deletion | https://appnesta.com/fund-nesta/delete-account.html |
| Terms of service | https://appnesta.com/fund-nesta/terms.html |

Publish these HTML pages over HTTPS without sign-in, geographic restrictions, editable document access, or a PDF-only response. Verify the URLs return the intended pages on the public domain before entering them in Play Console. The local files and preview are not publication.

## API rollout

The API source changes are in `/Users/octolaneai/Desktop/codebase/fund-ledger`. Build and deploy that service through its existing release process. Apply `prisma/migrations/20261011020000_add_account_deletion_requests/migration.sql` through the normal Prisma deployment process. No production database migration or deployment was executed while preparing this package.

```sh
npx prisma migrate deploy
npx prisma generate
npm run build
```

Use these commands in the intended deployment environment with the correct database configuration. `migrate deploy` applies all outstanding migrations, so review the pending migrations before running it. Do not point a local test at the production database.

Authenticated API routes:

- `POST /v1/auth/account-deletion-requests` accepts `{}` and returns `id`, `status`, `requested_at`, `due_at`, and `support_email`. User and tenant identity come from the verified session. Repeated requests preserve the original reference and deadline.
- `GET /v1/auth/account-deletion-requests/current` returns the signed-in account's request or `null`.
- These routes do not require a project role or active subscription. The normal project routes retain their membership requirements. People unable to sign in can email support.

After deployment, test with a designated disposable account: submit, retry, verify the queue, fulfill deletion, and confirm access is revoked and eligible associated data is removed. Do not use a real member account as a deletion test. A successful request response alone does not prove deletion fulfillment.

## Daily deletion operation

Assign a privacy request owner and backup. Monitor hello@appnesta.com and check pending API requests every working day from an authorized server terminal:

```sh
npm run privacy:requests:prod
```

This command prints account contact information. Keep its output restricted to authorized staff. It orders pending requests by deadline and identifies overdue requests; it does not send emails or delete data.

1. For app requests, identify the signed-in account from the queue's user and tenant identifiers. For emailed requests, verify ownership through the registered email or phone with proportionate checks. Do not demand unrelated identity documents or require app reinstallation.
2. Confirm which accounts the person wants deleted, including accounts across organizations if requested. Do not disclose another person's accounts. An organization's staff cannot authorize deletion of someone else's account without a valid basis.
3. Identify linked personal data before changes. Include User contact fields, credentials and device token; sessions; project memberships; linked Member and MemberProfile details; nominee fields; personal uploads and member documents; notifications; poll/event participation; notices; follow-up notes; activity and other records with embedded personal information. Search by both stable account identifiers and associated member identifiers, not just email.
4. Document any specific lawful retention reason and period for transaction, receipt, approval, audit, dispute, or fraud records. A generic wish to keep an audit trail does not justify retaining every personal field. Remove unnecessary identifiers and restrict retained records. Do not erase another person's independent records or an entire organization's ledger.
5. Revoke access and remove or irreversibly anonymize eligible personal information. `isActive=false`, membership removal, or changing the visible name alone is insufficient. After migration `20261016140000_preserve_history_on_user_deletion`, shared events, polls, notices, call logs, commitments and reminders survive user deletion with a null creator/sender. The linked-organization identity root still blocks deletion while other accounts depend on it; review those accounts before deleting the root. Deleting a User row alone does not fulfill the full personal-data cleanup described here.
6. Remove eligible file objects from the actual storage provider as well as file metadata and links. Include identity documents and profile photos. Coordinate Firebase Authentication and installation/token deletion where applicable. Do not remove a shared provider identity without checking whether it serves another valid account.
7. Record the real backup expiry period and ensure restore procedures reapply completed deletions. Explain backup and provider deletion periods to the requester. Do not promise immediate deletion from Firebase backup systems.
8. Verify that the person can no longer authenticate and eligible data and files are gone. Explain any retained categories, basis, period, or necessary extension to the requester. Complete within 30 days of the verified request.
9. Only after fulfillment, update the queue record to `completed`, record `completed_at`, and add a minimal `resolution_note` referencing completion and specific retention decisions. This is an operator action in the restricted database administration process. Do not put identity documents, passwords, OTPs, or unnecessary contact details in the note. Apply an approved retention period to the request/completion record itself.

## Data safety form preparation

These are categories evidenced by the reviewed app and API features, not a submitted or certified Play Console declaration. Complete the form for all app versions available to users, including SDK and backend handling. Optional collection still needs disclosure.

| Google Play category to assess | Observed information | Purpose and collection conditions |
| --- | --- | --- |
| Personal info | Name, email, phone, account IDs, addresses, date of birth, occupation, national ID and nominee information | Account management and app functionality. Some fields and records are optional or supplied by organization staff. Government IDs may fall under Other personal info. |
| Financial info | Contributions, payment history, bank details, dues, invoices, expenses and receipts | App functionality and accounting records. Assess User payment info and Purchase history for the enabled flows. Do not claim collection of card credentials unless a deployed flow actually collects them. |
| Contacts | A contact's selected name and phone submitted with a form | Optional app functionality. Only selected details are submitted, not the entire address book. |
| Photos and videos | Profile photos, selected receipt/payment proof/expense/project images | Optional app functionality. The reviewed upload UI selects images. Do not declare video collection unless another deployed feature collects it. |
| Files and docs | Uploaded member documents and proofs | Optional app functionality; files may contain personal, identity or financial information. |
| App activity | Poll/event responses, follow-up notes, promises, notices, approvals, account/project activity | App functionality, organizational records, and fraud/security controls as applicable. Assess Other user-generated content and Other actions. Manual call notes are not audio recordings. |
| Device or other IDs | FCM registration tokens and Firebase installation identifiers | Notifications, app functionality and provider security. |
| Diagnostics and other technical data | IP/user-agent and service logs, plus SDK data in use | Check provider documentation and actual configuration before selecting a category or marking data ephemeral. IP collection does not by itself mean the app requests location. |

Use https://support.google.com/googleplay/android-developer/answer/10787469 for the definitions of collection, sharing, ephemeral processing, optional collection, and permitted exceptions. Assess sharing separately for service providers, organization recipients, messaging integrations and user-initiated transfers. A service-provider exception can affect the Data safety sharing label without removing the privacy-policy disclosure duty. Do not simply select “no sharing” because data is not sold.

Verify all transmissions, including provider sign-in, files, redirects and notification endpoints, use appropriate encryption before claiming every collected type is encrypted in transit. Check Firebase disclosures at https://firebase.google.com/support/privacy. No advertising SDK, Google Analytics initialization or Firebase Crashlytics initialization was found in the reviewed app; reconfirm this for the actual release.

## Remaining release work

- Have an appropriately qualified legal reviewer confirm the operator identity, governing law, retention grounds, organization/controller arrangements, lawful basis, international processing, and terms for the actual markets served. The policy does not invent a fixed statutory accounting retention period.
- Record the actual hosting/storage providers, storage locations, backup expiry periods, security/log retention, and legally required financial retention periods. Align operations and policy text before publication; update the shared source if the reviewed facts change.
- Confirm the mailbox receives messages and is monitored. Ensure the deletion owner can meet the approved 30-day commitment and can perform actual data/file/provider deletion.
- Deploy the website and API migration/service, then verify public URLs and the complete deletion workflow.
- The APK's release variant currently uses the existing debug signing key. Configure a production upload/signing key and build the signed AAB required for a new Play release. Increment the version code for subsequent releases. Do not replace the key of an already published app arbitrarily.
- Complete Data safety, target audience, content rating, financial features and app access declarations as applicable. Align the 18+ policy audience with the real product and Play settings. Provide review access to protected functionality through the Play Console app-access process.
- Verify the final merged manifest: camera, contacts and notifications are feature permissions; unused microphone, broad media/storage and overlay permissions were removed for this build. Exercise camera capture, photo picking, contact picking and notifications on the release APK.
- Google Play approval depends on the submitted app, accurate declarations, live resources and operational behavior; preparing documents alone does not guarantee approval.

## Sources reviewed

- Google Play User Data policy: https://support.google.com/googleplay/android-developer/answer/10144311
- Google Play Data safety guidance: https://support.google.com/googleplay/android-developer/answer/10787469
- Google Play Photo and Video Permissions guidance: https://support.google.com/googleplay/android-developer/answer/15800983
- Firebase privacy and data processing information: https://firebase.google.com/support/privacy

## Updating the policies

Edit `src/legal/policies.json`, run `docs/legal/generate_documents.py` with Python and python-docx, review the rendered document and generated pages, copy `docs/legal/site/fund-nesta/` to the website's `fund-nesta/` directory, and rebuild the app. Keep the effective date and all published versions consistent.
