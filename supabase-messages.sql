-- Messages table for client-firm communication
CREATE TABLE IF NOT EXISTS messages (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  sender     text not null check (sender in ('client','firm')),
  text       text not null,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- A EQUIPE TRABALHA PELO SERVIDOR com a service role (passa por cima da RLS).
-- A policy `firm_all_messages` lia raw_user_meta_data por subconsulta em
-- auth.users (forjavel em tese, e `permission denied` na pratica). Sai, e a
-- tabela fecha para o navegador. Ver sql/rls-tabelas-expostas-v2.sql.
DROP POLICY IF EXISTS "firm_all_messages" ON messages;
REVOKE ALL ON messages FROM anon, authenticated;

CREATE POLICY "client_own_messages" ON messages
  FOR ALL USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );

SELECT 'Messages table created ✓' as status;
