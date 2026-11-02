CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','staff')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS app_secrets (
  key TEXT PRIMARY KEY,
  value_encrypted TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draft_orders (
  id UUID PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  contact_name TEXT NOT NULL,
  delivery_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','processing','created','failed','cancelled')),
  bexio_order_id INTEGER,
  bexio_order_nr TEXT,
  bexio_delivery_id INTEGER,
  bexio_delivery_nr TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  error_message TEXT,
  created_by BIGINT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draft_order_items (
  id BIGSERIAL PRIMARY KEY,
  draft_order_id UUID NOT NULL REFERENCES draft_orders(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL,
  article_name TEXT NOT NULL,
  quantity NUMERIC(14,6) NOT NULL CHECK (quantity > 0),
  unit_name TEXT,
  bexio_position_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES app_users(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata JSONB,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS bexio_text_position_id INTEGER;
ALTER TABLE draft_orders ADD COLUMN IF NOT EXISTS bexio_delivery_issued BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_draft_orders_status_date ON draft_orders(status, delivery_date DESC);
CREATE INDEX IF NOT EXISTS idx_draft_order_items_draft ON draft_order_items(draft_order_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);


CREATE TABLE IF NOT EXISTS product_visibility (
  article_id INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  display_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by BIGINT REFERENCES app_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_visibility_enabled_sort ON product_visibility(enabled, sort_order, article_id);


-- v1.15 Monatsauswertung / manuelle Umsätze
ALTER TABLE draft_order_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14,4);

CREATE TABLE IF NOT EXISTS manual_sales (
  id UUID PRIMARY KEY,
  sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
  category TEXT NOT NULL CHECK (category IN ('TWINT','Märit Bern','Märit Thun','Bar')),
  amount_chf NUMERIC(14,2) NOT NULL CHECK (amount_chf >= 0),
  note TEXT,
  article_id INTEGER,
  article_name TEXT,
  quantity NUMERIC(14,6),
  unit_name TEXT,
  created_by BIGINT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_manual_sales_date ON manual_sales(sale_date DESC);


-- v1.16 Märit Bern / Lohnabrechnung
ALTER TABLE manual_sales ADD COLUMN IF NOT EXISTS salesperson TEXT;
ALTER TABLE manual_sales ADD COLUMN IF NOT EXISTS cash_chf NUMERIC(14,2);
ALTER TABLE manual_sales ADD COLUMN IF NOT EXISTS twint_chf NUMERIC(14,2);
