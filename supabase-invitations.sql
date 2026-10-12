-- ═══════════════════════════════════════════════════════════
-- PeaceOnTax — Client Invitation System
-- Run this in: Supabase → SQL Editor → New Query
-- (Run AFTER supabase-schema.sql)
-- ═══════════════════════════════════════════════════════════

-- ─── CLIENT INVITATIONS ───────────────────────────────────
create table if not exists client_invitations (
  id            uuid primary key default gen_random_uuid(),
  token         text unique not null default encode(gen_random_bytes(32), 'hex'),
  client_name   text not null,
  client_email  text not null,
  client_phone  text,
  client_type   text not null check (client_type in ('business','individual')),
  language      text not null default 'en' check (language in ('en','pt','es','zh')),
  assignee      text,
  sent_via      text[] not null default '{}',   -- ['email','sms','whatsapp']
  status        text not null default 'pending'
                  check (status in ('pending','sent','opened','registered','expired')),
  expires_at    timestamptz not null default (now() + interval '7 days'),
  opened_at     timestamptz,
  registered_at timestamptz,
  sent_at       timestamptz,
  message_note  text,          -- custom note from the firm
  created_by    text,          -- firm staff name
  created_at    timestamptz not null default now()
);

-- Track every send attempt (email, sms, resend, etc.)
create table if not exists invitation_logs (
  id            uuid primary key default gen_random_uuid(),
  invitation_id uuid not null references client_invitations(id) on delete cascade,
  channel       text not null check (channel in ('email','sms','whatsapp','copy')),
  recipient     text not null,   -- email address or phone number
  status        text not null default 'sent',
  provider_id   text,            -- Twilio message SID or Resend email ID
  error         text,
  created_at    timestamptz not null default now()
);

-- Indexes
create index if not exists idx_invitations_token   on client_invitations(token);
create index if not exists idx_invitations_email   on client_invitations(client_email);
create index if not exists idx_invitations_status  on client_invitations(status);
create index if not exists idx_inv_logs_invitation on invitation_logs(invitation_id);

-- RLS — only firm staff can manage invitations
alter table client_invitations enable row level security;
alter table invitation_logs     enable row level security;

-- FECHADO PARA O NAVEGADOR: quem le/grava convite e o servidor com a service
-- role. A policy `firm_manage_*` lia user_metadata (campo que o cliente forja,
-- ver supabase-schema.sql) e `public_read_invite_by_token` (using true)
-- entregava a tabela inteira -- com o TOKEN que cria a conta -- a qualquer um
-- com a anon key, SEM login. O convite e validado por /api/invite/[token] com
-- a service role, nao pelo navegador, entao a leitura publica nao servia a
-- nada. Historico e conserto: sql/rls-tabelas-expostas-v2.sql.
revoke all on client_invitations, invitation_logs from anon, authenticated;

select 'Invitation schema created ✓' as status;
