-- Run this in the Supabase SQL editor for your project.

create table if not exists public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ts timestamptz not null default now(),
  type text not null check (type in ('hall','out','grocery')),
  name text not null,
  swipes int,        -- set when type = 'hall'
  amount numeric,    -- set when type = 'out'
  created_at timestamptz not null default now()
);

alter table public.meal_logs enable row level security;

drop policy if exists "Users can view their own logs" on public.meal_logs;
create policy "Users can view their own logs"
  on public.meal_logs for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own logs" on public.meal_logs;
create policy "Users can insert their own logs"
  on public.meal_logs for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own logs" on public.meal_logs;
create policy "Users can delete their own logs"
  on public.meal_logs for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can update their own logs" on public.meal_logs;
create policy "Users can update their own logs"
  on public.meal_logs for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- RLS policies only restrict *which rows* a role can touch — Postgres also
-- requires this separate, coarser grant before a role can query the table at
-- all. Tables created via the SQL editor (as opposed to Supabase's Table
-- Editor UI, which does this automatically) don't get it for free, so every
-- table below needs one explicitly or every query 42501s regardless of RLS.
grant select, insert, update, delete on public.meal_logs to authenticated;

-- Per-user dining plan (set on first login, editable afterward).
-- semester_start/semester_type record which term the plan was saved for, so the
-- app can detect "this plan is stale, a new semester has started" on load and
-- (for Fall -> Spring) roll unused swipes into the new semester's suggested total.
create table if not exists public.meal_plans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan_name text,
  total_swipes int not null,
  weekly_allowance int not null,
  semester_start timestamptz,
  semester_type text check (semester_type in ('fall','spring')),
  swipes_adjustment int not null default 0,
  updated_at timestamptz not null default now()
);

-- If you already created meal_plans before this update, run these to add the new columns:
-- alter table public.meal_plans add column if not exists plan_name text;
-- alter table public.meal_plans add column if not exists semester_start timestamptz;
-- alter table public.meal_plans add column if not exists semester_type text check (semester_type in ('fall','spring'));
-- alter table public.meal_plans add column if not exists swipes_adjustment int not null default 0;

alter table public.meal_plans enable row level security;

drop policy if exists "Users can view their own plan" on public.meal_plans;
create policy "Users can view their own plan"
  on public.meal_plans for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own plan" on public.meal_plans;
create policy "Users can insert their own plan"
  on public.meal_plans for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own plan" on public.meal_plans;
create policy "Users can update their own plan"
  on public.meal_plans for update
  using (auth.uid() = user_id);

grant select, insert, update on public.meal_plans to authenticated;

-- Per-user spending goals (fully optional, set/edited from the Settings modal's
-- "Spending Goal" / "Grocery Budget" tabs — never prompted on signup like
-- meal_plans is). One row per user per category ('out' = eating out, 'grocery');
-- no row for a category simply means no goal is set for it. `period` controls
-- which window index.html compares actual spend against ("today"/"this week"/etc).
create table if not exists public.spending_goals (
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null default 'out' check (category in ('out','grocery')),
  amount numeric not null,
  period text not null check (period in ('day','week','month','semester')),
  updated_at timestamptz not null default now(),
  primary key (user_id, category)
);

alter table public.spending_goals enable row level security;

drop policy if exists "Users can view their own spending goal" on public.spending_goals;
create policy "Users can view their own spending goal"
  on public.spending_goals for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own spending goal" on public.spending_goals;
create policy "Users can insert their own spending goal"
  on public.spending_goals for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own spending goal" on public.spending_goals;
create policy "Users can update their own spending goal"
  on public.spending_goals for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own spending goal" on public.spending_goals;
create policy "Users can delete their own spending goal"
  on public.spending_goals for delete
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.spending_goals to authenticated;

-- Server-side backstop for the @columbia.edu / @barnard.edu restriction the app
-- already checks client-side (index.html) — blocks signup even if someone bypasses
-- the UI (devtools, a direct call to the Supabase Auth API, etc). Same trigger
-- mechanism Supabase's own docs use for auto-populating a profile row on signup,
-- just validating instead of inserting: https://supabase.com/docs/guides/auth/managing-user-data
create or replace function public.enforce_edu_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email !~* '^[^@]+@(columbia|barnard)\.edu$' then
    raise exception 'Signups are restricted to @columbia.edu and @barnard.edu addresses';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_edu_email_trigger on auth.users;
create trigger enforce_edu_email_trigger
  before insert on auth.users
  for each row
  execute function public.enforce_edu_email();

