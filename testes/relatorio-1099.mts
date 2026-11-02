// testes/relatorio-1099.mts — quem entra na lista do 1099, e por quanto
//
// O 1099 é o documento que a firma manda ao IRS em nome do cliente. Prestador
// que fica de fora é multa para o cliente; prestador que entra sem dever é
// trabalho jogado fora. Limite por ano, cartão fora e grafias juntas são o
// tipo de regra que se erra lendo.

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

const paypal = apura([tx('Dan', 'Contract Labor', -900, 'chk', 'PAYPAL *DANWEB 402-935')])
eq('PayPal pela descrição fica fora', paypal.candidatos.length, 0)
eq('…e vai para plataforma', paypal.foraDoFormulario.plataforma, 900)
eq('Venmo pelo payee fica fora', apura([tx('Venmo', 'Contract Labor', -900)]).foraDoFormulario.plataforma, 900)
eq('Cash App fica fora', apura([tx('Eve', 'Contract Labor', -900, 'chk', 'CASH APP*EVE')]).foraDoFormulario.plataforma, 900)
eq('Zelle CONTINUA no 1099', apura([tx('Fred', 'Contract Labor', -900, 'chk', 'ZELLE TO FRED')]).candidatos.map(l => l.total), [900])
eq('palavra parecida não é plataforma', apura([tx('Gil', 'Contract Labor', -900, 'chk', 'PAYPALOOZA EVENTS')]).candidatos.length, 1)

const grafias = apura([tx('JOHN SMITH', 'Contract Labor', -300), tx('John Smith.', 'Contract Labor', -200), tx('John Smith.', 'Contract Labor', -150)])
eq('grafias diferentes somam juntas', grafias.candidatos.map(l => l.total), [650])
eq('…e mostram a mais usada', grafias.candidatos[0]?.prestador, 'John Smith.')
eq('acento não separa', apura([tx('José Luís', 'Contract Labor', -400), tx('Jose Luis', 'Contract Labor', -400)]).candidatos.length, 1)

const formas = apura([tx('Hank LLC', 'Contract Labor', -700), tx('Hank LLC', 'Rent', -700)])
eq('NEC e MISC são linhas separadas', formas.candidatos.map(l => `${l.formulario}:${l.total}`).sort(), ['MISC:700', 'NEC:700'])
eq('contas da linha', apura([tx('Ivy', 'Contract Labor', -400), tx('Ivy', 'Legal & Professional', -400)]).candidatos[0]?.contas, ['Contract Labor', 'Legal & Professional'])

const semNome = apura([tx(null, 'Contract Labor', -500), tx('', 'Contract Labor', -250), tx(null, 'Contract Labor', -90, 'cc')])
eq('sem prestador no banco vira aviso', semNome.semPrestador, { total: 750, lancamentos: 2 })
eq('sem prestador no cartão vai para o resumo do cartão', semNome.foraDoFormulario.cartao, 90)

const muitos = Array.from({ length: 300 }, () => tx('Jay', 'Contract Labor', -0.1))
eq('300 × 0,10 soma 30,00 em centavos', apura(muitos).abaixoDoLimite[0]?.total, 30)
eq('ordem: maior total primeiro', apura([tx('Ana', 'Contract Labor', -700), tx('Zed', 'Contract Labor', -900)]).candidatos.map(l => l.prestador), ['Zed', 'Ana'])
eq('zero e lixo são ignorados', apura([tx('Kim', 'Contract Labor', 0), tx('Kim', 'Contract Labor', 'abc')]).abaixoDoLimite.length, 0)
eq('limite e ano vêm na apuração', [apura([], 2026).limite, apura([], 2026).ano], [2000, 2026])

console.log(`relatorio-1099: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
