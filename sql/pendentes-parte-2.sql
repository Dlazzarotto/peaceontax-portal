-- sql/pendentes-parte-2.sql
-- TUDO O QUE FALTA, MENOS A TABELA. Cole isto de UMA VEZ no SQL Editor.
--
-- POR QUE EM DUAS PARTES
-- O SQL Editor do Supabase reescreve o script quando encontra `create table`
-- (e o detector dele confunde `select ... into <variavel>` de plpgsql com
-- criacao de tabela). Este arquivo NAO cria nenhuma tabela, entao o detector
-- nao engata. A unica migracao que cria tabela -- approval_codes -- vai
-- sozinha em sql/codigo-de-autorizacao-v1.sql, a PARTE 1, e la nao ha
-- nenhuma atribuicao de variavel por consulta.
--
-- ORDEM: rode a PARTE 1 primeiro (a tabela), depois esta.
--
-- Se o editor perguntar alguma coisa sobre "enable Row Level Security",
-- RECUSE: a RLS ja esta escrita dentro dos proprios scripts.
--
-- TUDO AQUI E IDEMPOTENTE. Rodar de novo o que ja rodou nao faz mal --
-- entao nao precisa lembrar o que ja foi aplicado.
--
-- O que entra, nesta ordem:
--   1. status-da-fatura-v2.sql                A definicao do status da fatura (data_da_firma, recalcular_status_da_fatura) -- as outras dependem dela
--   2. permissoes-por-pessoa-v4.sql           As quinze chaves de autorizacao no CHECK do banco
--   3. pricing-items-ativo-v1.sql             Servico novo nasce ativo no catalogo
--   4. codigo-de-autorizacao-funcao-v1.sql    O consumo atomico do codigo de autorizacao (a TABELA vem na PARTE 1)
--   5. recebimento-seguro-v1.sql              Estorno atomico e recusa de recebimento acima do saldo
--   6. rls-tabelas-expostas-v1.sql            RLS de staff_grants, staff_roles, schema_migrations e das views
--



-- ========================================================================
-- PARTE 2 · 1 de 6 — sql/status-da-fatura-v2.sql
-- ========================================================================

-- sql/status-da-fatura-v2.sql
-- O status da fatura passa a ser calculado por UMA funcao, e vencida com
-- pagamento parcial volta a contar como vencida.
--
-- DOIS DEFEITOS CORRIGIDOS
--
-- 1. VENCIDA COM ENTRADA SUMIA DA LISTA DE VENCIDAS.
--    A ordem do CASE punha `partial` antes de `overdue`: quem pagou $10 de
--    $1.000 e estava tres meses atrasado aparecia como "parcial", nunca como
--    "vencida". E exatamente o cliente que deu entrada e parou de pagar —
--    inadimplencia saindo do radar. Agora vencimento vence: `overdue` e
--    conferido antes de `partial`, e quanto entrou continua legivel em
--    `paid_total`. Quem lia status lia sempre os tres juntos
--    (`sent`/`partial`/`overdue`) como "em aberto", entao nenhuma tela muda
--    de comportamento; o relatorio de aging ja calculava pelo due_date.
--
-- 2. O VENCIMENTO VIRAVA AS 20H DE MALDEN.
--    `current_date` e a data do SERVIDOR, em UTC. A fatura passava a vencida
--    quando ainda era o dia anterior no escritorio. Agora a data e a do fuso
--    da firma, como lib/dia-da-firma.ts faz no lado do codigo.
--
-- UMA DEFINICAO SO
--    O calculo vivia no gatilho E em lib/estorno-stripe.ts, que escrevia
--    'partial'/'sent' na mao depois de desfazer um recebimento — sem olhar o
--    vencimento, ou seja, com o mesmo defeito 1. Agora existe
--    `recalcular_status_da_fatura(uuid)`: o gatilho chama, e o estorno chama
--    por RPC. Dois lugares calculando status divergem, e divergiram.
--
-- Idempotente. Nao altera dados por si: recalcula quando um pagamento muda.
-- Para acertar o historico de uma vez, o bloco final faz isso.

-- ── O fuso da firma, num lugar so ────────────────────────────────────────
create or replace function public.data_da_firma()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/New_York')::date
$$;

-- ── A definicao do status ────────────────────────────────────────────────
create or replace function public.recalcular_status_da_fatura(fid uuid)
returns void
language plpgsql
as $function$
declare
  soma numeric(12,2);
