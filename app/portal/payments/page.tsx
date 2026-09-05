'use client'
// Pagamentos — o balcão do cliente: contratos para assinar, débito automático
// para cadastrar, faturas para pagar e o histórico do que já foi pago.
//
// Pagar: um link só, com cartão, débito em conta (ACH) e Klarna; o cliente
// escolhe na página do Stripe e a Klarna aprova (ou não) ali mesmo.
// Fatura parcelada não paga à vista: cadastra o débito pelo plano.
// Contrato: assina aqui (DocuSign embutido) e cai direto no cadastro do débito.

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'

const T: Record<string, any> = {
  en: {
    title: 'Payments', balance: 'Outstanding balance', noBalance: 'Nothing to pay right now',
    history: 'Payment history', noHistory: 'No payments yet', pay: 'Pay now', due: 'Due', paid: 'Paid',
    contact: 'Questions about your invoice? Contact us at', methods: 'Payment methods',
    payHint: 'Card, bank debit (ACH) or Klarna — you choose on the next screen. Klarna approval happens there.',
    contracts: 'Agreements to sign', sign: 'Sign agreement', signHint: 'After signing, you will set up the automatic debit on the same screen.',
    plans: 'Automatic debit to set up', setup: 'Set up automatic debit', entry: 'Pay down payment',
    planHint: 'Bank account (ACH) or card. Nothing is charged until the agreed date.',
    invoices: 'Open invoices', installments: 'Installment schedule', schedule: 'installments',
    opening: 'Opening…', error: 'Could not open. Please try again or call (833) 732-2327.',
    msgPaid: 'Payment received. Thank you! If you paid by bank debit, the bank takes a few days to confirm.',
    msgCancelled: 'Payment was not completed. You can try again whenever you want.',
    msgEntry: 'Down payment received. The installments will be debited automatically on the agreed dates.',
    msgSetup: 'Payment method saved. Nothing was charged now; debits start on the agreed date.',
    msgSub: 'Automatic monthly payment set up. The first charge is on the agreed day.',
    signByEmail: 'Sign using the DocuSign e-mail you received.',
    msgSigned: 'Agreement signed. Thank you!', msgSignPending: 'The agreement is not signed yet. You can sign it below.',
  },
  pt: {
    title: 'Pagamentos', balance: 'Saldo em aberto', noBalance: 'Nada a pagar no momento',
    history: 'Histórico de pagamentos', noHistory: 'Nenhum pagamento ainda', pay: 'Pagar agora', due: 'Vencimento', paid: 'Pago',
    contact: 'Dúvidas sobre sua fatura? Fale conosco em', methods: 'Formas de pagamento',
    payHint: 'Cartão, débito em conta (ACH) ou Klarna — você escolhe na próxima tela. A aprovação da Klarna acontece lá mesmo.',
    contracts: 'Contratos para assinar', sign: 'Assinar contrato', signHint: 'Depois de assinar, você cadastra o débito automático na mesma tela.',
    plans: 'Débito automático para cadastrar', setup: 'Cadastrar débito automático', entry: 'Pagar entrada',
    planHint: 'Conta bancária (ACH) ou cartão. Nada é cobrado até a data combinada.',
    invoices: 'Faturas em aberto', installments: 'Cronograma de parcelas', schedule: 'parcelas',
    opening: 'Abrindo…', error: 'Não foi possível abrir. Tente de novo ou ligue (833) 732-2327.',
    msgPaid: 'Pagamento recebido. Obrigado! Se pagou por débito em conta, o banco leva alguns dias para confirmar.',
    msgCancelled: 'O pagamento não foi concluído. Você pode tentar de novo quando quiser.',
    msgEntry: 'Entrada recebida. As parcelas serão debitadas automaticamente nas datas combinadas.',
    msgSetup: 'Forma de pagamento cadastrada. Nada foi cobrado agora; os débitos começam na data combinada.',
    msgSub: 'Débito mensal cadastrado. A primeira cobrança é no dia combinado.',
    signByEmail: 'Assine pelo e-mail do DocuSign que você recebeu.',
    msgSigned: 'Contrato assinado. Obrigado!', msgSignPending: 'O contrato ainda não foi assinado. Você pode assinar abaixo.',
  },
  es: {
    title: 'Pagos', balance: 'Saldo pendiente', noBalance: 'Nada que pagar por ahora',
    history: 'Historial de pagos', noHistory: 'Sin pagos aún', pay: 'Pagar ahora', due: 'Vencimiento', paid: 'Pagado',
    contact: '¿Preguntas sobre su factura? Contáctenos en', methods: 'Formas de pago',
    payHint: 'Tarjeta, débito en cuenta (ACH) o Klarna — usted elige en la siguiente pantalla. La aprobación de Klarna ocurre allí mismo.',
    contracts: 'Contratos por firmar', sign: 'Firmar contrato', signHint: 'Después de firmar, registra el débito automático en la misma pantalla.',
    plans: 'Débito automático por registrar', setup: 'Registrar débito automático', entry: 'Pagar anticipo',
    planHint: 'Cuenta bancaria (ACH) o tarjeta. No se cobra nada hasta la fecha acordada.',
    invoices: 'Facturas abiertas', installments: 'Cronograma de cuotas', schedule: 'cuotas',
    opening: 'Abriendo…', error: 'No se pudo abrir. Intente de nuevo o llame al (833) 732-2327.',
    msgPaid: 'Pago recibido. ¡Gracias! Si pagó por débito en cuenta, el banco tarda unos días en confirmar.',
    msgCancelled: 'El pago no se completó. Puede intentar de nuevo cuando quiera.',
    msgEntry: 'Anticipo recibido. Las cuotas se debitarán automáticamente en las fechas acordadas.',
    msgSetup: 'Forma de pago registrada. No se cobró nada ahora; los débitos empiezan en la fecha acordada.',
    msgSub: 'Débito mensual registrado. El primer cobro es el día acordado.',
    signByEmail: 'Firme con el correo de DocuSign que recibió.',
    msgSigned: 'Contrato firmado. ¡Gracias!', msgSignPending: 'El contrato aún no está firmado. Puede firmarlo abajo.',
  },
}

