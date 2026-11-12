// testes/recebimento-parcelado.mts — receber por fora numa fatura parcelada
//
// Dinheiro com o Stripe do outro lado: a parcela escolhida não pode ser
// debitada de novo, o excedente tem de abater do fim, e nenhuma parcela pode
// ficar num valor que o Stripe não cobra. Errar aqui é cliente debitado em
// dobro ou parcela que ninguém cobra.

import { alocarRecebimento, abatimentoDaCobranca, abaterDoFim, primeiraCobrancaDo, MINIMO_CENTAVOS,
         debitoNaParcela, estornoNaParcela, emitida, cobrancaNoStripe, podeReceberNoParcelamento,
         type ParcelaDoCronograma, type DecisaoDoRecebimento } from '../lib/recebimento-parcelado.ts'
import { PAGA_ANTES_DO_AGENDAMENTO } from '../lib/parcela-stripe.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const P = (seq: number, amount: number | string = 350, status = 'scheduled', stripe_invoice: string | null = null): ParcelaDoCronograma =>
  ({ seq, amount, status, stripe_invoice, due_date: `2026-${String(seq).padStart(2, '0')}-10` })
// 10 parcelas de $350; 1 e 2 já pagas pelo Stripe
const plano = () => [P(1, 350, 'paid', 'in_1'), P(2, 350, 'paid', 'in_2'), ...[3, 4, 5, 6, 7, 8, 9, 10].map(s => P(s))]
const saldo = 8 * 350
const mud = (d: any) => d.tipo === 'alocacao' ? d.mudancas.map((m: any) => `${m.seq}:${m.de}->${m.para}${m.quitada ? ' Q' : ''}`) : d.tipo + ': ' + d.motivo

// ── O exemplo do sócio: deve $350, paga $500 ───────────────────────────
{
  const d = alocarRecebimento({ parcelas: plano(), valor: 500, saldo, escolhida: 3 })
  eq('$500 na parcela 3: a 3 quitada e a ÚLTIMA abatida em $150', mud(d), ['3:350->0 Q', '10:350->200'])
  eq('…a escolhida é a 3', (d as any).escolhida, 3)
  eq('…o resumo diz que o Stripe não debita a 3', /Parcela 3 \(03\/10\/2026\): \$350\.00 — quitada; o Stripe não debita/.test((d as any).resumo[0]), true)
  eq('…e quanto abateu da 10', (d as any).resumo[1], 'Parcela 10 (10/10/2026): $350.00 → $200.00 (abatidos $150.00)')
}
eq('valor exato da parcela: só ela', mud(alocarRecebimento({ parcelas: plano(), valor: 350, saldo, escolhida: 3 })), ['3:350->0 Q'])
eq('sem escolher: a primeira em aberto', (alocarRecebimento({ parcelas: plano(), valor: 350, saldo }) as any).escolhida, 3)
eq('pode pagar uma parcela fora de ordem', mud(alocarRecebimento({ parcelas: plano(), valor: 350, saldo, escolhida: 7 })), ['7:350->0 Q'])
eq('pagou a MENOS: abate da própria', mud(alocarRecebimento({ parcelas: plano(), valor: 200, saldo, escolhida: 3 })), ['3:350->150'])
eq('…e o resumo diz o que o Stripe ainda debita',
   (alocarRecebimento({ parcelas: plano(), valor: 200, saldo, escolhida: 3 }) as any).resumo[0],
   'Parcela 3 (03/10/2026): recebidos $200.00; o Stripe debita só os $150.00 que faltam')
eq('excedente que passa da última abate a penúltima',
   mud(alocarRecebimento({ parcelas: plano(), valor: 800, saldo, escolhida: 3 })), ['3:350->0 Q', '9:350->250', '10:350->0 Q'])
eq('excedente nunca volta para a própria escolhida (ela já está quitada)',
   mud(alocarRecebimento({ parcelas: [P(9), P(10)], valor: 600, saldo: 700, escolhida: 10 })), ['9:350->100', '10:350->0 Q'])
eq('saldo inteiro é quitação', alocarRecebimento({ parcelas: plano(), valor: saldo, saldo, escolhida: 5 }).tipo, 'quitacao')
eq('valor em texto, como vem do banco', mud(alocarRecebimento({ parcelas: [P(1, '333.33'), P(2, '333.34')], valor: '333.33', saldo: '666.67' })), ['1:333.33->0 Q'])
eq('a parcela da última que sobrou com $10', mud(alocarRecebimento({ parcelas: [P(9), P(10, 10)], valor: 350, saldo: 360, escolhida: 9 })), ['9:350->0 Q'])

