-- Corrige: "new row for relation fa_kiosk_sessions violates check constraint
-- fa_kiosk_sessions_plan_or_bank" ao dar entrada usando o saldo do pacote
-- (Porto Seguro).
--
-- A migration 20261104120000_fa_guardian_package_mode criou o modo de entrada
-- sem plano (plan_id nulo, uses_guardian_package = true), mas a constraint
-- continuava aceitando so plan_id / banco de horas / pacote / credito.

alter table fa_kiosk_sessions drop constraint if exists fa_kiosk_sessions_plan_or_bank;
alter table fa_kiosk_sessions add constraint fa_kiosk_sessions_plan_or_bank
  check (plan_id is not null or uses_hour_bank or uses_package or uses_child_credit or uses_guardian_package);
