-- Runs / jobs / ownership — shared by web + worker on Railway.
-- Apply after 001_railway_gemini.sql.

create schema if not exists app;

create table if not exists app.runs (
  id text primary key,
  session_id text not null,
  status text not null,
  category text not null,
  aspect_ratio text not null,
  target_duration double precision not null,
  output_resolution text not null default '1080p',
  initial_prompt text not null,
  script_model text not null,
  keyframe_model text not null,
  video_model text not null,
  current_shot_index integer not null default 0,
  rework_round integer not null default 0,
  gate text,
  revise_comment text,
  script_json text,
  input_assets_json text,
  pipeline_mode text not null default 'agentic',
  operator_script text,
  auto_options_json text,
  error text,
  counted integer not null default 0,
  user_id text not null,
  tenant_id text,
  created_by_kind text not null default 'dev',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists runs_user_created_idx on app.runs (user_id, created_at desc);
create index if not exists runs_session_idx on app.runs (session_id);
create index if not exists runs_status_idx on app.runs (status);

create table if not exists app.jobs (
  id text primary key,
  run_id text not null references app.runs (id) on delete cascade,
  type text not null,
  status text not null,
  weight integer not null default 1,
  heavy integer not null default 0,
  archive integer not null default 0,
  payload_json text not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_claim_idx on app.jobs (status, weight, created_at);
create index if not exists jobs_run_idx on app.jobs (run_id, status);

create table if not exists app.variants (
  id text primary key,
  run_id text not null references app.runs (id) on delete cascade,
  shot_index integer not null,
  kind text not null,
  variant_index integer not null,
  path text not null,
  prompt text not null,
  model_name text not null,
  selected integer not null default 0,
  rejected integer not null default 0,
  probe_json text,
  uniq_id text,
  created_at timestamptz not null default now()
);

create index if not exists variants_run_idx on app.variants (run_id, shot_index, kind);

create table if not exists app.assets (
  uniq_id text primary key,
  run_id text not null references app.runs (id) on delete cascade,
  shot_index integer,
  role text not null,
  path text not null,
  parent_uniq_id text,
  meta_json text not null,
  created_at timestamptz not null default now()
);

create table if not exists app.reviews (
  run_id text primary key references app.runs (id) on delete cascade,
  gate text not null,
  checklist_json text,
  aesthetic_score double precision,
  consistency_score double precision,
  use_xfade integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists app.cook_requests (
  request_id text not null,
  user_id text not null,
  run_id text not null references app.runs (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
