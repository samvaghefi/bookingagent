-- Calendar: blocked time + connected Google account
-- Run once in the Supabase SQL editor (additive; safe to re-run).

-- Blocked time a shop sets by hand (lunch, days off, holidays). Checked with
-- opening hours, bookings and Google Calendar before the AI offers a time.
create table if not exists public.calendar_blocks (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  repeat       text not null default 'none' check (repeat in ('none', 'weekly')),
  start_date   date not null,
  end_date     date,                                   -- null only for weekly blocks with no end
  weekdays     smallint[] not null default '{}',       -- 1=Mon..7=Sun, used when repeat = 'weekly'
  start_time   time,                                   -- null with end_time = all day
  end_time     time,
  team_member  text,                                   -- null = whole shop
  note         text,
  created_at   timestamptz not null default now(),
  constraint calendar_blocks_dates check (end_date is null or end_date >= start_date),
  constraint calendar_blocks_once_has_end check (repeat = 'weekly' or end_date is not null),
  constraint calendar_blocks_times_pair check ((start_time is null) = (end_time is null)),
  constraint calendar_blocks_time_order check (start_time is null or end_time > start_time),
  constraint calendar_blocks_weekly_days check (repeat = 'none' or cardinality(weekdays) > 0)
);

create index if not exists calendar_blocks_business_idx
  on public.calendar_blocks (business_id, start_date);

-- Same pattern as the other tables: only the server (service key) can read/write
alter table public.calendar_blocks enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'calendar_blocks' and policyname = 'No direct access') then
    create policy "No direct access" on public.calendar_blocks for all using (false);
  end if;
end $$;

-- Which Google account the shop connected (shown in Settings; never the tokens)
alter table public.businesses add column if not exists google_calendar_email text;
