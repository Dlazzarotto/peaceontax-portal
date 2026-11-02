// testes/aviso-de-falha.mts — o que se diz quando um débito automático falha
//
// A mensagem antiga prometia nova tentativa automática sem saber. No débito em
// conta o Stripe NÃO tenta de novo por padrão: o cliente esperava um débito
// que não vinha e a parcela ficava parada. Quem diz se haverá tentativa, e
// quando, é `next_payment_attempt` da invoice do evento.

import { mensagensDaFalha, novaTentativa } from '../lib/aviso-de-falha.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const tem = (n: string, texto: string, trecho: string | RegExp) =>
  eq(n, typeof trecho === 'string' ? texto.includes(trecho) : trecho.test(texto), true)
const naoTem = (n: string, texto: string, trecho: string | RegExp) =>
  eq(n, typeof trecho === 'string' ? texto.includes(trecho) : trecho.test(texto), false)

const AGORA = new Date('2026-10-28T15:00:00Z')
const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000)
const base = { valor: 250, cliente: 'Maria Souza', oQue: 'parcela 2/6', motivo: 'insufficient_funds', agora: AGORA }

// ── A leitura do campo ──────────────────────────────────────────────────
eq('nulo é "nenhuma"', novaTentativa(null, AGORA), { situacao: 'nenhuma', data: null })
eq('ausente é "desconhecida"', novaTentativa(undefined, AGORA), { situacao: 'desconhecida', data: null })
eq('texto é "desconhecida"', novaTentativa('1761675600', AGORA).situacao, 'desconhecida')
eq('zero é "desconhecida"', novaTentativa(0, AGORA).situacao, 'desconhecida')
eq('NaN é "desconhecida"', novaTentativa(NaN, AGORA).situacao, 'desconhecida')
eq('data futura é "agendada"', novaTentativa(unix('2026-11-03T14:00:00Z'), AGORA), { situacao: 'agendada', data: '2026-11-03' })
eq('o dia é o do escritório, não o UTC (22h de Malden já é amanhã em UTC)',
  novaTentativa(unix('2026-11-04T02:30:00Z'), AGORA).data, '2026-11-03')
eq('na virada do horário de verão (01/11) o dia segue o de Malden',
  novaTentativa(unix('2026-11-02T04:30:00Z'), AGORA).data, '2026-11-01')
eq('instante já passado (evento atrasado) vira hoje, não ontem',
  novaTentativa(unix('2026-10-20T12:00:00Z'), AGORA).data, '2026-10-28')

// ── Com tentativa marcada ───────────────────────────────────────────────
{
  const m = mensagensDaFalha({ ...base, proximaTentativa: unix('2026-11-03T14:00:00Z'), tentativasFeitas: 1 })
  eq('agendada', [m.situacao, m.dataDaTentativa], ['agendada', '2026-11-03'])
  tem('equipe: diz a data no formato do cliente', m.equipe, 'tenta de novo em 11/03/2026')
  tem('equipe: diz quantas já foram', m.equipe, 'Tentativas feitas: 1')
  tem('equipe: valor em dólar', m.equipe, '$250.00')
  tem('equipe: motivo e o que falhou', m.equipe, '(parcela 2/6): insufficient_funds')
  tem('cliente: diz a data', m.cliente, 'automaticamente em 11/03/2026')
  tem('cliente: pede o valor disponível', m.cliente, 'deixe o valor disponível na conta')
  naoTem('cliente: não expõe o motivo', m.cliente, 'insufficient')
  naoTem('cliente: não expõe o nome', m.cliente, 'Maria')
}

// ── Sem tentativa marcada: a mensagem NÃO promete ───────────────────────
{
  const m = mensagensDaFalha({ ...base, proximaTentativa: null, tentativasFeitas: 3 })
  eq('nenhuma', [m.situacao, m.dataDaTentativa], ['nenhuma', null])
  tem('equipe: diz que o Stripe NÃO tenta', m.equipe, 'NÃO vai tentar de novo')
  tem('equipe: aponta os caminhos', m.equipe, '"Cobrar de novo"')
  tem('cliente: diz que não haverá', m.cliente, 'não haverá nova tentativa automática')
  naoTem('cliente: nenhuma promessa de tentar de novo', m.cliente, /vamos tentar|será feita automaticamente|tentaremos/i)
  tem('cliente: telefone da firma', m.cliente, '(833) 732-2327')
}

// ── Campo ausente: não afirma nada para nenhum lado ─────────────────────
{
  const m = mensagensDaFalha({ ...base, proximaTentativa: undefined })
  eq('desconhecida', m.situacao, 'desconhecida')
  tem('equipe: manda conferir no painel', m.equipe, 'confira no painel do Stripe')
  naoTem('cliente: não promete tentativa', m.cliente, /tentar de novo|será feita automaticamente/i)
  naoTem('cliente: nem afirma que não haverá', m.cliente, 'não haverá')
  naoTem('equipe: sem contagem quando não veio', m.equipe, 'Tentativas feitas')
}

// ── Detalhes ────────────────────────────────────────────────────────────
eq('motivo vazio vira texto legível', mensagensDaFalha({ ...base, motivo: '', proximaTentativa: null }).equipe.includes('recusado pelo banco'), true)
eq('mensalidade também', mensagensDaFalha({ ...base, oQue: 'mensalidade: Bookkeeping', proximaTentativa: null }).equipe.includes('(mensalidade: Bookkeeping)'), true)
eq('valor com milhar', mensagensDaFalha({ ...base, valor: 1234.5, proximaTentativa: null }).cliente.includes('$1,234.50'), true)

console.log(`aviso-de-falha: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
