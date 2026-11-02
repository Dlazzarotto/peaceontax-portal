// testes/relatorio-1099.mts — quem entra na lista do 1099, e por quanto
//
// O 1099 é o documento que a firma manda ao IRS em nome do cliente. Prestador
// que fica de fora é multa para o cliente; prestador que entra sem dever é
// trabalho jogado fora. Limite por ano, cartão fora, plataforma paga pela
// conta bancária dentro e grafias juntas são o tipo de regra que se erra lendo.

import { apurar1099, limiteDo1099, formularioDoPedido, ehContaDeDespesa, LIMITES,
         type Lancamento1099 } from '../lib/relatorio-1099.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── Limite por ano ──────────────────────────────────────────────────────
eq('2024: 600', limiteDo1099(2024), 600)
eq('2025: 600', limiteDo1099(2025), 600)
eq('2026: 2000', limiteDo1099(2026), 2000)
eq('2030 fica no último valor publicado', limiteDo1099(2030), 2000)
eq('tabela do mais novo para o mais antigo', LIMITES.map(l => l.desde), [2026, 0])

// ── Formulário pedido e grupo da conta ──────────────────────────────────
eq('NEC', formularioDoPedido('NEC'), 'NEC')
eq('misc minúsculo', formularioDoPedido(' misc '), 'MISC')
eq('null tira do 1099', formularioDoPedido(null), null)
eq('vazio tira do 1099', formularioDoPedido(''), null)
eq('valor estranho é inválido', formularioDoPedido('K'), undefined)
eq('ausente é inválido, não "tirar"', formularioDoPedido(undefined), undefined)
eq('despesa', ehContaDeDespesa('expense'), true)
eq('custo do serviço', ehContaDeDespesa('cogs'), true)
eq('outras despesas', ehContaDeDespesa('other_expense'), true)
eq('receita não', ehContaDeDespesa('income'), false)
eq('ativo não', ehContaDeDespesa('asset'), false)

// ── Apuração ────────────────────────────────────────────────────────────
const contas = { 'Contract Labor': 'NEC' as const, 'Legal & Professional': 'NEC' as const, 'Rent': 'MISC' as const }
const tx = (payee: string | null, category: string, amount: number | string, account_id = 'chk', description = ''): Lancamento1099 =>
  ({ payee, category, amount, account_id, description })
const apura = (lancamentos: Lancamento1099[], ano = 2025, cartoes: string[] = ['cc']) =>
  apurar1099({ lancamentos, formularioDaConta: contas, contasDeCartao: cartoes, ano })

const tres300 = [tx('John Smith', 'Contract Labor', -300), tx('John Smith', 'Contract Labor', -300), tx('John Smith', 'Contract Labor', -300)]
eq('900 em 2025 é candidato', apura(tres300).candidatos.map(l => [l.prestador, l.total, l.pagamentos]), [['John Smith', 900, 3]])
eq('900 em 2026 fica abaixo do limite', apura(tres300, 2026).candidatos.length, 0)
eq('…e aparece em abaixo do limite', apura(tres300, 2026).abaixoDoLimite.map(l => l.total), [900])
eq('exatamente no limite entra', apura([tx('Ana', 'Contract Labor', -600)]).candidatos.length, 1)
eq('um centavo abaixo não entra', apura([tx('Ana', 'Contract Labor', -599.99)]).candidatos.length, 0)
eq('conta não marcada não conta', apura([tx('Ana', 'Office Supplies', -5000)]).candidatos.length +
                                   apura([tx('Ana', 'Office Supplies', -5000)]).abaixoDoLimite.length, 0)
eq('valor em texto (vem do banco)', apura([tx('Ana', 'Contract Labor', '-700.00')]).candidatos[0]?.total, 700)

const comReembolso = apura([tx('Bob', 'Contract Labor', -800), tx('Bob', 'Contract Labor', 250)])
eq('reembolso abate: 800 − 250', [comReembolso.abaixoDoLimite[0]?.pago, comReembolso.abaixoDoLimite[0]?.devolvido, comReembolso.abaixoDoLimite[0]?.total], [800, 250, 550])
eq('reembolso maior que o pago não fica negativo', apura([tx('Bob', 'Contract Labor', -100), tx('Bob', 'Contract Labor', 300)]).abaixoDoLimite.length, 0)

