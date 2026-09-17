// testes/permissoes.mts — nível + autorizações individuais
//
// Isto decide DINHEIRO: quem pode dar baixa, estornar e ver o total vendido.
// O caso que originou o módulo está testado por nome: autorizar a assistente
// a receber no balcão SEM que ela passe a ver o faturamento.

import {
  padraoDoNivel, permissoesDe, normalizarConcessoes,
  conflitoDeSeparacao, conflitosDoConjunto, resumoDeAcesso,
  PERMISSOES, CHAVES,
} from '../lib/permissoes.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── A base de cada nível, sem concessão nenhuma ──
const j = padraoDoNivel('junior')
eq('assistente emite',           j.criar, true)
eq('assistente NAO envia ao cliente',         j.enviar, false)
eq('assistente NAO ve as faturas dos outros', j.verTodasFaturas, false)
eq('assistente NAO edita cadastro',           j.editarCliente, false)
eq('assistente NAO recebe',      j.receber, false)
eq('assistente NAO estorna',     j.estornar, false)
eq('assistente NAO ve totais',   j.verTotais, false)

const m = padraoDoNivel('manager')
eq('gerente recebe',             m.receber, true)
eq('gerente estorna',            m.estornar, true)
eq('gerente envia ao cliente',    m.enviar, true)
eq('gerente ve todas as faturas', m.verTodasFaturas, true)
eq('gerente edita cadastro',      m.editarCliente, true)
eq('gerente NAO ve relatorios',  m.verRelatorios, false)
eq('gerente NAO ve totais',      m.verTotais, false)

const o = padraoDoNivel('owner')
eq('socio ve totais',            o.verTotais, true)
eq('socio ve relatorios',        o.verRelatorios, true)

// ── O CASO: emitir e cobrar no balcao, sem nunca ver o total vendido ──
{
  const c = permissoesDe('junior', { receber: true })
  eq('balcao: emite',                 c.criar, true)
  eq('balcao: recebe',                c.receber, true)
  eq('balcao: NAO ve total vendido',  c.verTotais, false)
  eq('balcao: NAO ve relatorios',     c.verRelatorios, false)
  eq('balcao: NAO estorna',           c.estornar, false)
  eq('balcao: NAO cancela',           c.cancelar, false)
  eq('balcao: NAO apaga',             c.apagar, false)
  eq('balcao: NAO da desconto',       c.darDesconto, false)
  eq('balcao: ve so as proprias faturas do dia', c.verTodasFaturas, false)
  eq('balcao: NAO edita cadastro',    c.editarCliente, false)
}

// ── Enviar nao pega mais carona em cancelar ──
// Eram a mesma trava no codigo: soltar uma soltava a outra, calada.
{
  const so = permissoesDe('junior', { enviar: true })
  eq('autorizado a enviar: envia',        so.enviar, true)
  eq('autorizado a enviar: NAO cancela',  so.cancelar, false)
  eq('autorizado a enviar: NAO apaga',    so.apagar, false)
  const semCancelar = permissoesDe('manager', { cancelar: false })
  eq('gerente sem cancelar CONTINUA enviando', semCancelar.enviar, true)
  const semEnviar = permissoesDe('manager', { enviar: false })
  eq('gerente sem enviar CONTINUA cancelando', semEnviar.cancelar, true)
}

// ── Soltar a lista de faturas sem soltar mais nada ──
{
  const c = permissoesDe('junior', { verTodasFaturas: true })
  eq('lista solta: ve todas',        c.verTodasFaturas, true)
  eq('lista solta: NAO recebe',      c.receber, false)
  eq('lista solta: NAO ve totais',   c.verTotais, false)
  eq('lista solta: NAO edita cadastro', c.editarCliente, false)
}

// ── Editar cadastro do cliente, isolado ──
{
  const c = permissoesDe('junior', { editarCliente: true })
  eq('cadastro solto: edita',        c.editarCliente, true)
  eq('cadastro solto: NAO recebe',   c.receber, false)
  eq('cadastro solto: nao ganha lista', c.verTodasFaturas, false)
}
// Retirar de um gerente tambem funciona
eq('gerente sem editar cadastro',
   permissoesDe('manager', { editarCliente: false }).editarCliente, false)

// ── Retirar a autorizacao depois ──
eq('autorizacao retirada volta ao nivel',
   permissoesDe('junior', { receber: false }).receber, false)
