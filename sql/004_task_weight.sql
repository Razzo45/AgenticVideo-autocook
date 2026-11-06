-- One queue row per task. task_weight is the sum of its deliverables.
-- Lower weight is admitted first. A task already in progress stays ahead of newcomers.
-- Apply after sql/003_cook_tasks.sql.

alter table app.jobs add column if not exists task_weight integer not null default 10;

create index if not exists jobs_task_queue_idx on app.jobs (status, task_weight, created_at);
