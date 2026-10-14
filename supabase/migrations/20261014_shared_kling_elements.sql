-- Account-wide reusable Kling elements for lodging reels.
-- Each element stores its independent photo copies and existing Kling element_id.
-- Shared records are strictly owned by the currently authenticated Supabase user.
create table if not exists public.lodging_reels_shared_elements (
  owner uuid not null references auth.users(id) on delete cascade,
  element_key text not null,
  name text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lodging_reels_shared_elements_pkey primary key (owner, element_key),
  constraint lodging_reels_shared_elements_name_unique unique (owner, name),
  constraint lodging_reels_shared_elements_key_check
    check (char_length(element_key) between 1 and 160),
  constraint lodging_reels_shared_elements_name_check
    check (char_length(name) between 1 and 20)
);
alter table public.lodging_reels_shared_elements enable row level security;
create policy lodging_reels_shared_elements_own
  on public.lodging_reels_shared_elements
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));
grant select, insert, update, delete on table public.lodging_reels_shared_elements to authenticated;
