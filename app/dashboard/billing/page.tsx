'use client'
// Financeiro → Faturamento
// Lista de orçamentos e faturas, criação (nasce rascunho), envio,
// recebimento, duplicação e cancelamento — cada botão conforme o nível.

import { useState, useEffect } from 'react'

interface Inv {
  id: string; number: string; doc_type: string; status: string; cliente: string
  issue_date: string; due_date: string | null; total: number; paid_total: number; saldo: number
  payment_plan: string; expected_method: string | null
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
  const [aba, setAba] = useState<'docs' | 'contratos' | 'parcelamentos'>('docs')
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
  const [fTipo, setFTipo] = useState('invoice')
  const [fVenc, setFVenc] = useState('')
  const [fPlano, setFPlano] = useState('full')
  const [fForma, setFForma] = useState('')
  const [fDesconto, setFDesconto] = useState('0')
  const [fNotas, setFNotas] = useState('')
  const [itens, setItens] = useState<Item[]>([{ description: '', qty: 1, unitPrice: 0 }])

  // recebimento
  const [receber, setReceber] = useState<Inv | null>(null)
  const [rValor, setRValor] = useState('')
  const [rForma, setRForma] = useState('zelle')
  const [rRef, setRRef] = useState('')
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

  const loadParcelamentos = async () => {
    const d = await jsonSeguro(await fetch('/api/billing/installment-plan'))
    if (d?.plans) setPcDados(d)
    else if (d?.error) setMsg(`⚠️ ${d.error}`)
  }
  useEffect(() => { if (aba === 'parcelamentos') loadParcelamentos() }, [aba])

  // Prévia local — espelha o cronograma que o servidor vai gravar
  const pcPreview = (() => {
    const f = (pcDados.invoices || []).find((x: any) => x.id === pcFatura)
    const n = Math.max(2, Math.min(36, Number(pcParcelas) || 0))
    if (!f || !pcPrimeira || n < 2) return null
    const entrada = Math.round(f.saldo * ((Number(pcEntrada) || 0) / 100) * 100) / 100
    const restante = Math.round((f.saldo - entrada) * 100) / 100
    if (restante <= 0) return null
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
    return { saldo: f.saldo, entrada, restante, linhas }
  })()

  const criarParcelamento = async () => {
    if (!pcFatura || !pcPrimeira) { setMsg('⚠️ Escolha a fatura e a data da primeira parcela.'); return }
    setBusy(true)
    const d = await fetch('/api/billing/installment-plan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: pcFatura, entryPct: Number(pcEntrada) || 0,
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
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
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

  const criar = async () => {
    if (!fCliente) { setMsg('⚠️ Escolha o cliente.'); return }
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/invoices', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: fCliente, docType: fTipo, dueDate: fVenc || null,
        paymentPlan: fPlano, expectedMethod: fForma || null,
        discount: Number(fDesconto) || 0, notes: fNotas, items: itens,
        installments: Number(fParcelas) || 0, firstDueDate: fPrimeiroVenc || null,
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setAbrirNovo(false); setItens([{ description: '', qty: 1, unitPrice: 0 }])
    setFVenc(''); setFNotas(''); setFDesconto('0')
    load()
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
    setReceber(inv); setRValor(String(inv.saldo)); setPagamentos([])
    setEstPass(''); setEstMotivo('')
    const d = await jsonSeguro(await fetch(`/api/billing/payments?invoiceId=${inv.id}`))
    if (d?.payments) setPagamentos(d.payments)
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

  const cobrarCartao = async (inv: Inv, forma: 'card' | 'klarna' | 'us_bank_account' = 'card') => {
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/stripe-checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invoiceId: inv.id, forma }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message} A baixa entra sozinha quando o cliente pagar.`)
    setReceber(null)
    window.open(d.url, '_blank')
  }

  const salvarRecebimento = async () => {
    if (!receber) return
    setBusy(true); setMsg('')
    const d = await fetch('/api/billing/payments', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: receber.id, amount: Number(rValor), method: rForma, reference: rRef,
      }),
    }).then(jsonSeguro).catch(e => ({ error: String(e) }))
    setBusy(false)
    if (!d?.ok) { setMsg(`⚠️ ${d?.error}`); return }
    setMsg(`✓ ${d.message}`)
    setReceber(null); setRRef(''); load()
  }

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
              onClick: () => setMsg('Relatórios de faturamento entram na próxima etapa.') },
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

      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid #E2E8F4' }}>
        {([['docs', 'Orçamentos e faturas'], ['contratos', 'Contratos recorrentes'], ['parcelamentos', 'Parcelamentos']] as const).map(([k, r]) => (
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
            ) : (
              <button onClick={criar} disabled={busy} style={btn('#1A6B4A', busy)}>Criar rascunho</button>
            )}
          </div>
        </section>
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
                      </td>
                      <td style={{ padding: '10px', whiteSpace: 'nowrap' as const }}>
                        {inv.status === 'draft' && perms?.cancelar && (
                          <button onClick={() => acao(inv, 'send')} disabled={busy} style={acaoBtn('#2D3278')}>Enviar</button>
                        )}
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
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>ENTRADA %</span>
                  <input type="number" min={0} max={90} step="1" value={pcEntrada}
                    onChange={e => setPcEntrada(e.target.value)} style={{ ...inp, width: 100 }} />
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

              {pcPreview && (
                <div style={{ marginTop: 14, padding: '12px 14px', background: '#F7F9FC', borderRadius: 10, border: '1px solid #E2E8F4' }}>
                  <div style={{ fontSize: 13.5, color: '#0F2340', fontWeight: 700, marginBottom: 8 }}>
                    Saldo {money(pcPreview.saldo)}
                    {pcPreview.entrada > 0
                      ? <> · entrada {money(pcPreview.entrada)} · a parcelar {money(pcPreview.restante)}</>
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
                <button onClick={criarParcelamento} disabled={busy || !pcPreview} style={btn('#1A6B4A', busy || !pcPreview)}>
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
                          <span style={{ fontSize: 12.5, color: '#6A7A9A' }}>aguardando o cliente</span>
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
            <p style={{ fontSize: 12, color: '#6A7A9A', margin: '0 0 10px' }}>
              Pode receber em partes: o que faltar continua em aberto na fatura.
            </p>

            <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#6A7A9A', marginBottom: 3 }}>Referência (Conf#, nº do cheque)</label>
            <input value={rRef} onChange={e => setRRef(e.target.value)}
              style={{ ...inp, width: '100%', marginBottom: 14, boxSizing: 'border-box' as const }} />
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
                <button onClick={salvarRecebimento} disabled={busy} style={btn('#1A6B4A', busy)}>
                  {rForma === 'card' ? 'Já cobrei — registrar' : 'Registrar'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
