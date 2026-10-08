// testes/escopo-faturas.mts — quem consulta QUAL fatura
//
// A lista de faturamento e do DIA e de QUEM EMITIU. Sair disso e um ATO, e
// o ato pede senha e motivo. So o SOCIO tem acesso ilimitado.

import {
  decidirConsulta, pedidoEhAmplo, statusDaSituacao, ehSituacao,
  janelaViva, SITUACOES, MINUTOS_DA_JANELA,
} from '../lib/escopo-faturas.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const HOJE = '2026-10-07'
const EU = 'u-eu', OUTRO = 'u-outro'
const junior = { nivel: 'junior' as const, userId: EU, verTodas: false, autorizado: false }
const gerente = { nivel: 'manager' as const, userId: EU, verTodas: false, autorizado: false }
const socio   = { nivel: 'owner' as const,  userId: EU, verTodas: false, autorizado: false }
const meuDia  = { de: HOJE, ate: HOJE, emissor: EU }

// ── o que conta como pedido AMPLO ────────────────────────────────────
eq('meu dia, minhas faturas: nao e amplo', pedidoEhAmplo(meuDia, EU, HOJE), false)
eq('dia anterior e amplo', pedidoEhAmplo({ de: '2026-10-06', ate: HOJE, emissor: EU }, EU, HOJE), true)
eq('outro emissor e amplo', pedidoEhAmplo({ de: HOJE, ate: HOJE, emissor: OUTRO }, EU, HOJE), true)
// SEM filtro de data e o jeito mais facil de ver tudo sem parecer que se
// pediu -- por isso a ausencia conta como amplo, nao como "o dia de hoje".
eq('sem data e amplo', pedidoEhAmplo({ emissor: EU }, EU, HOJE), true)
eq('data invalida conta como sem data', pedidoEhAmplo({ de: '07/10/2026', ate: HOJE, emissor: EU } as any, EU, HOJE), true)
// Emissor AUSENTE e "qualquer emissor", nao "eu" -- tratar ausencia como eu
// deixaria a porta aberta para quem simplesmente nao manda o campo.
eq('emissor ausente e amplo', pedidoEhAmplo({ de: HOJE, ate: HOJE }, EU, HOJE), true)
eq('emissor nulo e amplo', pedidoEhAmplo({ de: HOJE, ate: HOJE, emissor: null }, EU, HOJE), true)
eq('futuro tambem e amplo', pedidoEhAmplo({ de: HOJE, ate: '2026-12-31', emissor: EU }, EU, HOJE), true)

// ── o dia a dia: sem cerimonia ───────────────────────────────────────
const d1 = decidirConsulta(meuDia, junior, HOJE)
eq('meu dia nao e amplo', d1.amplo, false)
eq('meu dia nao pede autorizacao', d1.precisaAutorizacao, false)
eq('meu dia filtra por mim e por hoje', d1.filtro, { createdBy: EU, de: HOJE, ate: HOJE, status: null })

// ── assistente pedindo alem: RECUSA e explica ────────────────────────
const d2 = decidirConsulta({ de: '2026-01-01', ate: HOJE }, junior, HOJE)
eq('assistente alem do dia precisa de autorizacao', d2.precisaAutorizacao, true)
eq('o motivo fala em palavras, nao em regra', d2.motivo,
   'Ver fatura de outro dia ou de outra pessoa precisa de autorização de gerente ou sócio, com motivo.')
// O FILTRO DEVOLVIDO NUNCA PODE SER "TUDO". Se a rota responder assim mesmo,
// responde o que a pessoa ja podia ver -- o padrao seguro.
eq('recusa devolve o filtro seguro, nunca o aberto', d2.filtro, { createdBy: EU, de: HOJE, ate: HOJE, status: null })

