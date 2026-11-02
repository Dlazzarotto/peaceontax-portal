// /api/caixa/fluxo — fluxo de caixa da firma
//
// GET [?meses=12]  → realizado (pelo extrato), saldo em conta, projeção
//                    (faturas em aberto × contas a pagar em aberto) e os três
//                    números do topo do caixa (em aberto · a receber · pagas
//                    no mês)
//
// SÓ O SÓCIO. É o dinheiro da firma.
//
// Só leitura: não grava nada e não decide nada. A conta inteira mora em
// `lib/fluxo-de-caixa.ts`, que é puro e tem teste — aqui só se busca.
//
// TRÊS COISAS QUE PARECEM DETALHE E NÃO SÃO
// 1. O realizado lê SÓ O EXTRATO. O livro guarda também a conta de passagem
//    ("Recebimentos a depositar"), e somar as duas conta o mesmo depósito
//    duas vezes. A separação está explicada em lib/fluxo-de-caixa.ts.
// 2. O a receber é a carteira INTEIRA de clientes — inclusive as empresas
//    que o escopo por tipo esconde de quem não é sócio. Por isso esta rota
//    é do sócio e de mais ninguém: aqui não cabe `clientesOcultos`, cabe
//    não abrir a porta.
// 3. O PostgREST corta a resposta em 1000 linhas por padrão, e
//    `.limit(5000)` ou `.limit(20000)` NÃO passam disso. O extrato vinha com
//    `order('tx_date')` crescente: acima de mil linhas eram os meses
//    RECENTES que sumiam do fluxo, em silêncio. E a lista de faturas em
//    aberto parava na milésima — na temporada, com quase mil clientes, o
//    a receber ficava menor do que é. Tudo aqui é lido em páginas de 1000
//    com `order`, como já faz /api/bookkeeping/overview.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { idDaFirma } from '@/lib/caixa-firma'
import { dataDaFirma, janelaDaFirma } from '@/lib/dia-da-firma'
import { janelas } from '@/lib/painel'
import { fluxoRealizado, saldoEmConta, projetarCaixa,
         faturasEmAberto, aReceber, somaRecebido } from '@/lib/fluxo-de-caixa'
import { colunaAusente } from '@/lib/caixa-firma'

export const dynamic = 'force-dynamic'

const SO_O_SOCIO = 'O fluxo de caixa da firma é do sócio. Fale com ele.'
const SEM_CAIXA  = 'O caixa da firma ainda não existe. Crie em Caixa da firma.'

/**
 * As contas da firma, com o saldo que o banco informou.
 *
 * As colunas de saldo podem ainda não existir: o código sobe na Vercel a
 * cada push e a migração roda à mão. Sem isto, a tela inteira devolveria 500
 * entre o deploy e a migração — mesmo cuidado de `idDaFirma` com `is_firm`.
 * Sem o saldo o fluxo ainda mostra o realizado e diz que não sabe projetar.
 */
async function contasDaFirma(db: any, firma: string) {
  const busca = (campos: string) => db.from('bank_accounts').select(campos)
    .eq('client_id', firma).eq('active', true)
  const r = await busca('id, name, type, current_balance, balance_as_of')
  if (r.error && colunaAusente(r.error)) return busca('id, name, type')
  return r
}

/**
 * Lê TODAS as linhas de uma consulta, em páginas de 1000 com `order('id')`.
 * `monta` devolve um builder NOVO a cada página: o builder do supabase-js é
 * mutável, e reaproveitar um empilharia `range` sobre `range`.
 * Devolve `{ data, error }` como o supabase, para o laço de erros abaixo
 * tratar tudo do mesmo jeito.
 */
async function todasAsLinhas(monta: () => any): Promise<{ data: any[]; error: { message: string } | null }> {
  const PAGINA = 1000
  const linhas: any[] = []
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await monta().order('id').range(de, de + PAGINA - 1)
    if (error) return { data: linhas, error }
    linhas.push(...(data || []))
    if (!data || data.length < PAGINA) break
  }
  return { data: linhas, error: null }
}

