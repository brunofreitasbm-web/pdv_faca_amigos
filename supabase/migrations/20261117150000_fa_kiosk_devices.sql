-- Camada de "aparelho da unidade" antes do PIN.
--
-- Só um aparelho cadastrado pelo Owner (código de uso único) consegue listar
-- colaboradores e tentar PIN. A checagem é feita DENTRO das Edge Functions
-- list-employees e login-pin (_shared/deviceGate.ts), não na tela.
-- Tabelas só acessíveis pela service role: RLS ligado e nenhuma policy.

create table if not exists fa_kiosk_devices (
  id                     uuid primary key default gen_random_uuid(),
  unit_id                uuid not null references fa_kiosk_units (id),
  label                  text not null,
  token_hash             text not null unique,
  created_by_employee_id uuid references fa_kiosk_employees (id),
  created_at_ms          bigint not null default (extract(epoch from now()) * 1000)::bigint,
  last_seen_ms           bigint,
  revoked_at_ms          bigint,
  revoked_by_employee_id uuid references fa_kiosk_employees (id)
);

create table if not exists fa_kiosk_device_enroll_codes (
  code_hash              text primary key,
  unit_id                uuid not null references fa_kiosk_units (id),
  label                  text not null,
  created_by_employee_id uuid references fa_kiosk_employees (id),
  created_at_ms          bigint not null default (extract(epoch from now()) * 1000)::bigint,
  expires_at_ms          bigint not null,
  used_at_ms             bigint,
  device_id              uuid references fa_kiosk_devices (id)
);

-- Freio de força bruta do código: por IP (o código tem ~10^12 combinações,
-- mas a função é anônima).
create table if not exists fa_kiosk_device_enroll_attempts (
  ip_hash         text primary key,
  failed_count    integer not null default 0,
  last_failed_ms  bigint,
  locked_until_ms bigint
);

alter table fa_kiosk_devices enable row level security;
alter table fa_kiosk_device_enroll_codes enable row level security;
alter table fa_kiosk_device_enroll_attempts enable row level security;
revoke all on fa_kiosk_devices from anon, authenticated;
revoke all on fa_kiosk_device_enroll_codes from anon, authenticated;
revoke all on fa_kiosk_device_enroll_attempts from anon, authenticated;

-- Rastreia de qual aparelho veio cada login.
alter table fa_kiosk_audit_log add column if not exists device_id uuid references fa_kiosk_devices (id);

insert into fa_kiosk_role_capabilities (role, capability) values
  ('ADMIN', 'dispositivos.manage')
on conflict do nothing;
