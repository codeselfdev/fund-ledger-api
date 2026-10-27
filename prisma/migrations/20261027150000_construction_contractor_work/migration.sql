-- Existing lump-sum agreements and bills retain their current behaviour.
ALTER TABLE construction_contracts
 ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'lump_sum',
 ADD COLUMN work_terms JSONB,
 ADD COLUMN work_items JSONB,
 ADD COLUMN certified_quantities JSONB,
 ADD COLUMN agreement_file_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
 ADD COLUMN decided_by_id TEXT,
 ADD COLUMN decided_at TIMESTAMP(3);
ALTER TABLE construction_running_bills
 ADD COLUMN measurement_lines JSONB,
 ADD COLUMN evidence_file_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE construction_contracts DROP CONSTRAINT construction_contract_values;
ALTER TABLE construction_contracts ADD CONSTRAINT construction_contract_values CHECK (
 amount > 0 AND revised_amount >= certified_amount AND certified_amount >= 0 AND retention_bps BETWEEN 0 AND 10000
 AND advance_paid >= advance_recovered AND advance_recovered >= 0 AND retention_held >= retention_released AND retention_released >= 0
 AND ((billing_mode='lump_sum' AND status IN ('active','suspended','closed') AND work_items IS NULL)
 OR (billing_mode='item_rate' AND revised_amount=amount
   AND work_items IS NOT NULL AND jsonb_typeof(work_items)='array' AND jsonb_array_length(work_items) BETWEEN 1 AND 100
   AND work_terms IS NOT NULL AND jsonb_typeof(work_terms)='object'
   AND certified_quantities IS NOT NULL AND jsonb_typeof(certified_quantities)='object'
   AND ((status='pending' AND decided_by_id IS NULL AND decided_at IS NULL)
     OR (status IN ('active','suspended','closed','rejected') AND decided_by_id IS NOT NULL AND decided_by_id<>created_by_id AND decided_at IS NOT NULL))
   AND (status NOT IN ('pending','rejected') OR (certified_amount=0 AND advance_paid=0 AND retention_held=0))))
);
ALTER TABLE construction_running_bills DROP CONSTRAINT construction_running_bill_values;
ALTER TABLE construction_running_bills ADD CONSTRAINT construction_running_bill_values CHECK (
 (current_certified > 0 OR (current_certified=0 AND measurement_lines IS NOT NULL AND jsonb_typeof(measurement_lines)='array' AND jsonb_array_length(measurement_lines)>0))
 AND (measurement_lines IS NULL OR jsonb_typeof(measurement_lines)='array')
 AND cumulative_certified::bigint=previous_certified::bigint+current_certified AND previous_certified>=0
 AND retention>=0 AND advance_recovery>=0 AND wastage_deduction>=0
 AND net_payable::bigint=current_certified::bigint-retention-advance_recovery-wastage_deduction
 AND paid_amount BETWEEN 0 AND net_payable AND status IN ('pending','approved','rejected')
);
