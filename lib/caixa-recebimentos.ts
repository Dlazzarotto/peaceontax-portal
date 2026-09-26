// Os recebimentos de fatura entrando no livro da firma.
//
// REGRA (seção 4.2 da especificação): a contabilidade fiscal da firma é por
// REGIME DE CAIXA; a DESPESA vem direto do extrato e a RECEITA vem do
// RECEBIMENTO da fatura, que fica numa conta de passagem — "Recebimentos a
// depositar", o Undeposited Funds do QuickBooks — até o depósito esvaziá-la.
//
// POR QUE NÃO HÁ GANCHO NO CAMINHO DO DINHEIRO
// `invoice_payments` é gravado em três lugares (baixa manual, webhook do
// Stripe, parcelamento) e apagado no estorno. Pendurar a criação do
// lançamento em cada um seria quatro pontos para manter em pé — e o que
// falhasse deixaria receita fora do livro sem ninguém saber. Aqui a
// sincronização é uma ROTINA IDEMPOTENTE que roda ao abrir a tela: cria o
// que falta, remove o que foi estornado. O índice único em `payment_id`
// (sql/caixa-conciliacao-v1.sql) é o que garante que rodar duas vezes não
// dobra a receita do ano.
//
// ESTORNO DEPOIS DO DEPÓSITO NÃO SE APAGA EM SILÊNCIO. O dinheiro já entrou
// no banco: apagar a linha desfaria a conciliação e deixaria o depósito sem
// explicação. Vira AVISO para o sócio decidir.

import { dataDaFirma } from '@/lib/dia-da-firma'
import { CONTA_DO_RECEBIMENTO, CONTA_DE_PASSAGEM } from '@/lib/deposito-match'

export interface ResultadoDaSincronizacao {
  criados: number
  removidos: number
  avisos: string[]
  erro: string | null
  contaDePassagem: string | null
}

/**
 * A conta de passagem da firma no plano de contas bancárias. Criada na
 * primeira vez; `type` fica como `checking` porque é o que as telas já
 * sabem desenhar — o que a distingue é o NOME, e nenhuma delas é conta de
 * banco de verdade para efeito de conciliação bancária (ninguém escolhe
 * esta conta lá: ela não tem extrato).
 */
export async function contaDePassagem(db: any, firmaId: string): Promise<{ id: string | null; erro: string | null }> {
  const { data: existe, error: errBusca } = await db.from('bank_accounts')
    .select('id').eq('client_id', firmaId).eq('name', CONTA_DE_PASSAGEM).limit(1)
  if (errBusca) return { id: null, erro: `Conta de passagem: ${errBusca.message}` }
  if (existe?.[0]?.id) return { id: existe[0].id, erro: null }

  const { data, error } = await db.from('bank_accounts')
    .insert({ client_id: firmaId, name: CONTA_DE_PASSAGEM, account_hint: CONTA_DE_PASSAGEM, type: 'checking' })
    .select('id').single()
  if (error) return { id: null, erro: `Nao foi possivel criar a conta de passagem: ${error.message}` }
  return { id: data.id, erro: null }
}

/** O texto que o sócio lê no registro. Nome do cliente + número da fatura. */
export function descricaoDoRecebimento(
  cliente: string | null | undefined,
  fatura: string | null | undefined,
  forma: string | null | undefined
): string {
  const quem = String(cliente || 'Cliente').trim()
  const doc  = fatura ? ` — ${fatura}` : ''
  const como = forma ? ` (${forma})` : ''
  return `${quem}${doc}${como}`.slice(0, 500)
}

/**
 * Cria no livro da firma a linha de cada recebimento que ainda não tem uma,
 * e remove as de recebimento estornado.
 *
 * Idempotente: rodar de novo não muda nada.
 */
