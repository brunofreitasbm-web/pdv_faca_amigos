-- Segurança (auditoria 2026-11-10, onda 1): fecha RPCs internas que estavam
-- executáveis por anon (chave publishable é pública).
--
-- * fa_gerencial_clientes devolvia CPF, telefone, e-mail e filhos de até 150
--   responsáveis por chamada, sem sessão nem papel. Passa a exigir colaborador
--   ativo (ou service_role) e perde o EXECUTE de anon/PUBLIC.
-- * fa_checkin, fa_kiosk_cancel_session, fa_reimprimir_entrada e
--   fa_kiosk_enqueue_entry_prints: só o PDV logado chama (client.ts). Perdem o
--   EXECUTE de anon/PUBLIC; authenticated e service_role continuam.
-- * Funções de trigger do chat não precisam de EXECUTE por ninguém da API.
-- * search_path fixo nas 8 funções apontadas pelo advisor.
--
-- Ficam com anon de propósito (fluxo público): fa_pre_checkin_*,
-- fa_acompanhar_*, fa_chat_unread_hint (selo da tela de PIN, só um contador).
-- As biofit_* não pertencem a este repositório e não são tocadas aqui.
--
-- ROLLBACK:
--   grant execute on function public.fa_gerencial_clientes(text, uuid) to anon;
--   grant execute on function public.fa_checkin(text,uuid,text,uuid,uuid,jsonb,jsonb,text,uuid,text,text[],boolean,uuid,integer,uuid,text,uuid,boolean) to anon;
--   grant execute on function public.fa_kiosk_cancel_session(uuid, text) to public;
--   grant execute on function public.fa_reimprimir_entrada(uuid, uuid, text) to public;
--   grant execute on function public.fa_kiosk_enqueue_entry_prints(uuid, text) to public;
--   grant execute on function public.fa_chat_notify_owner(), public.fa_chat_notify_read() to public;
--   (o guard de fa_gerencial_clientes sai reaplicando 20260812000004)

create or replace function public.fa_gerencial_clientes(p_search text default null, p_unit_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_search text := trim(coalesce(p_search, ''));
  v_reset_at_ms bigint := coalesce((select reset_at_ms from fa_kiosk_visit_counter_reset where id = true), 0);
  v_res jsonb;
begin
  -- Dados pessoais de clientes: só colaborador ativo logado (ou o servidor).
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (
       select 1 from fa_kiosk_employees e
        where e.auth_user_id = auth.uid() and e.active
     ) then
    raise exception 'NAO_AUTORIZADO' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_res
  from (
    select
      g.id as guardian_id,
      g.full_name as guardian_name,
      g.cpf,
      g.phone_e164,
      g.email,
      g.created_at,
      (
        select count(distinct s.id)
        from fa_kiosk_sessions s
        where s.guardian_id = g.id
          and s.checkin_at_ms >= v_reset_at_ms
          and (p_unit_id is null or s.unit_id = p_unit_id)
      ) as total_visits,
      (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', c.id,
          'fullName', c.full_name,
          'birthDate', c.birth_date,
          'photoPath', c.photo_path
        )), '[]'::jsonb)
        from fa_kiosk_child_guardians cg
        join fa_kiosk_children c on c.id = cg.child_id
        where cg.guardian_id = g.id
      ) as children
    from fa_kiosk_guardians g
    where (
      v_search = '' or
      g.full_name ilike '%' || v_search || '%' or
      g.cpf ilike '%' || v_search || '%' or
      g.phone_e164 ilike '%' || v_search || '%' or
      exists (
        select 1 from fa_kiosk_child_guardians cg2
        join fa_kiosk_children c2 on c2.id = cg2.child_id
        where cg2.guardian_id = g.id and c2.full_name ilike '%' || v_search || '%'
      )
    )
    order by total_visits desc, g.created_at desc
    limit 150
  ) item;

  return v_res;
end;
$function$;

revoke execute on function public.fa_gerencial_clientes(text, uuid) from public, anon;
grant execute on function public.fa_gerencial_clientes(text, uuid) to authenticated, service_role;

revoke execute on function public.fa_checkin(text,uuid,text,uuid,uuid,jsonb,jsonb,text,uuid,text,text[],boolean,uuid,integer,uuid,text,uuid,boolean) from public, anon;
revoke execute on function public.fa_kiosk_cancel_session(uuid, text) from public, anon;
revoke execute on function public.fa_reimprimir_entrada(uuid, uuid, text) from public, anon;
revoke execute on function public.fa_kiosk_enqueue_entry_prints(uuid, text) from public, anon;
grant execute on function public.fa_kiosk_cancel_session(uuid, text) to authenticated, service_role;
grant execute on function public.fa_reimprimir_entrada(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.fa_kiosk_enqueue_entry_prints(uuid, text) to authenticated, service_role;

revoke execute on function public.fa_chat_notify_owner() from public, anon, authenticated;
revoke execute on function public.fa_chat_notify_read() from public, anon, authenticated;

alter function public.fa_acompanhar_por_codigo(text) set search_path to 'public', 'pg_temp';
alter function public.fa_birthday_belem_date(bigint) set search_path to 'public', 'pg_temp';
alter function public.fa_birthday_cohort(date) set search_path to 'public', 'pg_temp';
alter function public.fa_birthday_in_year(date, integer) set search_path to 'public', 'pg_temp';
alter function public.fa_birthday_month_end(date) set search_path to 'public', 'pg_temp';
alter function public.fa_birthday_next(date, date) set search_path to 'public', 'pg_temp';
alter function public.fa_coupon_schedule_ok(smallint[], time without time zone, time without time zone, text, bigint) set search_path to 'public', 'pg_temp';
alter function public.fa_kiosk_vip_flags(uuid, uuid[]) set search_path to 'public', 'pg_temp';

-- Funções novas deixam de nascer executáveis por anon: quem for pública de
-- propósito precisa de `grant execute ... to anon` explícito na migration.
alter default privileges for role postgres in schema public revoke execute on functions from anon;