/** Primeiro dia do mês, `n` meses atrás. */
function mesesAtras(hoje: string, n: number): string {
  const [a, m] = hoje.split('-').map(Number)
  const total = a * 12 + (m - 1) - n
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: SO_O_SOCIO }, { status: 403 })
  if ((await getStaffLevel(auth.userId)) !== 'owner')
    return NextResponse.json({ error: SO_O_SOCIO }, { status: 403 })

  const db = serviceDb()
  const firma = await idDaFirma(db)
  if (!firma) return NextResponse.json({ error: SEM_CAIXA }, { status: 400 })

  const hoje = dataDaFirma()
  const pedido = parseInt(req.nextUrl.searchParams.get('meses') || '12')
  const meses = Number.isFinite(pedido) ? Math.min(Math.max(pedido, 1), 60) : 12
  const de = mesesAtras(hoje, meses - 1)

  // "Pagas no mês" é o que ENTROU no mês do ESCRITÓRIO: a janela do relatório
  // de recebimentos (fim exclusivo, `.lt`), não a data UTC do servidor.
  const inicioMes = janelas(hoje).inicioMes
  const janela = janelaDaFirma(inicioMes, hoje)

  const [lanc, contas, faturas, aPagar, pagamentos] = await Promise.all([
    todasAsLinhas(() => db.from('bank_transactions')
      .select('id, tx_date, amount, source, account_id, transfer_match_id, balance')
      .eq('client_id', firma).gte('tx_date', de)),
    contasDaFirma(db, firma),
    // O que a firma tem a receber: faturas em aberto de TODOS os clientes.
    // A firma como cliente de si mesma não entra — ela não se deve nada.
    todasAsLinhas(() => db.from('invoices').select('id, due_date, total, paid_total, status, client_id')
      .in('status', ['sent', 'partial', 'overdue']).neq('client_id', firma)),
    db.from('firm_bills').select('id, due_date, amount, status')
      .eq('client_id', firma).eq('status', 'aberta').limit(2000),
    todasAsLinhas(() => db.from('invoice_payments').select('id, amount, received_at')
      .gte('received_at', janela.inicio).lt('received_at', janela.fimExclusivo)),
  ])

  // Cada consulta responde pelo próprio erro. Num Promise.all, conferir uma
  // e ignorar as outras faz a que falhou virar lista vazia — e aqui lista
  // vazia é a afirmação mais cara que existe: "não há nada a receber".
  for (const [oque, r] of [['os lançamentos', lanc], ['as contas bancárias', contas],
                           ['as faturas em aberto', faturas], ['as contas a pagar', aPagar],
                           ['os pagamentos do mês', pagamentos]] as const) {
    if (r.error) return NextResponse.json(
      { error: `Fluxo não calculado — falhou ao ler ${oque}: ${r.error.message}` }, { status: 500 })
  }

  // O realizado é da janela pedida. O SALDO não: o `balance` mais recente
  // pode estar fora dela num extrato parado há meses, e um saldo "de doze
  // meses atrás" apresentado como o de hoje é pior que nenhum.
  const { data: ultimos, error: errSaldo } = await db.from('bank_transactions')
    .select('account_id, tx_date, balance')
    .eq('client_id', firma).not('balance', 'is', null)
    .order('tx_date', { ascending: false }).limit(500)
  if (errSaldo) return NextResponse.json(
    { error: `Fluxo não calculado — falhou ao ler o saldo das contas: ${errSaldo.message}` }, { status: 500 })

  const saldo = saldoEmConta(contas.data || [], ultimos || [])
  const realizado = fluxoRealizado((lanc.data || []) as any, de, hoje)
  const projecao = projetarCaixa({
    saldoInicial: saldo.total,
    faturas: (faturas.data || []) as any,
    contas: (aPagar.data || []) as any,
    hoje,
  })

  // Os três números do topo. Definições em lib/fluxo-de-caixa.ts (com teste):
  // nenhuma conta nova aqui, só reuso do que a projeção já calculou.
  const resumo = {
    emAberto: faturasEmAberto((faturas.data || []) as any),
    aReceber: aReceber(projecao),
    recebidoNoMes: { ...somaRecebido((pagamentos.data || []) as any), desde: inicioMes },
  }

  return NextResponse.json({ hoje, de, meses, saldo, realizado, projecao, faturas: resumo })
}