-- Scraped daily menus (see scripts/scrape-menus.js). One row per calendar day; the
-- `menus` JSON is shaped like { Breakfast: {...}, Lunch: {...}, Dinner: {...},
-- "Late Night": {...} } matching SAMPLE_MENUS in api/menus.js. Written only by the
-- scraper (using the service role key, which bypasses RLS) — anon/authenticated
-- users can only read. api/menus.js falls back to curated sample data if today's
-- row is missing (scraper hasn't run yet, or it failed). Rows older than 7 days
-- are deleted by the scraper itself (cleanupOldMenus() in scrape-menus.js) on
-- every run — Postgres/Supabase has no built-in row expiry, so this table would
-- otherwise grow forever.
create table if not exists public.daily_menus (
  date date primary key,
  menus jsonb not null,
  scraped_at timestamptz not null default now()
);

alter table public.daily_menus enable row level security;

drop policy if exists "Anyone can read today's menus" on public.daily_menus;
create policy "Anyone can read today's menus"
  on public.daily_menus for select
  using (true);

grant select on public.daily_menus to anon, authenticated;

-- No insert/update/delete policy for anon/authenticated — only the service role
-- (used by scripts/scrape-menus.js, never exposed to the browser) can write here.

-- Swipe Market (see the "Swipe Market" page in index.html, modeled loosely on
-- swipemarketcu.com). Signed-in students post "selling N swipes" or "buying N
-- swipes" listings with a price; other students browse and claim them (see
-- claim_swipe_listing() below) to arrange the actual exchange — there's no in-app
-- payment or swipe transfer, since Columbia doesn't expose an API for that, and
-- swipes can only change hands by physically swiping the other person in.
-- Restricted to authenticated users end-to-end (no guest/localStorage mode like
-- meal_logs has) since a listing is only useful if it can be matched with a real
-- person to meet.
-- meeting_location/meeting_start/meeting_end exist because that meetup has to be
-- scheduled up front — meeting_end/meeting_start are compared client-side against
-- "now" (index.html) to mark a listing "Expired" once the window has passed,
-- rather than a cron job flipping status server-side.
-- contact_email is always the poster's own account email (set client-side from
-- the logged-in session, never typed in) — auth.users enforces @columbia.edu /
-- @barnard.edu at signup already (enforce_edu_email above), so the check here is
-- just a second guarantee that only a school email is ever shown to other users.
create table if not exists public.swipe_listings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('sell','buy')),
  quantity int not null check (quantity > 0),
  price_per_swipe numeric not null check (price_per_swipe >= 0),
  note text,
  contact_email text not null check (contact_email ~* '^[^@]+@(columbia|barnard)\.edu$'),
  payment_methods text[] not null check (
    cardinality(payment_methods) > 0
    and payment_methods <@ array['venmo','paypal','cash','zelle']
  ),
  meeting_location text not null,
  meeting_start timestamptz not null,
  meeting_end timestamptz not null check (meeting_end >= meeting_start + interval '15 minutes'),
  status text not null default 'active' check (status in ('active','completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- If you already created swipe_listings before this update, run these instead of
-- the create table above (existing rows get NULL contact_email/meeting fields
-- until edited — there's no sane default to backfill):
-- alter table public.swipe_listings rename column contact to contact_email;
-- alter table public.swipe_listings add constraint swipe_listings_contact_email_check check (contact_email ~* '^[^@]+@(columbia|barnard)\.edu$');
-- alter table public.swipe_listings add column if not exists meeting_location text;
-- alter table public.swipe_listings add column if not exists meeting_start timestamptz;
-- alter table public.swipe_listings add column if not exists meeting_end timestamptz;
-- alter table public.swipe_listings add constraint swipe_listings_meeting_window_check check (meeting_end >= meeting_start + interval '15 minutes');
-- alter table public.swipe_listings add column if not exists payment_methods text[] not null default array['cash'];
-- alter table public.swipe_listings add constraint swipe_listings_payment_methods_check check (cardinality(payment_methods) > 0 and payment_methods <@ array['venmo','paypal','cash','zelle']);
-- alter table public.swipe_listings alter column payment_methods drop default;

alter table public.swipe_listings enable row level security;

-- Active listings are visible to any signed-in student (that's the whole point of
-- a marketplace); a poster can also see their own completed listings so
-- their "My Listings" tab shows full history.
drop policy if exists "Signed-in users can view active listings and their own" on public.swipe_listings;
create policy "Signed-in users can view active listings and their own"
  on public.swipe_listings for select
  to authenticated
  using (status = 'active' or auth.uid() = user_id);

drop policy if exists "Users can insert their own listings" on public.swipe_listings;
create policy "Users can insert their own listings"
  on public.swipe_listings for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own listings" on public.swipe_listings;
create policy "Users can update their own listings"
  on public.swipe_listings for update
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can delete their own listings" on public.swipe_listings;
create policy "Users can delete their own listings"
  on public.swipe_listings for delete
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.swipe_listings to authenticated;

-- A confirmed match between a listing's poster and whoever claimed it (see
-- claim_swipe_listing() below), snapshotting everything both people need to meet
-- up: each other's email, how many swipes, the price, and the location/time from
-- the listing at the moment of claiming. Only ever written by that function
-- (security definer, so it bypasses RLS) — regular users never insert/update/
-- delete rows here directly, only read the ones they're part of.
-- listing_type snapshots the *original* listing's type ('sell' = poster was
-- selling, claimer is buying; 'buy' = poster wanted to buy, claimer is selling to
-- them) — needed because index.html has no other way to tell which side of the
-- trade the poster was on once a match row exists on its own.
create table if not exists public.swipe_matches (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid references public.swipe_listings(id) on delete set null,
  listing_type text not null check (listing_type in ('sell','buy')),
  poster_id uuid not null references auth.users(id) on delete cascade,
  claimer_id uuid not null references auth.users(id) on delete cascade,
  poster_email text not null,
  claimer_email text not null,
  quantity int not null check (quantity > 0),
  price_per_swipe numeric not null check (price_per_swipe >= 0),
  payment_methods text[] not null,
  meeting_location text not null,
  meeting_start timestamptz not null,
  meeting_end timestamptz not null,
  status text not null default 'active' check (status in ('active','cancelled')),
  cancelled_at timestamptz,
  -- The meal_logs rows claim_swipe_listing() creates for each side (see below)
  -- so this specific "swipe usage" can be found and deleted again if the
  -- agreement gets cancelled before the swipes actually change hands.
  poster_meal_log_id uuid references public.meal_logs(id) on delete set null,
  claimer_meal_log_id uuid references public.meal_logs(id) on delete set null,
  created_at timestamptz not null default now()
);

-- If you already created swipe_matches before this update, run this instead of
-- the create table above:
-- alter table public.swipe_matches add column if not exists poster_meal_log_id uuid references public.meal_logs(id) on delete set null;
-- alter table public.swipe_matches add column if not exists claimer_meal_log_id uuid references public.meal_logs(id) on delete set null;

alter table public.swipe_matches enable row level security;

drop policy if exists "Participants can view their own matches" on public.swipe_matches;
create policy "Participants can view their own matches"
  on public.swipe_matches for select
  to authenticated
  using (auth.uid() = poster_id or auth.uid() = claimer_id);

-- select only — inserts/updates on this table only ever happen inside the
-- security definer functions below, which run as the functions' owner and so
-- don't need a grant on this table themselves.
grant select on public.swipe_matches to authenticated;

-- Atomically claims `p_quantity` swipes from a listing: records a swipe_matches
-- row (so both people can see each other's email + the meetup details in the app,
-- no email/push service involved) and either decrements the listing's remaining
-- quantity or marks it completed if this claim used the last of it. Runs as
-- security definer specifically so it can do both of those writes in one
-- transaction under a row lock (`for update`) — that lock is what stops two
-- students from simultaneously claiming more swipes than a listing actually has.
--
-- Also logs the swipe usage on both sides: the seller's card gets swiped
-- p_quantity times at the meetup (those swipes are gone from their plan
-- whether or not they personally eat), and the buyer gets p_quantity meals
-- without touching their own plan at all — so both get a 'hall' meal_logs row
-- (dated to the listing's meeting_start, not claim time), which is what makes
-- this actually count toward "swipes used" for both of them, same as any
-- other dining hall visit. Logged optimistically at claim time, same as the
-- listing quantity/status update above — if the agreement falls through,
-- cancel_swipe_match() deletes these rows again.
create or replace function public.claim_swipe_listing(p_listing_id uuid, p_quantity int)
returns public.swipe_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.swipe_listings%rowtype;
  v_claimer_email text;
  v_match public.swipe_matches%rowtype;
  v_poster_log_id uuid;
  v_claimer_log_id uuid;
  v_log_name text;
begin
  select email into v_claimer_email from auth.users where id = auth.uid();
  if v_claimer_email is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_listing from public.swipe_listings where id = p_listing_id for update;
  if not found then
    raise exception 'Listing not found';
  end if;
  if v_listing.status <> 'active' then
    raise exception 'This listing is no longer active';
  end if;
  if v_listing.meeting_end < now() then
    raise exception 'This listing''s meeting window has already passed';
  end if;
  if v_listing.user_id = auth.uid() then
    raise exception 'You can''t claim your own listing';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > v_listing.quantity then
    raise exception 'Invalid quantity';
  end if;

  v_log_name := 'Swipe Market: ' || v_listing.meeting_location;

  insert into public.meal_logs (user_id, ts, type, name, swipes)
  values (v_listing.user_id, v_listing.meeting_start, 'hall', v_log_name, p_quantity)
  returning id into v_poster_log_id;

  insert into public.meal_logs (user_id, ts, type, name, swipes)
  values (auth.uid(), v_listing.meeting_start, 'hall', v_log_name, p_quantity)
  returning id into v_claimer_log_id;

  insert into public.swipe_matches (
    listing_id, listing_type, poster_id, claimer_id, poster_email, claimer_email,
    quantity, price_per_swipe, payment_methods, meeting_location, meeting_start, meeting_end,
    poster_meal_log_id, claimer_meal_log_id
  ) values (
    v_listing.id, v_listing.type, v_listing.user_id, auth.uid(), v_listing.contact_email, v_claimer_email,
    p_quantity, v_listing.price_per_swipe, v_listing.payment_methods, v_listing.meeting_location, v_listing.meeting_start, v_listing.meeting_end,
    v_poster_log_id, v_claimer_log_id
  ) returning * into v_match;

  if p_quantity = v_listing.quantity then
    update public.swipe_listings set status = 'completed', updated_at = now() where id = v_listing.id;
  else
    update public.swipe_listings set quantity = quantity - p_quantity, updated_at = now() where id = v_listing.id;
  end if;

  return v_match;
end;
$$;

grant execute on function public.claim_swipe_listing(uuid, int) to authenticated;

-- In-app chat between a match's two participants (post-claim only — there's no
-- pre-claim negotiation, matching how claiming already works: click a listing,
-- confirm, you're connected). is_system marks the automated "cancelled this
-- agreement" note inserted by cancel_swipe_match() below; regular users can
-- never set is_system themselves (see the insert policy), so a message showing
-- as system-authored in index.html is trustworthy.
create table if not exists public.swipe_messages (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.swipe_matches(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(btrim(body)) > 0),
  is_system boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.swipe_messages enable row level security;

drop policy if exists "Participants can view their match's messages" on public.swipe_messages;
create policy "Participants can view their match's messages"
  on public.swipe_messages for select
  to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- sender must be one of the match's two participants, and recipient must be
-- specifically the *other* one — this is what stops anyone from messaging a
-- match they're not part of, without needing a separate "is participant" check.
drop policy if exists "Participants can message the other side of their match" on public.swipe_messages;
create policy "Participants can message the other side of their match"
  on public.swipe_messages for insert
  to authenticated
  with check (
    auth.uid() = sender_id
    and is_system = false
    and exists (
      select 1 from public.swipe_matches m
      where m.id = match_id
        and ((m.poster_id = auth.uid() and recipient_id = m.claimer_id)
          or (m.claimer_id = auth.uid() and recipient_id = m.poster_id))
    )
  );

drop policy if exists "Recipients can mark messages read" on public.swipe_messages;
create policy "Recipients can mark messages read"
  on public.swipe_messages for update
  to authenticated
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

grant select, insert, update on public.swipe_messages to authenticated;

-- Cancels an active agreement: either participant can call this. Restores the
-- claimed quantity back onto the listing (and reactivates it if claiming this
-- match had marked it 'completed') so those swipes are buyable/sellable by
-- anyone again — a no-op on the listing side if the poster already deleted it
-- (listing_id went null via the on-delete-set-null above). Also deletes the
-- meal_logs rows claim_swipe_listing() created for both sides, since the
-- swipes never actually changed hands. Notifies both sides by inserting a
-- system message into their shared thread rather than email, consistent with
-- how matches themselves were already designed with no email/push service.
create or replace function public.cancel_swipe_match(p_match_id uuid)
returns public.swipe_matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.swipe_matches%rowtype;
  v_canceller_email text;
  v_recipient_id uuid;
begin
  select * into v_match from public.swipe_matches where id = p_match_id for update;
  if not found then
    raise exception 'Agreement not found';
  end if;
  if auth.uid() <> v_match.poster_id and auth.uid() <> v_match.claimer_id then
    raise exception 'Not authorized';
  end if;
  if v_match.status <> 'active' then
    raise exception 'This agreement is already cancelled';
  end if;

  select email into v_canceller_email from auth.users where id = auth.uid();
  v_recipient_id := case when auth.uid() = v_match.poster_id then v_match.claimer_id else v_match.poster_id end;

  update public.swipe_matches set status = 'cancelled', cancelled_at = now()
    where id = p_match_id returning * into v_match;

  update public.swipe_listings
    set quantity = quantity + v_match.quantity, status = 'active', updated_at = now()
    where id = v_match.listing_id;

  delete from public.meal_logs where id in (v_match.poster_meal_log_id, v_match.claimer_meal_log_id);

  insert into public.swipe_messages (match_id, sender_id, recipient_id, body, is_system)
  values (p_match_id, auth.uid(), v_recipient_id, v_canceller_email || ' cancelled this agreement.', true);

  return v_match;
end;
$$;

grant execute on function public.cancel_swipe_match(uuid) to authenticated;
