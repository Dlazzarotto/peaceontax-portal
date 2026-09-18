// lib/service-db.ts — o client com service role, num módulo sem dependências
//
// Existe separado de lib/api-auth.ts por causa de um ciclo de importação:
// `canAccessClient` precisa saber o NÍVEL de quem chama (para decidir se
// alguém sem `verEmpresas` pode abrir um cliente Empresa), e o nível vem de
// lib/staff-perms.ts — que precisava do `serviceDb` de api-auth. api-auth →
// staff-perms → api-auth.
//
// Em ESM esse ciclo às vezes funciona, porque a ligação se resolve na hora da
// chamada. "Às vezes funciona" não é base para controle de acesso: um dia a
// ordem de carga muda e o `serviceDb` chega `undefined` em produção. Com o
// módulo separado, os dois importam daqui e não há ciclo.
//
// api-auth.ts reexporta `serviceDb` para as ~40 rotas que já o importam de lá.

import { createClient } from '@supabase/supabase-js'

export function serviceDb() {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY
  if (!key) throw new Error('Service role key não configurada')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key)
}
