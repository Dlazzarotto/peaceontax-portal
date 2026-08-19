-- ============================================================
-- WHATSAPP — ATENDIMENTO v1
-- Complementa o whatsapp-base.sql que já está no banco
-- (wa_conversations, wa_messages, pode_mensagem_livre, trg_wa_toca)
--
-- Este arquivo é idempotente: pode rodar duas vezes sem quebrar.
-- ============================================================

-- ── 1. Canal (whatsapp | sms) ───────────────────────────────
-- Motivo: o 617 vai para WhatsApp e o 857 fica com SMS. Sem o
-- canal, o mesmo cliente falando pelos dois vira UMA conversa
-- só, com o histórico embaralhado — e a janela de 24h do
-- WhatsApp seria aplicada a SMS, que não tem essa regra.
alter table wa_conversations add column if not exists canal text not null default 'whatsapp';
alter table wa_messages      add column if not exists canal text not null default 'whatsapp';

do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'wa_conversations_canal_chk') then
    alter table wa_conversations add constraint wa_conversations_canal_chk
      check (canal in ('whatsapp','sms'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wa_messages_canal_chk') then
    alter table wa_messages add constraint wa_messages_canal_chk
      check (canal in ('whatsapp','sms'));
  end if;
end $do$;

drop index if exists idx_wa_fone;
create unique index if not exists idx_wa_fone_canal on wa_conversations (phone, canal);

-- ── 2. Marcos do atendimento (base do relatório do sócio) ───
alter table wa_conversations add column if not exists assumida_em  timestamptz;
alter table wa_conversations add column if not exists resolvida_em timestamptz;

-- ── 3. Templates aprovados pela Meta ────────────────────────
-- Fora da janela de 24h só sai template. Enquanto esta tabela
-- estiver vazia, a tela BLOQUEIA o envio fora da janela — é o
-- comportamento correto: a mensagem seria recusada pela Meta.
create table if not exists wa_templates (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null unique,           -- identificação interna
  descricao   text,
  content_sid text not null,                  -- HX... do Twilio Content Template
  corpo       text not null,                  -- prévia com {{1}}, {{2}} para a equipe ler
  variaveis   integer not null default 0,
  idioma      text not null default 'pt_BR',
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ── 4. Casar telefone recebido com o cadastro do cliente ────
-- Descobre sozinha qual é a coluna de telefone da tabela clients
-- e compara pelos 10 últimos dígitos (ignora +1, parênteses e traço).
do $do$
declare col text;
begin
  select column_name into col
    from information_schema.columns
   where table_schema = 'public' and table_name = 'clients'
     and column_name in ('phone','telefone','phone_number','celular','mobile','whatsapp')
   order by array_position(
     array['phone','telefone','phone_number','celular','mobile','whatsapp'], column_name)
   limit 1;

  if col is null then
    raise notice 'Nenhuma coluna de telefone encontrada em clients — casamento automatico desativado.';
    execute 'create or replace function wa_client_por_telefone(p text) returns uuid
             language sql stable as $fn$ select null::uuid $fn$';
  else
    raise notice 'Casamento por telefone usando clients.%', col;
    execute format($fmt$
      create or replace function wa_client_por_telefone(p text) returns uuid
      language sql stable as $fn$
        select c.id from clients c
         where length(regexp_replace(coalesce(c.%I, ''), '[^0-9]', '', 'g')) >= 10
           and right(regexp_replace(coalesce(c.%I, ''), '[^0-9]', '', 'g'), 10)
             = right(regexp_replace(coalesce(p, ''),  '[^0-9]', '', 'g'), 10)
         limit 1
      $fn$
    $fmt$, col, col);
  end if;
end $do$;

-- ── 5. Onde ficam as fotos e PDFs recebidos ─────────────────
-- O link que a Twilio manda exige autenticação e expira: se
-- guardarmos só ele, o anexo some da tela. Baixamos o arquivo
-- para um bucket PRIVADO (são documentos fiscais) e a tela abre
-- por link assinado de curta duração.
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do nothing;

-- ── 6. Relatório de atendimento (base para a tela do sócio) ─
create or replace view wa_relatorio_atendimento as
select
  c.id, c.client_id, c.phone, c.canal, c.status, c.atendente_id,
  c.created_at, c.assumida_em, c.resolvida_em, c.ultima_mensagem,
  (select min(m.created_at) from wa_messages m
     where m.conversation_id = c.id and m.autor = 'equipe') as primeira_resposta_equipe,
  (select count(*) from wa_messages m
     where m.conversation_id = c.id and m.autor = 'bot')    as msgs_bot,
  (select count(*) from wa_messages m
     where m.conversation_id = c.id and m.autor = 'equipe') as msgs_equipe,
  (select count(*) from wa_messages m
     where m.conversation_id = c.id and m.autor = 'cliente') as msgs_cliente
from wa_conversations c;

-- ── 7. Segurança ────────────────────────────────────────────
-- RLS ligada e SEM policy é proposital: nenhum navegador lê estas
-- tabelas direto. Todo acesso passa pelas rotas do servidor, que
-- conferem sócio/gerente antes de consultar com a service key.
-- Efeito colateral aceito: Supabase Realtime não funciona aqui,
-- por isso a tela atualiza por consulta periódica.
alter table wa_conversations enable row level security;
alter table wa_messages      enable row level security;
alter table wa_templates     enable row level security;

revoke all on wa_conversations from anon, authenticated;
revoke all on wa_messages      from anon, authenticated;
revoke all on wa_templates     from anon, authenticated;

-- ── 8. Comentários no schema (documentação viva) ────────────
-- Ficam DENTRO desta migração de propósito: rodar solto, antes
-- das colunas existirem, dá erro 42703.
comment on column wa_messages.autor_nome is
  'INTERNO. Quem escreveu (equipe) ou o motivo (bot). O cliente NUNCA ve este nome — toda mensagem sai como Peace on Tax. Alimenta o relatorio de atendimento.';
comment on column wa_conversations.canal is
  'whatsapp (617, janela de 24h) ou sms (857, sem janela).';
comment on column wa_conversations.assumida_em is
  'Quando alguem da equipe assumiu. Base do tempo de resposta no relatorio.';
comment on table wa_templates is
  'Templates aprovados pela Meta. Sem linha aqui, envio fora da janela de 24h fica bloqueado na tela — que e o comportamento correto.';

-- ── Conferência ─────────────────────────────────────────────
select 'canal em conversations' as item,
       count(*) filter (where column_name = 'canal') as ok
  from information_schema.columns
 where table_name = 'wa_conversations'
union all
select 'assumida_em/resolvida_em', count(*)
  from information_schema.columns
 where table_name = 'wa_conversations' and column_name in ('assumida_em','resolvida_em')
union all
select 'wa_templates', count(*) from information_schema.tables where table_name = 'wa_templates'
union all
select 'funcao wa_client_por_telefone', count(*) from pg_proc where proname = 'wa_client_por_telefone'
union all
select 'view wa_relatorio_atendimento', count(*) from pg_views where viewname = 'wa_relatorio_atendimento';
