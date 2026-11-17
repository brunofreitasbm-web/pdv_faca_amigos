-- Configuração da ponte do playground guardada no Vault do banco (alternativa aos
-- secrets de Edge Function). Só a service role consegue ler, e só estes 3 nomes.
-- Os valores em si (URL da clínica, segredo HMAC e chave pública) são gravados com
-- vault.create_secret fora do repositório; a função playground-eval-bridge lê daqui
-- quando a variável de ambiente correspondente não existe.
create or replace function fa_playground_bridge_config(p_name text) returns text
language plpgsql security definer set search_path = pg_temp as $$
declare
  v text;
begin
  if p_name not in ('CLINIC_URL', 'CLINIC_BRIDGE_SECRET', 'PLAYGROUND_BRIDGE_PUBLIC_KEY') then
    raise exception 'configuração desconhecida' using errcode = '22023';
  end if;
  select decrypted_secret into v
  from vault.decrypted_secrets
  where name = p_name
  order by created_at desc
  limit 1;
  return v;
end;
$$;

revoke all on function fa_playground_bridge_config(text) from public, anon, authenticated;
grant execute on function fa_playground_bridge_config(text) to service_role;