// ── Recusas que dizem o que fazer ────────────────────────────────────────
const motivo = (d: any) => d.tipo === 'recusa' ? d.motivo : '(não recusou)'
eq('zero', alocarRecebimento({ parcelas: plano(), valor: 0, saldo }).tipo, 'recusa')
eq('acima do saldo', /acima do saldo/.test(motivo(alocarRecebimento({ parcelas: plano(), valor: saldo + 1, saldo }))), true)
eq('parcela que não está em aberto', /parcela 2 não está em aberto/.test(motivo(alocarRecebimento({ parcelas: plano(), valor: 350, saldo, escolhida: 2 }))), true)
eq('sem parcela em aberto: só o saldo', /só do saldo inteiro/.test(motivo(alocarRecebimento({ parcelas: [P(1, 350, 'paid', 'in_1')], valor: 10, saldo: 20 }))), true)

// Parcela com cobrança JÁ emitida no Stripe (falhou): só sai inteira
const comFalha = () => [P(3, 350, 'failed', 'in_3'), P(4), P(5), P(6)]
eq('emitida (falhou) e paga a menos: recusa, e aponta Cobrar novamente',
   motivo(alocarRecebimento({ parcelas: comFalha(), valor: 200, saldo: 1400, escolhida: 3 })),
   'A parcela 3 já tem cobrança emitida no Stripe, e o valor de uma cobrança emitida não muda: receba os $350.00 da parcela inteiros — ou mais, que o excedente abate do fim —, ou use Cobrar novamente.')
eq('emitida em rascunho (ainda não falhou): a recusa não oferece Cobrar novamente',
   /Cobrar novamente/.test(motivo(alocarRecebimento({ parcelas: [P(3, 350, 'scheduled', 'in_3'), P(4)], valor: 200, saldo: 700, escolhida: 3 }))), false)
{
  const d = alocarRecebimento({ parcelas: comFalha(), valor: 350, saldo: 1400, escolhida: 3 })
  eq('emitida e paga inteira: quitada, e a cobrança dela sai da linha', (d as any).mudancas, [{ seq: 3, de: 350, para: 0, statusAntes: 'failed', quitada: true, stripeInvoice: 'in_3' }])
}
eq('emitida e paga a mais: o excedente abate do fim', mud(alocarRecebimento({ parcelas: comFalha(), valor: 500, saldo: 1400, escolhida: 3 })), ['3:350->0 Q', '6:350->200'])
eq('o excedente pula a emitida que não cobre inteira', mud(alocarRecebimento({ parcelas: comFalha(), valor: 1050, saldo: 1400, escolhida: 6 })), ['4:350->0 Q', '5:350->0 Q', '6:350->0 Q'])
eq('…e o que sobrar para ela é recusado com os valores que servem',
   motivo(alocarRecebimento({ parcelas: comFalha(), valor: 1100, saldo: 1400, escolhida: 6 })),
   'Sobram $50.00 que não cabem nas parcelas em aberto (parcela com cobrança já emitida no Stripe só se abate inteira). Receba $1400.00 (quita a fatura) ou no máximo $1050.00.')
// O cronograma não cobre o saldo (a entrada ainda não entrou): a recusa NÃO
// culpa parcela emitida nenhuma — não há.
eq('sobra porque as parcelas não cobrem o saldo: a recusa diz isso, sem inventar causa',
   motivo(alocarRecebimento({ parcelas: [P(3), P(4)], valor: 800, saldo: 1000, escolhida: 3 })),
   'Sobram $100.00 que não cabem nas parcelas em aberto. Receba $1000.00 (quita a fatura) ou no máximo $700.00.')

// Mínimo do Stripe: nenhuma parcela com menos de $0.50 a cobrar
eq('o mínimo é 50 centavos', MINIMO_CENTAVOS, 50)
eq('sobrar $0.30 na escolhida: recusa com os dois valores que servem',
   motivo(alocarRecebimento({ parcelas: plano(), valor: 349.7, saldo, escolhida: 3 })),
   'A parcela 3 ficaria com $0.30 a cobrar — abaixo de $0.50, o mínimo que o Stripe cobra. Receba $350.00 (quita a parcela 3) ou no máximo $349.50.')
eq('sobrar $0.50 exatos passa', mud(alocarRecebimento({ parcelas: plano(), valor: 349.5, saldo, escolhida: 3 })), ['3:350->0.5'])
eq('sobra abaixo do mínimo na última, pelo excedente', /parcela 10 ficaria com \$0\.20/.test(motivo(alocarRecebimento({ parcelas: plano(), valor: 699.8, saldo, escolhida: 3 }))), true)

