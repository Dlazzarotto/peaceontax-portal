-- Cancelamento de convite: tirar da fila sem apagar o rastro
--
-- A tela de convites so sabia criar e reenviar. Convite mandado para o
-- endereco errado, ou para quem desistiu, ficava na lista para sempre.
--
-- Apagar a linha resolveria a tela e violaria a secao 2 da especificacao
-- ("nada se apaga sem rastro"): perderiamos quem convidou quem, quando, e
-- com que texto. Entao cancelar preserva a linha e so muda a situacao --
-- a tela e que passa a esconder as canceladas.
--
-- Convite ja aceito (status 'registered') nao pode ser cancelado: virou
-- cliente, e o convite e a prova de como esse cliente entrou. A trava esta
-- na rota (app/api/invitations/[id]) e tambem aqui, no proprio banco.
--
-- Idempotente. Aplicar com:
--   npm run migrar -- sql/convite-cancelamento-v1.sql

-- ── 1. Situacao nova: 'cancelled' ─────────────────────────────────────────
alter table public.client_invitations
  drop constraint if exists client_invitations_status_check;

alter table public.client_invitations
  add constraint client_invitations_status_check
  check (status in ('pending', 'sent', 'opened', 'registered', 'expired', 'cancelled'));

-- ── 2. Quem cancelou, quando e por que ────────────────────────────────────
alter table public.client_invitations add column if not exists cancelled_at  timestamptz;
alter table public.client_invitations add column if not exists cancelled_by  text;
alter table public.client_invitations add column if not exists cancel_reason text;

-- Cancelado e cancelado: os tres campos andam juntos, e o motivo e obrigatorio.
alter table public.client_invitations
  drop constraint if exists client_invitations_cancel_chk;

alter table public.client_invitations
  add constraint client_invitations_cancel_chk
  check (
    (status <> 'cancelled' and cancelled_at is null)
    or
    (status = 'cancelled' and cancelled_at is not null
     and cancel_reason is not null and length(btrim(cancel_reason)) >= 3)
  );

-- Convite aceito nunca vira cancelado -- a prova de entrada do cliente fica.
create or replace function public.convite_nao_cancela_aceito()
returns trigger language plpgsql as $fn$
begin
  if new.status = 'cancelled' and old.status = 'registered' then
    raise exception 'Convite ja aceito nao pode ser cancelado (%).', old.client_email;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_convite_nao_cancela_aceito on public.client_invitations;
create trigger trg_convite_nao_cancela_aceito
  before update on public.client_invitations
  for each row execute function public.convite_nao_cancela_aceito();

-- A lista da tela nao traz cancelado; este indice serve esse filtro.
create index if not exists client_invitations_status_idx
  on public.client_invitations (status, created_at desc);

-- ── Conferencia ───────────────────────────────────────────────────────────
do $$
declare
  aceita_cancelado boolean;
  tem_colunas      integer;
  tem_gatilho      boolean;
begin
  select count(*) into tem_colunas
    from information_schema.columns
   where table_schema = 'public' and table_name = 'client_invitations'
     and column_name in ('cancelled_at', 'cancelled_by', 'cancel_reason');

  select pg_get_constraintdef(oid) like '%cancelled%' into aceita_cancelado
    from pg_constraint
   where conrelid = 'public.client_invitations'::regclass
     and conname  = 'client_invitations_status_check';

  select exists (
    select 1 from pg_trigger
     where tgrelid = 'public.client_invitations'::regclass
       and tgname  = 'trg_convite_nao_cancela_aceito'
  ) into tem_gatilho;

  raise notice 'colunas de cancelamento: % de 3', tem_colunas;
  raise notice 'situacao cancelled aceita: %', aceita_cancelado;
  raise notice 'gatilho que protege convite aceito: %', tem_gatilho;

  if tem_colunas < 3 or not aceita_cancelado or not tem_gatilho then
    raise exception 'Migracao incompleta -- confira os avisos acima';
  end if;
end $$;
