-- sql/pricing-items-ativo-v1.sql
-- Servico novo nasce ATIVO no catalogo (pricing_items.active).
--
-- O QUE ACONTECIA
-- O POST de /api/pricing criava o item sem gravar `active`. A tela de Precos
-- lista TUDO, entao o item aparecia la; a fatura e o contrato mensal exigiam
-- `active = true`, entao o item NAO aparecia onde seria usado. Quem cadastrou
-- ve o servico na tabela de precos e nao o encontra na hora de faturar --
-- parece que a lista da fatura "nao atualiza".
--
-- O conserto e nos dois lados:
--   codigo  -- o POST grava `active: true`, e quem le trata NULO como ativo
--             (lib/catalogo-precos.ts): desativar e um ATO, e ele grava false;
--   banco   -- esta migracao acerta as linhas que ja nasceram nulas e poe o
--             `default` na coluna, para nao depender de quem insere.
--
-- A tabela pricing_items nasceu no painel e nao estava em nenhum .sql. Este
-- arquivo nao a cria (nao ha `create table` aqui) -- so acerta a coluna e
-- deixa registrado o que ela deve garantir.
--
-- Idempotente. Nao atribui variavel por consulta (o SQL Editor do Supabase
-- le isso como criacao de tabela).

-- 1) A coluna existe? Se nao, cria ja com o default certo.
alter table public.pricing_items
  add column if not exists active boolean not null default true;

-- 2) Coluna que ja existia: garante o default para quem inserir sem dizer.
alter table public.pricing_items
  alter column active set default true;

-- 3) Linhas que nasceram nulas voltam a existir para a fatura.
update public.pricing_items set active = true where active is null;

-- == Conferencia ===========================================================
do $$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'pricing_items'
         and column_name = 'active') <> 1
  then
    raise exception 'pricing_items.active nao existe';
  end if;

  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'pricing_items'
         and column_name = 'active') is distinct from 'true'
  then
    raise exception 'pricing_items.active sem default true -- item novo nasceria invisivel na fatura';
  end if;

  if (select count(*) from public.pricing_items where active is null) <> 0
  then
    raise exception 'ainda ha item com active nulo';
  end if;

  raise notice 'pricing_items.active: coluna, default true e nenhum nulo';
end $$;

-- Quantos itens a fatura enxerga agora
select count(*) filter (where active)           as ativos,
       count(*) filter (where not active)       as desativados,
       count(*)                                  as total
  from public.pricing_items;
