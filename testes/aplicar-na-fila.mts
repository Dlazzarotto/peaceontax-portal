// testes/aplicar-na-fila.mts — a regra aplicada à fila inteira, em lotes
//
// Medido na rota antiga: 3.000 na fila, 600 casando, 200 reconhecidas em
// 209 idas ao banco e 6,3 s — lia mil (o teto do PostgREST) e gravava uma por
// vez. Aqui, com um banco falso que imita o teto, conta as idas e injeta
// falha: a fila toda é visitada, os lotes cabem na URL, a linha aprovada no
// meio não volta para a fila, outro cliente não é tocado e a recusa viaja.

import { aplicarNaFila, POR_LOTE, POR_PAGINA, type LinhaDaFila } from '../lib/aplicar-na-fila.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

type Linha = LinhaDaFila & { client_id: string; status: string; category?: string | null }

/** Só o que a rotina usa do supabase-js. Teto de mil por leitura, como o PostgREST. */
function bancoFalso(linhas: Linha[], o: { falharLeituraNa?: number; falharGravacaoNa?: number; depoisDeLer?: () => void } = {}) {
  const idas = { leituras: 0, gravacoes: 0, maiorLote: 0 }
  const db = {
    from(_t: string) {
      const filtros: [string, string, any][] = []
      let faixa: [number, number] | null = null, alteracao: Record<string, unknown> | null = null
      const q: any = {
        select: () => q,
        update: (a: Record<string, unknown>) => { alteracao = a; return q },
        eq: (c: string, v: any) => { filtros.push(['eq', c, v]); return q },
        in: (c: string, v: any[]) => { filtros.push(['in', c, v]); return q },
        order: () => q,
        range: (a: number, b: number) => { faixa = [a, b]; return q },
        then: (ok: any, erro: any) => Promise.resolve(resolver()).then(ok, erro),
      }
      const casa = (l: any) => filtros.every(([t, c, v]) => t === 'eq' ? l[c] === v : v.includes(l[c]))
      const resolver = () => {
        if (alteracao) {
          idas.gravacoes++
          const ids = (filtros.find(([, c]) => c === 'id') || [])[2] || []
          idas.maiorLote = Math.max(idas.maiorLote, ids.length)
          if (o.falharGravacaoNa === idas.gravacoes) return { error: { message: 'value too long for type character varying(120)' }, count: null }
          const alvo = linhas.filter(casa)
          for (const l of alvo) Object.assign(l, alteracao)
          return { error: null, count: alvo.length }
        }
        idas.leituras++
        if (o.falharLeituraNa === idas.leituras) return { data: null, error: { message: 'canceling statement due to statement timeout' } }
        const todas = linhas.filter(casa).sort((x, y) => x.id.localeCompare(y.id))
        const [a, b] = faixa || [0, 999]
        const pedaco = todas.slice(a, Math.min(b + 1, a + 1000))   // o teto de mil
        if (o.depoisDeLer && idas.leituras === 1) o.depoisDeLer()
        return { data: pedaco.map(({ id, description, amount, account_id }) => ({ id, description, amount, account_id })), error: null }
      }
      return q
    },
  }
  return { db, idas }
}

const id = (i: number) => `tx-${String(i).padStart(6, '0')}`
const fila = (n: number, casaACada: number, cliente = 'c1'): Linha[] => Array.from({ length: n }, (_, i) => ({
  id: id(i), client_id: cliente, status: 'pending', account_id: 'a1', amount: -10,
  description: i % casaACada === 0 ? `AMAZON MKTPLACE PMTS ${i}` : `SHELL OIL ${i}`,
}))
const ehAmazon = (l: LinhaDaFila) => /amazon mktplace/i.test(l.description)
const alt = { category: 'Office Supplies', status: 'auto', categorized_by: 'rule' }

