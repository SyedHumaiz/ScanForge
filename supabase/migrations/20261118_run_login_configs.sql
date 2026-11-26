-- The existing test_runs columns are readable by project members. Keep per-run
-- ciphertext in a service-role-only table instead of a visible run column.
create table if not exists public.run_login_configs (
  run_id uuid primary key references public.test_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  expires_at timestamptz not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  constraint run_login_configs_ciphertext_size check (length(ciphertext) <= 16384)
);
create index if not exists run_login_configs_expires_at_idx on public.run_login_configs(expires_at);
alter table public.run_login_configs enable row level security;
revoke all on public.run_login_configs from public, anon, authenticated;
grant all on public.run_login_configs to service_role;
-- service_role bypasses RLS and is used only by the Vercel API and GitHub runner.
