create schema if not exists revoice;
revoke all on schema revoice from public, anon, authenticated;

create table if not exists revoice.calls (
  call_id text primary key,
  label text not null check (label in ('scam', 'legit', 'unknown')),
  playbook_version integer not null check (playbook_version >= 0),
  ended_at timestamptz not null,
  record jsonb not null,
  metrics jsonb not null,
  critic jsonb
);

create table if not exists revoice.playbooks (
  version integer primary key check (version > 0),
  document jsonb not null
);

-- A null version points to the built-in empty playbook (v0).
create table if not exists revoice.current_playbook (
  singleton boolean primary key default true check (singleton),
  version integer references revoice.playbooks (version)
);
insert into revoice.current_playbook default values on conflict do nothing;

create table if not exists revoice.eval_runs (
  name text primary key,
  result jsonb not null
);
