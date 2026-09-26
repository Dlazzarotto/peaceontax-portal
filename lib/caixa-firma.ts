// O caixa da propria firma — a Peace on Tax como cliente de si mesma.
//
// POR QUE A FIRMA E UMA LINHA EM `clients`
// Todo o bookkeeping (Plaid, importacao, motor de regras, plano de contas,
// conciliacao, P&L, balanco) e amarrado a `clients.id`. Dar livro proprio a
// firma com tabelas separadas duplicaria o motor de classificacao — que o
// projeto ja carrega em TRES lugares e chama de divida aceita. Seria a
// quarta copia, e ela desandaria na primeira regra nova.
//
// O PRECO, E COMO ELE E PAGO
// Sendo uma linha em `clients`, a firma aparece por padrao em toda tela que
// lista cliente. Isso e o contrario do padrao da casa ("nasce fechado"), e
// por isso a marca `is_firm` nao e rotulo: e fronteira, conferida em dois
// lugares e so nesses dois —
//   . `canAccessClient` (lib/api-auth.ts): a linha da firma e SO DO SOCIO.
//     Nao basta ser da equipe nem ter `verEmpresas` — o gerente tem
//     `verEmpresas` por nivel e abriria a folha de pagamento da firma.
//   . `clientesOcultos` (lib/api-auth.ts): a firma sai das LISTAS (seletor
//     de fatura e de contrato, central de bookkeeping, alertas do painel),
//     e `/api/clients` a tira tambem das CONTAGENS.
//
// A COLUNA PODE AINDA NAO EXISTIR. O codigo sobe na Vercel a cada push; a
// migracao (`sql/caixa-da-firma-v1.sql`) roda a mao depois. Se `idDaFirma`
// tratasse o erro de coluna ausente como erro de verdade, o funil de acesso
// inteiro passaria a recusar tudo entre o deploy e a migracao. Aqui a
// ausencia significa "ainda nao ha caixa da firma"; quem PRECISA do caixa
// (a rota /api/caixa/firma) consulta direto e mostra o erro real.

/** Colunas de `clients` que o cadastro do caixa preenche. */
const CAMPOS = [
  'name', 'business_name', 'ein', 'email', 'phone',
  'address_line1', 'city', 'state', 'zip',
] as const

export interface DadosDaFirma {
  name?: string | null
  business_name?: string | null
  ein?: string | null
  email?: string | null
  phone?: string | null
  address_line1?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

/**
 * So os campos da lista. O corpo do pedido NUNCA vai inteiro para o banco —
 * aqui isso e mais grave que no cadastro comum: `is_firm`, `user_id` e `type`
 * ficam de fora de proposito. `is_firm` vindo do corpo deixaria o socio
 * marcar um CLIENTE como firma, e o cliente marcado sumiria das listas.
 */
export function camposDaFirma(corpo: any): DadosDaFirma {
  const limpo: any = {}
  for (const k of CAMPOS) {
    const v = corpo?.[k]
    if (v === undefined || v === null) continue
    const t = String(v).trim()
    limpo[k] = t === '' ? null : t
  }
  return limpo
}

/** O que impede o caixa de existir. Devolve a mensagem, ou null se esta bom. */
export function criticarFirma(f: DadosDaFirma): string | null {
  if (!f.name) return 'Informe o nome da firma.'
  if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return 'E-mail inválido.'
  // A firma e uma empresa: sem razao social, o impresso sai com o nome.
  if (!f.business_name) f.business_name = f.name
  return null
}

/** O que a linha da firma tem ALEM dos campos digitados. */
export const MARCA_DA_FIRMA = { is_firm: true, type: 'business', active: true } as const

// O id nao muda (o indice unico parcial impede uma segunda firma) e apagar a
// firma nao e fluxo nenhum, entao guardar o achado e seguro. So o POSITIVO se
// guarda: a ausencia de hoje pode ser o caixa criado daqui a um minuto.
let idGuardado: string | null = null

/**
 * O id da firma, ou null quando ainda nao ha caixa.
 *
 * Erro de consulta (a coluna `is_firm` antes da migracao) tambem devolve
 * null, DE PROPOSITO e so aqui: e a diferenca entre "o sistema segue sem o
 * caixa" e "o sistema inteiro recusa acesso ate alguem rodar um SQL".
 */
export async function idDaFirma(db: any): Promise<string | null> {
  if (idGuardado) return idGuardado
  const { data, error } = await db.from('clients').select('id').eq('is_firm', true).limit(1)
  if (error) return null
  const id = data?.[0]?.id ?? null
  if (id) idGuardado = id
  return id
}

/** Esquece o id guardado — para o POST que acaba de criar o caixa. */
export function esquecerFirma(): void { idGuardado = null }