const cartao = apura([tx('Carla', 'Contract Labor', -700, 'cc'), tx('Carla', 'Contract Labor', -100)])
eq('pago no cartão fica fora do total', cartao.abaixoDoLimite[0]?.total, 100)
eq('…mas aparece na linha', cartao.abaixoDoLimite[0]?.porCartao, 700)
eq('…e no resumo do que ficou fora', cartao.foraDoFormulario.cartao, 700)

// ── O que saiu da conta bancária entra, inclusive por plataforma (decisão do
//    sócio). A transferência pessoal do Venmo/PayPal não tem 1099-K: o 1099 é
//    do pagador. A linha diz quanto veio por plataforma, porque o pagamento a
//    perfil de negócio ("goods & services") vai no 1099-K e sai antes de enviar.
const paypal = apura([tx('Dan', 'Contract Labor', -900, 'chk', 'PAYPAL *DANWEB 402-935')])
eq('PayPal pela conta bancária ENTRA no total', paypal.candidatos.map(l => [l.prestador, l.total, l.pagamentos]), [['Dan', 900, 1]])
eq('…marcado na linha', paypal.candidatos[0]?.porPlataforma, 900)
eq('…e somado no que veio por plataforma', paypal.plataformaNoTotal, 900)
eq('…e fora do formulário só fica o cartão', Object.keys(paypal.foraDoFormulario), ['cartao'])
const venmo = apura([tx('Eve', 'Contract Labor', -900, 'chk', 'VENMO PAYMENT 1035826431 WEB ID: 3264681992')])
eq('Venmo pela conta bancária ENTRA', venmo.candidatos.map(l => [l.total, l.porPlataforma]), [[900, 900]])
eq('Cash App pela conta bancária ENTRA', apura([tx('Eve', 'Contract Labor', -900, 'chk', 'CASH APP*EVE')]).candidatos.map(l => l.total), [900])
eq('Zelle entra e não é plataforma', apura([tx('Fred', 'Contract Labor', -900, 'chk', 'ZELLE TO FRED')]).candidatos.map(l => [l.total, l.porPlataforma]), [[900, 0]])
eq('cheque entra e não é plataforma', apura([tx('Fred', 'Contract Labor', -900, 'chk', 'CHECK 1043')]).candidatos.map(l => [l.total, l.porPlataforma]), [[900, 0]])
eq('palavra parecida não é plataforma', apura([tx('Gil', 'Contract Labor', -900, 'chk', 'PAYPALOOZA EVENTS')]).candidatos.map(l => l.porPlataforma), [0])

const venmoNoCartao = apura([tx('Hal', 'Contract Labor', -900, 'cc', 'VENMO *HAL')])
eq('Venmo pago no CARTÃO de crédito fica fora (cartão é 1099-K)', venmoNoCartao.candidatos.length + venmoNoCartao.abaixoDoLimite.length, 0)
eq('…e conta como cartão, não como plataforma', [venmoNoCartao.foraDoFormulario.cartao, venmoNoCartao.plataformaNoTotal], [900, 0])

// O payee que É a plataforma não é prestador: o 1099 sairia em nome do Venmo.
const soVenmo = apura([tx('Venmo', 'Contract Labor', -900), tx('VENMO PAYMENT', 'Contract Labor', -300, 'chk', 'VENMO PAYMENT 1035')])
eq('payee "Venmo" não vira candidato', soVenmo.candidatos.length + soVenmo.abaixoDoLimite.length, 0)
eq('…vai para sem prestador, contado como plataforma', soVenmo.semPrestador, { total: 1200, lancamentos: 2, viaPlataforma: 2 })
eq('payee "PayPal" também', apura([tx('PayPal', 'Contract Labor', -50)]).semPrestador.viaPlataforma, 1)