// A primeira cobrança do agendamento não tem rascunho: não se abate
eq('primeira cobrança paga a menos: recusa', /primeira cobrança do Stripe/.test(motivo(alocarRecebimento({ parcelas: plano(), valor: 200, saldo, escolhida: 3, primeiraCobranca: 3 }))), true)
eq('primeira cobrança paga inteira: passa', mud(alocarRecebimento({ parcelas: plano(), valor: 350, saldo, escolhida: 3, primeiraCobranca: 3 })), ['3:350->0 Q'])
eq('primeira cobrança paga a mais: passa, o excedente vai ao fim', mud(alocarRecebimento({ parcelas: plano(), valor: 500, saldo, escolhida: 3, primeiraCobranca: 3 })), ['3:350->0 Q', '10:350->200'])
eq('o excedente não pode abater a primeira cobrança pela metade',
   /primeira cobrança do Stripe/.test(motivo(alocarRecebimento({ parcelas: [P(3), P(4)], valor: 500, saldo: 700, escolhida: 4, primeiraCobranca: 3 }))), true)
eq('outra parcela paga a menos com a primeira por cobrar: passa', mud(alocarRecebimento({ parcelas: plano(), valor: 100, saldo, escolhida: 5, primeiraCobranca: 3 })), ['5:350->250'])

// ── O abatimento da cobrança do período (invoice.created) ────────────────
eq('parcela paga por fora: abate a cobrança inteira', abatimentoDaCobranca({ cobrancaCentavos: 35000, parcela: { amount: 350, status: 'paid' } }), 35000)
eq('faltam $10: abate $340', abatimentoDaCobranca({ cobrancaCentavos: 35000, parcela: { amount: 10, status: 'scheduled' } }), 34000)
eq('falta tudo: não abate', abatimentoDaCobranca({ cobrancaCentavos: 35000, parcela: { amount: '350.00', status: 'scheduled' } }), 0)
eq('falta mais que a cobrança: não abate (e quem chama avisa)', abatimentoDaCobranca({ cobrancaCentavos: 35000, parcela: { amount: 350.3, status: 'failed' } }), 0)

// ── abaterDoFim, direto ──────────────────────────────────────────────────
{
  const abertas = [P(1), P(2), P(3)]
  const falta = new Map(abertas.map(p => [p.seq, 35000]))
  eq('abate da última para trás e devolve o que não coube', abaterDoFim(abertas, falta, 80000, null), 0)
  eq('…deixando a primeira com o resto', [falta.get(1), falta.get(2), falta.get(3)], [25000, 0, 0])
  const f2 = new Map(abertas.map(p => [p.seq, 35000]))
  eq('pula a de exceção', abaterDoFim(abertas, f2, 35000, 3), 0)
  eq('…e abate da anterior', [f2.get(2), f2.get(3)], [0, 35000])
  eq('o que não cabe volta', abaterDoFim([P(1)], new Map([[1, 100]]), 500, null), 400)
}

// ── Qual parcela leva a primeira cobrança (a que não tem rascunho) ───────
eq('nenhuma cobrança ainda: a primeira parcela', primeiraCobrancaDo([P(1), P(2)], true), 1)
eq('a 1 paga por fora antes: a primeira cobrança é DELA (vai a zero), não da 2', primeiraCobrancaDo([P(1, 350, 'paid'), P(2)], true), 1)
eq('a paga antes do agendamento fica de fora', primeiraCobrancaDo([P(1, 350, 'paid', PAGA_ANTES_DO_AGENDAMENTO), P(2)], true), 2)
eq('o Stripe já cobrou alguma: não há mais primeira cobrança', primeiraCobrancaDo([P(1, 350, 'paid', 'in_1'), P(2)], true), null)
eq('cancelada não conta', primeiraCobrancaDo([P(1, 350, 'cancelled'), P(2)], true), 2)
// Sem agendamento no Stripe (esperando a entrada ou o cartão), as fases vão
// nascer do cronograma JÁ abatido: recusar o abatimento da 1 seria recusa falsa.
eq('sem agendamento: não há primeira cobrança a proteger', primeiraCobrancaDo([P(1), P(2)], false), null)
eq('…e a parcela 1 pode ser paga em parte antes do cadastro do cartão',
   mud(alocarRecebimento({ parcelas: [P(1), P(2)], valor: 100, saldo: 700, escolhida: 1, primeiraCobranca: primeiraCobrancaDo([P(1), P(2)], false) })),
   ['1:350->250'])

