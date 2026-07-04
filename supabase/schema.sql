-- ============================================================================
-- Chadstone Valet — full database schema
-- Cloned (structure only, NO data) from the chatswood-valet project.
-- Run this ONCE in the new Chadstone project: Supabase Dashboard → SQL Editor.
-- Safe to re-run (idempotent-ish: uses IF NOT EXISTS / OR REPLACE / drop-recreate policies).
-- ============================================================================

-- ---------- TABLES ----------

create table if not exists public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb,
  updated_by text,
  updated_at timestamptz default now()
);

create table if not exists public.audit_log (
  id          bigserial primary key,
  user_name   text,
  action      text,
  entity_type text,
  entity_id   text,
  details     jsonb,
  created_at  timestamptz default now()
);

create table if not exists public.data_backups (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind       text not null default 'nightly',
  row_count  integer,
  payload    jsonb not null
);

create table if not exists public.entries (
  id                text primary key,
  ticket            text not null,
  time_in           timestamptz not null,
  time_out          timestamptz,
  bay               text,
  brand             text,
  model             text,
  colour            text,
  rego              text,
  name              text,
  phone             text,
  notes             text,
  attendant_in      text,
  attendant_out     text,
  parking_fee       numeric(10,2),
  valet_fee         numeric(10,2),
  total_fee         numeric(10,2),
  fee_overridden    boolean default false,
  tip               numeric(10,2),
  payment_status    text,
  payment_method    text,
  photo             text,
  gps               jsonb,
  pickup_requested  timestamptz,
  pickup_eta        timestamptz,
  created_by        text,
  updated_by        text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  discounts         jsonb default '[]'::jsonb,
  discount_total    numeric default 0,
  pickup_source     text,
  pickup_status     text,
  bag_status        text,
  bag_requested     timestamptz,
  bag_location      text,
  bag_count         integer,
  bag_assigned      text,
  bag_notes         text,
  bag_photo         text,
  bag_done_at       timestamptz,
  bag_in_car_by     text,
  shop_account      text,
  shop_cover        numeric,
  shop_settled_at   timestamptz,
  shop_settled_by   text,
  vip               boolean,
  square_payment    text,
  car_wash          jsonb,
  incident          jsonb,
  bag_shop_photo    text,
  bag_assigned_user text,
  bag_collecting_at timestamptz,
  bag_shop_photo_at timestamptz,
  bag_in_car_at     timestamptz,
  bag_jobs          jsonb,
  rating            smallint,
  rating_at         timestamptz,
  rating_comment    text
);

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  label      text,
  created_at timestamptz not null default now(),
  user_name  text
);

create table if not exists public.staff (
  username      text primary key,
  display_name  text not null,
  password_hash text not null,
  role          text default 'staff',
  is_active     boolean default true,
  created_at    timestamptz default now(),
  last_login    timestamptz
);

-- ---------- INDEXES ----------

create index if not exists idx_audit_log_created_at on public.audit_log using btree (created_at desc);
create index if not exists idx_entries_rego         on public.entries using btree (rego);
create index if not exists idx_entries_ticket       on public.entries using btree (ticket);
create index if not exists idx_entries_time_in      on public.entries using btree (time_in desc);
create index if not exists idx_entries_time_out     on public.entries using btree (time_out);
create index if not exists push_subscriptions_user_name_idx on public.push_subscriptions using btree (user_name);

-- ---------- ROW LEVEL SECURITY ----------
-- Enable RLS on every table. The dashboard runs as the `authenticated` role
-- (via the staff-auth shared session); the public ticket page reaches data
-- only through the SECURITY DEFINER functions further below.

alter table public.app_config         enable row level security;
alter table public.app_settings       enable row level security;
alter table public.audit_log          enable row level security;
alter table public.data_backups       enable row level security;
alter table public.entries            enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.staff              enable row level security;

-- `authenticated` gets full access on the operational tables.
-- (app_config and data_backups intentionally have NO policy → service-role only.)
drop policy if exists auth_full on public.app_settings;
create policy auth_full on public.app_settings       for all to authenticated using (true) with check (true);
drop policy if exists auth_full on public.audit_log;
create policy auth_full on public.audit_log          for all to authenticated using (true) with check (true);
drop policy if exists auth_full on public.entries;
create policy auth_full on public.entries            for all to authenticated using (true) with check (true);
drop policy if exists auth_full on public.push_subscriptions;
create policy auth_full on public.push_subscriptions for all to authenticated using (true) with check (true);
drop policy if exists auth_full on public.staff;
create policy auth_full on public.staff              for all to authenticated using (true) with check (true);

-- ---------- PII LOCKDOWN ----------
-- The anon key is PUBLIC (it ships in the GitHub Pages HTML). Hide ONLY the
-- password_hash column: revoke table-level SELECT, then grant column-level SELECT
-- on every other column. So the app can list staff (names/roles/last-login) but
-- neither anon nor authenticated can ever read password_hash (only the service
-- role, used by the staff-auth Edge Function, can).
revoke select on public.staff from anon, authenticated;
grant select (username, display_name, role, is_active, last_login, created_at)
  on public.staff to anon, authenticated;

