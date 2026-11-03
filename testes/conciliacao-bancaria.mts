// testes/conciliacao-bancaria.mts — a diferença da conciliação bancária
//
// A conciliação do ano fecha o livro do cliente com o extrato do banco. A
// tela dizia "diferença 0.00" e a rota recusava com $3635.15: cada uma somava
// de um jeito, e a da rota virava zero quando a consulta falhava. Aqui a conta
// é uma só, em centavos, e marcado que não está no registro não passa calado.

import { apurarConciliacao, emLotes, LOTE_DA_MARCACAO } from '../lib/conciliacao-bancaria.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const tx = (id: string, amount: number | string | null) => ({ id, amount })

// ── O caso da tela: 4294.57 + 275445.85 − 279081.00 = 659.42 ───────────
{
  const elegiveis = [tx('a', 275445.85), tx('b', -279081.00), tx('c', -50)]
  const r = apurarConciliacao({ saldoInicial: '4294.57', saldoFinal: '659.42', elegiveis, marcados: ['a', 'b'] })
  eq('o caso da tela fecha', [r.diferenca, r.fecha], [0, true])
  eq('entradas e saídas marcadas', [r.entradas, r.qtdEntradas, r.saidas, r.qtdSaidas], [275445.85, 1, -279081, 1])
  eq('saldo calculado', r.saldoCalculado, 659.42)
  eq('o que não foi marcado não entra', r.total, -3635.15)
  const nenhum = apurarConciliacao({ saldoInicial: '4294.57', saldoFinal: '659.42', elegiveis, marcados: [] })
  eq('sem nada marcado a diferença é saldo inicial − final (o número da mensagem falsa)', nenhum.diferenca, 3635.15)
}

// ── Muitos lançamentos, em centavos ──────────────────────────────────────
{
  const elegiveis = Array.from({ length: 965 }, (_, i) => tx(`t${i}`, i % 7 === 0 ? 0.1 : -0.1))
  const marcados = elegiveis.map(t => t.id)
  const r = apurarConciliacao({ saldoInicial: 0, saldoFinal: 0, elegiveis, marcados })
  const esperado = Math.round((138 * 0.1 - 827 * 0.1) * 100) / 100
  eq('965 lançamentos de 10 centavos somam certo', r.total, esperado)
  eq('…e a contagem bate', [r.qtdEntradas, r.qtdSaidas], [138, 827])
  eq('valor em texto, como vem do banco', apurarConciliacao({ saldoInicial: '10.00', saldoFinal: '7.66', elegiveis: [tx('x', '-2.34')], marcados: ['x'] }).fecha, true)
  eq('um centavo de diferença não fecha', apurarConciliacao({ saldoInicial: 10, saldoFinal: 7.65, elegiveis: [tx('x', -2.34)], marcados: ['x'] }).diferenca, 0.01)
  eq('…e diz o sinal', apurarConciliacao({ saldoInicial: 10, saldoFinal: 7.67, elegiveis: [tx('x', -2.34)], marcados: ['x'] }).diferenca, -0.01)
}

// ── Marcado fora do registro não passa calado ─────────────────────────────
{
  const elegiveis = [tx('a', 100), tx('b', -40)]
  const r = apurarConciliacao({ saldoInicial: 0, saldoFinal: 60, elegiveis, marcados: ['a', 'b', 'apagado', 'outra-conta'] })
  eq('ids fora dos elegíveis são listados', r.naoElegiveis, ['apagado', 'outra-conta'])
  eq('…e não entram na soma', r.total, 60)
  eq('id repetido conta uma vez', apurarConciliacao({ saldoInicial: 0, saldoFinal: 100, elegiveis, marcados: ['a', 'a'] }).total, 100)
  eq('lançamento de valor zero não é entrada nem saída', (() => {
    const z = apurarConciliacao({ saldoInicial: 0, saldoFinal: 0, elegiveis: [tx('z', 0), tx('n', null)], marcados: ['z', 'n'] })
    return [z.qtdEntradas, z.qtdSaidas, z.fecha, z.naoElegiveis.length]
  })(), [0, 0, true, 0])
  eq('saldo vazio ou inválido conta como zero', apurarConciliacao({ saldoInicial: '', saldoFinal: 'abc', elegiveis, marcados: [] }).diferenca, 0)
}

// ── Lotes da marcação: a URL do update não pode crescer sem limite ───────
eq('o lote é de 100', LOTE_DA_MARCACAO, 100)
eq('965 ids viram 10 lotes', emLotes(Array.from({ length: 965 }, (_, i) => i)).map(l => l.length), [100, 100, 100, 100, 100, 100, 100, 100, 100, 65])
eq('nenhum id, nenhum lote', emLotes([]).length, 0)
eq('nenhum lote passa do tamanho', emLotes(Array.from({ length: 1000 }, (_, i) => i)).every(l => l.length <= LOTE_DA_MARCACAO), true)

console.log(`conciliacao-bancaria: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