begin
  select coalesce(sum(amount), 0) into soma
    from invoice_payments where invoice_id = fid;

  update invoices set
    paid_total = soma,
    status = case
      -- Cancelada nao muda por pagamento nenhum
      when status = 'void' then 'void'
      -- Quitada e quitada
      when soma >= total and total > 0 then 'paid'
      -- VENCIMENTO VENCE: entrada nao esconde atraso
      when due_date is not null and due_date < public.data_da_firma() then 'overdue'
      -- Em aberto e dentro do prazo, com algo recebido
      when soma > 0 then 'partial'
      -- Saiu de paid/partial/overdue e nao ha o que marcar: volta a enviada
      when status in ('paid', 'partial', 'overdue') then 'sent'
      else status
    end,
    updated_at = now()
  where id = fid;
end $function$;

-- ── O gatilho passa a so chamar a funcao ─────────────────────────────────
create or replace function public.atualiza_saldo_da_fatura()
returns trigger
language plpgsql
as $function$
begin
  perform public.recalcular_status_da_fatura(coalesce(new.invoice_id, old.invoice_id));
  return null;
end $function$;

-- ── Acerta o historico ───────────────────────────────────────────────────
-- Faturas que hoje estao como `partial` mas ja venceram: passam a `overdue`.
-- Nada de dinheiro se move; e so a leitura ficando honesta.
do $$
declare
  corrigidas integer;
begin
  with alvo as (
    select id from invoices
     where status = 'partial'
       and due_date is not null
       and due_date < public.data_da_firma()
  ), feito as (
    update invoices set status = 'overdue', updated_at = now()
     where id in (select id from alvo) returning 1
  )
  select count(*) into corrigidas from feito;
  raise notice 'faturas vencidas que estavam como parcial: %', corrigidas;
end $$;

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  f1 integer; f2 integer; f3 integer; restou integer;
begin
  select count(*) into f1 from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'data_da_firma';
  select count(*) into f2 from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'recalcular_status_da_fatura';
  select count(*) into f3 from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'atualiza_saldo_da_fatura';
  select count(*) into restou from invoices
   where status = 'partial' and due_date is not null and due_date < public.data_da_firma();

  raise notice 'data_da_firma: % | recalcular_status_da_fatura: % | atualiza_saldo_da_fatura: %', f1, f2, f3;
  raise notice 'vencidas ainda marcadas como parcial (esperado 0): %', restou;
  if f1 <> 1 or f2 <> 1 or f3 <> 1 then
    raise exception 'Alguma funcao nao ficou criada';
  end if;
  if restou <> 0 then
    raise exception 'Sobraram % faturas vencidas como parcial', restou;
  end if;
end $$;


-- ========================================================================
-- PARTE 2 · 2 de 6 — sql/permissoes-por-pessoa-v4.sql
-- ========================================================================

-- sql/permissoes-por-pessoa-v4.sql
-- Duas chaves novas, decididas pelo socio:
--   verEmpresas    — sem ela, a pessoa ve e atende apenas PESSOA FISICA.
--                    Empresa e a carteira do ano todo (bookkeeping, payroll,
--                    EIN); pessoa fisica e a temporada e o balcao.
--   baixarArquivo  — abrir/salvar declaracao, W-2, extrato. VER A LISTA
--                    continua liberado: baixar nao e ver, e o arquivo e o que
--                    sai do predio.
--
-- Com isto o TIPO do cliente passa a ser fronteira de acesso — por isso
-- troca-lo na ficha pede senha e motivo e sai na trilha como type_changed.
--
-- Substitui o CHECK da v3 (que por sua vez continha a v2). Rodar so esta
-- basta, desde que a v1 (a tabela) ja tenha rodado. Idempotente.

do $$
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'staff_grants'
  ) then
    raise exception 'Rode sql/permissoes-por-pessoa-v1.sql primeiro.';
  end if;
end $$;

