-- Keep a privacy-safe acceptance timestamp when an Auth user is deleted. The accepted_by foreign
-- key intentionally uses ON DELETE SET NULL; the original equivalence check made that cleanup fail.
alter table public.total_sync_invitations
  drop constraint if exists total_sync_invitations_check;

alter table public.total_sync_invitations
  add constraint total_sync_invitations_acceptance_consistent
  check (accepted_by is null or accepted_at is not null);
