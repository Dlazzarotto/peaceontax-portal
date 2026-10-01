-- sql/contas-a-pagar-v1.sql
-- CONTAS A PAGAR da firma: a obrigacao ANTES de o dinheiro sair.
--
-- O QUE ESTA TABELA NAO E
-- Ela NAO e contabilidade. O livro da firma e por REGIME DE CAIXA: a
-- despesa nasce quando o dinheiro sai, e isso ja chega pelo extrato
-- (Plaid) e e classificado pelo motor de regras. Se a conta a pagar
-- virasse lancamento, a mesma despesa entraria DUAS vezes -- uma na
-- emissao e outra no pagamento.
--
-- O QUE ELA E
-- O caixa DIARIO: o que a firma deve, para quem e quando vence. Serve
-- para (a) nao esquecer de pagar, (b) projetar o caixa das proximas
-- semanas e (c) fechar o circulo quando o debito aparece no banco.
--
-- O ELO COM O EXTRATO
-- `paid_tx_id` aponta o lancamento bancario que pagou a conta. E o unico
-- vinculo entre os dois mundos: a conta FECHA, e a despesa continua sendo
-- a do banco. O indice unico impede que um mesmo debito pague duas contas
-- -- senao bastaria um clique a mais para a firma "pagar" o dobro no
-- papel e a projecao passar a mentir.
--
-- FORNECEDOR e o cadastro que ja existe (`payees`, com `client_id` da
-- firma e `type = 'vendor'`). Criar uma segunda lista de fornecedores
-- seria a mesma duplicacao que o projeto ja paga caro em outros lugares.
--
-- Idempotente. Cria tabela: liga a RLS aqui mesmo, nao atribui variavel
-- por consulta e nao define funcao -- as tres coisas que fazem o SQL
-- Editor do Supabase reescrever o arquivo.

create table if not exists public.firm_bills (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null,                  -- a firma (clients.is_firm)
  payee         text not null,                  -- nome do fornecedor (payees.name)
  description   text,
  category      text,                           -- conta contabil sugerida
  amount        numeric(14,2) not null check (amount > 0),
  issue_date    date,
  due_date      date not null,
  status        text not null default 'aberta'
                check (status in ('aberta', 'paga', 'cancelada')),
  paid_tx_id    uuid,                           -- bank_transactions.id que pagou
  paid_at       timestamptz,
  cancel_reason text,
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Nasce FECHADA para o navegador: quem trabalha nela e o servidor, com a
-- service role key, que passa por cima da RLS. Sem policy, de proposito.
alter table public.firm_bills enable row level security;
revoke all on public.firm_bills from anon, authenticated;

-- Um debito do banco paga UMA conta. Sem isto, dois cliques fazem a firma
-- "pagar" o dobro no papel e a projecao de caixa passa a mentir.
create unique index if not exists firm_bills_um_pagamento
  on public.firm_bills (paid_tx_id) where paid_tx_id is not null;

create index if not exists firm_bills_abertas
  on public.firm_bills (client_id, due_date) where status = 'aberta';

comment on table public.firm_bills is
  'Contas a pagar da firma. NAO e contabilidade (o livro e por caixa, e a despesa vem do extrato): e o caixa diario -- o que se deve, para quem e quando vence.';
comment on column public.firm_bills.paid_tx_id is
  'bank_transactions.id do debito que pagou. Unico: um debito nao paga duas contas.';

-- == Conferencia ===========================================================
do $$
begin
  if to_regclass('public.firm_bills') is null then
    raise exception 'firm_bills nao foi criada';
  end if;

  if (select count(*) from pg_indexes
       where schemaname = 'public' and indexname = 'firm_bills_um_pagamento') <> 1
  then
    raise exception 'falta o indice firm_bills_um_pagamento -- um debito poderia pagar duas contas';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.firm_bills'::regclass) then
    raise exception 'firm_bills sem RLS -- responderia ao navegador com a anon key';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'firm_bills'
       and grantee in ('anon', 'authenticated'))
  then
    raise exception 'firm_bills ainda tem privilegio para anon/authenticated';
  end if;

  raise notice 'firm_bills: tabela, indice unico de pagamento, RLS e revoke no lugar';
end $$;

select count(*) as contas_a_pagar from public.firm_bills;
