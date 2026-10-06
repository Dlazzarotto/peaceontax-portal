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
 * Campos que o formulário de edição aceita, e o nome deles na tabela.
 * Lista FECHADA: corpo de requisição nunca vai inteiro para o banco.
 */
export const CAMPOS_EDITAVEIS = {
  description: 'description',
  amount: 'amount',
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
    if (coluna === 'amount') {
      // 350, '350.00' e 350.0 são o mesmo dinheiro.
      igual = Math.round(Number(atual || 0) * 100) === Math.round(Number(valor as number) * 100)
    } else if (coluna === 'auto_charge') {
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

  if (pedido.description !== undefined) {
    const t = String(pedido.description).trim()
    if (!t) return { campos: [], update: {}, erro: 'Descreva o serviço do contrato.' }
    poe('description', t)
  }
  if (pedido.amount !== undefined) {
    const v = Math.round(Number(pedido.amount) * 100) / 100
    if (!Number.isFinite(v) || v <= 0) return { campos: [], update: {}, erro: 'Informe o valor do contrato.' }
    poe('amount', v)
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
