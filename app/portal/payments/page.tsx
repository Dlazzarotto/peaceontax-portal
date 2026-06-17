'use client'
import { useState, useEffect } from 'react'

const T: Record<string, any> = {
  en: { title: 'Payments', balance: 'Outstanding Balance', noBalance: 'No outstanding balance', history: 'Payment History', noHistory: 'No payment history yet', pay: 'Pay Now', due: 'Due', paid: 'Paid', pending: 'Pending', contact: 'Questions about your invoice? Contact us at' },
  pt: { title: 'Pagamentos', balance: 'Saldo Pendente', noBalance: 'Sem saldo pendente', history: 'Histórico de Pagamentos', noHistory: 'Nenhum histórico de pagamentos ainda', pay: 'Pagar Agora', due: 'Vencimento', paid: 'Pago', pending: 'Pendente', contact: 'Dúvidas sobre sua fatura? Entre em contato em' },
  es: { title: 'Pagos', balance: 'Saldo Pendiente', noBalance: 'Sin saldo pendiente', history: 'Historial de Pagos', noHistory: 'Sin historial de pagos aún', pay: 'Pagar Ahora', due: 'Vencimiento', paid: 'Pagado', pending: 'Pendiente', contact: '¿Preguntas sobre su factura? Contáctenos en' },
  zh: { title: '付款', balance: '未结余额', noBalance: '无未结余额', history: '付款历史', noHistory: '暂无付款历史', pay: '立即付款', due: '到期', paid: '已付', pending: '待付', contact: '对您的发票有疑问？请联系我们' },
}

export default function PaymentsPage() {
  const [client,  setClient]  = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/portal/documents')
      .then(r => r.json())
      .then(d => { setClient(d.client); setLoading(false) })
  }, [])

  const lang = client?.language || 'en'
  const t    = T[lang] || T.en
  const balance = client?.balance || 0

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6a7a9a' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', marginBottom: 20 }}>{t.title}</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Balance card */}
        <div style={{ background: balance > 0 ? 'linear-gradient(135deg,#2D3278,#1a1f5e)' : '#fff', borderRadius: 14, padding: 24, border: '1px solid #e2e8f4', color: balance > 0 ? '#fff' : '#1a2a3a' }}>
          <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>{t.balance}</div>
          <div style={{ fontFamily: 'monospace', fontSize: 42, fontWeight: 800, marginBottom: 16 }}>
            ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
          {balance > 0 ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 16 }}>Tax preparation services — 2024</div>
              <button style={{ background: '#F47B20', color: '#fff', border: 'none', padding: '12px 28px', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'Georgia,serif', width: '100%' }}>
                💳 {t.pay}
              </button>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 10, textAlign: 'center' }}>Secure payment powered by Stripe</div>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: '#e8f5ee', borderRadius: 10 }}>
              <span style={{ fontSize: 22 }}>✅</span>
              <span style={{ fontSize: 14, color: '#1a6b4a', fontWeight: 700 }}>{t.noBalance}</span>
            </div>
          )}
        </div>

        {/* Info card */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 24, border: '1px solid #e2e8f4' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', marginBottom: 16 }}>Payment Methods</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { icon: '💳', label: 'Credit / Debit Card', desc: 'Visa, Mastercard, Amex' },
              { icon: '🏦', label: 'Bank Transfer (ACH)', desc: 'Direct from your bank account' },
              { icon: '📱', label: 'Check', desc: 'Made payable to Peace on Tax' },
            ].map(m => (
              <div key={m.label} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 10, background: '#f8faff', border: '1px solid #e2e8f4' }}>
                <span style={{ fontSize: 22 }}>{m.icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: '#6a7a9a' }}>{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16, padding: '12px 14px', background: '#f0f4fa', borderRadius: 10, fontSize: 12, color: '#6a7a9a' }}>
            {t.contact} <strong style={{ color: '#2D3278' }}>info@peaceontax.com</strong>
          </div>
        </div>
      </div>

      {/* Payment history */}
      <div style={{ background: '#fff', borderRadius: 14, padding: 22, border: '1px solid #e2e8f4', marginTop: 20 }}>
        <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', marginBottom: 16 }}>{t.history}</h2>
        <div style={{ textAlign: 'center', padding: '24px 0', color: '#9aaab0', fontSize: 13 }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>💰</div>
          {t.noHistory}
        </div>
      </div>
    </div>
  )
}