alter table public.staff_grants drop constraint if exists staff_grants_chave_ck;
alter table public.staff_grants add constraint staff_grants_chave_ck
  check (chave in (
    'criar','enviar','verTodasFaturas','receber','duplicar','editar','estornar',
    'cancelar','apagar','darDesconto',
    'verEmpresas','editarCliente','baixarArquivo',
    'verRelatorios','verTotais'
  ));

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  limpas integer;
begin
  begin
    insert into public.staff_grants (user_id, chave, concedido, concedido_por, motivo)
    values ('00000000-0000-0000-0000-000000000000','verEmpresas',true,
            '00000000-0000-0000-0000-000000000000','conferencia da migracao'),
           ('00000000-0000-0000-0000-000000000000','baixarArquivo',true,
            '00000000-0000-0000-0000-000000000000','conferencia da migracao');
  exception when check_violation then
    raise exception 'O CHECK nao aceitou as chaves novas -- migracao incompleta';
  end;

  delete from public.staff_grants
   where user_id = '00000000-0000-0000-0000-000000000000';
  get diagnostics limpas = row_count;

  raise notice 'chaves novas aceitas; linhas de teste removidas: %', limpas;
  if limpas <> 2 then
    raise exception 'Conferencia inconsistente -- esperado 2, veio %', limpas;
  end if;
end $$;


-- ========================================================================
-- PARTE 2 · 3 de 6 — sql/pricing-items-ativo-v1.sql
-- ========================================================================

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


-- ========================================================================
-- PARTE 2 · 4 de 6 — sql/codigo-de-autorizacao-funcao-v1.sql
-- ========================================================================

-- sql/codigo-de-autorizacao-funcao-v1.sql
-- O consumo do codigo de autorizacao. Roda DEPOIS de
-- sql/codigo-de-autorizacao-v1.sql, que cria a tabela approval_codes.
--
-- POR QUE ESTA SEPARADO
-- O SQL Editor do Supabase reescreve todo script que contem `create table`
-- (e o que oferece ligar a RLS). O separador de comandos dessa reescrita
-- entende `$$` e NAO entende tag nomeada como uma tag NOMEADA: ele parte o
-- corpo da funcao no primeiro `;` e devolve
-- `unterminated dollar-quoted string`. Arquivo que cria tabela, portanto,
-- nao define funcao -- e aqui, por seguranca, a tag e `$$` mesmo.
--
-- O CONSUMO E ATOMICO, e isso e o ponto.
-- Dois atendentes com o mesmo numero no papel nao podem liberar duas
-- cobrancas. Quem decide e um UPDATE condicional
-- (`where usado_em is null and expira_em > now()`) com RETURNING: o Postgres
-- serializa, o segundo nao acha linha e recebe 'ja_usado'. Conferir antes e
-- gravar depois, em dois passos, deixaria a janela aberta.
--
-- Idempotente (create or replace).

-- ── O consumo ────────────────────────────────────────────────────────────
create or replace function public.consumir_codigo_de_autorizacao(
  p_codigo     text,
  p_usado_por  uuid,
  p_invoice_id uuid,
  p_valor      numeric,
  p_forma      text
)
returns table (ok boolean, motivo text, emitido_por uuid)
language plpgsql
as $$
declare
  emissor uuid;
begin
  -- Primeiro TENTA consumir. A condicao esta no proprio UPDATE, entao dois
  -- pedidos simultaneos com o mesmo codigo nao passam os dois.
  update public.approval_codes ac set
    usado_em   = now(),
    usado_por  = p_usado_por,
    invoice_id = p_invoice_id,
    valor      = p_valor,
    forma      = p_forma
   where ac.codigo = upper(btrim(p_codigo))
     and ac.usado_em is null
     and ac.expira_em > now()
  returning ac.emitido_por into emissor;

  if emissor is not null then
    return query select true, 'ok'::text, emissor;
    return;
  end if;

  -- Nao consumiu: agora sim vale explicar por que.
  --
  -- Aqui NAO se usa `select ... into <variavel>`: o editor de SQL do Supabase
  -- le essa linha como o `SELECT ... INTO <tabela>` do SQL puro, conclui que
  -- a migracao criou uma tabela com o nome da VARIAVEL e reescreve o script
  -- para acrescentar `alter table <variavel> enable row level security` --
  -- cortando o corpo da funcao no meio. O erro que aparece e
  -- "unterminated dollar-quoted string", que nao tem nada a ver com a causa.
  -- RETURN QUERY preenche FOUND, entao da para decidir sem variavel nenhuma.
  return query
  select false,
         (case when ac.usado_em is not null then 'ja_usado' else 'expirado' end)::text,
         ac.emitido_por
    from public.approval_codes ac
   where ac.codigo = upper(btrim(p_codigo));

  if not found then
    return query select false, 'nao_encontrado'::text, null::uuid;
  end if;
end $$;


-- ── Conferencia ─────────────────────────────────────────
do $$
declare
  f integer;