-- ---------- FUNCTIONS (public ticket page + backups) ----------

create or replace function public.get_public_settings()
 returns table(handsfree boolean, pickup boolean)
 language sql stable security definer set search_path to 'public'
as $$
  select
    coalesce(((select value from public.app_settings where key = 'feature_handsfree') #>> '{}')::boolean, false) as handsfree,
    coalesce(((select value from public.app_settings where key = 'feature_pickup')    #>> '{}')::boolean, false) as pickup;
$$;

create or replace function public.get_ticket_status(p_id text, p_ticket text default null::text)
 returns table(id text, ticket text, rego text, time_in timestamptz, time_out timestamptz,
               pickup_requested timestamptz, pickup_eta timestamptz, pickup_source text,
               pickup_status text, bag_jobs jsonb, rating smallint, rating_comment text)
 language sql security definer set search_path to 'public'
as $$
  select id,ticket,rego,time_in,time_out,pickup_requested,pickup_eta,pickup_source,pickup_status,bag_jobs,rating,rating_comment
  from public.entries
  where (p_id is not null and id = p_id)
     or (p_id is null and p_ticket is not null and lower(ticket)=lower(p_ticket) and time_out is null)
  order by time_in desc limit 1;
$$;

create or replace function public.latest_backup_info()
 returns table(created_at timestamptz, row_count integer)
 language sql security definer set search_path to 'public'
as $$
  select created_at, row_count from public.data_backups order by created_at desc limit 1;
$$;

create or replace function public.make_data_backup(p_kind text default 'nightly'::text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare snap jsonb; n int;
begin
  select jsonb_build_object(
    'entries',      (select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) from public.entries e),
    'app_settings', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public.app_settings s),
    'staff',        (select coalesce(jsonb_agg(to_jsonb(st) - 'password_hash'), '[]'::jsonb) from public.staff st)
  ) into snap;
  n := jsonb_array_length(snap->'entries');
  insert into public.data_backups(kind, payload, row_count) values (coalesce(p_kind,'nightly'), snap, n);
  delete from public.data_backups where created_at < now() - interval '30 days';
  return jsonb_build_object('created_at', now(), 'entries', n);
end $$;

create or replace function public.request_bag(p_id text, p_location text, p_count integer)
 returns void language plpgsql security definer set search_path to 'public'
as $$
declare jobs jsonb; newjob jsonb;
begin
  select bag_jobs into jobs from public.entries where id=p_id and time_out is null;
  if not found then return; end if;
  jobs := coalesce(jobs, '[]'::jsonb);
  newjob := jsonb_build_object(
    'id', 'bj'||replace(gen_random_uuid()::text,'-',''), 'status','requested',
    'requested', to_jsonb(now()), 'location', coalesce(nullif(p_location,''),'Valet Desk'),
    'count', greatest(1, coalesce(p_count,1)), 'notes','', 'source','customer',
    'assigned',null,'assignedUser',null,'collectingAt',null,'shopPhoto',null,'shopPhotoAt',null,
    'inCarBy',null,'inCarAt',null,'photo',null,'doneAt',null);
  update public.entries set bag_jobs = jobs || jsonb_build_array(newjob) where id=p_id and time_out is null;
end $$;

create or replace function public.request_pickup(p_id text, p_eta timestamptz default null::timestamptz)
 returns integer language plpgsql security definer set search_path to 'public'
as $$
declare n int;
begin
  update public.entries
     set pickup_requested=now(), pickup_eta=p_eta, pickup_source='customer', pickup_status=null
   where id=p_id and time_out is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.submit_rating(p_id text, p_score integer, p_comment text default null::text)
 returns void language sql security definer set search_path to 'public'
as $$
  update public.entries set rating=greatest(1,least(5,p_score)), rating_at=now(),
    rating_comment=coalesce(p_comment, rating_comment)
  where id=p_id;
$$;

-- ---------- FUNCTION EXECUTE GRANTS ----------
-- Customer-facing (called from the public ticket page with the anon key):
grant execute on function public.get_public_settings()               to anon, authenticated, service_role;
grant execute on function public.get_ticket_status(text, text)       to anon, authenticated, service_role;
grant execute on function public.request_bag(text, text, integer)    to anon, authenticated, service_role;
grant execute on function public.request_pickup(text, timestamptz)   to anon, authenticated, service_role;
grant execute on function public.submit_rating(text, integer, text)  to anon, authenticated, service_role;
-- Staff/service only:
revoke execute on function public.latest_backup_info()   from anon;
revoke execute on function public.make_data_backup(text) from anon;
grant  execute on function public.latest_backup_info()   to authenticated, service_role;
grant  execute on function public.make_data_backup(text) to authenticated, service_role;

-- ============================================================================
-- AFTER running this file, do the steps in SUPABASE-SETUP.md:
--   1. Create the shared-login row in app_config (for staff-auth).
--   2. Deploy the staff-auth Edge Function (and optional feature functions).
--   3. Paste the Project URL + anon key into index_v2.html (const CENTRE).
-- ============================================================================
