-- ══════════════════════════════════════════════════════════
-- AssetTrack — Supabase Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor
-- ══════════════════════════════════════════════════════════

-- ── Extensions ────────────────────────────────────────────
create extension if not exists "uuid-ossp";

-- ══════════════════════════════════════════════════════════
-- TABLES
-- ══════════════════════════════════════════════════════════

-- Profiles (one row per Supabase auth user)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('admin', 'branch')),
  branch_name text,               -- null for admins, branch name for branch users
  created_at  timestamptz default now()
);

-- Branches
create table if not exists public.branches (
  name        text primary key,
  updated_at  timestamptz default now()
);

-- Assets
create table if not exists public.assets (
  id            text primary key,
  name          text not null,
  serial        text,
  category      text,
  branch_name   text references public.branches(name) on delete set null,
  status        text,
  location      text,
  assigned_to   text,
  cost          numeric,
  monthly       numeric,
  sales_tax     numeric,
  buyout_enhancement numeric,
  freight       numeric,
  hp            text,
  mileage       text,
  vendor        text,
  acquired_date text,
  lease_start   text,
  lease_end     text,
  notes         text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Requests
create table if not exists public.requests (
  id           text primary key,
  type         text not null,
  branch_name  text,
  asset_id     text,
  asset_name   text,
  description  text,
  status       text not null default 'pending',
  admin_note   text,
  created_at   timestamptz default now(),
  resolved_at  timestamptz
);

-- LRF Presets
create table if not exists public.lrf_presets (
  id         text primary key,
  name       text not null,
  lrf        numeric not null,
  updated_at timestamptz default now()
);

-- Settings (key-value store)
create table if not exists public.settings (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

-- ══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ══════════════════════════════════════════════════════════

alter table public.profiles    enable row level security;
alter table public.branches    enable row level security;
alter table public.assets      enable row level security;
alter table public.requests    enable row level security;
alter table public.lrf_presets enable row level security;
alter table public.settings    enable row level security;

-- Helper: is the current user an admin?
create or replace function public.is_admin()
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Helper: what branch is the current user?
create or replace function public.my_branch()
returns text
language sql stable
security definer
set search_path = public
as $$
  select branch_name from public.profiles where id = auth.uid();
$$;

-- ── Drop existing policies (safe re-run) ─────────────────
drop policy if exists "profiles: own read"        on public.profiles;
drop policy if exists "profiles: admin write"     on public.profiles;
drop policy if exists "branches: anon read"       on public.branches;
drop policy if exists "branches: all users read"  on public.branches;
drop policy if exists "branches: admin write"     on public.branches;
drop policy if exists "assets: branch read own"   on public.assets;
drop policy if exists "assets: admin write"       on public.assets;
drop policy if exists "requests: branch read own" on public.requests;
drop policy if exists "requests: branch insert own" on public.requests;
drop policy if exists "requests: branch update own" on public.requests;
drop policy if exists "requests: admin delete"    on public.requests;
drop policy if exists "lrf_presets: all read"     on public.lrf_presets;
drop policy if exists "lrf_presets: admin write"  on public.lrf_presets;
drop policy if exists "settings: all read"        on public.settings;
drop policy if exists "settings: admin write"     on public.settings;

-- ── profiles ──────────────────────────────────────────────
-- Users can read their own profile; admins can read all
create policy "profiles: own read"
  on public.profiles for select
  using (id = auth.uid() or public.is_admin());

-- Only admins can insert/update profiles (via Supabase dashboard or admin API)
create policy "profiles: admin write"
  on public.profiles for all
  using (public.is_admin());

-- ── branches ──────────────────────────────────────────────
-- Allow anyone (including unauthenticated) to read branch names for the login dropdown
create policy "branches: anon read"
  on public.branches for select
  using (true);

create policy "branches: all users read"
  on public.branches for select
  using (auth.role() = 'authenticated');

create policy "branches: admin write"
  on public.branches for all
  using (public.is_admin());

-- ── assets ────────────────────────────────────────────────
-- Branch users see only their branch's assets; admins see all
create policy "assets: branch read own"
  on public.assets for select
  using (
    public.is_admin()
    or branch_name = public.my_branch()
  );

create policy "assets: admin write"
  on public.assets for all
  using (public.is_admin());

-- ── requests ──────────────────────────────────────────────
-- Branch users see and insert only their own requests; admins see all
create policy "requests: branch read own"
  on public.requests for select
  using (
    public.is_admin()
    or branch_name = public.my_branch()
  );

create policy "requests: branch insert own"
  on public.requests for insert
  with check (branch_name = public.my_branch() or public.is_admin());

create policy "requests: branch update own"
  on public.requests for update
  using (branch_name = public.my_branch() or public.is_admin());

create policy "requests: admin delete"
  on public.requests for delete
  using (public.is_admin());

-- ── lrf_presets ───────────────────────────────────────────
create policy "lrf_presets: all read"
  on public.lrf_presets for select
  using (auth.role() = 'authenticated');

create policy "lrf_presets: admin write"
  on public.lrf_presets for all
  using (public.is_admin());

-- ── settings ──────────────────────────────────────────────
create policy "settings: all read"
  on public.settings for select
  using (auth.role() = 'authenticated');

create policy "settings: admin write"
  on public.settings for all
  using (public.is_admin());

-- ── audit_log ──────────────────────────────────────────────
create table if not exists public.audit_log (
  id          text primary key,
  action      text not null,
  entity_type text,
  entity_id   text,
  entity_name text,
  actor_role  text,
  branch_name text,
  details     text,
  created_at  timestamptz default now()
);

alter table public.audit_log enable row level security;

drop policy if exists "audit_log: admin read"           on public.audit_log;
drop policy if exists "audit_log: authenticated insert" on public.audit_log;

create policy "audit_log: admin read"
  on public.audit_log for select using (public.is_admin());

create policy "audit_log: authenticated insert"
  on public.audit_log for insert with check (auth.role() = 'authenticated');

-- Add target_branch_name to requests (for branch-to-branch transfers)
alter table public.requests add column if not exists target_branch_name text;

-- Add make/model/year + renewal_date to assets
alter table public.assets add column if not exists make         text;
alter table public.assets add column if not exists model        text;
alter table public.assets add column if not exists year         text;
alter table public.assets add column if not exists renewal_date text;

-- ══════════════════════════════════════════════════════════
-- INSPECTIONS (branch-submitted inspection reports)
-- Files stored in the "asset-files" bucket under inspections/ prefix
-- ══════════════════════════════════════════════════════════

create table if not exists public.inspections (
  id           text primary key,
  asset_id     text not null references public.assets(id) on delete cascade,
  branch_name  text not null,
  name         text not null,        -- original filename
  storage_path text not null,        -- path in asset-files bucket
  notes        text,
  uploaded_at  timestamptz default now()
);

alter table public.inspections enable row level security;

drop policy if exists "inspections: admin all"      on public.inspections;
drop policy if exists "inspections: branch insert"  on public.inspections;
drop policy if exists "inspections: branch read"    on public.inspections;

-- Admins can do everything
create policy "inspections: admin all"
  on public.inspections for all
  using (public.is_admin())
  with check (public.is_admin());

-- Branch users can insert inspections for assets assigned to their branch
create policy "inspections: branch insert"
  on public.inspections for insert
  with check (
    branch_name = public.my_branch()
    and exists (select 1 from public.assets where id = asset_id and branch_name = public.my_branch())
  );

-- Branch users can read their own inspections
create policy "inspections: branch read"
  on public.inspections for select
  using (branch_name = public.my_branch());

-- Storage: branch users can upload inspection files (inspections/ prefix)
drop policy if exists "storage asset-files: branch inspections upload" on storage.objects;
drop policy if exists "storage asset-files: branch inspections read"   on storage.objects;

create policy "storage asset-files: branch inspections upload"
  on storage.objects for insert
  with check (
    bucket_id = 'asset-files'
    and name like 'inspections/%'
    and auth.role() = 'authenticated'
  );

-- Branch users can download inspection files they submitted
create policy "storage asset-files: branch inspections read"
  on storage.objects for select
  using (
    bucket_id = 'asset-files'
    and name like 'inspections/%'
    and exists (
      select 1 from public.inspections i
      where i.storage_path = storage.objects.name
        and i.branch_name = (select branch_name from public.profiles where id = auth.uid())
    )
  );

-- ══════════════════════════════════════════════════════════
-- ASSET FILES (Supabase Storage metadata)
-- Before running: create a private bucket named "asset-files"
-- in Supabase Dashboard → Storage → New bucket
-- ══════════════════════════════════════════════════════════

create table if not exists public.asset_files (
  id           text primary key,
  asset_id     text not null references public.assets(id) on delete cascade,
  name         text not null,
  storage_path text not null,
  size         bigint,
  mime_type    text,
  uploaded_at  timestamptz default now()
);

alter table public.asset_files enable row level security;

drop policy if exists "asset_files: admin all"    on public.asset_files;
drop policy if exists "asset_files: branch read"  on public.asset_files;

-- Admins can do everything (explicit with check covers INSERT)
create policy "asset_files: admin all"
  on public.asset_files for all
  using (public.is_admin())
  with check (public.is_admin());

-- Branch users can read file records for assets assigned to their branch
create policy "asset_files: branch read"
  on public.asset_files for select
  using (
    exists (
      select 1 from public.assets
      where id = asset_id and branch_name = public.my_branch()
    )
  );

-- ── Storage bucket RLS (run after creating the "asset-files" bucket) ──
drop policy if exists "storage asset-files: admin all"   on storage.objects;
drop policy if exists "storage asset-files: branch read" on storage.objects;

-- Admins can upload, download, and delete in the bucket.
-- Inline the admin check to avoid search_path issues with the helper function.
create policy "storage asset-files: admin all"
  on storage.objects for all
  using (
    bucket_id = 'asset-files'
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  )
  with check (
    bucket_id = 'asset-files'
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

-- Branch users can download files for assets assigned to their branch
create policy "storage asset-files: branch read"
  on storage.objects for select
  using (
    bucket_id = 'asset-files'
    and exists (
      select 1 from public.asset_files af
      join public.assets a on a.id = af.asset_id
      where af.storage_path = storage.objects.name
      and a.branch_name = (select branch_name from public.profiles where id = auth.uid())
    )
  );

-- ══════════════════════════════════════════════════════════
-- SALE LISTINGS (branch-submitted for-sale listings)
-- ══════════════════════════════════════════════════════════

create table if not exists public.sale_listings (
  id           text primary key,
  asset_id     text,
  asset_name   text,
  asset_serial text,
  branch       text,
  asking_price numeric,
  condition    text,
  mileage      text,
  description  text,
  status       text not null default 'pending',  -- pending | active | pending_sold | sold
  created_at   timestamptz default now(),
  approved_at  timestamptz,
  sold_price   numeric,
  sold_date    text
);

alter table public.sale_listings enable row level security;

drop policy if exists "sale_listings: admin all"        on public.sale_listings;
drop policy if exists "sale_listings: branch read own"  on public.sale_listings;
drop policy if exists "sale_listings: branch insert own" on public.sale_listings;
drop policy if exists "sale_listings: branch update own" on public.sale_listings;

-- Admins can do everything
create policy "sale_listings: admin all"
  on public.sale_listings for all
  using (public.is_admin())
  with check (public.is_admin());

-- Branch users can read their own branch's listings
create policy "sale_listings: branch read own"
  on public.sale_listings for select
  using (branch = public.my_branch() or public.is_admin());

-- Branch users can insert their own listings
create policy "sale_listings: branch insert own"
  on public.sale_listings for insert
  with check (branch = public.my_branch() or public.is_admin());

-- Branch users can update their own listings (e.g. edit, cancel)
create policy "sale_listings: branch update own"
  on public.sale_listings for update
  using (branch = public.my_branch() or public.is_admin());

-- ══════════════════════════════════════════════════════════
-- INVOICES (admin-pushed monthly invoices to branches)
-- ══════════════════════════════════════════════════════════

create table if not exists public.invoices (
  id           text primary key,
  branch       text not null,
  period       text not null,
  items        jsonb,
  total        numeric,
  asset_count  integer,
  sent_at      timestamptz default now()
);

alter table public.invoices enable row level security;

drop policy if exists "invoices: admin all"       on public.invoices;
drop policy if exists "invoices: branch read own" on public.invoices;

-- Admins can do everything
create policy "invoices: admin all"
  on public.invoices for all
  using (public.is_admin())
  with check (public.is_admin());

-- Branch users can read their own invoices
create policy "invoices: branch read own"
  on public.invoices for select
  using (branch = public.my_branch() or public.is_admin());

-- ══════════════════════════════════════════════════════════
-- MIGRATIONS: Add new columns to existing tables
-- ══════════════════════════════════════════════════════════

-- Add monthly and new financial columns to assets
alter table public.assets add column if not exists monthly            numeric;
alter table public.assets add column if not exists sales_tax          numeric;
alter table public.assets add column if not exists buyout_enhancement numeric;
alter table public.assets add column if not exists freight            numeric;
alter table public.assets add column if not exists hp                 text;
alter table public.assets add column if not exists mileage            text;