// Quem só chega ao limite com o que veio por plataforma: conferir no app.
const depende = apura([tx('Ian', 'Contract Labor', -1500, 'chk', 'VENMO PAYMENT 1'), tx('Ian', 'Contract Labor', -1000, 'chk', 'CHECK 1044')], 2026)
eq('2.500 com 1.500 por Venmo em 2026: candidato', depende.candidatos.map(l => [l.total, l.porPlataforma]), [[2500, 1500]])
eq('…que só passa do limite com o Venmo', depende.candidatos[0]?.dependeDaPlataforma, true)
const naoDepende = apura([tx('Ian', 'Contract Labor', -2500, 'chk', 'CHECK 1044'), tx('Ian', 'Contract Labor', -500, 'chk', 'VENMO PAYMENT 2')], 2026)
eq('2.500 por cheque + 500 por Venmo: não depende da plataforma', naoDepende.candidatos.map(l => [l.total, l.porPlataforma, l.dependeDaPlataforma]), [[3000, 500, false]])
eq('exatamente no limite sem a plataforma: não depende', apura([tx('Ian', 'Contract Labor', -2000, 'chk', 'CHECK 1'), tx('Ian', 'Contract Labor', -10, 'chk', 'VENMO 3')], 2026).candidatos[0]?.dependeDaPlataforma, false)
eq('abaixo do limite nunca "depende"', apura([tx('Ian', 'Contract Labor', -900, 'chk', 'VENMO PAYMENT 4')], 2026).abaixoDoLimite[0]?.dependeDaPlataforma, false)

// Reembolso pela plataforma abate dos dois lados; a parte da plataforma nunca passa do total.
const devolveu = apura([tx('Joe', 'Contract Labor', -800, 'chk', 'VENMO PAYMENT 5'), tx('Joe', 'Contract Labor', 300, 'chk', 'VENMO CASHOUT')])
eq('reembolso por Venmo abate do total e da plataforma', devolveu.abaixoDoLimite.map(l => [l.total, l.porPlataforma]), [[500, 500]])
const chequeDevolvido = apura([tx('Kai', 'Contract Labor', -500, 'chk', 'VENMO PAYMENT 6'), tx('Kai', 'Contract Labor', 300, 'chk', 'DEPOSIT')])
eq('plataforma nunca maior que o total', chequeDevolvido.abaixoDoLimite.map(l => [l.total, l.porPlataforma]), [[200, 200]])
eq('soma da plataforma é a das linhas listadas',
   apura([...tres300.map(t => ({ ...t, description: 'VENMO PAYMENT' })), tx('Zoe', 'Contract Labor', -100, 'chk', 'PAYPAL INST XFER')]).plataformaNoTotal, 1000)

const grafias = apura([tx('JOHN SMITH', 'Contract Labor', -300), tx('John Smith.', 'Contract Labor', -200), tx('John Smith.', 'Contract Labor', -150)])
eq('grafias diferentes somam juntas', grafias.candidatos.map(l => l.total), [650])
eq('…e mostram a mais usada', grafias.candidatos[0]?.prestador, 'John Smith.')
eq('acento não separa', apura([tx('José Luís', 'Contract Labor', -400), tx('Jose Luis', 'Contract Labor', -400)]).candidatos.length, 1)

const formas = apura([tx('Hank LLC', 'Contract Labor', -700), tx('Hank LLC', 'Rent', -700)])
eq('NEC e MISC são linhas separadas', formas.candidatos.map(l => `${l.formulario}:${l.total}`).sort(), ['MISC:700', 'NEC:700'])
eq('contas da linha', apura([tx('Ivy', 'Contract Labor', -400), tx('Ivy', 'Legal & Professional', -400)]).candidatos[0]?.contas, ['Contract Labor', 'Legal & Professional'])

const semNome = apura([tx(null, 'Contract Labor', -500), tx('', 'Contract Labor', -250), tx(null, 'Contract Labor', -90, 'cc')])
eq('sem prestador no banco vira aviso', semNome.semPrestador, { total: 750, lancamentos: 2, viaPlataforma: 0 })
eq('sem prestador no cartão vai para o resumo do cartão', semNome.foraDoFormulario.cartao, 90)

const muitos = Array.from({ length: 300 }, () => tx('Jay', 'Contract Labor', -0.1))
eq('300 × 0,10 soma 30,00 em centavos', apura(muitos).abaixoDoLimite[0]?.total, 30)
eq('ordem: maior total primeiro', apura([tx('Ana', 'Contract Labor', -700), tx('Zed', 'Contract Labor', -900)]).candidatos.map(l => l.prestador), ['Zed', 'Ana'])
eq('zero e lixo são ignorados', apura([tx('Kim', 'Contract Labor', 0), tx('Kim', 'Contract Labor', 'abc')]).abaixoDoLimite.length, 0)
eq('limite e ano vêm na apuração', [apura([], 2026).limite, apura([], 2026).ano], [2000, 2026])

console.log(`relatorio-1099: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
