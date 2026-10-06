// lib/contrato-recorrente.ts — a agenda de um contrato recorrente
//
// POR QUE ISTO SAIU DA ROTA
// A conta da próxima cobrança vivia dentro de `app/api/billing/recurring`,
// sem teste, e tinha dois defeitos que só aparecem meses depois:
//
//   1. IGNORAVA O INTERVALO. Somava UM mês, sempre — então contrato
//      trimestral e anual tinham a próxima data de um mensal. Como nada
//      cobra por essa data ainda (ver o aviso em `/dashboard/billing`),
//      o erro ficou invisível; no dia em que passar a cobrar, cobraria
//      o trimestral todo mês.
//   2. USAVA O DIA DO SERVIDOR (UTC), não o do ESCRITÓRIO. É o mesmo
//      defeito já corrigido na lista de faturas e no relatório: às 20h
//      de Malden já é o dia seguinte em UTC, e um contrato criado à noite
//      pulava um mês inteiro.
//
// A agenda é ANCORADA no início, não em hoje: as ocorrências de um
// trimestral que começou em 10/jan são 10/jan, 10/abr, 10/jul, 10/out —
// recalcular a partir de hoje somando três meses daria outra régua a cada
// edição, e o cliente veria a data andar sozinha.
//
// Módulo puro: só depende de `dia-da-firma`, que também é puro.

import { dataDaFirma } from './dia-da-firma.ts'

export const INTERVALOS = ['monthly', 'quarterly', 'annual'] as const
export type Intervalo = (typeof INTERVALOS)[number]

/** Quantos meses cada intervalo anda. */
export const MESES_DO_INTERVALO: Record<Intervalo, number> = {
  monthly: 1, quarterly: 3, annual: 12,
}

export const ROTULO_DO_INTERVALO: Record<Intervalo, string> = {
  monthly: 'mensal', quarterly: 'trimestral', annual: 'anual',
}

export function ehIntervalo(v: unknown): v is Intervalo {
  return typeof v === 'string' && (INTERVALOS as readonly string[]).includes(v)
}

// O dia vai só até 28 de propósito: 29, 30 e 31 não existem em todo mês, e
// "cobra no último dia" é outra regra — que ninguém pediu e que, mal feita,
// faz fevereiro cobrar três dias antes.
export const DIA_MAXIMO = 28

export function diaValido(v: unknown): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(DIA_MAXIMO, n))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Soma meses a um par ano/mês (mês de 1 a 12). */
function somarMeses(ano: number, mes: number, k: number): { ano: number; mes: number } {
  const t = mes - 1 + k
  return { ano: ano + Math.floor(t / 12), mes: ((t % 12) + 12) % 12 + 1 }
}

/** Data ISO (YYYY-MM-DD) é comparável como texto — não precisa de Date. */
const iso = (ano: number, mes: number, dia: number) => `${ano}-${pad(mes)}-${pad(dia)}`

function partes(data: string): { ano: number; mes: number; dia: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(data || '').slice(0, 10))
  if (!m) return null
  return { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) }
}

/**
 * A PRIMEIRA ocorrência do contrato: o dia escolhido, no mês do início —
 * ou no mês seguinte, se o início já passou desse dia.
 */
export function primeiraCobranca(dia: number, inicio: string): string {
  const d = diaValido(dia)
  const p = partes(inicio)
  if (!p) return iso(1970, 1, d)
  return d >= p.dia
    ? iso(p.ano, p.mes, d)
    : (({ ano, mes }) => iso(ano, mes, d))(somarMeses(p.ano, p.mes, 1))
}

/**
 * A próxima cobrança: a primeira ocorrência da régua que cai DEPOIS de hoje.
 *
 * Hoje é o dia do ESCRITÓRIO. "Depois", e não "a partir de": se a data de
 * hoje é o dia da cobrança, ela já é de hoje — a próxima é a seguinte.
 */
export function proximaCobranca(
  dia: number,
  inicio: string,
  intervalo: Intervalo = 'monthly',
  hoje: string = dataDaFirma(),
): string {
  const n = MESES_DO_INTERVALO[ehIntervalo(intervalo) ? intervalo : 'monthly']
  const d = diaValido(dia)
  const primeira = primeiraCobranca(d, inicio)
  if (primeira > hoje) return primeira

  const p = partes(primeira)!
  const h = partes(hoje)
  if (!h) return primeira

  // Salto direto, em vez de somar mês a mês: um contrato antigo pode estar
  // a décadas de distância, e laço longo em caminho de requisição é risco.
  const difMeses = (h.ano - p.ano) * 12 + (h.mes - p.mes)
  const saltos = Math.max(0, Math.floor(difMeses / n))
  let { ano, mes } = somarMeses(p.ano, p.mes, saltos * n)

  // Correção curta e LIMITADA: o salto pode parar um passo antes (o dia do
  // mês ainda não chegou) e nunca mais de um passo depois.
  for (let i = 0; i < 4 && iso(ano, mes, d) <= hoje; i++) {
    ({ ano, mes } = somarMeses(ano, mes, n))
  }
  return iso(ano, mes, d)
}

