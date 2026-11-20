// testes/lista-de-lancamentos.mts — a lista do Banking e os números em volta dela
//
// "O Plaid não traz as transações anteriores a 20/05/2025" era a tela: a rota
// devolvia as MIL mais recentes (teto do PostgREST) e a tela tirava dessa lista
// cortada as abas, o total, os cartões e os ANOS do seletor. Aqui: os números
// contados sobre tudo, os anos que existem e o aviso quando a aba passa do teto.

import {
  resumirLancamentos, anosEntre, avisoDaLista, grupoDoStatus, ehGrupo, STATUS_DO_GRUPO, GRUPOS, LIMITE_DA_LISTA,
  type LinhaLeve,
} from '../lib/lista-de-lancamentos.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const l = (account_id: string | null, status: string, amount: number | string, tx_date: string, balance: number | null = null): LinhaLeve =>
  ({ account_id, status, amount, tx_date, balance })

// ── As abas ─────────────────────────────────────────────────────────────────
eq('pending é "Não reconhecidas"', grupoDoStatus('pending'), 'unrecognized')
eq('auto é "Reconhecidas"', grupoDoStatus('auto'), 'recognized')
eq('approved e reviewed são o Registro', [grupoDoStatus('approved'), grupoDoStatus('reviewed')], ['register', 'register'])
eq('excluded é "Excluídas"', grupoDoStatus('excluded'), 'excluded')
eq('status desconhecido não é aba nenhuma', grupoDoStatus('outro'), null)
eq('cada status mora numa aba só', GRUPOS.flatMap(g => STATUS_DO_GRUPO[g]).length, new Set(GRUPOS.flatMap(g => STATUS_DO_GRUPO[g])).size)
eq('aba válida', [ehGrupo('register'), ehGrupo('banking'), ehGrupo(undefined)], [true, false, false])
eq('o teto é a página do PostgREST', LIMITE_DA_LISTA, 1000)

// ── O caso da tela: 1.330 transações em 24 meses, todas a revisar ───────────
{
  const fim = Date.UTC(2026, 10, 20), ini = fim - 730 * 86400000
  const linhas = Array.from({ length: 1330 }, (_, k) => {
    const d = new Date(ini + Math.round((k + 1) * (fim - ini) / 1330)).toISOString().slice(0, 10)
    return l('a1', 'pending', k % 3 ? -25.5 : 120, d)
  })
  const r = resumirLancamentos(linhas, null)
  eq('o total é o de TODAS, não o teto', r.summary.total, 1330)
  eq('"Não reconhecidas" conta todas', r.contagens.unrecognized, 1330)
  eq('o cartão da conta conta todas', [r.cartoes.a1.total, r.cartoes.a1.forReview], [1330, 1330])
  // A milésima mais recente é a de 20/05/2025 — o corte que a tela mostrava.
  const ordenadas = linhas.map(x => x.tx_date).sort().reverse()
  eq('com o teto, a milésima mais recente cai em 20/05/2025', ordenadas[LIMITE_DA_LISTA - 1], '2025-05-20')
}

// ── Contagens, resumo e cartões ────────────────────────────────────────────
{
  const linhas = [
    l('a1', 'pending', -10, '2025-01-05'),
    l('a1', 'auto', -20.1, '2025-02-01', 900),
    l('a1', 'approved', 100.2, '2025-03-01', 1000.5),
    l('a2', 'reviewed', -0.1, '2025-03-02'),
    l('a2', 'excluded', 5, '2025-03-03'),
    l(null, 'pending', -1, '2025-03-04'),
  ]
  const r = resumirLancamentos(linhas, null)
  eq('contagens por aba', r.contagens, { recognized: 1, unrecognized: 2, register: 2, excluded: 1, total: 6 })
  eq('resumo: total, em aberto, entradas e saídas (centavos)', r.summary, { total: 6, pending: 2, credits: 105.2, debits: -31.2 })
  eq('cartão a1', r.cartoes.a1, { total: 3, forReview: 2, inRegister: 1, lastBalance: 1000.5, lastDate: '2025-03-01' })
  eq('cartão a2 sem saldo', r.cartoes.a2, { total: 2, forReview: 0, inRegister: 1, lastBalance: null, lastDate: null })
  eq('lançamento sem conta não vira cartão', Object.keys(r.cartoes).sort(), ['a1', 'a2'])
  const so1 = resumirLancamentos(linhas, 'a1')
  eq('a conta escolhida filtra as abas e o resumo', [so1.contagens.total, so1.summary.pending, so1.contagens.register], [3, 1, 1])
  eq('…mas os cartões continuam mostrando todas as contas', Object.keys(so1.cartoes).sort(), ['a1', 'a2'])
  eq('o saldo do cartão é o da linha mais recente com saldo',
    resumirLancamentos([l('a', 'approved', 1, '2025-05-01', 50), l('a', 'approved', 1, '2025-04-01', 70)], null).cartoes.a.lastBalance, 50)
  eq('saldo zero informado é um saldo', resumirLancamentos([l('a', 'approved', 1, '2025-05-01', 0)], null).cartoes.a.lastBalance, 0)
  eq('lista vazia ou nula', [resumirLancamentos([], null).summary.total, resumirLancamentos(null, null).contagens.total], [0, 0])
  eq('valor em texto, como vem do banco', resumirLancamentos([l('a', 'pending', '12.34', '2025-01-01')], null).summary.credits, 12.34)
  eq('mil valores de 10 centavos somam certo',
    resumirLancamentos(Array.from({ length: 1000 }, () => l('a', 'pending', 0.1, '2025-01-01')), null).summary.credits, 100)
}

// ── Os anos do seletor vêm do banco ────────────────────────────────────────
eq('de 2024 a 2026, do mais recente', anosEntre(2024, 2026), [2026, 2025, 2024])
eq('em texto também', anosEntre('2025', '2026'), [2026, 2025])
eq('um ano só', anosEntre(2026, 2026), [2026])
eq('sem nada no banco', anosEntre(null, null), [])
eq('só o mínimo', anosEntre(2025, null), [2025])
eq('invertido não inventa intervalo', anosEntre(2027, 2026), [2026])
eq('intervalo absurdo não vira lista de 2 mil anos', anosEntre(1, 2026), [2026])

// ── O aviso ────────────────────────────────────────────────────────────────
eq('cabe: sem aviso', avisoDaLista({ mostrando: 300, total: 300, maisAntiga: '2025-01-01', anoEscolhido: false }), null)
{
  const a = avisoDaLista({ mostrando: 1000, total: 1330, maisAntiga: '2025-05-20', anoEscolhido: false }) || ''
  eq('passou do teto: diz quantas e de quando', [a.includes('1.000'), a.includes('1.330'), a.includes('05/20/2025')], [true, true, true])
  eq('…e manda escolher o ano', /escolha o ano/.test(a), true)
  const b = avisoDaLista({ mostrando: 1000, total: 2500, maisAntiga: '2025-07-01', anoEscolhido: true }) || ''
  eq('com o ano já escolhido, manda escolher a conta', [/escolha o ano/.test(b), /escolha uma conta/.test(b)], [false, true])
  eq('…e lembra que o que sai da aba abre espaço', /abre espaço/.test(b), true)
}

console.log(`lista-de-lancamentos: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
