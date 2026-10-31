-- Quizzy · Supabase schema (run once in Supabase Dashboard > SQL Editor > New query > Run).
-- One table holds every per-user document (files, pages, quizzes, attempts, flashcards, reports) as JSONB.
-- Row Level Security makes each row visible/writable ONLY to its owner: students cannot read each other's data,
-- not even by calling the REST API directly with the public anon key.

create table if not exists public.kv (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  k          text        not null,
  kind       text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, k)
);
create index if not exists kv_user_kind on public.kv (user_id, kind);

alter table public.kv enable row level security;
drop policy if exists kv_select_own on public.kv;
drop policy if exists kv_insert_own on public.kv;
drop policy if exists kv_update_own on public.kv;
drop policy if exists kv_delete_own on public.kv;
create policy kv_select_own on public.kv for select to authenticated using (user_id = auth.uid());
create policy kv_insert_own on public.kv for insert to authenticated with check (user_id = auth.uid());
create policy kv_update_own on public.kv for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy kv_delete_own on public.kv for delete to authenticated using (user_id = auth.uid());

create or replace function public.kv_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists kv_touch on public.kv;
create trigger kv_touch before update on public.kv for each row execute function public.kv_touch();

-- Right to erasure: the signed-in user deletes their own account; kv rows go with it (ON DELETE CASCADE).
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  delete from auth.users where id = auth.uid();
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
