-- Break the workspace/member RLS recursion without widening access. Cross-table policy checks run
-- through narrow boolean SECURITY DEFINER predicates; mutations still use the caller's auth.uid().
create or replace function public.total_sync_is_workspace_owner(
  p_workspace_id uuid,
  p_user_id uuid
) returns boolean
language sql stable security definer set search_path = public
as $$
  select p_user_id is not null and exists (
    select 1 from public.total_sync_workspaces w
    where w.id = p_workspace_id and w.owner_id = p_user_id
  )
$$;

create or replace function public.total_sync_is_workspace_member(
  p_workspace_id uuid,
  p_user_id uuid
) returns boolean
language sql stable security definer set search_path = public
as $$
  select p_user_id is not null and exists (
    select 1 from public.total_sync_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_user_id
  )
$$;

revoke all on function public.total_sync_is_workspace_owner(uuid,uuid) from public;
revoke all on function public.total_sync_is_workspace_member(uuid,uuid) from public;
grant execute on function public.total_sync_is_workspace_owner(uuid,uuid) to authenticated;
grant execute on function public.total_sync_is_workspace_member(uuid,uuid) to authenticated;

drop policy if exists "members can read workspace" on public.total_sync_workspaces;
create policy "members can read workspace"
  on public.total_sync_workspaces for select to authenticated
  using (
    owner_id = auth.uid()
    or public.total_sync_is_workspace_member(id, auth.uid())
  );

drop policy if exists "members can read membership" on public.total_sync_members;
create policy "members can read membership"
  on public.total_sync_members for select to authenticated
  using (
    user_id = auth.uid()
    or public.total_sync_is_workspace_owner(workspace_id, auth.uid())
  );

drop policy if exists "owners can add membership" on public.total_sync_members;
create policy "owners can add membership"
  on public.total_sync_members for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.total_sync_is_workspace_owner(workspace_id, auth.uid())
  );

drop policy if exists "members can read encrypted envelopes" on public.total_sync_envelopes;
create policy "members can read encrypted envelopes"
  on public.total_sync_envelopes for select to authenticated
  using (public.total_sync_is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "members can append encrypted envelopes" on public.total_sync_envelopes;
create policy "members can append encrypted envelopes"
  on public.total_sync_envelopes for insert to authenticated
  with check (public.total_sync_is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "owners can list invitations" on public.total_sync_invitations;
create policy "owners can list invitations"
  on public.total_sync_invitations for select to authenticated
  using (public.total_sync_is_workspace_owner(workspace_id, auth.uid()));

drop policy if exists "members can read registered devices" on public.total_sync_devices;
create policy "members can read registered devices"
  on public.total_sync_devices for select to authenticated
  using (public.total_sync_is_workspace_member(workspace_id, auth.uid()));

drop policy if exists "members can register their device" on public.total_sync_devices;
create policy "members can register their device"
  on public.total_sync_devices for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.total_sync_is_workspace_member(workspace_id, auth.uid())
  );
