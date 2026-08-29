-- Optional hosted support/feedback system. Accounting data never belongs in these tables.
create table if not exists public.total_support_tickets (
  id uuid primary key default gen_random_uuid(),
  external_case_id text not null unique,
  category text not null,
  severity text,
  status text not null default 'submitted' check (status in ('submitted','open','waiting','resolved','deleted')),
  reply_email text,
  source text not null check (source in ('app','website')),
  message text not null check (length(message) between 1 and 10000),
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.total_support_events (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.total_support_tickets(id) on delete cascade,
  kind text not null check (kind in ('received','notification_sent','notification_failed','status_changed','message','deleted')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.total_feedback_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  kind text not null check (kind in ('idea','vote','follow','unfollow')),
  idea_id text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists total_support_tickets_status on public.total_support_tickets(status, updated_at desc);
create index if not exists total_feedback_events_idea on public.total_feedback_events(idea_id, created_at desc);

alter table public.total_support_tickets enable row level security;
alter table public.total_support_events enable row level security;
alter table public.total_feedback_events enable row level security;

-- Public clients never access these tables directly. The Edge Function validates a server-to-server
-- secret and writes with the service role; support administration uses the Supabase dashboard or a
-- separately authenticated internal tool.
revoke all on public.total_support_tickets from anon, authenticated;
revoke all on public.total_support_events from anon, authenticated;
revoke all on public.total_feedback_events from anon, authenticated;