// ── GERENTE perde a carteira a mostra ────────────────────────────────
// Antes `verTodasFaturas` vinha por NIVEL e o gerente abria a tela com o
// historico inteiro. Agora ele e tratado como qualquer um: pedir alem do
// proprio dia e um ato.
const d3 = decidirConsulta({ de: '2026-09-01', ate: HOJE }, gerente, HOJE)
eq('gerente alem do dia tambem precisa de autorizacao', d3.precisaAutorizacao, true)
eq('gerente no proprio dia nao precisa', decidirConsulta(meuDia, gerente, HOJE).precisaAutorizacao, false)

// ── SOCIO: ilimitado, literalmente ───────────────────────────────────
const d4 = decidirConsulta({ de: '2020-01-01', ate: HOJE }, socio, HOJE)
eq('socio nunca pede autorizacao', d4.precisaAutorizacao, false)
eq('socio consulta o periodo que pediu', d4.filtro, { createdBy: null, de: '2020-01-01', ate: HOJE, status: null })
eq('socio sem filtro nenhum ve tudo',
   decidirConsulta({}, socio, HOJE).filtro, { createdBy: null, de: null, ate: null, status: null })

// ── a concessao individual dispensa o SEGUNDO, nao o rastro ──────────
const comConcessao = { ...gerente, verTodas: true }
const d5 = decidirConsulta({ de: '2026-01-01', ate: HOJE }, comConcessao, HOJE)
eq('concessao dispensa a autorizacao', d5.precisaAutorizacao, false)
eq('mas a consulta continua AMPLA (e por isso vai para a trilha)', d5.amplo, true)

// ── a janela de autorizacao ──────────────────────────────────────────
const autorizado = { ...junior, autorizado: true }
const d6 = decidirConsulta({ de: '2026-01-01', ate: HOJE, emissor: OUTRO }, autorizado, HOJE)
eq('com janela viva, passa', d6.precisaAutorizacao, false)
eq('e alcanca o emissor pedido', d6.filtro.createdBy, OUTRO)
eq('a janela dura 30 minutos', MINUTOS_DA_JANELA, 30)

const agora = new Date('2026-10-07T15:00:00Z')
eq('janela no futuro esta viva', janelaViva('2026-10-07T15:20:00Z', agora), true)
eq('janela vencida nao vale', janelaViva('2026-10-07T14:59:59Z', agora), false)
eq('sem janela nao vale', janelaViva(null, agora), false)
eq('janela com texto invalido nao vale', janelaViva('ontem', agora), false)
// Vencida nao pode virar viva por acidente de parsing: o caso perigoso e o
// contrario do habitual -- aqui, deixar passar.
eq('janela vazia nao vale', janelaViva('', agora), false)

// ── as situacoes do filtro ───────────────────────────────────────────
// 'em aberto' sao TRES status lidos juntos no sistema inteiro: o status tem
// uma definicao so, no banco (recalcular_status_da_fatura).
eq('em aberto sao os tres juntos', statusDaSituacao('aberto'), ['sent', 'partial', 'overdue'])
eq('paga', statusDaSituacao('paga'), ['paid'])
eq('cancelada e `void` no banco', statusDaSituacao('cancelada'), ['void'])
eq('rascunho', statusDaSituacao('rascunho'), ['draft'])
eq('todas nao filtra', statusDaSituacao('todas'), null)
eq('situacao desconhecida nao filtra (e nao quebra)', statusDaSituacao('qualquer'), null)
eq('situacao ausente nao filtra', statusDaSituacao(undefined), null)
eq('ehSituacao recusa o que nao esta na lista', ehSituacao('paga2'), false)
eq('a lista de situacoes e fechada', Object.keys(SITUACOES), ['todas','aberto','paga','cancelada','rascunho'])

// A situacao atravessa a decisao inteira, inclusive na recusa: filtrar por
// "pagas" nao pode virar "todas" so porque faltou autorizacao.
eq('a situacao sobrevive a recusa',
   decidirConsulta({ de: '2026-01-01', situacao: 'paga' }, junior, HOJE).filtro.status, ['paid'])
eq('a situacao sobrevive ao socio',
   decidirConsulta({ situacao: 'cancelada' }, socio, HOJE).filtro.status, ['void'])

console.log(`escopo-faturas: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
