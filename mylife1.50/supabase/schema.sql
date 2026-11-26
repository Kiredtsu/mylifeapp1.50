create table if not exists public.mylife_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.mylife_data enable row level security;

revoke all on public.mylife_data from anon;
grant select, insert, update, delete on public.mylife_data to authenticated;

drop policy if exists "Users can read their own MyLife data" on public.mylife_data;
drop policy if exists "Users can insert their own MyLife data" on public.mylife_data;
drop policy if exists "Users can update their own MyLife data" on public.mylife_data;
drop policy if exists "Users can delete their own MyLife data" on public.mylife_data;

create policy "Users can read their own MyLife data"
  on public.mylife_data for select
  using (auth.uid() = user_id);

create policy "Users can insert their own MyLife data"
  on public.mylife_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own MyLife data"
  on public.mylife_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own MyLife data"
  on public.mylife_data for delete
  using (auth.uid() = user_id);