begin
  select count(*) into f from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname = 'consumir_codigo_de_autorizacao';
  raise notice 'funcao consumir_codigo_de_autorizacao: %', f;
  if f <> 1 then
    raise exception 'Funcao nao criada -- confira os avisos acima';
  end if;
end $$;


-- ========================================================================
-- PARTE 2 · 5 de 6 — sql/recebimento-seguro-v1.sql
-- ========================================================================

-- sql/recebimento-seguro-v1.sql
-- Duas travas de dinheiro que estavam no CODIGO e por isso nao valiam sob
-- concorrencia. Ambas viram regra do BANCO.
--
-- RODE DEPOIS de sql/status-da-fatura-v2.sql (usa recalcular_status_da_fatura).
--
-- 1) ESTORNO ATOMICO, E SEM PERDER O RASTRO
--    O estorno manual (/api/billing/payments) gravava payment_reversals com
--    `.then(() => null, () => null)` -- erro descartado -- e DEPOIS apagava o
--    recebimento. Se o rastro falhasse, o dinheiro sumia sem registro, que e
--    o oposto do principio 2 e o oposto do que o irmao dele
--    (lib/estorno-stripe.ts) ja fazia certo: la o rastro e conferido e o
--    recebimento e PRESERVADO quando ele falha.
--    Alem disso era conferir-e-apagar em dois passos: dois estornos
--    simultaneos do mesmo recebimento gravavam DOIS rastros.
--    Aqui os dois passos viram um: o DELETE ... RETURNING trava a linha (o
--    segundo pedido nao acha nada e recebe 'ja_estornado'), e se o INSERT do
--    rastro falhar a transacao inteira volta atras -- o recebimento fica.
--
-- 2) RECEBIMENTO ACIMA DO SALDO
--    A rota confere `valor > saldo` antes de gravar. Conferir antes e gravar
--    depois deixa a janela aberta: o Zelle digitado no balcao e o webhook do
--    Stripe chegando juntos leem o mesmo saldo e os dois passam. A fatura
--    fica com paid_total maior que o total, e ninguem percebe.
--    O gatilho passa a recusar. So em INSERT/UPDATE: em DELETE, nao --
--    senao uma fatura que JA esteja com sobra nao poderia nem ser estornada.
--
-- Idempotente. Nao cria tabela e nao atribui variavel por consulta fora de
-- funcao (ver CLAUDE.md sobre o SQL Editor do Supabase).

do $$
begin
  if to_regprocedure('public.recalcular_status_da_fatura(uuid)') is null then
    raise exception 'Rode sql/status-da-fatura-v2.sql antes desta migracao';
  end if;
end $$;

-- ── 1. Estorno atomico ───────────────────────────────────────────────────
create or replace function public.estornar_recebimento(
  p_payment_id   uuid,
  p_reason       text,
  p_performed_by uuid,
  p_staff_level  text
)
returns table (ok boolean, motivo text, valor numeric, fatura uuid)
language plpgsql
as $function$
declare
  pg record;
begin
  -- Um passo so: apaga E devolve o que apagou. O segundo pedido simultaneo
  -- espera a trava, nao encontra linha e sai com 'ja_estornado'.
  delete from public.invoice_payments where id = p_payment_id returning * into pg;

  if pg.id is null then
    return query select false, 'ja_estornado'::text, null::numeric, null::uuid;
    return;
  end if;

  -- Se este insert falhar, a excecao desfaz o delete acima: o recebimento
  -- FICA. "Nada se apaga sem rastro" deixa de depender de quem escreveu a rota.
  insert into public.payment_reversals
    (invoice_id, amount, method, reference, stripe_object, reason, performed_by, staff_level)
  values
    (pg.invoice_id, pg.amount, pg.method, pg.reference, pg.stripe_object,
     coalesce(nullif(btrim(p_reason), ''), 'estorno'), p_performed_by, p_staff_level);

  return query select true, 'ok'::text, pg.amount, pg.invoice_id;
end $function$;

-- ── 2. Recebimento acima do saldo ────────────────────────────────────────
create or replace function public.atualiza_saldo_da_fatura()
returns trigger
language plpgsql
as $function$
declare
  fid uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  perform public.recalcular_status_da_fatura(fid);

  -- So quando ENTRA dinheiro. Em DELETE (estorno) nunca: uma fatura que ja
  -- esteja com sobra tem de poder ser corrigida.
  if tg_op <> 'DELETE' then
    if (select paid_total - total from public.invoices where id = fid) > 0.005 then
      raise exception
        'Recebimento acima do saldo desta fatura. Outro lancamento entrou ao mesmo tempo -- confira os recebimentos antes de repetir.'
        using errcode = 'check_violation';
    end if;
  end if;

  return null;
