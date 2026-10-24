-- DSR shared JSON backend v1. Run in your own project's SQL Editor.
-- Creates EMPTY storage only. Does not import, delete, or change browser data.
-- No email has access until the project owner grants membership (02 instructions).
begin;

create table if not exists public.dsr_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'editor')),
  created_at timestamptz not null default now()
);

create table if not exists public.dsr_document (
  id text primary key check (id = 'dsr-main'),
  version bigint not null default 0 check (version >= 0),
  payload jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.dsr_save_receipts (
  request_id uuid primary key,
  user_id uuid not null,
  request_hash text not null,
  saved_version bigint not null,
  saved_at timestamptz not null default now()
);

insert into public.dsr_document(id) values ('dsr-main') on conflict do nothing;

alter table public.dsr_members enable row level security;
alter table public.dsr_document enable row level security;
alter table public.dsr_save_receipts enable row level security;

-- No direct client reads/writes, including membership or RLS-policy changes.
revoke all on public.dsr_members, public.dsr_document, public.dsr_save_receipts
  from public, anon, authenticated;

create or replace function public.dsr_read(p_known_version bigint default -1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.dsr_document; member_role text;
begin
  select role into member_role from public.dsr_members where user_id = auth.uid();
  if member_role is null then
    raise exception using errcode = '42501', message = 'DSR_ACCESS_DENIED';
  end if;
  select * into strict d from public.dsr_document where id = 'dsr-main';
  return jsonb_build_object('version', d.version, 'updated_at', d.updated_at,
    'role', member_role, 'unchanged', d.version = p_known_version,
    'payload', case when d.version = p_known_version then null else d.payload end);
end;
$$;

-- One request UUID represents ONE save intent, reused on timeout/retry.
-- expected_version is the version originally read, NEVER fetched just to force a save.
-- A stale writer fails atomically. Drafts must remain on the client for review.
create or replace function public.dsr_save(
  p_request_id uuid, p_expected_version bigint, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d public.dsr_document;
  receipt public.dsr_save_receipts;
  member_role text;
  request_hash text;
  records jsonb;
  record_count integer;
begin
  select role into member_role from public.dsr_members where user_id = auth.uid();
  if member_role is null then
    raise exception using errcode = '42501', message = 'DSR_ACCESS_DENIED';
  end if;
  if p_request_id is null or p_expected_version is null or p_expected_version < 0
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 8388608 then
    raise exception using errcode = '22023', message = 'DSR_INVALID_PAYLOAD';
  end if;
  if jsonb_typeof(p_payload->'records') is distinct from 'array'
     or jsonb_typeof(p_payload->'config') is distinct from 'object'
     or p_payload->>'format' is distinct from 'DSR_OFFLINE_BACKUP'
     or p_payload->'version' is distinct from '2'::jsonb then
    raise exception using errcode = '22023', message = 'DSR_INVALID_BACKUP';
  end if;
  records := p_payload->'records';
  record_count := jsonb_array_length(records);
  if record_count > 10000 or exists (
    select 1 from jsonb_array_elements(records) as r
    where jsonb_typeof(r) <> 'object'
      or jsonb_typeof(r->'__backendId') is distinct from 'string'
      or length(r->>'__backendId') not between 1 and 256
      or btrim(r->>'__backendId') = ''
      or jsonb_typeof(r->'record_type') is distinct from 'string'
      or length(r->>'record_type') not between 1 and 128
      or btrim(r->>'record_type') = ''
  ) or (select count(distinct r->>'__backendId') from jsonb_array_elements(records) r) <> record_count then
    raise exception using errcode = '22023', message = 'DSR_INVALID_RECORDS';
  end if;

  request_hash := encode(sha256(convert_to(jsonb_build_object(
    'expected_version', p_expected_version, 'payload', p_payload)::text, 'UTF8')), 'hex');
  -- Serialize save intents across accounts/tabs before checking the unique receipt.
  select * into strict d from public.dsr_document where id = 'dsr-main' for update;
  select * into receipt from public.dsr_save_receipts where request_id = p_request_id;
  if found then
    if receipt.user_id <> auth.uid() or receipt.request_hash <> request_hash then
      raise exception using errcode = '22023', message = 'DSR_REQUEST_ID_REUSED';
    end if;
    return jsonb_build_object('version', receipt.saved_version, 'replayed', true);
  end if;
  if d.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'DSR_VERSION_CONFLICT';
  end if;
  if d.version = 0 and member_role <> 'owner' then
    raise exception using errcode = '42501', message = 'DSR_OWNER_REQUIRED_FOR_IMPORT';
  end if;
  if record_count = 0 and coalesce(jsonb_array_length(d.payload->'records'), 0) > 0 then
    raise exception using errcode = '22023', message = 'DSR_REFUSE_EMPTY_REPLACEMENT';
  end if;
  update public.dsr_document set payload = p_payload, version = d.version + 1,
    updated_at = now(), updated_by = auth.uid() where id = 'dsr-main';
  insert into public.dsr_save_receipts(request_id, user_id, request_hash, saved_version)
    values (p_request_id, auth.uid(), request_hash, d.version + 1);
  return jsonb_build_object('version', d.version + 1, 'replayed', false);
end;
$$;

revoke all on function public.dsr_read(bigint) from public, anon;
revoke all on function public.dsr_save(uuid, bigint, jsonb) from public, anon;
grant execute on function public.dsr_read(bigint) to authenticated;
grant execute on function public.dsr_save(uuid, bigint, jsonb) to authenticated;

commit;

select 'DSR schema ready; no business data imported and no members granted yet' as status;
