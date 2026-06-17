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

CREATE POLICY "firm_all_messages" ON messages
  FOR ALL USING (
    (SELECT raw_user_meta_data->>'role' FROM auth.users WHERE id = auth.uid()) = 'firm'
  );

CREATE POLICY "client_own_messages" ON messages
  FOR ALL USING (
    client_id IN (SELECT id FROM clients WHERE user_id = auth.uid())
  );

SELECT 'Messages table created ✓' as status;