end $function$;

-- == Conferencia ===========================================================
do $$
begin
  if to_regprocedure('public.estornar_recebimento(uuid,text,uuid,text)') is null then
    raise exception 'estornar_recebimento nao ficou criada';
  end if;
  if to_regprocedure('public.atualiza_saldo_da_fatura()') is null then
    raise exception 'atualiza_saldo_da_fatura nao ficou criada';
  end if;
  if (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'atualiza_saldo_da_fatura' and not t.tgisinternal) = 0 then
    raise exception 'Nenhum gatilho usa atualiza_saldo_da_fatura -- o saldo nao seria recalculado';
  end if;
  raise notice 'estorno atomico e trava de recebimento acima do saldo: instalados';
end $$;

-- Faturas que JA estao com recebimento acima do total (se houver, sao de
-- antes desta trava e precisam de decisao humana).
select i.number, i.total, i.paid_total, round(i.paid_total - i.total, 2) as sobra
  from public.invoices i
 where i.paid_total - i.total > 0.005
 order by (i.paid_total - i.total) desc;


-- ========================================================================
-- PARTE 2 · 6 de 6 — sql/rls-tabelas-expostas-v1.sql
-- ========================================================================

-- sql/rls-tabelas-expostas-v1.sql
-- Fechar staff_grants (e a view staff_grants_atual) para o navegador.
--
-- O QUE ACONTECEU
-- Das 18 tabelas do sistema, 16 nascem com `enable row level security` e
-- `revoke all ... from anon, authenticated` -- o padrao que sql/whatsapp-
-- atendimento-v1.sql escreveu e explicou. As DUAS que faltavam sao as duas
-- que eu criei: staff_grants (ja aplicada) e approval_codes (a v1 dela ja
-- ficou corrigida no proprio arquivo).
--
-- POR QUE ISSO IMPORTA
-- No Supabase, tabela nova no schema public nasce com privilegio para anon e
-- authenticated -- a RLS e que segura. Sem RLS, a tabela responde pelo
-- PostgREST a QUALQUER pessoa com a anon key, que esta no navegador de todo
-- mundo que entra no portal.
--
-- Em staff_grants isso nao e vazamento, e ESCALADA: a tabela e append-only e
-- o estado atual e a ultima linha de cada chave. Uma unica linha inserida
-- pelo navegador (`concedido = true`, chave `receber` ou `verTotais`) passa a
-- valer em permissoesDe. Quem concede tinha de ser socio, com senha e motivo;
-- pela porta dos fundos nao precisava de nada disso.
--
-- A VIEW TAMBEM
-- View no Postgres roda com o dono, nao com quem chama: RLS na tabela nao
-- protege quem le pela view. Por isso a view leva revoke propria.
--
-- Nenhuma policy, de proposito: quem trabalha nestas tabelas e o servidor,
-- com a service role key, que passa por cima da RLS.
--
-- Idempotente.

alter table public.staff_grants enable row level security;
revoke all on public.staff_grants       from anon, authenticated;
revoke all on public.staff_grants_atual from anon, authenticated;

-- approval_codes pode ainda nao existir (a migracao dela e outra). Se ja
-- existir, fecha aqui tambem -- rodar as duas em qualquer ordem da no mesmo.
do $$
begin
  if to_regclass('public.approval_codes') is not null then
    execute 'alter table public.approval_codes enable row level security';
    execute 'revoke all on public.approval_codes from anon, authenticated';
  end if;
end $$;

-- staff_roles e a tabela do NIVEL (owner/manager/junior) e nao esta em
-- nenhum arquivo .sql -- nasceu no painel, e por isso ninguem sabe em que
-- estado ela esta. Desde que o papel passou a se apoiar nela
-- (sql/papel-no-app-metadata-v1.sql), uma linha inserida pelo navegador
-- viraria promocao. Fechar aqui custa nada e e idempotente.
do $$
begin
  if to_regclass('public.staff_roles') is not null then
    execute 'alter table public.staff_roles enable row level security';
    execute 'revoke all on public.staff_roles from anon, authenticated';
  end if;
end $$;

