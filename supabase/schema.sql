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
  lrf           numeric,
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
as $$
  select branch_name from public.profiles where id = auth.uid();
$$;

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

-- ══════════════════════════════════════════════════════════
-- SEED: Default LRF presets (optional — app seeds these too)
-- ══════════════════════════════════════════════════════════
insert into public.lrf_presets (id, name, lrf) values
  ('p1', 'Standard', 0.0185),
  ('p2', 'Promo',    0.0200),
  ('p3', 'Special',  0.0165)
on conflict (id) do nothing;
