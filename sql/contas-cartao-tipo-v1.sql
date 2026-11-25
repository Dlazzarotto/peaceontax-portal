-- sql/contas-cartao-tipo-v1.sql
-- Cartao de credito e `credit_card` em bank_accounts.type -- em toda conta.
--
-- O QUE ACONTECIA
-- A importacao do historico do QuickBooks criava a conta de cartao com
-- type = 'credit'. O resto do sistema grava e procura 'credit_card' (o Plaid,
-- o cadastro manual, a tela de contas). Com 'credit':
--   * o Balanco e o fluxo de caixa somavam o cartao como DINHEIRO em banco,
--     com a divida do lado do ativo;
--   * o 1099 nao reconhecia o pagamento feito no cartao (que vai no 1099-K)
--     e o somava ao prestador.
-- O motor de classificacao nao sofria: ele testa /credit|card/ no tipo.
--
-- O conserto e nos dois lados:
--   codigo -- a importacao grava 'credit_card' (app/api/bookkeeping/
--             import-quickbooks/route.ts) e o Balanco aceita os dois
--             (ehCartao, lib/balanco.ts), para nao depender desta migracao;
--   banco  -- esta migracao acerta as contas que ja nasceram 'credit'.
--
-- So troca 'credit' (exato, em qualquer caixa) -- nenhum outro tipo e
-- tocado. Idempotente: na segunda rodada nao ha o que trocar. Nao cria
-- tabela e nao atribui variavel por consulta.

update public.bank_accounts
   set type = 'credit_card'
 where lower(trim(type)) = 'credit';

-- == Conferencia ===========================================================
do $$
begin
  if exists (select 1 from public.bank_accounts where lower(trim(type)) = 'credit') then
    raise exception 'ainda ha conta com type = credit';
  end if;
  raise notice 'bank_accounts: nenhum cartao com type = credit';
end $$;

-- Como ficaram os tipos (para conferir de olho)
select type, count(*) as contas
  from public.bank_accounts
 group by type
 order by type;
