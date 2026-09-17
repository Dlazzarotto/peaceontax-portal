import { sessaoComFormasDisponiveis, formaNaoAtivada, FORMAS_DO_CLIENTE } from '../lib/stripe-formas.ts'

let passou = 0, falhou = 0
const eq = (nome: string, a: any, b: any) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  ok ? passou++ : (falhou++, console.log('FALHOU:', nome, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// Erro real do Stripe quando a forma nao esta ativada na conta
const erroStripe = (forma: string) => Object.assign(new Error(
  `The payment method type "${forma}" is invalid. Please ensure the provided type is activated in your dashboard (https://dashboard.stripe.com/settings/payment_methods) and specified in the correct format.`
), { raw: {} })

const fakeStripe = (recusa: string[]) => ({
  checkout: { sessions: { create: async (p: any) => {
    const ruim = (p.payment_method_types || []).find((f: string) => recusa.includes(f))
    if (ruim) throw erroStripe(ruim)
    return { id: 'cs_1', url: 'https://stripe/x', payment_method_types: p.payment_method_types }
  } } },
}) as any

const montar = (formas: string[]) => ({ mode: 'payment', payment_method_types: formas })

// 1. conta completa: nada sai
let r = await sessaoComFormasDisponiveis(fakeStripe([]), [...FORMAS_DO_CLIENTE], montar)
eq('conta completa mantem as tres', r.formas, ['card', 'us_bank_account', 'klarna'])
eq('conta completa nao recusa nada', r.recusadas, [])

// 2. ACH desativado (o caso relatado): a sessao nasce assim mesmo
r = await sessaoComFormasDisponiveis(fakeStripe(['us_bank_account']), [...FORMAS_DO_CLIENTE], montar)
eq('sem ACH ainda cria a sessao', r.formas, ['card', 'klarna'])
eq('sem ACH avisa qual caiu', r.recusadas, ['us_bank_account'])

// 3. ACH e Klarna desativados: sobra o cartao
r = await sessaoComFormasDisponiveis(fakeStripe(['us_bank_account', 'klarna']), [...FORMAS_DO_CLIENTE], montar)
eq('so cartao ainda funciona', r.formas, ['card'])
eq('as duas recusadas aparecem', r.recusadas.sort(), ['klarna', 'us_bank_account'])

// 4. cadastro de debito do parcelamento: ACH fora, cartao entra
r = await sessaoComFormasDisponiveis(fakeStripe(['us_bank_account']), ['us_bank_account', 'card'], montar)
eq('cadastro de debito sobrevive sem ACH', r.formas, ['card'])

// 5. erro que NAO e forma inativa sobe inteiro (nao vira retry infinito)
const outroErro = { checkout: { sessions: { create: async () => { throw new Error('No such customer: cus_x') } } } } as any
let subiu = ''
try { await sessaoComFormasDisponiveis(outroErro, [...FORMAS_DO_CLIENTE], montar) } catch (e: any) { subiu = e.message }
eq('erro alheio sobe sem mascarar', subiu, 'No such customer: cus_x')

// 6. conta sem nenhuma forma: erro real do cartao sobe
let subiu2 = ''
try { await sessaoComFormasDisponiveis(fakeStripe(['card', 'us_bank_account', 'klarna']), [...FORMAS_DO_CLIENTE], montar) } catch (e: any) { subiu2 = e.message }
eq('sem nenhuma forma o erro nomeia TODAS as recusadas', subiu2,
  'A conta do Stripe não tem nenhuma forma de pagamento ativada entre as pedidas (cartão, débito em conta (ACH), Klarna). Ative em Settings → Payment methods.')

// 7. o detector nao confunde forma nao pedida
eq('so aponta forma que foi pedida', formaNaoAtivada(erroStripe('klarna'), ['card', 'us_bank_account']), null)
eq('aponta a forma pedida', formaNaoAtivada(erroStripe('us_bank_account'), ['card', 'us_bank_account']), 'us_bank_account')

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
