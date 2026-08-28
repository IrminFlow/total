-- Provider-side deletion must address the same privacy-safe event identity returned by the website.
alter table public.total_feedback_events
  add column if not exists external_event_id uuid;

update public.total_feedback_events
set external_event_id = case
  when coalesce(payload ->> 'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (payload ->> 'id')::uuid
  else null
end
where external_event_id is null;

create unique index if not exists total_feedback_events_external_id
  on public.total_feedback_events(external_event_id)
  where external_event_id is not null;
