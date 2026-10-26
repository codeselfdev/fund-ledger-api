-- One lifetime App Guide allowance per linked user identity, independent of projects and plans.
-- Store no questions, financial records, or unrestricted model output.
CREATE TABLE app_guide_requests (
  identity_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  request_key UUID NOT NULL,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  authorization_hash TEXT NOT NULL,
  plan JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (identity_user_id, request_key)
);
