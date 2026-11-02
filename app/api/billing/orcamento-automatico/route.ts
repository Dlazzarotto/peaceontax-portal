// /api/billing/orcamento-automatico — o orçamento da declaração pelos documentos
//
//  GET ?clientId=&ano=  → { itens, total, perfil, aviso }   equipe, escopo por tipo
//
// Preenche os ITENS do orçamento no formulário do Financeiro — não grava
// nada. Era o "Gerar cotação automática" do módulo Quotes, que gravava numa
// tabela à parte (`quotes`), fora do Financeiro; com os orçamentos num lugar
// só (decisão do sócio), o cálculo serve o formulário e a equipe revisa e
// salva como qualquer documento. A regra está em lib/orcamento-automatico.ts.
//
// Empresa não tem cálculo automático: a declaração dela depende de
// avaliação, e um número calculado daria a impressão de que já foi avaliada.
//
// Nenhuma das três consultas pode falhar em silêncio: catálogo vazio vira
// "a base não existe", e documentos vazios viram um orçamento só com a base
// — um preço errado com cara de certo.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { perfilDosDocumentos, itensDaDeclaracao } from '@/lib/orcamento-automatico'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const sp = req.nextUrl.searchParams
  const clientId = sp.get('clientId') || ''
  const ano = Number(sp.get('ano'))
  if (!clientId) return NextResponse.json({ error: 'Escolha o cliente.' }, { status: 400 })
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) {
    return NextResponse.json({ error: 'Ano da declaração inválido.' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) {
    return NextResponse.json({ error: 'Sem acesso a este cliente' }, { status: 403 })
  }

  const db = serviceDb()
  const [
    { data: cliente, error: errCliente },
    { data: docs, error: errDocs },
    { data: catalogo, error: errCatalogo },
  ] = await Promise.all([
    db.from('clients').select('type, filing_status').eq('id', clientId).maybeSingle(),
    db.from('documents').select('doc_type, category, subcategory, file_name')
      .eq('client_id', clientId).eq('tax_year', ano),
    db.from('pricing_items').select('id, code, label, amount, active'),
  ])
  for (const [oque, err] of [['o cliente', errCliente], ['os documentos', errDocs], ['a tabela de Preços', errCatalogo]] as const) {
    if (err) return NextResponse.json({ error: `Não foi possível ler ${oque}: ${err.message}` }, { status: 500 })
  }
  if (!cliente) return NextResponse.json({ error: 'Cliente não encontrado' }, { status: 404 })
  if (cliente.type === 'business') {
    return NextResponse.json({
      error: 'Empresa não tem cálculo automático: a declaração depende de avaliação. Monte os itens do orçamento.',
    }, { status: 409 })
  }

  const perfil = perfilDosDocumentos(docs || [], cliente.filing_status)
  const r = itensDaDeclaracao(perfil, catalogo || [])
  if (r.ok === false) return NextResponse.json({ error: r.motivo }, { status: 409 })

  // O que a equipe precisa conferir antes de enviar — dito, não escondido.
  const avisos: string[] = []
  if (!perfil.documentos) avisos.push(`Nenhum documento de ${ano} na ficha: o cálculo deu só a declaração base.`)
  const semTipo = perfil.por1099.nao_identificado || 0
  if (semTipo) avisos.push(`${semTipo} 1099 sem o tipo no nome contou como Schedule C — confira se é NEC, MISC ou K.`)

  return NextResponse.json({ itens: r.itens, total: r.total, perfil, aviso: avisos.join(' ') || null })
}