/**
 * Situação do contrato. ENCERRADO vence PAUSADO: encerrar também desliga o
 * `active`, e sem olhar o `end_date` primeiro um contrato acabado apareceria
 * como "pausado" — com botão de Reativar, que ressuscitaria um acordo que
 * a firma e o cliente já desfizeram.
 */
export type Situacao = 'ativo' | 'pausado' | 'encerrado'

export function situacaoDoContrato(
  plano: { active?: unknown; end_date?: unknown },
  hoje: string = dataDaFirma(),
): Situacao {
  const fim = typeof plano?.end_date === 'string' ? plano.end_date.slice(0, 10) : null
  if (fim && fim <= hoje) return 'encerrado'
  return plano?.active ? 'ativo' : 'pausado'
}

/**
 * Campos ESCALARES que o formulário de edição aceita, e o nome deles na
 * tabela. Lista FECHADA: corpo de requisição nunca vai inteiro para o banco.
 *
 * `amount` e `description` NÃO estão aqui, e isso é a regra, não um
 * esquecimento: os dois são DERIVADOS das linhas (`montarContrato` e a RPC
 * `salvar_itens_do_contrato`). Aceitar os dois caminhos deixaria o
 * cabeçalho discordar das linhas no primeiro item acrescentado — o mesmo
 * defeito que a impressão de fatura já teve aqui.
 *
 * `discount` e `due_days` também ficam de fora: o desconto anda junto com
 * os itens (muda o total do mesmo jeito) e o prazo é validado por
 * `prazoValido`. Os dois são tratados à parte, na rota.
 */
export const CAMPOS_EDITAVEIS = {
  interval: 'interval',
  dayOfMonth: 'day_of_month',
  startDate: 'start_date',
  autoCharge: 'auto_charge',
} as const

export type CampoEditavel = keyof typeof CAMPOS_EDITAVEIS

/**
 * Mudar QUALQUER um destes muda quanto ou quando o cliente paga. Pelo
 * princípio 3, pedem senha e motivo. É a lista inteira de propósito: não
 * há campo "inofensivo" num contrato — até a descrição é o que o cliente
 * vê como justificativa da cobrança.
 */
export function exigeSenha(campos: string[]): boolean {
  return campos.length > 0
}

/** Só o que mudou de verdade — editar sem mudar nada não vira trilha. */
export function mudancasDoContrato(
  antes: Record<string, any>,
  pedido: Record<string, any>,
): { campos: CampoEditavel[]; update: Record<string, unknown>; erro?: string } {
  const update: Record<string, unknown> = {}
  const campos: CampoEditavel[] = []

  // Comparar o que está gravado com o que foi pedido tem três armadilhas, e
  // cada uma faria a tela gravar "mudou" sem nada ter mudado — enchendo a
  // trilha de ruído e escondendo a alteração de verdade no meio.
  const poe = (c: CampoEditavel, valor: unknown) => {
    const coluna = CAMPOS_EDITAVEIS[c]
    const atual = antes?.[coluna]
    let igual: boolean
    if (coluna === 'auto_charge') {
      // null no banco é "não cobra", igual a false. Sem isto, abrir a edição
      // de um contrato antigo e salvar já marcava auto_charge como alterado.
      igual = !!atual === !!valor
    } else if (coluna === 'start_date') {
      // A coluna é `date`, mas basta um driver devolver com hora para o
      // texto nunca bater e a data "mudar" em toda edição.
      igual = String(atual ?? '').slice(0, 10) === String(valor ?? '').slice(0, 10)
    } else {
      igual = String(atual ?? '') === String(valor ?? '')
    }
    if (igual) return
    update[coluna] = valor
    campos.push(c)
  }

  if (pedido.interval !== undefined) {
    if (!ehIntervalo(pedido.interval)) return { campos: [], update: {}, erro: 'Intervalo inválido.' }
    poe('interval', pedido.interval)
  }
  if (pedido.dayOfMonth !== undefined) poe('dayOfMonth', diaValido(pedido.dayOfMonth))
  // Campo de data VAZIO é "não mexi nisso", não "data inválida". Contrato
  // antigo pode estar sem `start_date`: o formulário manda '' e, recusando,
  // quem só queria trocar o VALOR levava um erro sobre data.
  if (pedido.startDate !== undefined && String(pedido.startDate).trim() !== '') {
    const p = partes(String(pedido.startDate))
    if (!p) return { campos: [], update: {}, erro: 'Data de início inválida (use MM/DD/YYYY no campo).' }
    poe('startDate', iso(p.ano, p.mes, p.dia))
  }
  if (pedido.autoCharge !== undefined) poe('autoCharge', !!pedido.autoCharge)

  return { campos, update }
}

