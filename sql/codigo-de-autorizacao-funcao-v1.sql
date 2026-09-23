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
