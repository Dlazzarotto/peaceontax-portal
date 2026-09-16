// /portal/reports — Contabilidade do cliente (P&L, Balanço, Fornecedores, 1099)
//
// A tela é só o balcão: quem monta cada relatório são as rotas de
// `app/api/bookkeeping/` (pnl, balance-sheet, vendors), que já aceitam o
// próprio cliente quando ele é conta empresarial. Relatório abre em aba nova,
// pronto para imprimir.
//
// Só conta `business`: é quem tem bookkeeping. Pessoa física cai na home —
// o menu nem mostra o item, mas a URL digitada à mão também não passa.

import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'
import ClientReports from '@/components/portal/ClientReports'

export const dynamic = 'force-dynamic'

export default async function PortalReportsPage() {
  const user = await getUser()
  if (!user) redirect('/login')

  // Service role: contorna RLS da tabela clients
  const sbAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY!,
  )
  const { data: client } = await sbAdmin
    .from('clients')
    .select('id, name, business_name, type, language')
    .eq('user_id', user.id)
    .single()

  if (!client) redirect('/portal')
  if (client.type !== 'business') redirect('/portal')

  return (
    <ClientReports
      clientId={client.id}
      displayName={client.business_name || client.name || ''}
      lang={client.language || 'pt'}
    />
  )
}
