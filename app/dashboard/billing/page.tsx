'use client'
// Financeiro → Faturamento
// Lista de orçamentos e faturas, criação (nasce rascunho), envio,
// recebimento, duplicação e cancelamento — cada botão conforme o nível.

import { useState, useEffect } from 'react'
import { exigeAprovacao, nomeDaForma } from '@/lib/recebimento-aprovacao'
import { entradaDoPedido, tetoDaEntrada } from '@/lib/entrada-parcelamento'
import { formatar as formatarCodigo, formatoValido as codigoBemFormado,
         relogio, segundosRestantes, MINUTOS_DE_VIDA } from '@/lib/codigo-autorizacao'

interface Inv {
  id: string; number: string; doc_type: string; status: string; cliente: string
  issue_date: string; due_date: string | null; total: number; paid_total: number; saldo: number
  payment_plan: string; expected_method: string | null
  ach_desde?: string | null; ach_valor?: number | null
}
interface Item { description: string; qty: number; unitPrice: number; serviceId?: string }

const STATUS: Record<string, { rotulo: string; cor: string }> = {
  draft:    { rotulo: 'Rascunho',  cor: '#6A7A9A' },
  sent:     { rotulo: 'Enviada',   cor: '#2D3278' },
  accepted: { rotulo: 'Aceito',    cor: '#0A6A8A' },
  declined: { rotulo: 'Recusado',  cor: '#B02020' },
  partial:  { rotulo: 'Parcial',   cor: '#C06010' },
  paid:     { rotulo: 'Paga',      cor: '#1A6B4A' },
  overdue:  { rotulo: 'Vencida',   cor: '#B02020' },
  void:     { rotulo: 'Cancelada', cor: '#9AAAB0' },
}

const FORMAS = [
  ['card', 'Cartão'], ['ach', 'Débito em conta (ACH)'], ['zelle', 'Zelle'],
  ['venmo', 'Venmo'], ['cash', 'Dinheiro'], ['check', 'Cheque'],
  ['wire', 'Wire'], ['external', 'Financiadora'],
]

