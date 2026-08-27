-- Total optional collaboration relay. The server stores opaque, signed ciphertext only.
create table if not exists public.total_sync_workspaces (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.total_sync_members (
  workspace_id uuid not null references public.total_sync_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.total_sync_envelopes (
  relay_id bigint generated always as identity primary key,
  workspace_id uuid not null references public.total_sync_workspaces(id) on delete cascade,
  envelope_id uuid not null,
  device_id uuid not null,
  sequence bigint not null check (sequence > 0),
  entity_kind text not null check (entity_kind in ('proposal','draft','comment','task')),
  entity_id text not null check (length(entity_id) between 1 and 180),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, envelope_id),
  unique (workspace_id, device_id, sequence)
);

create table if not exists public.total_sync_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.total_sync_workspaces(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check ((accepted_by is null) = (accepted_at is null))
);
create index if not exists total_sync_invitations_workspace
  on public.total_sync_invitations(workspace_id, created_at desc);
create index if not exists total_sync_envelopes_cursor
  on public.total_sync_envelopes(workspace_id, relay_id);

alter table public.total_sync_workspaces enable row level security;
alter table public.total_sync_members enable row level security;
alter table public.total_sync_envelopes enable row level security;
alter table public.total_sync_invitations enable row level security;

create policy "members can read workspace"
  on public.total_sync_workspaces for select to authenticated
  using (owner_id=auth.uid() or exists (
    select 1 from public.total_sync_members m
    where m.workspace_id=id and m.user_id=auth.uid()
  ));
create policy "users can create owned workspace"
  on public.total_sync_workspaces for insert to authenticated
  with check (owner_id=auth.uid());
create policy "members can read membership"
  on public.total_sync_members for select to authenticated
  using (user_id=auth.uid() or exists (
    select 1 from public.total_sync_workspaces w
    where w.id=workspace_id and w.owner_id=auth.uid()
  ));
create policy "owners can add membership"
  on public.total_sync_members for insert to authenticated
  with check (
    user_id=auth.uid() and exists (
      select 1 from public.total_sync_workspaces w
      where w.id=workspace_id and w.owner_id=auth.uid()
    )
  );
create policy "members can read encrypted envelopes"
  on public.total_sync_envelopes for select to authenticated
  using (exists (
    select 1 from public.total_sync_members m
    where m.workspace_id=total_sync_envelopes.workspace_id and m.user_id=auth.uid()
  ));
create policy "members can append encrypted envelopes"
  on public.total_sync_envelopes for insert to authenticated
  with check (exists (
    select 1 from public.total_sync_members m
    where m.workspace_id=total_sync_envelopes.workspace_id and m.user_id=auth.uid()
  ));

create policy "owners can list invitations"
  on public.total_sync_invitations for select to authenticated
  using (exists (
    select 1 from public.total_sync_workspaces w
    where w.id=total_sync_invitations.workspace_id and w.owner_id=auth.uid()
  ));

-- Raw invitation tokens never enter the database. Edge Functions hash them before calling
-- these narrowly scoped SECURITY DEFINER functions; each function rechecks auth.uid().
create or replace function public.total_sync_create_invitation(
  p_workspace_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns public.total_sync_invitations
language plpgsql security definer set search_path = public
as $$
declare result public.total_sync_invitations;
begin
  if auth.uid() is null or not exists (
    select 1 from public.total_sync_workspaces
    where id=p_workspace_id and owner_id=auth.uid()
  ) then raise exception 'workspace owner required' using errcode='42501'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid token hash'; end if;
  if p_expires_at <= now() + interval '5 minutes' or p_expires_at > now() + interval '30 days'
    then raise exception 'invalid invitation expiry'; end if;
  insert into public.total_sync_invitations(workspace_id,token_hash,created_by,expires_at)
    values(p_workspace_id,p_token_hash,auth.uid(),p_expires_at) returning * into result;
  return result;
end $$;

create or replace function public.total_sync_revoke_invitation(p_invitation_id uuid)
returns public.total_sync_invitations
language plpgsql security definer set search_path = public
as $$
declare result public.total_sync_invitations;
begin
  update public.total_sync_invitations i set revoked_at=now()
  where i.id=p_invitation_id and i.accepted_at is null and i.revoked_at is null
    and exists (select 1 from public.total_sync_workspaces w
      where w.id=i.workspace_id and w.owner_id=auth.uid())
  returning * into result;
  if result.id is null then raise exception 'active invitation not found' using errcode='42501'; end if;
  return result;
end $$;

create or replace function public.total_sync_accept_invitation(
  p_workspace_id uuid,
  p_token_hash text
) returns public.total_sync_members
language plpgsql security definer set search_path = public
as $$
declare invitation public.total_sync_invitations;
declare membership public.total_sync_members;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode='42501'; end if;
  select * into invitation from public.total_sync_invitations
    where workspace_id=p_workspace_id and token_hash=p_token_hash
      and accepted_at is null and revoked_at is null and expires_at>now()
    for update;
  if invitation.id is null then raise exception 'invitation is invalid or expired' using errcode='42501'; end if;
  insert into public.total_sync_members(workspace_id,user_id,role)
    values(p_workspace_id,auth.uid(),'member')
    on conflict(workspace_id,user_id) do update set role=total_sync_members.role
    returning * into membership;
  update public.total_sync_invitations set accepted_by=auth.uid(),accepted_at=now()
    where id=invitation.id;
  return membership;
end $$;

revoke all on function public.total_sync_create_invitation(uuid,text,timestamptz) from public;
revoke all on function public.total_sync_revoke_invitation(uuid) from public;
revoke all on function public.total_sync_accept_invitation(uuid,text) from public;
grant execute on function public.total_sync_create_invitation(uuid,text,timestamptz) to authenticated;
grant execute on function public.total_sync_revoke_invitation(uuid) to authenticated;
grant execute on function public.total_sync_accept_invitation(uuid,text) to authenticated;

-- Payloads are append-only. Clients can discard their local materialized views without
-- deleting shared history, and no user-facing API is granted update/delete access.
revoke update, delete on public.total_sync_envelopes from authenticated;
revoke insert, update, delete on public.total_sync_invitations from authenticated;