// ─────────────────────────────────────────────────────────────────────────
// O CONTRATO É O MOLDE DE UMA FATURA: itens, desconto, total e vencimento.
//
// Antes era uma descrição e um valor, e não dava para escrever o acordo
// real — "Bookkeeping 350 + Payroll 120, menos 50, vence 15 dias depois".
//
// O total é DERIVADO. Um total digitado à parte deixaria o cabeçalho
// discordar das linhas, que é exatamente o defeito que a impressão de
// fatura já teve aqui: itens que falhavam iam embora com o total inteiro.
// ─────────────────────────────────────────────────────────────────────────

export interface ItemDoContrato {
  description: string
  quantity: number
  unit_price: number
}

const cents = (v: number) => Math.round(v * 100) / 100

/** Quantas casas o dinheiro tem. Quantidade aceita fração (0,5 hora). */
function numero(v: unknown, padrao = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : padrao
}

/**
 * Prazo em DIAS, não em dia do mês. "Emite no dia 1 e vence no dia 10"
 * desmonta quando a emissão é no dia 25: o vencimento cairia ANTES da
 * emissão. "Vence em N dias" atravessa a virada do mês sozinho, e é como o
 * mundo contábil já escreve (Net 15, Net 30).
 */
export const PRAZO_MAXIMO = 365

export function prazoValido(v: unknown): number {
  const n = Math.trunc(numero(v, 0))
  return Math.max(0, Math.min(PRAZO_MAXIMO, n))
}

/** O vencimento da cobrança emitida em `emissao`. Meio-dia UTC: somar dias
 *  em cima da meia-noite escorrega um dia nas viradas de horário de verão. */
export function vencimentoDaCobranca(emissao: string, dias: unknown): string {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(emissao || '').slice(0, 10))
  if (!p) return String(emissao || '').slice(0, 10)
  const d = new Date(Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]), 12))
  d.setUTCDate(d.getUTCDate() + prazoValido(dias))
  return d.toISOString().slice(0, 10)
}

/**
 * O que a lista de contratos mostra na coluna Serviço. DERIVADO dos itens:
 * um rótulo digitado à parte divergiria das linhas no primeiro item novo.
 */
export function resumoDosItens(itens: ItemDoContrato[]): string {
  const nomes = (itens || []).map(i => String(i.description || '').trim()).filter(Boolean)
  if (nomes.length === 0) return 'Serviço'
  if (nomes.length <= 3) return nomes.join(' + ')
  return `${nomes.slice(0, 3).join(' + ')} +${nomes.length - 3}`
}

export interface ContratoMontado {
  itens: ItemDoContrato[]
  bruto: number
  desconto: number
  total: number
  resumo: string
}

/**
 * Valida as linhas e fecha a conta. UMA função: a tela mostra a prévia e a
 * rota grava a partir daqui, porque duas telas nunca devem calcular o mesmo
 * número de jeitos diferentes.
 *
 * O DESCONTO É EM DÓLAR, nunca em porcentagem — este projeto já pagou caro
 * pelo contrário na entrada do parcelamento, onde $250 em $1.000 obrigava a
 * digitar 25 e digitar 250 era recusado.
 */
export function montarContrato(
  pedido: { itens?: any[]; desconto?: unknown },
): ContratoMontado | { erro: string } {
  const brutas = Array.isArray(pedido.itens) ? pedido.itens : []

  // Linha inteiramente vazia é o campo em branco que todo formulário deixa
  // sobrando — some sem reclamar. Linha com preço e SEM nome não some: isso
  // é dinheiro sem justificativa, e o cliente recebe a conta.
  const itens: ItemDoContrato[] = []
  for (const l of brutas) {
    const nome = String(l?.description ?? '').trim()
    const qtd = numero(l?.quantity, 1)
    const preco = numero(l?.unit_price ?? l?.unitPrice, 0)
    if (!nome && !preco && (!l?.quantity || qtd === 1)) continue
    if (!nome) return { erro: 'Há uma linha com valor e sem descrição. Diga o que é, ou apague a linha.' }
    if (!(qtd > 0)) return { erro: `Quantidade inválida em "${nome}".` }
    if (preco < 0) return { erro: `Preço negativo em "${nome}" — desconto é o campo de baixo.` }
    itens.push({ description: nome, quantity: cents(qtd), unit_price: cents(preco) })
  }

  if (itens.length === 0) return { erro: 'O contrato precisa de pelo menos um item.' }

  const bruto = cents(itens.reduce((s, i) => s + i.quantity * i.unit_price, 0))
  const desconto = cents(Math.max(0, numero(pedido.desconto, 0)))

  if (desconto > bruto) {
    return { erro: `O desconto (${desconto.toFixed(2)}) é maior que a soma dos itens (${bruto.toFixed(2)}).` }
  }
  const total = cents(bruto - desconto)
  if (total <= 0) {
    return { erro: 'O contrato ficaria em zero. Um acordo que não cobra nada não é contrato — apague-o ou ajuste o desconto.' }
  }

  return { itens, bruto, desconto, total, resumo: resumoDosItens(itens) }
}