// ── A marca "paga antes do agendamento" não é cobrança do Stripe ─────────
{
  const sent = P(3, 350, 'scheduled', PAGA_ANTES_DO_AGENDAMENTO)   // reaberta por um estorno
  eq('a marca não é cobrança', cobrancaNoStripe(sent), null)
  eq('…então a parcela reaberta não conta como emitida', emitida(sent), false)
  eq('…recebe em parte (não há cobrança a respeitar)', mud(alocarRecebimento({ parcelas: [sent, P(4)], valor: 100, saldo: 700, escolhida: 3 })), ['3:350->250'])
  const q = alocarRecebimento({ parcelas: [sent, P(4)], valor: 350, saldo: 700, escolhida: 3 }) as any
  eq('…e quitada não manda tirar "da linha" uma cobrança que não existe', q.mudancas[0].stripeInvoice, null)
  eq('cobrança real é cobrança', cobrancaNoStripe(P(3, 350, 'failed', 'in_3')), 'in_3')
}

// ── O débito do Stripe contra o que falta da parcela (invoice.paid) ──────
eq('débito igual ao que falta', debitoNaParcela({ faltaCentavos: 35000, pagoCentavos: 35000 }), { tipo: 'exato' })
eq('débito maior (abatimento não aconteceu): excesso', debitoNaParcela({ faltaCentavos: 20000, pagoCentavos: 35000 }), { tipo: 'excesso', excesso: 15000 })
eq('débito MENOR (estorno depois do abatimento): a parcela fica com o resto',
   debitoNaParcela({ faltaCentavos: 35000, pagoCentavos: 20000 }), { tipo: 'falta', resto: 15000 })
eq('centavo de arredondamento não vira resto', debitoNaParcela({ faltaCentavos: 34999.6, pagoCentavos: 35000 }), { tipo: 'exato' })

// ── O estorno desfaz pela DIFERENÇA (estornoNaParcela) ───────────────────
const L = (amount: number, status = 'scheduled', stripe_invoice: string | null = null) => ({ amount, status, stripe_invoice })
eq('quitada e intocada desde então: reabre com o valor dela',
   estornoNaParcela({ linha: L(350, 'paid'), mudanca: { de: 350, para: 0 } }), { amount: 350, reabre: true, porFora: false, devolvido: 350 })
eq('abatida e intocada: volta ao valor de antes',
   estornoNaParcela({ linha: L(200), mudanca: { de: 350, para: 200 } }), { amount: 350, reabre: false, porFora: false, devolvido: 150 })
eq('abatida e DEPOIS debitada pelo Stripe (paga com $200): reabre devendo os $150 — por fora',
   estornoNaParcela({ linha: L(200, 'paid', 'in_10'), mudanca: { de: 350, para: 200 } }), { amount: 150, reabre: true, porFora: true, devolvido: 150 })
eq('abatida e depois abatida de novo por outro recebimento ($100): volta a $250, não a $350',
   estornoNaParcela({ linha: L(100), mudanca: { de: 350, para: 200 } }), { amount: 250, reabre: false, porFora: false, devolvido: 150 })
eq('quitada e a cobrança do período já passou a zero no Stripe: reabre, por fora',
   estornoNaParcela({ linha: L(350, 'paid', 'in_3'), mudanca: { de: 350, para: 0 } }), { amount: 350, reabre: true, porFora: true, devolvido: 350 })
eq('abatida com o rascunho do período já abatido (ainda não debitado): por fora',
   estornoNaParcela({ linha: L(200, 'scheduled', 'in_10'), mudanca: { de: 350, para: 200 } }).porFora, true)
eq('a que ficou fora do agendamento: por fora',
   estornoNaParcela({ linha: L(350, 'paid', PAGA_ANTES_DO_AGENDAMENTO), mudanca: { de: 350, para: 0 } })!.porFora, true)
eq('mudança sem valor devolvido: nada a fazer', estornoNaParcela({ linha: L(350), mudanca: { de: 350, para: 350 } }), null)
eq('centavos: $349.50 → $0.50 devolve $349.00',
   estornoNaParcela({ linha: L(0.5), mudanca: { de: 349.5, para: 0.5 } }), { amount: 349.5, reabre: false, porFora: false, devolvido: 349 })

