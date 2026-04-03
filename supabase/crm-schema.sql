-- ============================================================
-- CRM AI Agents Platform — Database Schema
-- Run this in Supabase SQL Editor after the main schema.sql
-- ============================================================

-- Multi-tenant: one row per service business client
CREATE TABLE IF NOT EXISTS crm_tenants (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL,
  slug                     text UNIQUE NOT NULL,
  phone                    text,
  twilio_phone_number      text,
  twilio_account_sid       text,
  twilio_auth_token        text,
  stripe_secret_key        text,
  stripe_publishable_key   text,
  ai_enabled               boolean DEFAULT false,
  ai_system_prompt         text,
  missed_call_sms_template text DEFAULT 'Hi! Sorry we missed your call. We''ll get back to you shortly. — {business_name}',
  business_hours           jsonb DEFAULT '{"mon":["08:00","18:00"],"tue":["08:00","18:00"],"wed":["08:00","18:00"],"thu":["08:00","18:00"],"fri":["08:00","18:00"],"sat":null,"sun":null}',
  primary_color            text DEFAULT '#2563eb',
  logo_url                 text,
  created_at               timestamptz DEFAULT now()
);

-- Internal CRM staff users (links Supabase auth.users to a tenant)
CREATE TABLE IF NOT EXISTS crm_users (
  id          uuid PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  tenant_id   uuid REFERENCES crm_tenants ON DELETE CASCADE NOT NULL,
  role        text CHECK (role IN ('admin','staff')) DEFAULT 'staff',
  full_name   text,
  created_at  timestamptz DEFAULT now()
);

-- Contacts / leads
CREATE TABLE IF NOT EXISTS crm_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid REFERENCES crm_tenants ON DELETE CASCADE NOT NULL,
  name        text,
  phone       text,
  email       text,
  status      text CHECK (status IN ('lead','prospect','customer','inactive')) DEFAULT 'lead',
  source      text,   -- 'missed_call', 'ai_call', 'web_form', 'manual'
  notes       text,
  tags        text[],
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Jobs / projects
CREATE TABLE IF NOT EXISTS crm_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES crm_tenants ON DELETE CASCADE NOT NULL,
  contact_id    uuid REFERENCES crm_contacts ON DELETE SET NULL,
  title         text NOT NULL,
  description   text,
  status        text CHECK (status IN ('lead','quoted','booked','in_progress','completed','invoiced','paid','cancelled')) DEFAULT 'lead',
  scheduled_at  timestamptz,
  completed_at  timestamptz,
  address       text,
  amount        numeric(10,2),
  assigned_to   uuid REFERENCES crm_users ON DELETE SET NULL,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- Activity timeline (calls, SMS, notes, status changes, payments)
CREATE TABLE IF NOT EXISTS crm_activities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid REFERENCES crm_tenants ON DELETE CASCADE NOT NULL,
  contact_id   uuid REFERENCES crm_contacts ON DELETE SET NULL,
  job_id       uuid REFERENCES crm_jobs ON DELETE SET NULL,
  type         text CHECK (type IN ('call','sms','note','status_change','payment')),
  direction    text CHECK (direction IN ('inbound','outbound')),
  summary      text,
  body         text,       -- full SMS body or call transcript JSON
  duration_sec int,
  created_at   timestamptz DEFAULT now()
);

-- Invoices
CREATE TABLE IF NOT EXISTS crm_invoices (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid REFERENCES crm_tenants ON DELETE CASCADE NOT NULL,
  job_id                  uuid REFERENCES crm_jobs ON DELETE SET NULL,
  contact_id              uuid REFERENCES crm_contacts ON DELETE SET NULL,
  amount                  numeric(10,2) NOT NULL,
  status                  text CHECK (status IN ('draft','sent','paid','overdue')) DEFAULT 'draft',
  due_date                date,
  paid_at                 timestamptz,
  stripe_invoice_id       text,
  stripe_customer_id      text,
  hosted_invoice_url      text,
  line_items              jsonb DEFAULT '[]',
  created_at              timestamptz DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS crm_contacts_tenant_idx    ON crm_contacts (tenant_id);
CREATE INDEX IF NOT EXISTS crm_contacts_phone_idx     ON crm_contacts (phone);
CREATE INDEX IF NOT EXISTS crm_jobs_tenant_idx        ON crm_jobs (tenant_id);
CREATE INDEX IF NOT EXISTS crm_jobs_contact_idx       ON crm_jobs (contact_id);
CREATE INDEX IF NOT EXISTS crm_activities_tenant_idx  ON crm_activities (tenant_id);
CREATE INDEX IF NOT EXISTS crm_activities_contact_idx ON crm_activities (contact_id);
CREATE INDEX IF NOT EXISTS crm_invoices_tenant_idx    ON crm_invoices (tenant_id);
CREATE INDEX IF NOT EXISTS crm_tenants_phone_idx      ON crm_tenants (twilio_phone_number);

-- ── Row Level Security ────────────────────────────────────────────────────

ALTER TABLE crm_tenants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_jobs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_invoices   ENABLE ROW LEVEL SECURITY;

-- Helper: get the calling user's tenant
CREATE OR REPLACE FUNCTION crm_my_tenant()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT tenant_id FROM crm_users WHERE id = auth.uid()
$$;

-- Helper: check if calling user is a CRM admin
CREATE OR REPLACE FUNCTION crm_is_admin()
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM crm_users WHERE id = auth.uid() AND role = 'admin'
  )
$$;

-- crm_tenants: users can read their own tenant; admins can update
CREATE POLICY "crm_tenants_read"   ON crm_tenants FOR SELECT USING (id = crm_my_tenant());
CREATE POLICY "crm_tenants_update" ON crm_tenants FOR UPDATE USING (id = crm_my_tenant() AND crm_is_admin());

-- crm_users: see own tenant's users; admins can insert/delete
CREATE POLICY "crm_users_select" ON crm_users FOR SELECT USING (tenant_id = crm_my_tenant());
CREATE POLICY "crm_users_insert" ON crm_users FOR INSERT WITH CHECK (tenant_id = crm_my_tenant() AND crm_is_admin());
CREATE POLICY "crm_users_delete" ON crm_users FOR DELETE USING (tenant_id = crm_my_tenant() AND crm_is_admin());

-- crm_contacts: full CRUD scoped to tenant
CREATE POLICY "crm_contacts_all" ON crm_contacts
  FOR ALL USING (tenant_id = crm_my_tenant())
  WITH CHECK (tenant_id = crm_my_tenant());

-- crm_jobs: full CRUD scoped to tenant
CREATE POLICY "crm_jobs_all" ON crm_jobs
  FOR ALL USING (tenant_id = crm_my_tenant())
  WITH CHECK (tenant_id = crm_my_tenant());

-- crm_activities: full CRUD scoped to tenant
CREATE POLICY "crm_activities_all" ON crm_activities
  FOR ALL USING (tenant_id = crm_my_tenant())
  WITH CHECK (tenant_id = crm_my_tenant());

-- crm_invoices: full CRUD scoped to tenant
CREATE POLICY "crm_invoices_all" ON crm_invoices
  FOR ALL USING (tenant_id = crm_my_tenant())
  WITH CHECK (tenant_id = crm_my_tenant());

-- ── updated_at triggers ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER crm_contacts_updated_at BEFORE UPDATE ON crm_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER crm_jobs_updated_at BEFORE UPDATE ON crm_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
