-- Bind each opaque collaboration device ID and Ed25519 public key to the authenticated
-- workspace member who first registers it. Envelope sequence numbers are meaningful only
-- after this ownership check; without it one member could reserve another device's sequence.
create table if not exists public.total_sync_devices (
  workspace_id uuid not null references public.total_sync_workspaces(id) on delete cascade,
  device_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  signing_public_key text not null check (
    length(signing_public_key) between 80 and 2048
    and signing_public_key like '-----BEGIN PUBLIC KEY-----%'
  ),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (workspace_id, device_id)
);
create index if not exists total_sync_devices_user
  on public.total_sync_devices(workspace_id,user_id);

alter table public.total_sync_devices enable row level security;

create policy "members can read registered devices"
  on public.total_sync_devices for select to authenticated
  using (exists (
    select 1 from public.total_sync_members m
    where m.workspace_id=total_sync_devices.workspace_id and m.user_id=auth.uid()
  ));

create policy "members can register their device"
  on public.total_sync_devices for insert to authenticated
  with check (
    user_id=auth.uid() and exists (
      select 1 from public.total_sync_members m
      where m.workspace_id=total_sync_devices.workspace_id and m.user_id=auth.uid()
    )
  );

-- Device ownership and signing keys are immutable through the public API. A future explicit
-- revocation endpoint may remove a device through a narrowly scoped SECURITY DEFINER function.
revoke update, delete on public.total_sync_devices from authenticated;
