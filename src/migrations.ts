export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ap_analyst','budget_owner','ap_approver','finance_admin','supplier_contact'))
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  version INTEGER NOT NULL,
  stale_after_seconds INTEGER NOT NULL,
  per_call_max_minor INTEGER NOT NULL,
  cumulative_cap_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  approved_providers TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, version)
);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  siren TEXT NOT NULL,
  vendor_state TEXT NOT NULL DEFAULT 'unverified' CHECK (vendor_state IN ('unverified','monitored','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  accepted_snapshot TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, siren)
);
CREATE INDEX idx_suppliers_tenant ON suppliers(tenant_id);

CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL CHECK (kind IN ('vendor_master','invoice')),
  filename TEXT,
  mapping TEXT NOT NULL,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_ok INTEGER NOT NULL DEFAULT 0,
  rows_failed INTEGER NOT NULL DEFAULT 0,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_imports_tenant ON imports(tenant_id, kind);

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id),
  tenant_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error','duplicate')),
  error_code TEXT,
  error_detail TEXT,
  supplier_id TEXT,
  invoice_id TEXT
);
CREATE INDEX idx_import_rows_import ON import_rows(import_id);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_ref TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  siren TEXT,
  issued_at TEXT NOT NULL,
  raw TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('linked','unlinked','error')),
  error_code TEXT,
  import_id TEXT REFERENCES imports(id),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, external_ref, import_id)
);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id, supplier_id);

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  supplier_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  trigger_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','consumed','closed')),
  refresh_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, trigger_key)
);
CREATE INDEX idx_triggers_supplier ON triggers(tenant_id, supplier_id, state);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  siren TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  source_effective_at TEXT,
  terms TEXT NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT
);
CREATE INDEX idx_snapshots_siren ON snapshots(tenant_id, siren);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  siren TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  source TEXT NOT NULL,
  source_effective_at TEXT,
  retrieved_at TEXT NOT NULL,
  snapshot_id TEXT REFERENCES snapshots(id)
);
CREATE INDEX idx_observations_siren ON observations(tenant_id, siren, field);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  siren TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  metadata TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','consumed','expired','rejected')),
  created_at TEXT NOT NULL
);

CREATE TABLE refreshes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  expected_version INTEGER NOT NULL,
  trigger_key TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  quote_id TEXT REFERENCES quotes(id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued','reserved','awaiting_source','review_ready','accepted','dismissed','blocked','reconciling','superseded')),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  block_reason TEXT,
  snapshot_id TEXT REFERENCES snapshots(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX idx_refreshes_supplier ON refreshes(tenant_id, supplier_id, state);

CREATE TABLE spend_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  refresh_id TEXT NOT NULL REFERENCES refreshes(id),
  listing_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  grant_ref TEXT NOT NULL,
  rail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN
    ('reserved','dispatched','settled','failed','reconciling','cancelled')),
  remote_ref TEXT,
  failure TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_spend_intents_refresh ON spend_intents(refresh_id);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  spend_intent_id TEXT NOT NULL REFERENCES spend_intents(id),
  remote_ref TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, remote_ref)
);

CREATE TABLE diffs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  refresh_id TEXT NOT NULL REFERENCES refreshes(id),
  field TEXT NOT NULL,
  accepted_value TEXT,
  observed_value TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('changed','unchanged','unknown')),
  source TEXT,
  source_effective_at TEXT,
  retrieved_at TEXT,
  rule_version TEXT NOT NULL,
  observation_id TEXT
);
CREATE INDEX idx_diffs_refresh ON diffs(refresh_id);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  refresh_id TEXT NOT NULL REFERENCES refreshes(id),
  expected_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('accept','dismiss')),
  reason TEXT,
  field_diffs TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_pending ON outbox(state, next_at);

CREATE TABLE exceptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  invoice_id TEXT REFERENCES invoices(id),
  detail TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','referred','closed')),
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(tenant_id, entity, entity_id);
`,
  },
];