// Varredura: receber e estornar em seguida devolve o cronograma EXATAMENTE
// ao que era; e, com o Stripe debitando uma parcela abatida no meio, a soma
// do que está em aberto sobe exatamente o valor estornado.
{
  const aplicar = (ps: ParcelaDoCronograma[], d: DecisaoDoRecebimento) => ps.map(p => {
    const m = d.tipo === 'alocacao' ? d.mudancas.find(x => x.seq === p.seq) : null
    return !m ? { ...p } : m.quitada ? { ...p, status: 'paid' } : { ...p, amount: m.para }
  })
  const estornar = (ps: ParcelaDoCronograma[], d: DecisaoDoRecebimento) => ps.map(p => {
    const m = d.tipo === 'alocacao' ? d.mudancas.find(x => x.seq === p.seq) : null
    const e = m ? estornoNaParcela({ linha: p, mudanca: m }) : null
    return !e ? { ...p } : { ...p, amount: e.amount, status: e.reabre ? 'scheduled' : p.status }
  })
  const emAbertoC = (ps: ParcelaDoCronograma[]) => ps.filter(p => ['scheduled', 'failed'].includes(p.status))
    .reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0)
  let casos = 0, voltou = 0, somaCerta = 0
  for (const valor of [0.5, 1, 99.99, 150, 349.5, 350, 351, 500, 700, 1049.5, 1234.56, 2000, 2799.5]) {
    for (const escolhida of [3, 4, 7, 10]) {
      const antes = plano()
      const d = alocarRecebimento({ parcelas: antes, valor, saldo, escolhida })
      if (d.tipo !== 'alocacao') continue
      casos++
      const depois = estornar(aplicar(antes, d), d)
      if (JSON.stringify(depois.map(p => [p.seq, Number(p.amount), p.status])) === JSON.stringify(antes.map(p => [p.seq, Number(p.amount), p.status]))) voltou++
      // O Stripe debita, no meio, a última parcela que este recebimento abateu (sem quitar).
      const abatida = d.mudancas.filter(m => !m.quitada).pop()
      const meio = aplicar(antes, d).map(p => abatida && p.seq === abatida.seq ? { ...p, status: 'paid', stripe_invoice: 'in_x' } : p)
      const fim = estornar(meio, d)
      if (emAbertoC(fim) - emAbertoC(meio) === Math.round(valor * 100)) somaCerta++
    }
  }
  eq('varredura: houve casos de alocação', casos > 20, true)
  eq('varredura: receber e estornar volta o cronograma ao que era, em todos', voltou, casos)
  eq('varredura: com débito no meio, o em aberto sobe exatamente o estornado, em todos', somaCerta, casos)
}

// ── "Receber parcela" na aba Parcelamentos: quem oferece ────────────────
// A mesma pergunta do quadro de recebimento (parcelamentoVivo): plano vivo,
// com fatura emitida e saldo. Antes o recebimento só existia na lista de faturas.
{
  const R = (o: any) => podeReceberNoParcelamento({ status: 'active', temFatura: true, statusDaFatura: 'partial', saldo: 1050, ...o })
  eq('ativo, com fatura e saldo: oferece', R({}), true)
  eq('débito recusado: oferece (é o caso mais comum de receber por fora)', R({ status: 'payment_failed' }), true)
  eq('esperando o cartão: oferece (a parcela 1 pode ser paga no balcão)', R({ status: 'awaiting_setup' }), true)
  eq('esperando a entrada: oferece (o quadro avisa que vai para as parcelas)', R({ status: 'awaiting_entry' }), true)
  eq('pausado: oferece', R({ status: 'paused' }), true)
  eq('cancelado: não (o saldo se recebe como fatura comum)', R({ status: 'cancelled' }), false)
  eq('concluído: não', R({ status: 'completed' }), false)
  eq('status desconhecido: não (lista fechada)', R({ status: 'qualquer' }), false)
  eq('sem fatura (módulo antigo): não — não há onde lançar', R({ temFatura: false }), false)
  eq('fatura quitada: não', R({ statusDaFatura: 'paid', saldo: 0 }), false)
  eq('fatura cancelada: não', R({ statusDaFatura: 'void' }), false)
  eq('fatura rascunho: não', R({ statusDaFatura: 'draft' }), false)
  eq('saldo zero: não', R({ saldo: 0 }), false)
  eq('saldo ilegível (consulta da fatura falhou): não', R({ saldo: NaN }), false)
  eq('fatura vencida com saldo: oferece', R({ statusDaFatura: 'overdue' }), true)
  eq('um centavo de saldo: oferece', R({ saldo: 0.01 }), true)
}

console.log(`recebimento-parcelado: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