// ── A fila inteira, não as primeiras mil ──────────────────────────────────
{
  const linhas = fila(3000, 5)
  const { db, idas } = bancoFalso(linhas)
  const r = await aplicarNaFila(db, { clientId: 'c1', status: ['pending', 'auto'], casa: ehAmazon, alteracao: alt })
  eq('3.000 na fila, 600 casam: as 600 são reconhecidas (antes, 200)', [r.casaram, r.aplicadas, r.falharam], [600, 600, 0])
  eq('…inclusive as que ficavam depois da milésima',
    linhas.filter(l => ehAmazon(l) && Number(l.id.slice(3)) >= 1000).every(l => l.status === 'auto'), true)
  eq('as que não casam ficam como estavam', linhas.filter(l => !ehAmazon(l)).every(l => l.status === 'pending'), true)
  eq('quatro leituras (três páginas cheias e a vazia) e seis lotes — não 600 gravações', [idas.leituras, idas.gravacoes], [4, 6])
  eq(`nenhum lote passa de ${POR_LOTE} ids (o "in" vai na URL)`, idas.maiorLote <= POR_LOTE, true)
}
{
  const { db, idas } = bancoFalso(fila(POR_PAGINA, 2))
  await aplicarNaFila(db, { clientId: 'c1', status: ['pending'], casa: ehAmazon, alteracao: alt })
  eq('exatamente mil: lê a segunda página (vazia) para saber que acabou', idas.leituras, 2)
}
{
  const { db, idas } = bancoFalso(fila(500, 1000000))
  const r = await aplicarNaFila(db, { clientId: 'c1', status: ['pending'], casa: () => false, alteracao: alt })
  eq('nada casa: nenhuma gravação', [r.casaram, r.aplicadas, idas.gravacoes], [0, 0, 0])
}

// ── O que NÃO pode ser tocado ─────────────────────────────────────────────
{
  const linhas = [...fila(300, 3, 'c1'), ...fila(300, 3, 'c2').map(l => ({ ...l, id: 'outro-' + l.id }))]
  const { db } = bancoFalso(linhas)
  await aplicarNaFila(db, { clientId: 'c1', status: ['pending', 'auto'], casa: ehAmazon, alteracao: alt })
  eq('outro cliente não é tocado', linhas.filter(l => l.client_id === 'c2').every(l => l.status === 'pending'), true)
}
{
  const linhas = fila(1200, 4).map((l, i) => i === 8 ? { ...l, status: 'approved', category: 'Rent' } : l)
  const { db } = bancoFalso(linhas)
  const r = await aplicarNaFila(db, { clientId: 'c1', status: ['pending', 'auto'], casa: ehAmazon, alteracao: alt })
  eq('linha já aprovada não entra na fila (nem é lida)', [linhas[8].status, linhas[8].category], ['approved', 'Rent'])
  eq('…e não conta', r.casaram, 299)
}
{
  // Aprovada por alguém ENTRE a leitura e a gravação: a regra não a devolve à fila.
  const linhas = fila(400, 4)
  const { db } = bancoFalso(linhas, { depoisDeLer: () => { linhas[4].status = 'approved'; linhas[4].category = 'Rent' } })
  const r = await aplicarNaFila(db, { clientId: 'c1', status: ['pending', 'auto'], casa: ehAmazon, alteracao: alt })
  eq('aprovada no meio continua aprovada, com a conta dela', [linhas[4].status, linhas[4].category], ['approved', 'Rent'])
  eq('…e o número é o que o banco gravou, não o que casou', [r.casaram, r.aplicadas], [100, 99])
}

// ── A recusa viaja ────────────────────────────────────────────────────────
{
  const linhas = fila(1000, 2)
  const { db } = bancoFalso(linhas, { falharGravacaoNa: 2 })
  const r = await aplicarNaFila(db, { clientId: 'c1', status: ['pending'], casa: ehAmazon, alteracao: alt })
  eq('lote recusado: conta as recusadas e segue com os outros', [r.casaram, r.aplicadas, r.falharam], [500, 400, 100])
  eq('…com o texto da primeira recusa', r.primeiraFalha, 'value too long for type character varying(120)')
}
{
  const { db } = bancoFalso(fila(2500, 5), { falharLeituraNa: 2 })
  let erro = ''
  try { await aplicarNaFila(db, { clientId: 'c1', status: ['pending'], casa: ehAmazon, alteracao: alt }) }
  catch (e) { erro = (e as Error).message }
  eq('leitura que falha LANÇA (não vira "nenhuma casou")', erro, 'não foi possível ler os lançamentos: canceling statement due to statement timeout')
}

console.log(`aplicar-na-fila: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
