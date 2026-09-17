// lib/novo-cliente.ts — cadastro de cliente novo, num lugar só.
//
// Quem cria um cliente hoje: a tela de Clientes e a de Financeiro (ao emitir
// uma fatura para alguém que ainda não existe). As duas passam por aqui, para
// não divergirem no que aceitam nem no que disparam.
//
// Duas regras que valem sempre:
//   - o corpo do pedido NÃO vai direto para o insert. Antes ia, e qualquer
//     campo enviado entrava na tabela — inclusive `user_id`, que amarra o
//     cadastro a um login. Aqui só passa o que está na lista.
//   - criar cliente com e-mail MANDA O CONVITE de acesso ao portal, salvo
//     quando quem cadastra dispensa. Antes eram duas telas separadas e o
//     cliente ficava cadastrado sem nunca receber o login.

/** Campos que a equipe pode definir ao cadastrar. Nada fora daqui entra. */
const CAMPOS = [
  'name', 'email', 'phone', 'type', 'assignee', 'stage', 'language', 'notes',
  'business_name', 'ein', 'business_type', 'filing_status',
  'address_line1', 'address_line2', 'city', 'state', 'zip',
] as const

export type ClienteNovo = Partial<Record<(typeof CAMPOS)[number], string>>

/** Só os campos aceitos, já aparados. Campo vazio vira null, não string vazia. */
export function camposDoCliente(corpo: any): ClienteNovo {
  const limpo: any = {}
  for (const k of CAMPOS) {
    const v = corpo?.[k]
    if (v === undefined || v === null) continue
    const t = String(v).trim()
    limpo[k] = t === '' ? null : t
  }
  return limpo
}

/** O que impede o cadastro de existir. Devolve a mensagem, ou null se está bom. */
export function criticarCliente(c: ClienteNovo): string | null {
  if (!c.name) return 'Informe o nome do cliente.'
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) return 'E-mail inválido.'
  if (c.type && !['individual', 'business'].includes(c.type)) return 'Tipo inválido.'
  // Empresa sem razão social herda o nome: o documento impresso precisa de um
  // nome só, e ficava em branco quando a equipe preenchia um campo e não o outro
  if (c.type === 'business' && !c.business_name) c.business_name = c.name
  return null
}

/** Manda convite ao criar? Só com e-mail, e só se não pediram para não mandar. */
export function deveConvidar(corpo: any, c: ClienteNovo): boolean {
  if (!c.email) return false
  return corpo?.convidar !== false
}