const FREQ_PT: Record<string, string> = { weekly: 'semanal', biweekly: 'quinzenal', monthly: 'mensal' }
const STATUS_PT: Record<string, string> = {
  draft: 'rascunho', awaiting_entry: 'aguardando entrada', awaiting_setup: 'aguardando autorização',
  active: 'ativo', paused: 'pausado', payment_failed: 'débito falhou',
  completed: 'quitado', cancelled: 'cancelado',
}
const COR_STATUS: Record<string, string> = {
  active: '#1A6B4A', completed: '#1A6B4A', payment_failed: '#C0392B',
  cancelled: '#9AAAB0', awaiting_entry: '#C06010', awaiting_setup: '#C06010',
}
const money = (v: number) =>
  `$${(Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const dataUS = (d: string | null) => {
  if (!d) return '—'
  const [y, m, dia] = String(d).slice(0, 10).split('-')
  return `${m}/${dia}/${y}`
}


// A resposta pode não ser JSON (rota ausente, build em andamento, erro 500).
// Ler como texto primeiro evita o erro críptico "Unexpected token '<'".
async function jsonSeguro(resp: Response) {
  const bruto = await resp.text()
  try { return JSON.parse(bruto) } catch {
    if (resp.status === 404) {
      return { error: 'Rota /api/billing não encontrada. O deploy ainda não terminou, ou os arquivos da API não subiram.' }
    }
    return { error: `O servidor respondeu ${resp.status} sem dados. Verifique o build no Vercel.` }
  }
}

export default function BillingPage() {
  const [dados, setDados] = useState<any>({ invoices: [], clients: [], services: [], perms: null })
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [filtroDoc, setFiltroDoc] = useState('')
  const [filtroStatus, setFiltroStatus] = useState('')
  const [busca, setBusca] = useState('')
  const [soAbertas, setSoAbertas] = useState(false)
  const [aba, setAba] = useState<'docs' | 'contratos' | 'parcelamentos' | 'autorizacao'>('docs')
  // Aba Autorização: só sócio e gerente. O código sai AQUI, no login de quem
  // autoriza, e é ditado a quem está no balcão.
  const [autz, setAutz] = useState<any>({ vivo: null, usados: [] })
  const [autzSeg, setAutzSeg] = useState(0)
  // Relatórios do sócio (a rota recusa quem não é owner; aqui só a tela)
  const [relAberto, setRelAberto] = useState(false)
  const anoAtual = new Date().getFullYear()
  const [relDe, setRelDe] = useState(`${anoAtual}-01-01`)
  const [relAte, setRelAte] = useState(`${anoAtual}-12-31`)
  const abrirRelatorio = (id: string) =>
    window.open(`/api/billing/reports?report=${id}&from=${relDe}&to=${relAte}`, '_blank')
  // Parcelamento de fatura em aberto
  const [pcDados, setPcDados] = useState<any>({ plans: [], invoices: [] })
  const [pcFatura, setPcFatura] = useState('')
  const [pcEntrada, setPcEntrada] = useState('0')
  const [pcParcelas, setPcParcelas] = useState('4')
  const [pcFreq, setPcFreq] = useState<'weekly'|'biweekly'|'monthly'>('monthly')
  const [pcPrimeira, setPcPrimeira] = useState('')
  const [fParcelas, setFParcelas] = useState('3')
  const [fPrimeiroVenc, setFPrimeiroVenc] = useState('')
  const [editandoId, setEditandoId] = useState<string | null>(null)
  const [ePass, setEPass] = useState(''); const [eMotivo, setEMotivo] = useState('')
  // contratos recorrentes
  const [planos, setPlanos] = useState<any[]>([])
  const [cCliente, setCCliente] = useState(''); const [cDesc, setCDesc] = useState('')
  const [cValor, setCValor] = useState(''); const [cDia, setCDia] = useState('5')
  const [cAuto, setCAuto] = useState(false)

  // formulário
  const [abrirNovo, setAbrirNovo] = useState(false)
  const [fCliente, setFCliente] = useState('')
  // Cadastrar cliente sem sair da emissão: antes era ir a Clientes, cadastrar,
  // voltar ao Financeiro e recomeçar a fatura.
  const [novoCli, setNovoCli] = useState<{ nome: string; email: string; tipo: string; convidar: boolean } | null>(null)
  const [fTipo, setFTipo] = useState('invoice')
  const [fVenc, setFVenc] = useState('')
  const [fPlano, setFPlano] = useState('full')
  const [fForma, setFForma] = useState('')
  const [fDesconto, setFDesconto] = useState('0')
  const [fNotas, setFNotas] = useState('')
  const [itens, setItens] = useState<Item[]>([{ description: '', qty: 1, unitPrice: 0 }])

  // recebimento
  const [receber, setReceber] = useState<Inv | null>(null)
  const [cobranca, setCobranca] = useState<{ automatica: boolean; falhas: { seq: number; valor: number; motivo: string | null; tentativas: number }[]; podeCobrarDeNovo: boolean } | null>(null)
  const [rValor, setRValor] = useState('')
  const [rForma, setRForma] = useState('zelle')
  const [rRef, setRRef] = useState('')
  // Cartão e Zelle a equipe registra sozinha; o resto pede senha de gerente
  // ou sócio (lib/recebimento-aprovacao.ts). Não fica em memória depois de
  // salvar: senha de terceiro não sobra em tela aberta no balcão.
  // Cancelar parcelamento: acordo que desandou. Para o debito no Stripe e
  // deixa a fatura em aberto com o saldo. Pede motivo e senha, como toda
  // acao que mexe em regua de cobranca.
  const [pcCancelar, setPcCancelar] = useState<any | null>(null)
  const [pcMotivo, setPcMotivo]     = useState('')
  const [pcSenha, setPcSenha]       = useState('')
  // Caminho preferido: o código que o gerente dita da aba Autorização, no
  // login dele. A senha fica como reserva — senha de terceiro digitada na
  // máquina do balcão é o que queríamos parar de pedir.
  const [apCodigo, setApCodigo] = useState('')
  const [apPorSenha, setApPorSenha] = useState(false)
  const [apEmail, setApEmail] = useState('')
  const [apSenha, setApSenha] = useState('')
  const [pagamentos, setPagamentos] = useState<any[]>([])
  const [estPass, setEstPass] = useState(''); const [estMotivo, setEstMotivo] = useState('')

  const perms = dados.perms

  const load = async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (filtroDoc) qs.set('doc', filtroDoc)
      if (filtroStatus) qs.set('status', filtroStatus)
      const d = await jsonSeguro(await fetch(`/api/billing/invoices?${qs}`))
      if (d?.invoices) setDados(d)
      else setMsg(`⚠️ ${d?.error || 'Não foi possível carregar.'}`)
    } catch (e) { setMsg(`⚠️ ${(e as Error).message}`) }
    setLoading(false)
  }
  const loadPlanos = async () => {
    const d = await jsonSeguro(await fetch('/api/billing/recurring'))
    if (d?.plans) setPlanos(d.plans)
    else if (d?.error) setMsg(`⚠️ ${d.error}`)
  }
  useEffect(() => { load() }, [filtroDoc, filtroStatus])
  useEffect(() => { if (aba === 'contratos') loadPlanos() }, [aba])

  const cancelarParcelamento = async () => {
    if (!pcCancelar) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/installment-plan', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: pcCancelar.id, action: 'cancel', motivo: pcMotivo, password: pcSenha }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    setPcSenha('')
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)

    // "Editar" um parcelamento que nunca começou é refazer o acordo. Em vez
    // de cancelar e deixar a pessoa remontar tudo de cabeça, o formulário
    // volta preenchido com o que estava combinado.
    if (d.nuncaComecou) {
      const pl = pcCancelar
      setPcFatura(pl.invoice_id || '')
      setPcParcelas(String(pl.installments || 2))
      setPcFreq(pl.frequency || 'monthly')
      setPcEntrada(String(Number(pl.entry_amount) || 0))
      if (pl.next_charge_date) setPcPrimeira(String(pl.next_charge_date).slice(0, 10))
      // O formulário desta aba fica sempre visível: preencher os campos já
      // deixa o acordo pronto para revisar e criar de novo.
    }

    setPcCancelar(null); setPcMotivo('')
    loadParcelamentos(); load()
  }

  const loadParcelamentos = async () => {
    const d = await jsonSeguro(await fetch('/api/billing/installment-plan'))
    // O erro vem PRIMEIRO: `d.plans` com lista vazia é verdadeiro em JS, e
    // por isso uma consulta que falhava aparecia como "nenhum parcelamento".
    if (d?.error) { setMsg(`⚠️ ${d.error}`); return }
    if (d?.plans) setPcDados(d)
    else setMsg('⚠️ Resposta inesperada ao carregar os parcelamentos.')
  }
  useEffect(() => { if (aba === 'parcelamentos') loadParcelamentos() }, [aba])

  const loadAutorizacao = async () => {
    const d = await jsonSeguro(await fetch('/api/account/approval-code'))
    if (d?.error) { setMsg(`⚠️ ${d.error}`); return }
    setAutz(d)
  }
  const gerarAutorizacao = async () => {
    setBusy(true); setMsg('')
    const d = await jsonSeguro(await fetch('/api/account/approval-code', { method: 'POST' }))
    setBusy(false)
    if (d?.error) { setMsg(`⚠️ ${d.error}`); return }
    loadAutorizacao()
  }
  useEffect(() => { if (aba === 'autorizacao') loadAutorizacao() }, [aba])

  // O relógio precisa andar: um código sem contagem passa por válido depois
  // de vencido, e a equipe descobre pela recusa em vez de pela tela.
  useEffect(() => {
    if (aba !== 'autorizacao' || !autz?.vivo?.expira_em) { setAutzSeg(0); return }
    const tick = () => setAutzSeg(segundosRestantes(autz.vivo.expira_em))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [aba, autz?.vivo?.expira_em])

  // Prévia local — espelha o cronograma que o servidor vai gravar
  const pcPreview = (() => {
    const f = (pcDados.invoices || []).find((x: any) => x.id === pcFatura)
    const n = Math.max(2, Math.min(36, Number(pcParcelas) || 0))
    if (!f || !pcPrimeira || n < 2) return null
    // A conta da entrada é a MESMA da rota (lib/entrada-parcelamento.ts):
    // duas telas nunca devem calcular o mesmo número de jeitos diferentes.
    const e = entradaDoPedido({ saldo: f.saldo, entryAmount: pcEntrada })
    if ('erro' in e) return { erroEntrada: e.erro, saldo: f.saldo } as any
    const entrada = e.entrada
    const restante = e.restante
    const base = Math.floor((restante / n) * 100) / 100
    const inicio = new Date(`${pcPrimeira}T12:00:00Z`)
    const linhas = Array.from({ length: n }, (_, i) => {
      let d: Date
      if (pcFreq === 'weekly') { d = new Date(inicio); d.setUTCDate(d.getUTCDate() + 7 * i) }
      else if (pcFreq === 'biweekly') { d = new Date(inicio); d.setUTCDate(d.getUTCDate() + 14 * i) }
      else {
        const dia = inicio.getUTCDate(), ano = inicio.getUTCFullYear(), mes = inicio.getUTCMonth() + i
        const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate()
        d = new Date(Date.UTC(ano, mes, Math.min(dia, ultimo), 12, 0, 0))
      }
      return {
        seq: i + 1, data: d.toISOString().slice(0, 10),
        valor: i === n - 1 ? Math.round((restante - base * (n - 1)) * 100) / 100 : base,
      }
    })
    return { saldo: f.saldo, entrada, pct: e.pct, restante, linhas }
  })()

  // Plano que nasceu e nunca saiu do lugar: nada cobrado, nada a parar no
  // Stripe. Desfazer isso não é desfazer uma cobrança, e a tela não deve
  // falar como se fosse.
  // Quem decide é o servidor (a rota devolve `nuncaComecou`). A tela não
  // recebe os ids do Stripe: pedi-los no select principal foi o que fez a
  // lista de parcelamentos desaparecer.
  const nuncaComecou = (pl: any) => !!pl?.nuncaComecou

  const criarParcelamento = async () => {
    if (!pcFatura || !pcPrimeira) { setMsg('⚠️ Escolha a fatura e a data da primeira parcela.'); return }
    setBusy(true)
    const d = await fetch('/api/billing/installment-plan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: pcFatura, entryAmount: Number(pcEntrada) || 0,
        installments: Number(pcParcelas) || 0, frequency: pcFreq, firstDueDate: pcPrimeira,
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (d?.error) { setMsg(`⚠️ ${d.error}`); return }
    setMsg(`✓ ${d.message}`)
    if (d.url) window.open(d.url, '_blank')
    setPcFatura(''); setPcEntrada('0'); setPcPrimeira('')
    loadParcelamentos(); load()
  }

  const criarContrato = async () => {
    if (!cCliente || !cDesc.trim() || !Number(cValor)) { setMsg('⚠️ Preencha cliente, descrição e valor.'); return }
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/recurring', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: cCliente, description: cDesc, amount: Number(cValor),
        interval: 'monthly', dayOfMonth: Number(cDia), autoCharge: cAuto,
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) {
      setMsg(`⚠️ ${d?.error}`)
      // A fatura já tem plano: em vez de mandar procurar o botão em outra
      // aba, abre o cancelamento aqui. Era aqui que a equipe travava.
      if (d?.planoExistente) {
        const pl = (pcDados.plans || []).find((x: any) => x.id === d.planoExistente.id)
        if (pl) { setPcCancelar(pl); setPcMotivo(''); setPcSenha('') }
      }
      return
    }
    setMsg(`✓ ${d.message}`); setCDesc(''); setCValor(''); loadPlanos()
  }

  const alternarContrato = async (pl: any) => {
    const d = await fetch('/api/billing/recurring', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: pl.id, active: !pl.active }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`); loadPlanos()
  }

  // Prévia das parcelas, calculada na tela antes de gravar
  const previaParcelas = () => {
    const n = Math.max(2, Math.min(36, Number(fParcelas) || 0))
    const totalDoc = itens.reduce((s2, i) => s2 + (i.qty || 1) * (i.unitPrice || 0), 0) - (Number(fDesconto) || 0)
    if (!fPrimeiroVenc || totalDoc <= 0) return []
    const base = Math.floor((totalDoc / n) * 100) / 100
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(`${fPrimeiroVenc}T12:00:00Z`)
      d.setMonth(d.getMonth() + i)
      return {
        seq: i + 1,
        data: d.toISOString().slice(0, 10),
        valor: i === n - 1 ? Math.round((totalDoc - base * (n - 1)) * 100) / 100 : base,
      }
    })
  }

  // enviarAgora: o documento continua nascendo rascunho no servidor; quem já
  // pode enviar faz os dois passos num clique, em vez de criar, procurar na
  // lista e clicar Enviar com fila no balcão.
  const criar = async (enviarAgora = false) => {
    if (!fCliente) { setMsg('⚠️ Escolha o cliente.'); return }
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: fCliente, docType: fTipo, dueDate: fVenc || null,
        paymentPlan: fPlano, expectedMethod: fForma || null,
        discount: Number(fDesconto) || 0, notes: fNotas, items: itens,
        installments: Number(fParcelas) || 0, firstDueDate: fPrimeiroVenc || null,
        ...(enviarAgora ? { enviarAgora: true } : {}),
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(d.aviso ? `✓ ${d.message} ⚠️ ${d.aviso}` : `✓ ${d.message}`)
    setAbrirNovo(false); setItens([{ description: '', qty: 1, unitPrice: 0 }])
    setFVenc(''); setFNotas(''); setFDesconto('0')
    load()
  }

  const salvarNovoCliente = async () => {
    if (!novoCli) return
    if (!novoCli.nome.trim()) { setMsg('⚠️ Informe o nome do cliente.'); return }
    setBusy(true); setMsg('')
    const d = await fetch('/api/clients', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: novoCli.nome.trim(), email: novoCli.email.trim(), type: novoCli.tipo,
        stage: 'Onboarding', convidar: novoCli.convidar,
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    // E-mail repetido: a rota devolve o cliente que já existe — seleciona ele
    // em vez de obrigar a equipe a procurar na outra tela.
    if (d?.clientId) {
      setFCliente(d.clientId); setNovoCli(null)
      setMsg(`⚠️ ${d.error} Selecionei o cadastro que já existe.`)
      await load()
      return
    }
    if (!d?.client) { setMsg(`⚠️ ${d?.error || 'Não foi possível cadastrar.'}`); return }
    setNovoCli(null)
    await load()
    setFCliente(d.client.id)
    setMsg(`${d.aviso ? `⚠️ ${d.aviso} ` : '✓ '}${d.client.name} cadastrado${
      d.convite?.enviado ? ' e convidado ao portal' :
      novoCli.convidar && novoCli.email ? ` (o convite não saiu: ${d.convite?.motivo || 'falha no e-mail'})` : ''
    }. Já está selecionado nesta fatura.`)
  }

  const abrirEdicao = async (inv: Inv) => {
    setMsg('')
    const d = await jsonSeguro(await fetch(`/api/billing/invoices?id=${inv.id}`))
    if (!d?.invoice) { setMsg(`⚠️ ${d?.error || 'Não foi possível abrir a fatura.'}`); return }
    setEditandoId(inv.id)
    setFCliente(d.invoice.client_id); setFTipo(d.invoice.doc_type)
    setFVenc(d.invoice.due_date || ''); setFPlano(d.invoice.payment_plan)
    setFForma(d.invoice.expected_method || ''); setFDesconto(String(d.invoice.discount || 0))
    setFNotas(d.invoice.notes || '')
    const linhasDoc = (d.items || []).map((i: any) => ({
      description: i.description, qty: Number(i.qty), unitPrice: Number(i.unit_price),
      serviceId: i.service_id || undefined,
    }))
    setItens(linhasDoc.length ? linhasDoc : [{ description: '', qty: 1, unitPrice: 0 }])
    if (linhasDoc.length === 0) {
      setMsg('⚠️ Esta fatura ficou sem itens (falha na criação). Preencha os itens e salve para corrigi-la.')
    }
    setEPass(''); setEMotivo(''); setAbrirNovo(true); setAba('docs')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const salvarEdicao = async () => {
    if (!editandoId) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/invoices', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: editandoId, action: 'edit',
        dueDate: fVenc || null, expectedMethod: fForma || null,
        discount: Number(fDesconto) || 0, notes: fNotas, items: itens,
        password: ePass, reason: eMotivo,
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setEditandoId(null); setAbrirNovo(false)
    setItens([{ description: '', qty: 1, unitPrice: 0 }]); setEPass(''); setEMotivo('')
    load()
  }

  // Vencida pela data civil, sem passar por fuso — muda o rótulo do botão
  // de cobrança de "Lembrete" para "Cobrar".
  const vencida = (inv: Inv) =>
    !!inv.due_date && String(inv.due_date).slice(0, 10) < new Date().toISOString().slice(0, 10)

  const acao = async (inv: Inv, action: string, pergunta?: string) => {
    if (pergunta && !confirm(pergunta)) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/invoices', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: inv.id, action }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`); load()
  }

  const apagar = async (inv: Inv) => {
    if (!confirm(`Apagar ${inv.number} definitivamente?\n\nSe quiser manter no histórico, use Cancelar.`)) return
    setBusy(true); setMsg('')
    const d = await fetch(`/api/billing/invoices?id=${inv.id}`, { method: 'DELETE' })
      .then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`); load()
  }

  const abrirRecebimento = async (inv: Inv) => {
    setReceber(inv); setRValor(String(inv.saldo)); setPagamentos([]); setCobranca(null)
    setEstPass(''); setEstMotivo('')
    const d = await jsonSeguro(await fetch(`/api/billing/payments?invoiceId=${inv.id}`))
    if (d?.payments) setPagamentos(d.payments)
    if (d?.cobranca) setCobranca(d.cobranca)
  }

  const estornar = async (pg: any) => {
    if (!confirm(`Estornar ${money(pg.amount)} (${pg.method})?\n\nA fatura volta a ficar em aberto.`)) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/payments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refund', paymentId: pg.id, password: estPass, reason: estMotivo }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setReceber(null); load()
  }

  const cobrarCartao = async (inv: Inv, forma: 'card' | 'klarna' | 'us_bank_account' = 'card',
                             confirmarQuitacao = false) => {
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/stripe-checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invoiceId: inv.id, forma, confirmarQuitacao }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    // Fatura parcelada: cobrar aqui quita tudo de uma vez e encerra o
    // parcelamento. O servidor pede confirmação antes de deixar seguir.
    if (d?.precisaConfirmar) {
      if (confirm(`${d.error}\n\nSeguir e encerrar o parcelamento?`)) return cobrarCartao(inv, forma, true)
      return
    }
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message} A baixa entra sozinha quando o cliente pagar.`)
    setReceber(null)
    window.open(d.url, '_blank')
  }

  const cobrarDeNovo = async () => {
    if (!receber) return
    if (!confirm(`Pedir ao Stripe uma nova cobrança de ${receber.number}? O cliente será debitado de novo.`)) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/recharge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invoiceId: receber.id }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setReceber(null); load()
  }

  const salvarRecebimento = async (confirmarComAch = false) => {
    if (!receber) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/payments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: receber.id, amount: Number(rValor), method: rForma, reference: rRef,
        ...(confirmarComAch ? { confirmarComAch: true } : {}),
        ...(exigeAprovacao(rForma)
          ? (apPorSenha
              ? { approverEmail: apEmail, approverPassword: apSenha }
              : { approvalCode: apCodigo })
          : {}),
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    // Débito em conta a caminho: a rota recusa e explica. Quem confirma assume
    // que aquele débito não vai entrar — senão a baixa sai em dobro.
    if (d?.precisaConfirmarAch) {
      if (confirm(`${d.error}\n\nRegistrar assim mesmo?`)) return salvarRecebimento(true)
      return
    }
    if (!d?.ok) {
      setMsg(`⚠️ ${d?.error}`)
      // Código queimado ou senha errada: limpa os dois. Repetir o mesmo
      // código não passa mais — cada um libera uma cobrança só.
      setApSenha(''); setApCodigo('')
      return
    }
    setMsg(`✓ ${d.message}`)
    setReceber(null); setRRef(''); setApEmail(''); setApSenha(''); setApCodigo(''); load()
  }

  // Sem a aprovação preenchida o botão não sai do lugar: melhor travar aqui
  // do que mandar a senha vazia e voltar com erro.
  const faltaAprovacao = exigeAprovacao(rForma) && (apPorSenha
    ? (!apEmail.trim() || !apSenha)
    : !codigoBemFormado(apCodigo))

  const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E8F4', borderRadius: 16, padding: '18px 20px', marginBottom: 16 }
  const inp: React.CSSProperties = { padding: '10px 12px', border: '1.5px solid #E2E8F4', borderRadius: 9, fontSize: 14.5, outline: 'none' }
  const btn = (bg: string, off = false): React.CSSProperties => ({
    padding: '10px 16px', background: off ? '#E2E8F4' : bg, color: off ? '#9AAAB0' : '#fff',
    border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 700, cursor: off ? 'not-allowed' : 'pointer',
  })
  const acaoBtn = (cor: string): React.CSSProperties => ({
    background: 'none', border: 'none', color: cor, fontSize: 13, fontWeight: 700, cursor: 'pointer', marginRight: 10,
  })

  const q = busca.trim().toLowerCase()
  const lista: Inv[] = (dados.invoices || [])
    .filter((i: Inv) => !q || i.number.toLowerCase().includes(q) || i.cliente.toLowerCase().includes(q))
    .filter((i: Inv) => !soAbertas || (Number(i.saldo) > 0 && !['void', 'draft'].includes(i.status)))

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 28, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
          Faturamento
        </h1>
        <p style={{ fontSize: 14.5, color: '#6A7A9A', margin: 0, lineHeight: 1.5 }}>
          Orçamentos e faturas. Documentos nascem como rascunho; enviar, receber e cancelar
          são ações de gerente ou sócio.
        </p>
      </div>

      {msg && (
        <div style={{
          marginBottom: 14, padding: '12px 16px', borderRadius: 10, fontSize: 14.5, fontWeight: 700,
          background: msg.startsWith('✓') ? '#E8F5EE' : '#FEE2E2',
          color: msg.startsWith('✓') ? '#1A6B4A' : '#B02020',
        }}>
          {msg}
          <button onClick={() => setMsg('')} style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, color: 'inherit', fontWeight: 800 }}>✕</button>
        </div>
      )}

      {/* Fluxo do faturamento — estilo QuickBooks Desktop */}
      <section style={{ ...card, padding: '20px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {[
            { id: 'estimate', rotulo: 'Orçamento', desc: 'Proposta ao cliente', cor: '#0A6A8A',
              icone: <><path d="M14 3v5h5" /><path d="M19 8v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7z" /><path d="M9 13h6M9 17h4" /></>,
              onClick: () => { setFTipo('estimate'); setAbrirNovo(true) } },
            { id: 'invoice', rotulo: 'Fatura', desc: 'Emitir cobrança', cor: '#2D3278',
              icone: <><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
              onClick: () => { setFTipo('invoice'); setAbrirNovo(true) } },
            { id: 'receive', rotulo: 'Receber', desc: 'Dar baixa em pagamento', cor: '#1A6B4A',
              icone: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.6c0 2.2-5 1.4-5 3.8 0 1 1 1.6 2.5 1.6s2.5-.5 2.5-1.5" /></>,
              onClick: () => { setSoAbertas(true); setFiltroDoc('invoice'); setAbrirNovo(false) } },
            { id: 'reports', rotulo: 'Relatórios', desc: 'Faturamento e recebimentos', cor: '#5A1A8A',
              somenteSocio: true,
              icone: <><path d="M3 3v18h18" /><path d="M7 15v3M12 10v8M17 6v12" /></>,
              onClick: () => { setRelAberto(v => !v); setAbrirNovo(false) } },
          ].filter(b => !b.somenteSocio || perms?.verRelatorios).map((b, idx, arr) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button onClick={b.onClick}
                style={{ background: '#fff', border: '1.5px solid #E2E8F4', borderRadius: 12,
                  padding: '14px 16px', minWidth: 132, cursor: 'pointer', textAlign: 'center' as const }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke={b.cor}
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                  style={{ display: 'block', margin: '0 auto 8px' }}>
                  {b.icone}
                </svg>
                <div style={{ fontSize: 14.5, fontWeight: 700, color: '#0F2340' }}>{b.rotulo}</div>
                <div style={{ fontSize: 11.5, color: '#6A7A9A', marginTop: 2 }}>{b.desc}</div>
              </button>
              {idx < arr.length - 1 && (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B8C4D8" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Relatórios — só o sócio vê o botão, e só o sócio passa na rota */}
      {relAberto && perms?.verRelatorios && (
        <section style={{ ...card, padding: '18px 22px', border: '2px solid #5A1A8A' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 15, color: '#0F2340', margin: 0 }}>📊 Relatórios do sócio</h3>
            <span style={{ fontSize: 12, color: '#6A7A9A' }}>Abrem em nova aba, prontos para imprimir ou salvar em PDF.</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>Período</span>
            <input type="date" value={relDe} onChange={e => setRelDe(e.target.value)} style={{ padding: '7px 10px', border: '1.5px solid #E2E8F4', borderRadius: 8, fontSize: 13 }} />
            <span style={{ fontSize: 12, color: '#6A7A9A' }}>até</span>
            <input type="date" value={relAte} onChange={e => setRelAte(e.target.value)} style={{ padding: '7px 10px', border: '1.5px solid #E2E8F4', borderRadius: 8, fontSize: 13 }} />
            {[
              ['Este ano', `${anoAtual}-01-01`, `${anoAtual}-12-31`],
              ['Ano passado', `${anoAtual - 1}-01-01`, `${anoAtual - 1}-12-31`],
              ['Este mês', new Date().toISOString().slice(0, 8) + '01', new Date(anoAtual, new Date().getMonth() + 1, 0).toISOString().slice(0, 10)],
            ].map(([r, de, ate]) => (
              <button key={r} onClick={() => { setRelDe(de); setRelAte(ate) }}
                style={{ background: '#fff', border: '1.5px solid #E2E8F4', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 700, color: '#2D3278', cursor: 'pointer' }}>{r}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
            {[
              ['faturamento', 'Faturamento por mês', 'Emitido, recebido e em aberto, mês a mês'],
              ['recebimentos', 'Recebimentos', 'Por forma de pagamento e por cliente'],
              ['aberto', 'Contas a receber', 'Saldo em aberto por cliente e atraso (hoje)'],
              ['recorrente', 'Contratos e parcelamentos', 'Receita recorrente mensal e parcelas a receber (hoje)'],
              ['servicos', 'Faturamento por serviço', 'O que foi faturado, por item do catálogo'],
              ['estornos', 'Estornos e cancelamentos', 'Pagamentos estornados e faturas canceladas'],
            ].map(([id, titulo, desc]) => (
              <button key={id} onClick={() => abrirRelatorio(id)}
                style={{ background: '#fff', border: '1.5px solid #E2E8F4', borderRadius: 12, padding: '12px 14px', textAlign: 'left' as const, cursor: 'pointer' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F2340' }}>{titulo}</div>
                <div style={{ fontSize: 12, color: '#6A7A9A', marginTop: 3 }}>{desc}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #E2E8F4' }}>
        {([
          ['docs', 'Orçamentos e faturas', false],
          ['contratos', 'Contratos recorrentes', false],
          ['parcelamentos', 'Parcelamentos', false],
          // `receber` é o que gerente e sócio têm por nível; assistente
          // autorizado a receber NÃO passa a poder autorizar os outros —
          // quem aprova é quem tem o nível, conferido de novo no servidor.
          ['autorizacao', '🔑 Autorização', true],
        ] as const).filter(([, , soAprovador]) =>
          !soAprovador || perms?.nivel === 'owner' || perms?.nivel === 'manager',
        ).map(([k, r]) => (
          <button key={k} onClick={() => setAba(k)}
            style={{ background: 'none', border: 'none', borderBottom: aba === k ? '3px solid #2D3278' : '3px solid transparent',
              padding: '10px 16px', fontSize: 14.5, fontWeight: 700, cursor: 'pointer',
              color: aba === k ? '#0F2340' : '#6A7A9A' }}>
            {r}
          </button>
        ))}
      </div>

      {aba === 'docs' && (<>
      <div style={{ ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar número ou cliente"
          style={{ ...inp, flex: '1 1 220px' }} />
        <select value={filtroDoc} onChange={e => setFiltroDoc(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="">Orçamentos e faturas</option>
          <option value="estimate">Só orçamentos</option>
          <option value="invoice">Só faturas</option>
        </select>
        <select value={filtroStatus} onChange={e => setFiltroStatus(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
          <option value="">Todas as situações</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.rotulo}</option>)}
        </select>
        {soAbertas && (
          <button onClick={() => setSoAbertas(false)}
            style={{ ...btn('#1A6B4A'), fontSize: 13 }}>
            Só em aberto ✕
          </button>
        )}
        <button onClick={() => setAbrirNovo(v => !v)} style={btn('#2D3278')}>
          {abrirNovo ? 'Fechar' : '➕ Novo documento'}
        </button>
      </div>

      {abrirNovo && (
        <section style={card}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 12px', fontWeight: 400 }}>
            {editandoId ? 'Editar documento' : 'Novo documento'}
          </h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <select value={fCliente} onChange={e => setFCliente(e.target.value)} style={{ ...inp, flex: '2 1 240px', cursor: 'pointer' }}>
              <option value="">— cliente —</option>
              {(dados.clients || []).map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}
            </select>
            <button type="button" onClick={() => setNovoCli({ nome: '', email: '', tipo: 'individual', convidar: true })}
              title="Cadastrar um cliente novo aqui mesmo"
              style={{ ...inp, cursor: 'pointer', background: '#F0F4FF', border: '1.5px solid #2D3278',
                color: '#2D3278', fontWeight: 700, whiteSpace: 'nowrap' as const }}>
              + Novo cliente
            </button>
            <select value={fTipo} onChange={e => setFTipo(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
              <option value="invoice">Fatura</option>
              <option value="estimate">Orçamento</option>
            </select>
            <input type="date" value={fVenc} onChange={e => setFVenc(e.target.value)} style={inp} />
            <select value={fPlano} onChange={e => setFPlano(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
              <option value="full">À vista</option>
              <option value="installments">Parcelado</option>
              <option value="financed">Financiado</option>
              <option value="manual">Combinado</option>
            </select>
            <select value={fForma} onChange={e => setFForma(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
              <option value="">Forma prevista</option>
              {FORMAS.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
            </select>
          </div>

          {fPlano === 'installments' && (
            <div style={{ background:'#F8FAFC', border:'1px solid #E2E8F4', borderRadius:12, padding:'14px 16px', marginBottom:12 }}>
              <div style={{ fontSize:12.5, fontWeight:800, color:'#2D3278', marginBottom:8 }}>
                PARCELAMENTO
              </div>
              <div style={{ display:'flex', gap:10, flexWrap:'wrap', alignItems:'center', marginBottom:10 }}>
                <label style={{ fontSize:13.5, color:'#4A5A70' }}>
                  Parcelas{' '}
                  <input type="number" min={2} max={36} value={fParcelas}
                    onChange={e => setFParcelas(e.target.value)} style={{ ...inp, width:90 }} />
                </label>
                <label style={{ fontSize:13.5, color:'#4A5A70' }}>
                  1º vencimento{' '}
                  <input type="date" value={fPrimeiroVenc}
                    onChange={e => setFPrimeiroVenc(e.target.value)} style={inp} />
                </label>
                <span style={{ fontSize:12.5, color:'#6A7A9A' }}>
                  mensais · exige cartão ou ACH
                </span>
              </div>
              {previaParcelas().length > 0 && (
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  {previaParcelas().map(pp => (
                    <span key={pp.seq} style={{ fontSize:12.5, background:'#fff', border:'1px solid #E2E8F4',
                      borderRadius:8, padding:'5px 10px', fontVariantNumeric:'tabular-nums' as const }}>
                      {pp.seq}ª · {dataUS(pp.data)} · {money(pp.valor)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {itens.map((it, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <select value={it.serviceId || ''}
                onChange={e => {
                  const sv = (dados.services || []).find((x: any) => x.id === e.target.value)
                  setItens(a => a.map((x, i) => i === idx ? (sv
                    ? { ...x, serviceId: sv.id, description: sv.nome, unitPrice: sv.preco }
                    : { ...x, serviceId: undefined }) : x))
                }}
                style={{ ...inp, flex: '2 1 200px', cursor: 'pointer' }}>
                <option value="">— serviço do catálogo —</option>
                {(dados.services || []).map((sv: any) => (
                  <option key={sv.id} value={sv.id}>{sv.nome} · {money(sv.preco)}</option>
                ))}
              </select>
              <input value={it.description} placeholder="Descrição (ajuste se precisar)"
                onChange={e => setItens(a => a.map((x, i) => i === idx ? { ...x, description: e.target.value } : x))}
                style={{ ...inp, flex: '3 1 220px' }} />
              <input type="number" value={it.qty} min={1}
                onChange={e => setItens(a => a.map((x, i) => i === idx ? { ...x, qty: Number(e.target.value) } : x))}
                style={{ ...inp, width: 80 }} />
              <input type="number" value={it.unitPrice} step="0.01" placeholder="0.00"
                onChange={e => setItens(a => a.map((x, i) => i === idx ? { ...x, unitPrice: Number(e.target.value) } : x))}
                style={{ ...inp, width: 120 }} />
              {itens.length > 1 && (
                <button onClick={() => setItens(a => a.filter((_, i) => i !== idx))} style={acaoBtn('#B02020')}>remover</button>
              )}
            </div>
          ))}
          <button onClick={() => setItens(a => [...a, { description: '', qty: 1, unitPrice: 0 }])}
            style={{ ...acaoBtn('#2D3278'), marginBottom: 12 }}>➕ adicionar item</button>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {perms?.darDesconto && (
              <label style={{ fontSize: 13.5, color: '#4A5A70' }}>
                Desconto{' '}
                <input type="number" value={fDesconto} step="0.01"
                  onChange={e => setFDesconto(e.target.value)} style={{ ...inp, width: 110 }} />
              </label>
            )}
            {editandoId && perms?.senhaNaEdicao && (
              <>
                <input value={eMotivo} onChange={e => setEMotivo(e.target.value)}
                  placeholder="Motivo da alteração (obrigatório)"
                  style={{ ...inp, flex: '2 1 220px', borderColor: '#C06010' }} />
                <input type="password" value={ePass} onChange={e => setEPass(e.target.value)}
                  placeholder="Sua senha" style={{ ...inp, width: 160, borderColor: '#C06010' }} />
              </>
            )}
            <input value={fNotas} onChange={e => setFNotas(e.target.value)} placeholder="Observações"
              style={{ ...inp, flex: '1 1 220px' }} />
            <span style={{ fontSize: 16, fontWeight: 800, color: '#0F2340' }}>
              {money(itens.reduce((s, i) => s + (i.qty || 1) * (i.unitPrice || 0), 0) - (Number(fDesconto) || 0))}
            </span>
            {editandoId ? (
              <>
                <button onClick={salvarEdicao} disabled={busy} style={btn('#1A6B4A', busy)}>Salvar alterações</button>
                <button onClick={() => { setEditandoId(null); setAbrirNovo(false); setItens([{ description: '', qty: 1, unitPrice: 0 }]) }}
                  style={btn('#6A7A9A')}>Cancelar edição</button>
              </>
            ) : (<>
              <button onClick={() => criar(false)} disabled={busy} style={btn('#6A7A9A', busy)}>
                Salvar rascunho
              </button>
              {/* Quem não pode enviar vê só "Salvar rascunho" — e o rascunho
                  fica salvo para um gerente enviar depois. */}
              {perms?.enviar && (
                <button onClick={() => criar(true)} disabled={busy} style={btn('#1A6B4A', busy)}>
                  {fTipo === 'estimate' ? 'Criar e enviar orçamento' : 'Criar e enviar fatura'}
                </button>
              )}
            </>)}
          </div>
        </section>
      )}

      {/* Lista curta não pode parecer defeito: quem vê só as próprias faturas
          do dia precisa saber que é assim de propósito. */}
      {dados.escopo?.apenasMinhas && (
        <div style={{ background: '#F0F4FF', border: '1px solid #C8D4F0', borderRadius: 11,
          padding: '11px 14px', marginBottom: 14, fontSize: 13, color: '#2D3278', lineHeight: 1.55 }}>
          👁️ Você está vendo <strong>apenas as faturas que você emitiu hoje</strong>.
          Amanhã esta lista recomeça. Precisa consultar uma fatura de outro dia
          ou de outra pessoa? Peça ao sócio ou ao gerente.
        </div>
      )}

      {loading ? <p style={{ fontSize: 15, color: '#6A7A9A' }}>Carregando…</p> : (
        <div style={{ ...card, overflowX: 'auto' as const }}>
          {lista.length === 0 ? (
            <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhum documento ainda.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 860 }}>
              <thead><tr>
                {['Número', 'Cliente', 'Emissão', 'Vencimento', 'Total', 'Saldo', 'Situação', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '9px 10px', fontSize: 11, fontWeight: 800,
                    color: '#6A7A9A', textTransform: 'uppercase' as const, borderBottom: '1px solid #E2E8F4', whiteSpace: 'nowrap' as const }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {lista.map(inv => {
                  const st = STATUS[inv.status] || { rotulo: inv.status, cor: '#6A7A9A' }
                  return (
                    <tr key={inv.id} style={{ borderBottom: '1px solid #F0F4FA' }}>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, color: '#0F2340', whiteSpace: 'nowrap' as const }}>
                        {inv.number}
                        <div style={{ fontSize: 11, color: '#6A7A9A', fontWeight: 500 }}>
                          {inv.doc_type === 'estimate' ? 'orçamento' : 'fatura'}
                        </div>
                      </td>
                      <td style={{ padding: '10px', fontSize: 14 }}>{inv.cliente}</td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>{dataUS(inv.issue_date)}</td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>{dataUS(inv.due_date)}</td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' as const }}>{money(inv.total)}</td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' as const,
                        color: inv.saldo > 0 ? '#B02020' : '#1A6B4A' }}>{money(inv.saldo)}</td>
                      <td style={{ padding: '10px' }}>
                        <span style={{ fontSize: 12.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20,
                          color: st.cor, background: `${st.cor}14`, whiteSpace: 'nowrap' as const }}>{st.rotulo}</span>
                        {/* Débito em conta a caminho: sem isto a fatura parecia
                            simplesmente não paga, e a equipe cobrava ou dava
                            baixa por fora em cima de dinheiro já enviado. */}
                        {inv.ach_desde && (
                          <div title={`Débito em conta iniciado em ${dataUS(inv.ach_desde)} — o banco leva alguns dias`}
                            style={{ marginTop: 4, fontSize: 11.5, fontWeight: 700, color: '#0A6A8A', whiteSpace: 'nowrap' as const }}>
                            🏦 {money(Number(inv.ach_valor || 0))} a caminho
                          </div>
                        )}
                      </td>
                      <td style={{ padding: '10px', whiteSpace: 'nowrap' as const }}>
                        {inv.status === 'draft' && perms?.cancelar && (
                          <button onClick={() => acao(inv, 'send')} disabled={busy} style={acaoBtn('#2D3278')}>Enviar</button>
                        )}
                        {/* Fatura em aberto que já saiu do rascunho — inclusive a de
                            mensalidade, que nasce enviada pelo Stripe e nunca teve
                            botão. Reenviar repete o documento; Lembrete cobra. */}
                        {inv.status !== 'draft' && inv.status !== 'void' && inv.saldo > 0 && perms?.cancelar && (<>
                          <button onClick={() => acao(inv, 'resend',
                              `Reenviar ${inv.number} para ${inv.cliente}?\n\nMesmo aviso da emissão: "aqui está sua fatura, com o link de pagamento". Nada muda no valor nem na situação.`)}
                            disabled={busy} style={acaoBtn('#2D3278')}>Reenviar</button>
                          <button onClick={() => acao(inv, 'remind',
                              `Enviar lembrete de cobrança de ${inv.number} para ${inv.cliente}?\n\nTexto de cobrança — diz se a fatura está vencida e pede o pagamento.`)}
                            disabled={busy} style={acaoBtn(vencida(inv) ? '#B02020' : '#C06010')}>
                            {vencida(inv) ? 'Cobrar' : 'Lembrete'}
                          </button>
                        </>)}
                        {perms?.receber && inv.saldo > 0 && inv.status !== 'void' && inv.status !== 'draft' && (
                          <button onClick={() => abrirRecebimento(inv)} style={acaoBtn('#1A6B4A')}>Receber</button>
                        )}
                        {perms?.estornar && Number(inv.paid_total) > 0 && (
                          <button onClick={() => abrirRecebimento(inv)} style={acaoBtn('#C06010')}>
                            Pagamentos
                          </button>
                        )}

                        {perms?.editar && Number(inv.paid_total) === 0 && inv.status !== 'void' && (
                          <button onClick={() => abrirEdicao(inv)} disabled={busy} style={acaoBtn('#5A1A8A')}>Editar</button>
                        )}
                        {perms?.duplicar && (
                          <button onClick={() => acao(inv, 'duplicate')} disabled={busy} style={acaoBtn('#6A7A9A')}>Duplicar</button>
                        )}
                        {perms?.cancelar && inv.status !== 'void' && (
                          <button onClick={() => acao(inv, 'cancel', `Cancelar ${inv.number}? Ela continua no histórico.`)}
                            disabled={busy} style={acaoBtn('#C06010')}>Cancelar</button>
                        )}
                        <button onClick={() => window.open(`/api/billing/print?id=${inv.id}`, '_blank')}
                          style={acaoBtn('#0F2340')}>🖨 Imprimir</button>
                        {perms?.apagar && Number(inv.paid_total) === 0 && (
                          <button onClick={() => apagar(inv)} disabled={busy} style={acaoBtn('#B02020')}>Apagar</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      </>)}

      {aba === 'contratos' && (
        <>
          {perms?.receber && (
            <section style={card}>
              <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
                Novo contrato
              </h2>
              <p style={{ fontSize: 13, color: '#6A7A9A', margin: '0 0 12px' }}>
                Gera fatura sozinho no dia escolhido. Cobrança automática exige cartão ou ACH
                autorizado pelo cliente — sem isso, a fatura é emitida e a baixa é manual.
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={cCliente} onChange={e => setCCliente(e.target.value)} style={{ ...inp, flex: '2 1 220px', cursor: 'pointer' }}>
                  <option value="">— cliente —</option>
                  {(dados.clients || []).map((c: any) => <option key={c.id} value={c.id}>{c.nome}</option>)}
                </select>
                <select onChange={e => {
                    const sv = (dados.services || []).find((x: any) => x.id === e.target.value)
                    if (sv) { setCDesc(sv.nome); setCValor(String(sv.preco)) }
                  }}
                  style={{ ...inp, flex: '2 1 190px', cursor: 'pointer' }}>
                  <option value="">— serviço do catálogo —</option>
                  {(dados.services || []).map((sv: any) => (
                    <option key={sv.id} value={sv.id}>{sv.nome} · {money(sv.preco)}</option>
                  ))}
                </select>
                <input value={cDesc} onChange={e => setCDesc(e.target.value)} placeholder="Descrição"
                  style={{ ...inp, flex: '2 1 170px' }} />
                <input type="number" step="0.01" value={cValor} onChange={e => setCValor(e.target.value)}
                  placeholder="Valor" style={{ ...inp, width: 120 }} />
                <label style={{ fontSize: 13.5, color: '#4A5A70' }}>
                  Dia{' '}
                  <input type="number" min={1} max={28} value={cDia} onChange={e => setCDia(e.target.value)}
                    style={{ ...inp, width: 80 }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: '#4A5A70', cursor: 'pointer' }}>
                  <input type="checkbox" checked={cAuto} onChange={e => setCAuto(e.target.checked)} />
                  Cobrar automaticamente
                </label>
                <button onClick={criarContrato} disabled={busy} style={btn('#1A6B4A', busy)}>Criar contrato</button>
              </div>
            </section>
          )}

          <div style={{ ...card, overflowX: 'auto' as const }}>
            {planos.length === 0 ? (
              <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhum contrato cadastrado.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 720 }}>
                <thead><tr>
                  {['Cliente', 'Serviço', 'Valor', 'Dia', 'Próxima', 'Cobrança', 'Situação', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '9px 10px', fontSize: 11, fontWeight: 800,
                      color: '#6A7A9A', textTransform: 'uppercase' as const, borderBottom: '1px solid #E2E8F4', whiteSpace: 'nowrap' as const }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {planos.map((pl: any) => (
                    <tr key={pl.id} style={{ borderBottom: '1px solid #F0F4FA', opacity: pl.active ? 1 : 0.55 }}>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, color: '#0F2340' }}>{pl.cliente}</td>
                      <td style={{ padding: '10px', fontSize: 14 }}>{pl.description}</td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' as const }}>{money(pl.amount)}</td>
                      <td style={{ padding: '10px', fontSize: 13.5 }}>{pl.day_of_month}</td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>{dataUS(pl.next_run)}</td>
                      <td style={{ padding: '10px', fontSize: 13 }}>
                        {pl.auto_charge
                          ? <span style={{ color: '#1A6B4A', fontWeight: 700 }}>automática</span>
                          : <span style={{ color: '#6A7A9A' }}>manual</span>}
                      </td>
                      <td style={{ padding: '10px', fontSize: 13, fontWeight: 700,
                        color: pl.active ? '#1A6B4A' : '#9AAAB0' }}>{pl.active ? 'ativo' : 'pausado'}</td>
                      <td style={{ padding: '10px' }}>
                        {perms?.receber && (
                          <button onClick={() => alternarContrato(pl)} style={acaoBtn(pl.active ? '#C06010' : '#1A6B4A')}>
                            {pl.active ? 'Pausar' : 'Reativar'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {aba === 'parcelamentos' && (
        <>
          {perms?.receber && (
            <section style={card}>
              <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 17, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
                Parcelar uma fatura em aberto
              </h3>
              <p style={{ fontSize: 13.5, color: '#6A7A9A', margin: '0 0 14px' }}>
                O cliente autoriza o débito automático uma vez e o Stripe cobra as parcelas sozinho.
                Entrada zero é permitida — nesse caso nada é cobrado agora, só o mandato é colhido.
              </p>

              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 10, alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, flex: '2 1 260px' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>FATURA</span>
                  <select value={pcFatura} onChange={e => setPcFatura(e.target.value)} style={{ ...inp, cursor: 'pointer' }}>
                    <option value="">— escolha a fatura —</option>
                    {(pcDados.invoices || []).map((f: any) => (
                      <option key={f.id} value={f.id}>{f.number} · {f.cliente} · saldo {money(f.saldo)}</option>
                    ))}
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>ENTRADA $</span>
                  <input type="number" min={0} step="0.01" value={pcEntrada}
                    onChange={e => setPcEntrada(e.target.value)} style={{ ...inp, width: 120 }} />
                  {/* O valor é em dólar porque é assim que o cliente paga.
                      A porcentagem aparece na prévia, calculada. */}
                  <span style={{ fontSize: 11, color: '#9AAAB0' }}>
                    {pcPreview?.saldo ? `até ${money(tetoDaEntrada(pcPreview.saldo))}` : 'em dólar'}
                  </span>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>PARCELAS</span>
                  <input type="number" min={2} max={36} value={pcParcelas}
                    onChange={e => setPcParcelas(e.target.value)} style={{ ...inp, width: 100 }} />
                </label>

                <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>FREQUÊNCIA</span>
                  <select value={pcFreq} onChange={e => setPcFreq(e.target.value as any)} style={{ ...inp, cursor: 'pointer' }}>
                    <option value="monthly">Mensal</option>
                    <option value="biweekly">Quinzenal</option>
                    <option value="weekly">Semanal</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>1ª PARCELA</span>
                  <input type="date" value={pcPrimeira} onChange={e => setPcPrimeira(e.target.value)} style={inp} />
                </label>
              </div>

              {/* Entrada fora do limite: dizer aqui, antes de criar, com o
                  valor que resolve — não depois, num erro do servidor. */}
              {pcPreview?.erroEntrada && (
                <div style={{ marginTop: 14, padding: '11px 14px', background: '#FDF0F0',
                  border: '1px solid #F0C0C0', borderRadius: 10, fontSize: 13, color: '#B02020', lineHeight: 1.55 }}>
                  ⚠️ {pcPreview.erroEntrada}
                </div>
              )}

              {pcPreview && !pcPreview.erroEntrada && (
                <div style={{ marginTop: 14, padding: '12px 14px', background: '#F7F9FC', borderRadius: 10, border: '1px solid #E2E8F4' }}>
                  <div style={{ fontSize: 13.5, color: '#0F2340', fontWeight: 700, marginBottom: 8 }}>
                    Saldo {money(pcPreview.saldo)}
                    {pcPreview.entrada > 0
                      ? <> · entrada {money(pcPreview.entrada)} ({pcPreview.pct}%) · a parcelar {money(pcPreview.restante)}</>
                      : <> · sem entrada</>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
                    {pcPreview.linhas.map((l: any) => (
                      <span key={l.seq} style={{ fontSize: 13, color: '#4A5A70', background: '#fff',
                        border: '1px solid #E2E8F4', borderRadius: 8, padding: '5px 9px', whiteSpace: 'nowrap' as const }}>
                        <b>{l.seq}ª</b> {dataUS(l.data)} · {money(l.valor)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 14 }}>
                <button onClick={criarParcelamento}
                  disabled={busy || !pcPreview || !!pcPreview.erroEntrada}
                  style={btn('#1A6B4A', busy || !pcPreview || !!pcPreview.erroEntrada)}>
                  Criar parcelamento e gerar link
                </button>
              </div>
            </section>
          )}

          <div style={{ ...card, overflowX: 'auto' as const }}>
            {(pcDados.plans || []).length === 0 ? (
              <p style={{ fontSize: 15, color: '#4A5A70', margin: 0 }}>Nenhuma fatura parcelada ainda.</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 760 }}>
                <thead><tr>
                  {['Fatura', 'Cliente', 'Total', 'Entrada', 'Parcelas', 'Pagas', 'Próxima', 'Situação', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '9px 10px', fontSize: 11, fontWeight: 800,
                      color: '#6A7A9A', textTransform: 'uppercase' as const, borderBottom: '1px solid #E2E8F4', whiteSpace: 'nowrap' as const }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {(pcDados.plans || []).map((pl: any) => (
                    <tr key={pl.id} style={{ borderBottom: '1px solid #F0F4FA',
                      opacity: ['cancelled', 'completed'].includes(pl.status) ? 0.55 : 1 }}>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, color: '#0F2340' }}>{pl.numero}</td>
                      <td style={{ padding: '10px', fontSize: 14 }}>{pl.cliente}</td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' as const }}>{money(pl.total)}</td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>
                        {Number(pl.entry_amount) > 0 ? `${money(pl.entry_amount)} (${pl.entry_pct}%)` : '—'}
                      </td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>
                        {pl.installments}x {money(pl.installment_amount)}
                        <span style={{ color: '#6A7A9A' }}> · {FREQ_PT[pl.frequency] || pl.frequency}</span>
                      </td>
                      <td style={{ padding: '10px', fontSize: 13.5 }}>{pl.paid_installments}/{pl.installments}</td>
                      <td style={{ padding: '10px', fontSize: 13.5, whiteSpace: 'nowrap' as const }}>{dataUS(pl.next_charge_date)}</td>
                      <td style={{ padding: '10px', fontSize: 13, fontWeight: 700, color: COR_STATUS[pl.status] || '#6A7A9A' }}>
                        {STATUS_PT[pl.status] || pl.status}
                      </td>
                      <td style={{ padding: '10px', whiteSpace: 'nowrap' as const }}>
                        {['awaiting_entry', 'awaiting_setup'].includes(pl.status) && pl.stripe_session_id && (
                          <span style={{ fontSize: 12.5, color: '#6A7A9A', marginRight: 10 }}>aguardando o cliente</span>
                        )}
                        {!['cancelled', 'completed'].includes(pl.status) && pcDados.perms?.cancelar && (
                          <button onClick={() => { setPcCancelar(pl); setPcMotivo(''); setPcSenha(''); setMsg('') }}
                            style={{ background: 'none', border: 'none', color: '#B02020',
                              fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: 0 }}>
                            {/* Plano que nunca começou: refazer o acordo é o que
                                a equipe quer, e o cancelamento devolve o
                                formulário preenchido. */}
                            {nuncaComecou(pl) ? 'Refazer acordo' : 'Cancelar parcelamento'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {aba === 'autorizacao' && (
        <>
          <section style={card}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 17, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
              Autorizar um recebimento
            </h3>
            <p style={{ fontSize: 13.5, color: '#6A7A9A', margin: '0 0 16px', lineHeight: 1.6 }}>
              Dinheiro em espécie, cheque, wire e as outras formas fora de cartão e Zelle
              só entram com a sua autorização. Gere o número aqui e <strong>dite a quem
              está atendendo</strong> — ele vale {autz?.minutos || MINUTOS_DE_VIDA} minutos
              e <strong>uma cobrança só</strong>. Você nunca digita a sua senha no
              computador de outra pessoa.
            </p>

            {autz?.vivo && autzSeg > 0 ? (
              <div style={{ background: '#F0FBF4', border: '2px solid #1A6B4A', borderRadius: 14,
                padding: '22px 20px', textAlign: 'center' as const }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, color: '#1A6B4A',
                  textTransform: 'uppercase' as const, letterSpacing: 1, marginBottom: 8 }}>
                  Dite este número
                </div>
                <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: 6, color: '#0F2340',
                  fontFamily: 'monospace', lineHeight: 1.1 }}>
                  {formatarCodigo(autz.vivo.codigo)}
                </div>
                <div style={{ fontSize: 14, color: autzSeg < 60 ? '#B02020' : '#1A6B4A',
                  fontWeight: 700, marginTop: 10 }}>
                  vence em {relogio(autzSeg)}
                </div>
                <button onClick={gerarAutorizacao} disabled={busy}
                  style={{ ...btn('#6A7A9A', busy), marginTop: 14 }}>
                  Gerar outro (este deixa de valer)
                </button>
              </div>
            ) : (
              <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F4', borderRadius: 14,
                padding: '26px 20px', textAlign: 'center' as const }}>
                <p style={{ fontSize: 13.5, color: '#6A7A9A', margin: '0 0 14px' }}>
                  {autz?.vivo ? 'O seu último código venceu.' : 'Nenhum código ativo.'}
                </p>
                <button onClick={gerarAutorizacao} disabled={busy} style={btn('#1A6B4A', busy)}>
                  {busy ? 'Gerando…' : 'Gerar código de autorização'}
                </button>
              </div>
            )}
          </section>

          <div style={{ ...card, overflowX: 'auto' as const }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 10 }}>
              O QUE OS SEUS CÓDIGOS AUTORIZARAM
            </div>
            {(autz?.usados || []).length === 0 ? (
              <p style={{ fontSize: 14, color: '#4A5A70', margin: 0 }}>
                Nenhum código seu foi usado ainda.
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, minWidth: 520 }}>
                <thead><tr>
                  {['Código', 'Fatura', 'Valor', 'Forma', 'Usado em'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '9px 10px', fontSize: 11, fontWeight: 800,
                      color: '#6A7A9A', textTransform: 'uppercase' as const, borderBottom: '1px solid #E2E8F4' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {(autz.usados || []).map((u: any) => (
                    <tr key={u.codigo} style={{ borderBottom: '1px solid #F0F4FA' }}>
                      <td style={{ padding: '10px', fontSize: 13.5, fontFamily: 'monospace', fontWeight: 700 }}>
                        {formatarCodigo(u.codigo)}
                      </td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, color: '#0F2340' }}>{u.fatura || '—'}</td>
                      <td style={{ padding: '10px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' as const }}>{money(u.valor || 0)}</td>
                      <td style={{ padding: '10px', fontSize: 13.5 }}>{(FORMAS.find(([v]) => v === u.forma)?.[1]) || u.forma || '—'}</td>
                      <td style={{ padding: '10px', fontSize: 13, color: '#6A7A9A', whiteSpace: 'nowrap' as const }}>
                        {u.usado_em ? new Date(u.usado_em).toLocaleString('en-US') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Cancelar parcelamento: o acordo desandou e o cliente vai pagar de
          outro jeito. O que já foi pago FICA pago — isto para a cobrança
          futura, não desfaz recebimento (isso é estorno). */}
      {pcCancelar && (
        <div onClick={() => setPcCancelar(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,35,64,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 460, padding: '20px 22px' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
              {nuncaComecou(pcCancelar) ? 'Encerrar proposta de' : 'Cancelar parcelamento de'} {pcCancelar.numero}
            </h3>
            <p style={{ fontSize: 13, color: '#4A5A70', margin: '0 0 14px', lineHeight: 1.6 }}>
              {nuncaComecou(pcCancelar) ? (
                <>O cliente nunca cadastrou o débito: <strong>nada foi cobrado</strong> e
                não há nada a parar no Stripe. O link que ele recebeu deixa de
                valer e a fatura segue em aberto — depois disso você pode
                criar o acordo novo.</>
              ) : (
                <>O débito automático para de cobrar e as parcelas que faltam são
                canceladas. <strong>A fatura continua em aberto com o saldo</strong> —
                o que o cliente já pagou fica pago. Para devolver dinheiro ao
                cliente, o caminho é o estorno, não este.</>
              )}
            </p>
            <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F4', borderRadius: 10,
              padding: '10px 12px', marginBottom: 14, fontSize: 13, color: '#4A5A70' }}>
              {pcCancelar.paid_installments}/{pcCancelar.installments} parcelas pagas ·
              plano de {money(pcCancelar.total)}
            </div>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>
              Motivo * (fica na trilha do plano)
            </label>
            <input value={pcMotivo} onChange={e => setPcMotivo(e.target.value)}
              placeholder="ex.: cliente vai quitar o saldo por Zelle"
              style={{ ...inp, width: '100%', marginBottom: 10, boxSizing: 'border-box' as const }} />

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>
              Sua senha *
            </label>
            <input type="password" value={pcSenha} onChange={e => setPcSenha(e.target.value)}
              autoComplete="new-password"
              style={{ ...inp, width: '100%', marginBottom: 16, boxSizing: 'border-box' as const }} />

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setPcCancelar(null)} style={btn('#6A7A9A')}>Voltar</button>
              <button onClick={cancelarParcelamento}
                disabled={busy || pcMotivo.trim().length < 5 || !pcSenha}
                style={btn('#B02020', busy || pcMotivo.trim().length < 5 || !pcSenha)}>
                  {busy ? 'Cancelando…'
                  : nuncaComecou(pcCancelar) ? 'Encerrar proposta' : 'Cancelar parcelamento'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cadastro rápido, sem sair da emissão. Só o essencial: o resto do
          cadastro se completa na ficha do cliente, e o convite já sai daqui. */}
      {novoCli && (
        <div onClick={() => setNovoCli(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,35,64,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 440, padding: '20px 22px' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
              Novo cliente
            </h3>
            <p style={{ fontSize: 13, color: '#6A7A9A', margin: '0 0 16px', lineHeight: 1.5 }}>
              O necessário para emitir a fatura. O cadastro completo fica na ficha do cliente.
            </p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {[['individual', '👤 Pessoa física'], ['business', '🏢 Empresa']].map(([v, l]) => (
                <button key={v} type="button" onClick={() => setNovoCli({ ...novoCli, tipo: v })}
                  style={{ flex: 1, padding: '9px', borderRadius: 9, cursor: 'pointer', fontSize: 13.5, fontWeight: 700,
                    border: novoCli.tipo === v ? '2px solid #2D3278' : '1.5px solid #E2E8F4',
                    background: novoCli.tipo === v ? '#2D3278' : '#fff',
                    color: novoCli.tipo === v ? '#fff' : '#6A7A9A' }}>{l}</button>
              ))}
            </div>

            <input autoFocus value={novoCli.nome} onChange={e => setNovoCli({ ...novoCli, nome: e.target.value })}
              placeholder={novoCli.tipo === 'business' ? 'Nome da empresa' : 'Nome completo'}
              style={{ ...inp, width: '100%', boxSizing: 'border-box' as const, marginBottom: 10 }} />
            <input value={novoCli.email} onChange={e => setNovoCli({ ...novoCli, email: e.target.value })}
              placeholder="E-mail (para o acesso ao portal)" type="email"
              style={{ ...inp, width: '100%', boxSizing: 'border-box' as const, marginBottom: 10 }} />

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, color: '#4A5A70',
              marginBottom: 16, cursor: novoCli.email ? 'pointer' : 'not-allowed', opacity: novoCli.email ? 1 : 0.55 }}>
              <input type="checkbox" checked={novoCli.convidar && !!novoCli.email} disabled={!novoCli.email}
                onChange={e => setNovoCli({ ...novoCli, convidar: e.target.checked })} style={{ marginTop: 2 }} />
              <span>
                Enviar o convite de acesso ao portal agora
                <div style={{ fontSize: 11.5, color: '#9AAAB0' }}>
                  {novoCli.email
                    ? 'Ele recebe um e-mail para criar a senha. Vale por 7 dias.'
                    : 'Precisa de e-mail para enviar.'}
                </div>
              </span>
            </label>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setNovoCli(null)} disabled={busy}
                style={{ ...btn('#6A7A9A'), background: '#F0F4FA', color: '#4A5A70' }}>Cancelar</button>
              <button type="button" onClick={salvarNovoCliente} disabled={busy} style={btn('#2D3278', busy)}>
                {busy ? 'Salvando…' : 'Cadastrar e usar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {receber && (
        <div onClick={() => setReceber(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,35,64,0.55)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: '22px 24px', maxWidth: 460, width: '100%' }}>
            <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 18, color: '#0F2340', margin: '0 0 4px', fontWeight: 400 }}>
              {receber.saldo > 0 ? 'Receber' : 'Pagamentos de'} {receber.number}
            </h3>
            <p style={{ fontSize: 13.5, color: '#6A7A9A', margin: '0 0 14px' }}>
              {receber.cliente} · saldo {money(receber.saldo)}
            </p>

            {receber.saldo > 0 && (<>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>Valor recebido</label>
            <input type="number" step="0.01" value={rValor} onChange={e => setRValor(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 10, boxSizing: 'border-box' as const }} />

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>Forma</label>
            <select value={rForma} onChange={e => setRForma(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 10, cursor: 'pointer' }}>
              {FORMAS.map(([k, r]) => <option key={k} value={k}>{r}</option>)}
            </select>
            {cobranca?.automatica ? (
              <div style={{ background: '#FFF7E6', border: '1px solid #E0A860', borderRadius: 10, padding: '10px 13px', marginBottom: 10, fontSize: 12.5, color: '#5A3A00', lineHeight: 1.5 }}>
                <b>Cobrança automática pelo Stripe.</b>{' '}
                {cobranca.falhas.length > 0
                  ? <>Débito da parcela {cobranca.falhas[0].seq} falhou ({cobranca.falhas[0].motivo || 'recusado'}, {cobranca.falhas[0].tentativas} tentativa(s)). Receba por fora o valor exato da parcela ({money(cobranca.falhas[0].valor)}) ou o saldo inteiro — a fatura sai da linha de cobrança.</>
                  : <>Recebimento manual só do saldo inteiro: assim a fatura sai da linha de cobrança e o débito não acontece.</>}
                {cobranca.podeCobrarDeNovo && perms?.receber && (
                  <button onClick={cobrarDeNovo} disabled={busy}
                    style={{ display: 'block', marginTop: 8, background: '#fff', color: '#7A4A10', border: '1.5px solid #E0A860', borderRadius: 8, padding: '6px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                    🔁 Cobrar novamente pelo Stripe
                  </button>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 12, color: '#6A7A9A', margin: '0 0 10px' }}>
                Pode receber em partes: o que faltar continua em aberto na fatura.
              </p>
            )}

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>Referência (Conf#, nº do cheque)</label>
            <input value={rRef} onChange={e => setRRef(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 14, boxSizing: 'border-box' as const }} />

            {exigeAprovacao(rForma) && (
              <div style={{ background: '#FFF8E8', border: '1.5px solid #F0D8A0', borderRadius: 11,
                padding: '13px 15px', marginBottom: 14 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#7A5A10', marginBottom: 4 }}>
                  🔐 {nomeDaForma(rForma)} pede aprovação
                </div>
                <p style={{ fontSize: 12, color: '#7A5A10', margin: '0 0 10px', lineHeight: 1.55 }}>
                  Um gerente ou sócio precisa autorizar este lançamento.
                  Cartão e Zelle você registra sozinho.
                </p>
                {!apPorSenha ? (
                  <>
                    <input value={apCodigo} onChange={e => setApCodigo(e.target.value.toUpperCase())}
                      placeholder="Código do gerente (ex.: ACDE-3467)" autoComplete="off"
                      maxLength={12} spellCheck={false}
                      style={{ ...inp, width: '100%', boxSizing: 'border-box' as const,
                        borderColor: '#E0C880', fontSize: 18, fontWeight: 800,
                        letterSpacing: 2, textAlign: 'center' as const, fontFamily: 'monospace' }} />
                    <p style={{ fontSize: 11.5, color: '#7A5A10', margin: '8px 0 0', lineHeight: 1.5 }}>
                      O gerente abre <strong>Financeiro → Autorização</strong> no computador dele e
                      dita o número. Vale {MINUTOS_DE_VIDA} minutos e <strong>uma cobrança</strong>.
                    </p>
                    <button type="button" onClick={() => setApPorSenha(true)}
                      style={{ background: 'none', border: 'none', color: '#7A5A10', fontSize: 11.5,
                        textDecoration: 'underline', cursor: 'pointer', padding: '8px 0 0' }}>
                      O gerente está aqui e prefere usar a senha
                    </button>
                  </>
                ) : (
                  <>
                    <input value={apEmail} onChange={e => setApEmail(e.target.value)}
                      placeholder="E-mail de quem autoriza" autoComplete="off"
                      style={{ ...inp, width: '100%', marginBottom: 8, boxSizing: 'border-box' as const,
                        borderColor: '#E0C880', fontSize: 13 }} />
                    <input type="password" value={apSenha} onChange={e => setApSenha(e.target.value)}
                      placeholder="Senha de quem autoriza" autoComplete="new-password"
                      style={{ ...inp, width: '100%', boxSizing: 'border-box' as const,
                        borderColor: '#E0C880', fontSize: 13 }} />
                    <button type="button" onClick={() => { setApPorSenha(false); setApSenha('') }}
                      style={{ background: 'none', border: 'none', color: '#7A5A10', fontSize: 11.5,
                        textDecoration: 'underline', cursor: 'pointer', padding: '8px 0 0' }}>
                      Voltar a usar o código
                    </button>
                  </>
                )}
              </div>
            )}
            </>)}

            {receber.saldo > 0 && rForma === 'card' && (
              <div style={{ background: '#F8FAFC', border: '1px solid #E2E8F4', borderRadius: 10,
                padding: '11px 13px', marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, color: '#4A5A70', lineHeight: 1.5, marginBottom: 9 }}>
                  <b>Cartão:</b> pagamento à vista no crédito ou débito.<br />
                  <b>Klarna:</b> o cliente parcela com eles e <b>você recebe o valor cheio na hora</b> — a
                  inadimplência passa a ser risco da Klarna. Taxa maior (~6%).<br />
                  <b>ACH:</b> débito na conta bancária, taxa baixa, compensa em alguns dias.<br />
                  <b>Já cobrei:</b> quando o cartão passou na maquininha — informe o comprovante em Referência.
                </div>
                <button onClick={() => cobrarCartao(receber, 'card')} disabled={busy}
                  style={{ ...btn('#5A1A8A', busy), width: '100%', marginBottom: 8 }}>
                  💳 Cobrar no cartão — {money(Number(rValor) || receber.saldo)}
                </button>
                <button onClick={() => cobrarCartao(receber, 'klarna')} disabled={busy}
                  style={{ ...btn('#C06010', busy), width: '100%', marginBottom: 8 }}>
                  🧾 Parcelar com Klarna — você recebe integral
                </button>
                <button onClick={() => cobrarCartao(receber, 'us_bank_account')} disabled={busy}
                  style={{ ...btn('#0A6A8A', busy), width: '100%' }}>
                  🏦 Débito em conta (ACH)
                </button>
              </div>
            )}

            {receber.saldo <= 0 && (
              <p style={{ fontSize: 13.5, color: '#1A6B4A', fontWeight: 700, margin: '0 0 12px' }}>
                Fatura quitada. Para reabri-la, estorne o pagamento abaixo.
              </p>
            )}

            {pagamentos.length > 0 && (
              <div style={{ borderTop: '1px solid #EEF1F6', paddingTop: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 8 }}>
                  JÁ RECEBIDO NESTA FATURA
                </div>
                {pagamentos.map(pg => (
                  <div key={pg.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13 }}>
                    <span style={{ fontWeight: 700 }}>{money(pg.amount)}</span>
                    <span style={{ color: '#6A7A9A' }}>{pg.method}{pg.reference ? ` · ${pg.reference}` : ''}</span>
                    {perms?.estornar && (
                      <button onClick={() => estornar(pg)} disabled={busy}
                        style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#B02020',
                          fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                        Estornar
                      </button>
                    )}
                  </div>
                ))}
                {perms?.senhaNaEdicao && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <input value={estMotivo} onChange={e => setEstMotivo(e.target.value)}
                      placeholder="Motivo do estorno" style={{ ...inp, flex: 1, fontSize: 13, borderColor: '#C06010' }} />
                    <input type="password" value={estPass} onChange={e => setEstPass(e.target.value)}
                      placeholder="Sua senha" style={{ ...inp, width: 130, fontSize: 13, borderColor: '#C06010' }} />
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setReceber(null)} style={btn('#6A7A9A')}>
                {receber.saldo > 0 ? 'Cancelar' : 'Fechar'}
              </button>
              {receber.saldo > 0 && (
                <button onClick={() => salvarRecebimento()} disabled={busy || faltaAprovacao}
                  style={btn('#1A6B4A', busy || faltaAprovacao)}
                  title={faltaAprovacao ? 'Preencha o e-mail e a senha de quem autoriza' : ''}>
                  {rForma === 'card' ? 'Já cobrei — registrar'
                    : faltaAprovacao ? 'Aguardando aprovação' : 'Registrar'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