export async function sincronizarRecebimentos(
  db: any, firmaId: string
): Promise<ResultadoDaSincronizacao> {
  const vazio: ResultadoDaSincronizacao = { criados: 0, removidos: 0, avisos: [], erro: null, contaDePassagem: null }

  const conta = await contaDePassagem(db, firmaId)
  if (conta.erro || !conta.id) return { ...vazio, erro: conta.erro || 'conta de passagem não criada' }
  vazio.contaDePassagem = conta.id

  // Os recebimentos de verdade (a fonte) e o que já está no livro.
  const [pagamentos, jaNoLivro] = await Promise.all([
    db.from('invoice_payments')
      .select('id, invoice_id, client_id, amount, method, received_at, reference, stripe_object')
      .order('received_at', { ascending: true }).limit(20000),
    db.from('bank_transactions')
      .select('id, payment_id, deposit_tx_id')
      .eq('client_id', firmaId).not('payment_id', 'is', null).limit(20000),
  ])
  // Cada consulta responde pelo próprio erro: lista vazia aqui seria "não há
  // recebimento nenhum" — e a tela mandaria o sócio conciliar o nada.
  if (pagamentos.error) return { ...vazio, erro: `Recebimentos: ${pagamentos.error.message}` }
  if (jaNoLivro.error)  return { ...vazio, erro: `Livro da firma: ${jaNoLivro.error.message}` }

  const pagos = pagamentos.data || []
  const doLivro = new Map<string, any>((jaNoLivro.data || []).map((l: any) => [l.payment_id, l]))
  const idsDosPagos = new Set(pagos.map((p: any) => p.id))

  // Nomes: uma consulta por conjunto, não uma por linha.
  const faltando = pagos.filter((p: any) => !doLivro.has(p.id))
  let criados = 0
  if (faltando.length) {
    const idsFatura = Array.from(new Set(faltando.map((p: any) => p.invoice_id).filter(Boolean)))
    const idsCliente = Array.from(new Set(faltando.map((p: any) => p.client_id).filter(Boolean)))
    const [faturas, clientes] = await Promise.all([
      idsFatura.length ? db.from('invoices').select('id, number').in('id', idsFatura.slice(0, 1000))
                       : Promise.resolve({ data: [], error: null }),
      idsCliente.length ? db.from('clients').select('id, name, business_name').in('id', idsCliente.slice(0, 1000))
                        : Promise.resolve({ data: [], error: null }),
    ])
    if (faturas.error)  return { ...vazio, erro: `Faturas: ${faturas.error.message}` }
    if (clientes.error) return { ...vazio, erro: `Clientes: ${clientes.error.message}` }
    const numero = new Map<string, string>((faturas.data || []).map((f: any) => [f.id, f.number]))
    const nome = new Map<string, string>((clientes.data || []).map((c: any) => [c.id, c.business_name || c.name]))

    const linhas = faltando.map((p: any) => {
      // O dia é o do ESCRITÓRIO: recebido às 20h de Malden é hoje, não amanhã
      // em UTC — e é por dia que o ano fiscal corta.
      const dia = dataDaFirma(new Date(p.received_at))
      return {
        client_id: firmaId,
        account_id: conta.id,
        source: 'recebimento',
        payment_id: p.id,
        tx_date: dia,
        fiscal_year: Number(dia.slice(0, 4)),
        description: descricaoDoRecebimento(nome.get(p.client_id), numero.get(p.invoice_id), p.method),
        amount: Math.round(Number(p.amount) * 100) / 100,
        category: CONTA_DO_RECEBIMENTO,
        // Aprovado: a decisão foi de uma pessoa quando o recebimento entrou
        // (com senha e aprovação, onde a regra exige). Repetir a aprovação
        // aqui seria pedir duas vezes a mesma coisa.
        status: 'approved',
      }
    })
    for (let i = 0; i < linhas.length; i += 500) {
      const bloco = linhas.slice(i, i + 500)
      // ignoreDuplicates: duas abas abertas sincronizando ao mesmo tempo
      // batem no índice único em vez de dobrar a receita.
      const { error } = await db.from('bank_transactions')
        .upsert(bloco, { onConflict: 'payment_id', ignoreDuplicates: true })
      if (error) return { ...vazio, criados, erro: `Nao foi possivel lancar os recebimentos: ${error.message}` }
      criados += bloco.length
    }
  }

  // Estorno: o recebimento sumiu da fonte (estornar_recebimento apaga a linha
  // e grava payment_reversals). A linha do livro tem de sumir junto — MENOS
  // quando já foi depositada: aí o dinheiro entrou no banco e apagar deixaria
  // o depósito sem explicação.
  const sobrando = (jaNoLivro.data || []).filter((l: any) => !idsDosPagos.has(l.payment_id))
  const podeApagar = sobrando.filter((l: any) => !l.deposit_tx_id).map((l: any) => l.id)
  const avisos: string[] = []
  const depositados = sobrando.filter((l: any) => l.deposit_tx_id)
  if (depositados.length) {
    avisos.push(
      `${depositados.length} recebimento(s) estornado(s) DEPOIS de já terem sido depositados. ` +
      'A linha continua no livro porque o dinheiro entrou no banco — desfaça a conciliação do ' +
      'depósito e refaça, ou registre a devolução.'
    )
  }
  let removidos = 0
  if (podeApagar.length) {
    const { error } = await db.from('bank_transactions').delete().in('id', podeApagar)
    if (error) return { criados, removidos: 0, avisos, erro: `Estornos: ${error.message}`, contaDePassagem: conta.id }
    removidos = podeApagar.length
  }

  return { criados, removidos, avisos, erro: null, contaDePassagem: conta.id }
}
