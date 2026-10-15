-- Correct only the old automatic weekly names. Preserve manually renamed schedules.
UPDATE schedules AS s
SET name = CONCAT(CEIL(EXTRACT(DAY FROM s.due_date) / 7.0)::integer, 'W ',
                  (ARRAY['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'])[EXTRACT(MONTH FROM s.due_date)::integer],
                  ' ', TO_CHAR(s.due_date, 'YY'))
FROM recurring_schedules AS r
WHERE s.recurring_schedule_id = r.id
  AND r.frequency = 'weekly'
  AND s.name = CONCAT('1W ',
                     (ARRAY['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'])[EXTRACT(MONTH FROM s.due_date)::integer],
                     ' ', TO_CHAR(s.due_date, 'YY'))
  AND EXTRACT(DAY FROM s.due_date) > 7;