eq('retirar de quem tinha pelo nivel funciona',
   permissoesDe('manager', { estornar: false }).estornar, false)
eq('retirar uma nao mexe nas outras',
   permissoesDe('manager', { estornar: false }).cancelar, true)

// ── O socio e imune: nao se tira poder dele por chave solta ──
{
  const c = permissoesDe('owner', { verTotais: false, receber: false, apagar: false })
  eq('socio mantem totais',   c.verTotais, true)
  eq('socio mantem receber',  c.receber, true)
  eq('socio mantem apagar',   c.apagar, true)
}

// ── Lixo na concessao nao muda nada ──
eq('chave inexistente e ignorada',
   permissoesDe('junior', { virarSocio: true } as any).receber, false)
eq('valor nao booleano e ignorado',
   permissoesDe('junior', { receber: 'sim' } as any).receber, false)
eq('concessao nula = so o nivel',
   permissoesDe('junior', null), padraoDoNivel('junior'))

// ── So o que difere do nivel vira concessao (trilha sem ruido) ──
eq('igual ao nivel nao vira concessao',
   normalizarConcessoes('junior', { criar: true, receber: false }), {})
eq('diferente do nivel vira concessao',
   normalizarConcessoes('junior', { receber: true }), { receber: true })
eq('retirada do gerente vira concessao',
   normalizarConcessoes('manager', { estornar: false }), { estornar: false })
eq('chave desconhecida nao entra',
   normalizarConcessoes('junior', { virarSocio: true }), {})

// ── Separacao de funcoes (principio 1): quem emite nao da baixa ──
{
  const comReceber = permissoesDe('junior', { receber: true })
  const av = conflitoDeSeparacao('receber', true, comReceber)
  eq('autorizar receber a quem emite AVISA', typeof av === 'string' && av.length > 0, true)
}
eq('RETIRAR nunca gera conflito',
   conflitoDeSeparacao('receber', false, permissoesDe('junior', { receber: false })), null)
eq('permissao sem regra de separacao nao avisa',
   conflitoDeSeparacao('duplicar', true, permissoesDe('junior', { duplicar: true })), null)
{
  // estornar sem receber nao fecha o ciclo — nao ha o que desfazer
  const semReceber = permissoesDe('junior', { estornar: true })
  eq('estornar sem receber nao avisa',
     conflitoDeSeparacao('estornar', true, semReceber), null)
  const comAmbos = permissoesDe('junior', { receber: true, estornar: true })
  eq('estornar COM receber avisa',
     typeof conflitoDeSeparacao('estornar', true, comAmbos) === 'string', true)
}
eq('assistente puro nao tem conflito nenhum',
   conflitosDoConjunto(padraoDoNivel('junior')), [])
eq('assistente com receber tem um conflito',
   conflitosDoConjunto(permissoesDe('junior', { receber: true })).length, 1)
eq('gerente ja acumula emitir, receber e estornar',
   conflitosDoConjunto(padraoDoNivel('manager')).length, 2)

// ── Resumo da lista ──
eq('sem concessao, sem resumo',  resumoDeAcesso('junior', {}), '')
eq('socio nunca mostra resumo',  resumoDeAcesso('owner', { receber: false }), '')
eq('uma autorizacao',            resumoDeAcesso('junior', { receber: true }), '+1 autorização')
eq('uma retirada',               resumoDeAcesso('manager', { estornar: false }), '−1 retirada')
eq('os dois lados',
   resumoDeAcesso('junior', { receber: true, criar: false }), '+1 autorização · −1 retirada')

// ── A lista de chaves nao pode divergir do banco em silencio ──
// O check do SQL (staff_grants_chave_ck) lista exatamente estas.
eq('as chaves sao estas', [...CHAVES], [
  'criar','enviar','verTodasFaturas','receber','editar','duplicar','cancelar',
  'darDesconto','estornar','apagar','editarCliente','verRelatorios','verTotais',
])
eq('toda chave tem titulo e descricao',
   PERMISSOES.every(p => p.titulo.length > 3 && p.descricao.length > 5), true)
eq('receber e estornar avisam sobre separacao',
   PERMISSOES.filter(p => p.separacao).map(p => p.chave), ['receber', 'estornar'])

console.log(`permissoes: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