const fmtUS = (iso: string | null) => iso ? `${String(iso).slice(5, 7)}/${String(iso).slice(8, 10)}/${String(iso).slice(0, 4)}` : ''
const money = (n: any) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const METODO: Record<string, string> = { card: 'Card', ach: 'ACH', external: 'Klarna', cash: 'Cash', zelle: 'Zelle', venmo: 'Venmo', check: 'Check', wire: 'Wire' }

export default function PaymentsPage() {
  const params = useSearchParams()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [erro, setErro] = useState('')

  const load = () => fetch('/api/portal/billing').then(r => r.json()).then(d => { setData(d); setLoading(false) })
  useEffect(() => { load() }, [])

  const lang = data?.client?.language || 'en'
  const t = T[lang] || T.en

  // Mensagem de retorno do Stripe / DocuSign
  const banner = (() => {
    if (params.get('pago')) return { cor: '#1a6b4a', fundo: '#e8f5ee', txt: t.msgPaid }
    if (params.get('cancelado') || params.get('plan') === 'cancelled') return { cor: '#6a5a10', fundo: '#fff7e0', txt: t.msgCancelled }
    const p = params.get('plan')
    if (p === 'entry_success') return { cor: '#1a6b4a', fundo: '#e8f5ee', txt: t.msgEntry }
    if (p === 'setup_success') return { cor: '#1a6b4a', fundo: '#e8f5ee', txt: t.msgSetup }
    if (p === 'subscription_success') return { cor: '#1a6b4a', fundo: '#e8f5ee', txt: t.msgSub }
    const c = params.get('contrato')
    if (c === 'assinado') return { cor: '#1a6b4a', fundo: '#e8f5ee', txt: t.msgSigned }
    if (c === 'pendente') return { cor: '#6a5a10', fundo: '#fff7e0', txt: t.msgSignPending }
    return null
  })()

  // Abre a página do Stripe (ou do DocuSign) devolvida pela rota
  const abrir = async (chave: string, url: string, body: any) => {
    setBusy(chave); setErro('')
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (d?.url) { window.location.href = d.url; return }
      setErro(d?.error || t.error)
    } catch { setErro(t.error) }
    setBusy(null)
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6a7a9a' }}>Loading…</div>

  const faturas: any[] = data?.faturas || []
  const planos: any[] = data?.planos || []
  const contratos: any[] = data?.contratos || []
  const historico: any[] = data?.historico || []
  const saldo = faturas.reduce((s, f) => s + Number(f.saldo || 0), 0)
  const card = { background: '#fff', borderRadius: 14, padding: 22, border: '1px solid #e2e8f4', marginBottom: 20 }
  const h2 = { fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', margin: '0 0 12px' }
  const botao = (cor: string, off = false) => ({ background: off ? '#e2e8f4' : cor, color: off ? '#9aaab0' : '#fff', border: 'none', padding: '11px 22px', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: off ? 'not-allowed' : 'pointer', fontFamily: 'Georgia,serif' })
  const linha = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const, padding: '12px 14px', borderRadius: 10, background: '#f8faff', border: '1px solid #e2e8f4', marginBottom: 8 }
  const rotuloPlano = (p: any) => p.kind === 'installment'
    ? `${p.description || 'Installments'} — ${p.installments}× ${money(p.installment_amount)}`
    : `${p.description || 'Monthly service'} — ${money(p.monthly_amount)}/mo, day ${p.due_day ?? 5}`

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', marginBottom: 16 }}>{t.title}</h1>

      {banner && <div style={{ background: banner.fundo, color: banner.cor, borderRadius: 10, padding: '12px 16px', fontSize: 14, fontWeight: 600, marginBottom: 18 }}>{banner.txt}</div>}
      {erro && <div style={{ background: '#fdecec', color: '#b02020', borderRadius: 10, padding: '12px 16px', fontSize: 14, fontWeight: 600, marginBottom: 18 }}>{erro}</div>}

      {/* 1. Contratos para assinar */}
      {contratos.length > 0 && (
        <div style={{ ...card, border: '2px solid #5A1A8A' }}>
          <h2 style={h2}>✍️ {t.contracts}</h2>
          {contratos.map(c => (
            <div key={c.id} style={linha}>
              <div style={{ fontSize: 14, color: '#1a2a3a' }}>
                <b>{c.plano ? rotuloPlano(c.plano) : 'Service agreement'}</b>
                <div style={{ fontSize: 12, color: '#6a7a9a', marginTop: 3 }}>{t.signHint}</div>
              </div>
              {c.embedded ? (
                <button onClick={() => abrir(`c${c.id}`, '/api/portal/contract-sign', { id: c.id })} disabled={!!busy} style={botao('#5A1A8A', !!busy)}>
                  {busy === `c${c.id}` ? t.opening : t.sign}
                </button>
              ) : (
                <span style={{ fontSize: 12.5, color: '#5A1A8A', fontWeight: 700 }}>{t.signByEmail}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 2. Débito automático para cadastrar */}
      {planos.length > 0 && (
        <div style={{ ...card, border: '2px solid #2D3278' }}>
          <h2 style={h2}>🏦 {t.plans}</h2>
          {planos.map(p => (
            <div key={p.id} style={linha}>
              <div style={{ fontSize: 14, color: '#1a2a3a' }}>
                <b>{rotuloPlano(p)}</b>
                {p.kind === 'installment' && Number(p.entry_amount) > 0 && p.status === 'awaiting_entry' && (
                  <div style={{ fontSize: 12.5, color: '#3a4a5a', marginTop: 3 }}>Down payment: <b>{money(p.entry_amount)}</b> ({p.entry_pct}%)</div>
                )}
                <div style={{ fontSize: 12, color: '#6a7a9a', marginTop: 3 }}>{t.planHint}</div>
              </div>
              <button onClick={() => abrir(`p${p.id}`, '/api/portal/plan-checkout', { planId: p.id })} disabled={!!busy} style={botao('#2D3278', !!busy)}>
                {busy === `p${p.id}` ? t.opening : (p.status === 'awaiting_entry' ? t.entry : t.setup)}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 3. Faturas em aberto */}
      <div style={{ ...card, background: saldo > 0 ? 'linear-gradient(135deg,#2D3278,#1a1f5e)' : '#fff', color: saldo > 0 ? '#fff' : '#1a2a3a' }}>
        <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 4 }}>{t.balance}</div>
        <div style={{ fontFamily: 'monospace', fontSize: 38, fontWeight: 800, marginBottom: 14 }}>{money(saldo)}</div>
        {saldo <= 0 && planos.length === 0 && contratos.length === 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: '#e8f5ee', borderRadius: 10 }}>
            <span style={{ fontSize: 22 }}>✅</span><span style={{ fontSize: 14, color: '#1a6b4a', fontWeight: 700 }}>{t.noBalance}</span>
          </div>
        )}
        {faturas.map(f => (
          <div key={f.id} style={{ ...linha, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.25)' }}>
            <div style={{ fontSize: 14 }}>
              <b>{f.number}</b> · {fmtUS(f.issue_date)}{f.due_date && <> · {t.due} {fmtUS(f.due_date)}</>}
              <div style={{ fontSize: 12.5, opacity: 0.8, marginTop: 3 }}>
                {money(f.total)}{Number(f.paid_total) > 0 && <> · {t.paid} {money(f.paid_total)}</>} · <b>{money(f.saldo)}</b>
              </div>
              {f.parcelas?.length > 0 && (
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
                  {t.installments}: {f.parcelas.map((p: any) => `${fmtUS(p.due_date)} ${money(p.amount)}${p.status === 'paid' ? ' ✓' : ''}`).join(' · ')}
                </div>
              )}
              {!f.plano && <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{t.payHint}</div>}
            </div>
            {f.plano ? (
              <button onClick={() => abrir(`p${f.plano.id}`, '/api/portal/plan-checkout', { planId: f.plano.id })} disabled={!!busy} style={botao('#F47B20', !!busy)}>
                {busy === `p${f.plano.id}` ? t.opening : (f.plano.status === 'awaiting_entry' ? t.entry : t.setup)}
              </button>
            ) : (
              <button onClick={() => abrir(`f${f.id}`, '/api/portal/billing/checkout', { invoiceId: f.id })} disabled={!!busy} style={botao('#F47B20', !!busy)}>
                {busy === `f${f.id}` ? t.opening : `💳 ${t.pay}`}
              </button>
            )}
          </div>
        ))}
        {saldo > 0 && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6, textAlign: 'center' }}>Secure payment powered by Stripe</div>}
      </div>

      {/* 4. Formas de pagamento */}
      <div style={card}>
        <h2 style={h2}>{t.methods}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { icon: '💳', label: 'Credit / Debit Card', desc: 'Visa, Mastercard, Amex' },
            { icon: '🏦', label: 'Bank debit (ACH)', desc: 'Directly from your bank account' },
            { icon: '🧾', label: 'Klarna', desc: 'Pay in installments with Klarna (approval on the payment screen)' },
            { icon: '📱', label: 'Check, Zelle, Venmo', desc: 'Payable to Peace on Tax — we record it for you' },
          ].map(m => (
            <div key={m.label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, background: '#f8faff', border: '1px solid #e2e8f4' }}>
              <span style={{ fontSize: 22 }}>{m.icon}</span>
              <div><div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>{m.label}</div><div style={{ fontSize: 11, color: '#6a7a9a' }}>{m.desc}</div></div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14, padding: '12px 14px', background: '#f0f4fa', borderRadius: 10, fontSize: 12, color: '#6a7a9a' }}>
          {t.contact} <strong style={{ color: '#2D3278' }}>info@peaceontax.com</strong>
        </div>
      </div>

      {/* 5. Histórico */}
      <div style={card}>
        <h2 style={h2}>{t.history}</h2>
        {historico.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: '#9aaab0', fontSize: 13 }}><div style={{ fontSize: 32, marginBottom: 8 }}>💰</div>{t.noHistory}</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {historico.map(p => (
                <tr key={p.id} style={{ borderBottom: '1px solid #eef1f6' }}>
                  <td style={{ padding: '8px 6px', color: '#6a7a9a', whiteSpace: 'nowrap' }}>{fmtUS(String(p.received_at).slice(0, 10))}</td>
                  <td style={{ padding: '8px 6px' }}>{p.number || '—'}</td>
                  <td style={{ padding: '8px 6px', color: '#6a7a9a' }}>{METODO[p.method] || p.method}{p.financier ? ` (${p.financier})` : ''}</td>
                  <td style={{ padding: '8px 6px', textAlign: 'right', fontWeight: 700, color: '#1a6b4a' }}>{money(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
