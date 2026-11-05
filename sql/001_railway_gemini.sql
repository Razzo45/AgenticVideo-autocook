-- Autocook Railway / Postgres — GDP-ported Gemini Files cache + shared admission leases.
-- Apply once against DATABASE_URL (schema app).

create schema if not exists app;

create table if not exists app.gemini_files (
  sha256      text primary key,
  uri         text not null,
  mime        text not null,
  size        bigint not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create table if not exists app.gemini_file_uses (
  sha256        text not null references app.gemini_files (sha256) on delete cascade,
  run_id        text not null,
  created_at    timestamptz not null default now(),
  primary key (sha256, run_id)
);

create table if not exists app.gemini_admission_leases (
  token         uuid primary key,
  lane          text not null,
  request_class text not null,
  lease_until   timestamptz not null
);

create table if not exists app.gemini_admission_waiters (
  token         uuid primary key,
  lane          text not null,
  request_class text not null,
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);

create table if not exists app.gemini_admission_state (
  lane            text primary key,
  cooldown_until  timestamptz not null default to_timestamp(0),
  next_admit_at   timestamptz not null default to_timestamp(0),
  updated_at      timestamptz not null default now()
);

insert into app.gemini_admission_state (lane) values ('inference'), ('files')
on conflict (lane) do nothing;

create or replace function app.acquire_gemini_admission(
  target_token uuid,
  target_lane text,
  target_request_class text,
  lease_seconds integer default 90,
  max_active integer default 2,
  max_background integer default 1,
  minimum_interval_ms integer default 0
)
returns boolean
language plpgsql
as $$
declare
  active_count integer;
  background_count integer;
  interactive_count integer;
  idle_count integer;
  background_waiting boolean;
  state_row app.gemini_admission_state;
  is_background boolean := target_request_class = 'background';
begin
  if target_lane not in ('inference', 'files') then
    raise exception 'invalid Gemini admission lane';
  end if;
  if target_request_class not in ('interactive', 'background', 'idle') then
    raise exception 'invalid Gemini request class';
  end if;
  perform pg_advisory_xact_lock(hashtext('app-gemini-admission:' || target_lane));
  delete from app.gemini_admission_leases where lane = target_lane and lease_until <= now();
  delete from app.gemini_admission_waiters where expires_at <= now();
  if target_request_class <> 'idle' then
    insert into app.gemini_admission_waiters (token, lane, request_class, expires_at)
    values (target_token, target_lane, target_request_class, now() + interval '2 minutes')
    on conflict (token) do update set expires_at = excluded.expires_at;
  end if;
  select * into state_row from app.gemini_admission_state where lane = target_lane for update;
  if not found then raise exception 'Gemini admission state is missing for lane %', target_lane; end if;
  if state_row.cooldown_until > now() or state_row.next_admit_at > now() then return false; end if;
  select count(*),
         count(*) filter (where request_class = 'background'),
         count(*) filter (where request_class = 'interactive'),
         count(*) filter (where request_class = 'idle')
    into active_count, background_count, interactive_count, idle_count
  from app.gemini_admission_leases
  where lane = target_lane and lease_until >= now();
  if active_count >= greatest(1, max_active) then return false; end if;
  if target_request_class = 'idle' then
    if exists (select 1 from app.gemini_admission_waiters where lane = target_lane) then return false; end if;
    if greatest(1, max_active) > 1 and active_count >= greatest(1, max_active) - 1 then return false; end if;
  else
    select exists (
      select 1 from app.gemini_admission_waiters
      where lane = target_lane and request_class = 'background'
    ) into background_waiting;
    if is_background then
      if background_count >= least(greatest(1, max_background), greatest(1, max_active)) then return false; end if;
    else
      if background_waiting and interactive_count >=
        greatest(0, greatest(1, max_active) - least(greatest(1, max_background), greatest(1, max_active)))
      then return false; end if;
    end if;
  end if;
  insert into app.gemini_admission_leases (token, lane, request_class, lease_until)
  values (
    target_token,
    target_lane,
    target_request_class,
    now() + make_interval(secs => least(greatest(lease_seconds, 30), 180))
  );
  delete from app.gemini_admission_waiters where token = target_token;
  update app.gemini_admission_state
  set next_admit_at = now() + (greatest(0, minimum_interval_ms)::text || ' milliseconds')::interval,
      updated_at = now()
  where lane = target_lane;
  return true;
end;
$$;

create or replace function app.release_gemini_admission(target_token uuid)
returns void
language plpgsql
as $$
begin
  delete from app.gemini_admission_leases where token = target_token;
  delete from app.gemini_admission_waiters where token = target_token;
end;
$$;

create or replace function app.throttle_gemini_admission(target_lane text, cooldown_ms integer)
returns void
language plpgsql
as $$
begin
  update app.gemini_admission_state
  set cooldown_until = greatest(cooldown_until, now() + (greatest(1000, cooldown_ms)::text || ' milliseconds')::interval),
      updated_at = now()
  where lane = target_lane;
end;
$$;
