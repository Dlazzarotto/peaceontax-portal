// testes/parcelamento.mts — o que um recebimento manual pode fazer num parcelamento
//
// É dinheiro com o Stripe do outro lado: errar para "aceita" cobra o cliente
// duas vezes; errar para "recusa" deixa a parcela paga em cash sem baixa — o
// caso que o sócio trouxe. A decisão é pura e testada aqui; a rota só a chama.

import { decidirRecebimentoManual } from '../lib/parcelamento.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const p = (seq: number, amount: number | string, status = 'scheduled') => ({ seq, amount, status })

// ── A quitação vence ────────────────────────────────────────────────────
eq('saldo inteiro = quitação', decidirRecebimentoManual({ saldo: 300, valor: 300, proxima: p(2, 100) }).tipo, 'quitacao')
eq('saldo inteiro quita mesmo sem parcela em aberto', decidirRecebimentoManual({ saldo: 300, valor: 300, proxima: null }).tipo, 'quitacao')
eq('última parcela = saldo → quitação (encerra a régua), não "parcela"',
  decidirRecebimentoManual({ saldo: 100, valor: 100, proxima: p(3, 100) }).tipo, 'quitacao')

// ── A próxima parcela em aberto ─────────────────────────────────────────
{
  const d = decidirRecebimentoManual({ saldo: 300, valor: 100, proxima: p(2, 100) })
  eq('valor exato da próxima parcela', d.tipo, 'parcela')
  eq('…e é ELA que volta', (d as any).parcela.seq, 2)
}
eq('parcela que falhou também', decidirRecebimentoManual({ saldo: 300, valor: 100, proxima: p(2, 100, 'failed') }).tipo, 'parcela')
eq('parcela ainda não cobrada (scheduled) — o caso do sócio',
  decidirRecebimentoManual({ saldo: 300, valor: 100, proxima: p(1, 100, 'scheduled') }).tipo, 'parcela')
eq('centavo de arredondamento passa (0.005)', decidirRecebimentoManual({ saldo: 300, valor: 33.33, proxima: p(1, 33.334) }).tipo, 'parcela')
eq('valor em texto na parcela', decidirRecebimentoManual({ saldo: 300, valor: 33.34, proxima: p(1, '33.34') }).tipo, 'parcela')

// ── Recusa: nem a parcela, nem o saldo ──────────────────────────────────
{
  const d = decidirRecebimentoManual({ saldo: 300, valor: 50, proxima: p(2, 100), totalParcelas: 3 })
  eq('metade da parcela é recusa', d.tipo, 'recusa')
  eq('a recusa diz QUAL parcela e QUANTO', /parcela 2\/3 \(\$100\.00\)/.test((d as any).motivo), true)
  eq('…e o saldo da quitação', /\$300\.00/.test((d as any).motivo), true)
  eq('…e por que valor parcial não entra', /duas vezes/.test((d as any).motivo), true)
}
eq('parcela certa, valor errado por $1', decidirRecebimentoManual({ saldo: 300, valor: 101, proxima: p(2, 100) }).tipo, 'recusa')
eq('duas parcelas de uma vez é recusa (não é a próxima nem o saldo)',
  decidirRecebimentoManual({ saldo: 300, valor: 200, proxima: p(2, 100) }).tipo, 'recusa')
{
  const d = decidirRecebimentoManual({ saldo: 300, valor: 100, proxima: null })
  eq('sem parcela em aberto, só quitação', d.tipo, 'recusa')
  eq('…e a mensagem diz isso', /sem parcela em aberto/.test((d as any).motivo), true)
}
eq('falhada: a mensagem avisa que o débito falhou',
  /cujo débito falhou/.test((decidirRecebimentoManual({ saldo: 300, valor: 50, proxima: p(2, 100, 'failed') }) as any).motivo), true)
eq('sem totalParcelas a mensagem não inventa "/undefined"',
  /parcela 2 \(/.test((decidirRecebimentoManual({ saldo: 300, valor: 50, proxima: p(2, 100) }) as any).motivo), true)

console.log(`parcelamento: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
