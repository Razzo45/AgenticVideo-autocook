-- One operator task can fan out into several cooks (one file per kind).
-- Apply after sql/002_runs_ownership.sql.

create schema if not exists app;

create table if not exists app.cook_tasks (
  request_id text not null,
  user_id text not null,
  cooks_json text not null,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
