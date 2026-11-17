-- Recuperação: gera um código de ativação de aparelho direto no banco, para o
-- caso de o Owner ter perdido todos os aparelhos cadastrados.
-- Rode no SQL Editor do Supabase, troque o nome da unidade e o código abaixo
-- (8 caracteres A-Z/2-9, sem 0, O, 1, I, L). Vale 15 minutos, uma vez.
insert into fa_kiosk_device_enroll_codes (code_hash, unit_id, label, expires_at_ms)
select encode(digest('enroll:' || 'TROQUE123', 'sha256'), 'hex'),
       u.id,
       'Recuperação',
       (extract(epoch from now()) * 1000)::bigint + 15 * 60 * 1000
from fa_kiosk_units u
where u.name = 'TROQUE_PELO_NOME_DA_UNIDADE'
limit 1;
