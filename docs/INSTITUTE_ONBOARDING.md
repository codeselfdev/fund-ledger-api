# Institute setup and Nesta guidance

Open **Office → Get started**. The Home page also offers **Continue institute setup** on web and mobile. Nesta provides free English/Bangla steps on each page, and “What should I do next?” checks saved setup records. Ask Nesta can select these same curated articles when the existing App Guide AI service is configured; no new AI configuration or credits are required to read the guides.

1. Review Institute settings: school, coaching or training, academic year, timezone and days off.
2. Classes / courses: add each class section, coaching batch or training course batch. Use a distinct name for each section, such as `Class 8 A`; name + academic year identifies a group.
3. Subjects / modules: enter the subject code and assessment components totaling 100 marks.
4. Teachers: enter sign-in mobiles with country codes and assign classes and subjects. A subject assignment permits mark entry; class-teacher access permits leave decisions. One import row represents one assignment.
5. Students / trainees: enter or import rosters, optionally linking a student's own sign-in mobile. Guardian links are reviewed separately on the saved student's card.
6. Routine: select a class, then create sessions or import its complete weekly template. Prepare teacher assignments first.
7. Review People & roles for admin/accountant access, then fees and a default receiving account when needed.

The checklist checks current-year groups. “Records saved” means records exist; it does not certify that a full roster, all subject assignments or every weekly session has been entered. Teachers, students and guardians retain their existing scoped portals.

## Import workflow

Every directory and class routine has **Download sample CSV** and **Choose file & review**. Samples contain fictional placeholders. Downloading a sample never inserts data. Replace the sample rows before importing.

CSV, XLSX and XLS are accepted: one visible worksheet, at most 5 MB, 1,000 directory rows or 100 routine sessions per file. Keep the sample headings, including optional columns. Leave optional values blank. Keep mobile numbers, rolls and codes as text to preserve `+` and leading zeroes; replace spreadsheet formulas with plain values.

- Classes: `name, section, academic_year`
- Subjects: `name, code, pass_percent, written, mcq, practical`. The nonblank component maxima must total 100; leaving every component blank defaults to Written 100.
- Teachers: `name, mobile, group_name, academic_year, subject_code, is_class_teacher`. Use `true`/`false`. A teacher may repeat on distinct assignments; names must agree for the same mobile.
- Students: `name, roll_no, student_code, mobile, group_name, academic_year`. Mobile and student code are optional. Roll is unique within a class; student code is unique across the project.
- Routine: `weekday, starts_at, ends_at, subject_code, teacher_mobile, room, effective_from, effective_to`. Use full English weekdays, 24-hour `HH:MM`, and `YYYY-MM-DD` dates. Room and end date are optional. Choose the destination class in the page.

The server previews every row against saved records. Fix highlighted rows in the source file and choose the corrected file. Exact existing matches are kept. Conflicting student identities, classes or mark schemes are flagged rather than overwritten. Imports never transfer students or send invitations.

Review rows and enable **Confirm reviewed import** before committing. Each batch is atomic and uses a retry-safe idempotency key. Changes to saved data after preview require another review. For uncertain network outcomes, retry the unchanged import so the original receipt can be replayed.

Routine imports **replace the selected class's entire routine**, including future sessions. The preview and save both reject class/teacher overlaps and stale class revisions. Other classes' routines are preserved. Teachers must already belong to the selected class. The manual editor also loads future sessions and lets the office set effective dates.

## Samples

The frontend files in `FundLedgerMobile/docs/institute/samples/` form a consistent fictional school example: Class 8 A → MATH → Sample Teacher → Sample Student → Sunday routine. They are documentation fixtures; the app's downloads use the selected project's current year and selected group. Review sample effective dates before reuse.

## Backend and rollout

Preview: `POST /v1/institute/imports/:kind/preview`. Commit: `POST /v1/institute/imports/:kind` with `preview_hash` and an `Idempotency-Key` UUID. Kinds: `groups`, `subjects`, `teachers`, `students`, `routine`. Both require Office access and the corresponding write permission. Preview has no side effects; commit revalidates inside the existing serializable transaction.

These flows reuse the existing `institute_` tables; no additional table or migration is needed for this update. The initial Institute migration is still required before enabling `INSTITUTE_ENABLED`. No migration or production deployment was performed here.