-- wa_relatorio_atendimento: a view do atendimento por WhatsApp/SMS.
-- As tabelas de baixo (wa_conversations, wa_messages) ja tinham RLS e
-- revoke desde sql/whatsapp-atendimento-v1.sql -- a VIEW nao. E view roda
-- com o dono, nao com quem chama: ela entregava o historico inteiro
-- (telefone, canal, contagem de mensagens, client_id) a quem tivesse a
-- anon key. Conversa de cliente e justamente o que a firma nao expoe.
do $$
begin
  if to_regclass('public.wa_relatorio_atendimento') is not null then
    execute 'revoke all on public.wa_relatorio_atendimento from anon, authenticated';
  end if;
end $$;

-- security_invoker: a view passa a respeitar a RLS de QUEM CONSULTA, e nao
-- a do dono. E o cinto alem do revoke -- o padrao que sql/painel-v1.sql ja
-- usava. Em versao que nao suporta, segue sem ele (o revoke e o que segura).
do $$
declare
  v text;
begin
  foreach v in array array['public.staff_grants_atual','public.wa_relatorio_atendimento'] loop
    if to_regclass(v) is not null then
      begin
        execute format('alter view %s set (security_invoker = on)', v);
      exception when others then
        raise notice 'security_invoker indisponivel para % -- seguindo sem ele', v;
      end;
    end if;
  end loop;
end $$;

-- schema_migrations e o livro das migracoes. A consulta do fim desta
-- migracao mostrou que e a UNICA tabela do schema public ainda sem RLS --
-- e sem privilegio direto para anon/authenticated, entao nao e alcancavel
-- hoje. Fica fechada assim mesmo: e uma linha, e o proximo privilegio
-- concedido por engano nao encontraria a porta aberta.
do $$
begin
  if to_regclass('public.schema_migrations') is not null then
    execute 'alter table public.schema_migrations enable row level security';
    execute 'revoke all on public.schema_migrations from anon, authenticated';
  end if;
end $$;

-- == Conferencia ===========================================================
do $$
declare
  g boolean;
  p_tab integer;
  p_view integer;
begin
  select relrowsecurity into g from pg_class where oid = 'public.staff_grants'::regclass;

  -- Privilegio que sobrou para anon/authenticated (esperado: zero)
  select count(*) into p_tab from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'staff_grants'
     and grantee in ('anon','authenticated');
  select count(*) into p_view from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'staff_grants_atual'
     and grantee in ('anon','authenticated');

  raise notice 'staff_grants RLS: % | privilegios anon/authenticated -- tabela: % view: %', g, p_tab, p_view;
  if g is not true or p_tab <> 0 or p_view <> 0 then
    raise exception 'RLS incompleta -- confira os avisos acima';
  end if;
end $$;

-- == O que AINDA responde ao navegador ====================================
-- As tabelas de faturamento, planos e bookkeeping nasceram no painel, fora
-- de qualquer arquivo .sql -- daqui nao da para saber o estado delas. Esta
-- consulta nao muda nada: lista o que falta. Tabela em public sem RLS
-- responde ao PostgREST para quem tem a anon key.
select c.relname as tabela_sem_rls,
       coalesce(string_agg(distinct g.grantee, ', '), 'sem privilegio direto') as quem_alcanca
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join information_schema.role_table_grants g
         on g.table_schema = 'public' and g.table_name = c.relname
        and g.grantee in ('anon','authenticated')
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
 group by c.relname
 order by c.relname;


-- ============================================================================
-- CONFERENCIA FINAL — sem atribuir variavel por consulta, de proposito
-- ============================================================================
do $$
begin
  if to_regprocedure('public.data_da_firma()') is null then
    raise exception 'FALTOU: data_da_firma';
  end if;
  if to_regprocedure('public.recalcular_status_da_fatura(uuid)') is null then
    raise exception 'FALTOU: recalcular_status_da_fatura';
  end if;
  if to_regprocedure('public.estornar_recebimento(uuid,text,uuid,text)') is null then
    raise exception 'FALTOU: estornar_recebimento';
  end if;
  if to_regprocedure('public.consumir_codigo_de_autorizacao(text,uuid,uuid,numeric,text)') is null then
    raise exception 'FALTOU: consumir_codigo_de_autorizacao -- rode a PARTE 1 (a tabela) e depois esta de novo';
  end if;
  if (select count(*) from pg_class
       where oid = 'public.staff_grants'::regclass and relrowsecurity) <> 1 then
    raise exception 'FALTOU: RLS em staff_grants';
  end if;
  raise notice 'TUDO CERTO: status da fatura, 15 chaves, catalogo ativo, codigo de autorizacao, estorno atomico e RLS.';
end $$;
