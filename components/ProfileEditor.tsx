'use client'
// ProfileEditor — edição de dados de contato do cliente pela equipe
// Campos sensíveis (SSN/ITIN, nascimento) NÃO aparecem aqui — só o próprio cliente edita.
// Ativar/desativar e reenvio de acesso sempre exigem motivo.

import { useState } from 'react'

interface Props {
  client: any
  onSaved: () => void
}

export default function ProfileEditor({ client, onSaved }: Props) {
  const isBusiness = client.type === 'business'
  const [f, setF] = useState({
    name: client.name || '', email: client.email || '', phone: client.phone || '',
    language: client.language || 'pt',
    address_line1: client.address_line1 || '', city: client.city || '',
    state: client.state || '', zip: client.zip || '',
    filing_status: client.filing_status || '',
    business_name: client.business_name || '', ein: client.ein || '',
    business_type: client.business_type || '', industry: client.industry || '',
  })
  const [saving, setSaving]   = useState(false)
  const [msg, setMsg]         = useState('')

  // Modais
  const [statusModal, setStatusModal] = useState(false)   // ativar/desativar
  const [accessModal, setAccessModal] = useState(false)   // reenviar acesso
  const [reason, setReason]           = useState('')
  const [newEmail, setNewEmail]       = useState(client.email || '')
  const [processing, setProcessing]   = useState(false)

  const set = (k: string, v: string) => setF(x => ({ ...x, [k]: v }))

  const save = async () => {
    setSaving(true); setMsg('')
    const r = await fetch('/api/clients/profile', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: client.id, fields: f }),
    })
    const d = await r.json()
    setMsg(d.ok ? '✓ Dados atualizados.' : `Erro: ${d.error}`)
    if (d.ok) onSaved()
    setSaving(false)
  }

  const toggleStatus = async () => {
    if (!reason.trim()) { setMsg('Motivo é obrigatório.'); return }
    setProcessing(true); setMsg('')
    const r = await fetch('/api/clients/profile', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: client.id, fields: { active: !client.active }, reason }),
    })
    const d = await r.json()
    setMsg(d.ok ? `✓ Cliente ${client.active ? 'desativado' : 'reativado'}.` : `Erro: ${d.error}`)
    if (d.ok) { setStatusModal(false); setReason(''); onSaved() }
    setProcessing(false)
  }

  const resendAccess = async () => {
    if (!reason.trim()) { setMsg('Motivo é obrigatório.'); return }
    setProcessing(true); setMsg('')
    const r = await fetch('/api/clients/access', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientId: client.id,
        newEmail: newEmail !== client.email ? newEmail : undefined,
        reason,
      }),
    })
    const d = await r.json()
    setMsg(d.ok
      ? `✓ Link de acesso enviado para ${d.sentTo}.${d.loginUpdated ? ' E-mail antigo foi avisado da mudança.' : ''}`
      : `Erro: ${d.error}`)
    if (d.ok) { setAccessModal(false); setReason(''); onSaved() }
    setProcessing(false)
  }

  const input = { width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, outline:'none' }
  const label = { display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase' as const, letterSpacing:0.5, marginBottom:4 }
  const btn = (bg: string, disabled = false) => ({
    padding:'9px 18px', background: disabled ? '#e2e8f4' : bg,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:9,
    fontSize:13, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })

  const field = (lbl: string, key: string, type = 'text') => (
    <div>
      <label style={label}>{lbl}</label>
      <input type={type} value={(f as any)[key]} onChange={e => set(key, e.target.value)} style={input} />
    </div>
  )

  return (
    <div style={{ maxWidth:680 }}>
      {/* Status do cliente */}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:18, padding:'12px 16px',
        background: client.active ? '#e8f5ee' : '#fee2e2', borderRadius:10 }}>
        <span style={{ fontSize:14, fontWeight:700, color: client.active ? '#1a6b4a' : '#b02020' }}>
          {client.active ? '● Cliente Ativo' : '○ Cliente Inativo'}
        </span>
        <button onClick={() => { setStatusModal(true); setReason(''); setMsg('') }}
          style={{ ...btn(client.active ? '#b02020' : '#1a6b4a'), marginLeft:'auto' }}>
          {client.active ? 'Desativar' : 'Reativar'}
        </button>
      </div>

      {/* Formulário */}
      <div style={{ background:'#fff', borderRadius:14, padding:22, border:'1px solid #e2e8f4' }}>
        <h2 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 16px' }}>Dados de contato</h2>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
          {field('Nome', 'name')}
          {field('E-mail de contato', 'email', 'email')}
          {field('Telefone', 'phone', 'tel')}
          <div>
            <label style={label}>Idioma</label>
            <select value={f.language} onChange={e => set('language', e.target.value)} style={input}>
              <option value="pt">Português</option><option value="en">English</option>
              <option value="es">Español</option><option value="zh">中文</option>
              <option value="fr">Français</option>
            </select>
          </div>
          {field('Endereço', 'address_line1')}
          {field('Cidade', 'city')}
          {field('Estado', 'state')}
          {field('ZIP', 'zip')}
          {isBusiness ? (
            <>
              {field('Nome da empresa', 'business_name')}
              {field('EIN', 'ein')}
              {field('Tipo de entidade', 'business_type')}
              {field('Setor', 'industry')}
            </>
          ) : (
            <div>
              <label style={label}>Filing Status</label>
              <select value={f.filing_status} onChange={e => set('filing_status', e.target.value)} style={input}>
                <option value="">—</option>
                <option>Single</option>
                <option>Married Filing Jointly</option>
                <option>Married Filing Separately</option>
                <option>Head of Household</option>
              </select>
            </div>
          )}
        </div>

        <p style={{ fontSize:12, color:'#9aaab0', margin:'14px 0' }}>
          🔒 Dados sensíveis (SSN/ITIN, data de nascimento) são editados somente pelo próprio cliente no portal dele.
        </p>

        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <button onClick={save} disabled={saving} style={btn('#2D3278', saving)}>
            {saving ? 'Salvando…' : '💾 Salvar alterações'}
          </button>
          <button onClick={() => { setAccessModal(true); setNewEmail(f.email); setReason(''); setMsg('') }}
            style={{ ...btn('#fff'), color:'#F47B20', border:'1.5px solid #F47B20' }}>
            📧 Reenviar acesso ao portal
          </button>
        </div>
        {msg && <p style={{ fontSize:13, fontWeight:600, marginTop:10, color: msg.startsWith('✓') ? '#1a6b4a' : '#b02020' }}>{msg}</p>}
      </div>

      {/* Modal ativar/desativar */}
      {statusModal && (
        <Modal title={client.active ? '🚫 Desativar cliente' : '✓ Reativar cliente'}
          subtitle={client.active
            ? 'Cliente inativo some das listas, mas dados e documentos ficam preservados (retenção fiscal).'
            : 'O cliente volta a aparecer nas listas e a receber comunicações.'}
          reason={reason} setReason={setReason}
          onCancel={() => setStatusModal(false)} onConfirm={toggleStatus}
          processing={processing} confirmColor={client.active ? '#b02020' : '#1a6b4a'} />
      )}

      {/* Modal reenviar acesso */}
      {accessModal && (
        <Modal title="📧 Reenviar acesso ao portal"
          subtitle="Um link de acesso será enviado. Se o e-mail for alterado, o endereço antigo recebe um aviso de segurança."
          reason={reason} setReason={setReason}
          onCancel={() => setAccessModal(false)} onConfirm={resendAccess}
          processing={processing} confirmColor="#F47B20"
          extra={
            <>
              <label style={label}>E-mail de destino</label>
              <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                style={{ ...input, marginBottom:12 }} />
            </>
          } />
      )}
    </div>
  )
}

function Modal({ title, subtitle, reason, setReason, onCancel, onConfirm, processing, confirmColor, extra }: any) {
  const input = { width:'100%', padding:'9px 12px', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:14, outline:'none' }
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(15,35,64,0.5)', display:'flex',
      alignItems:'center', justifyContent:'center', zIndex:2000 }}>
      <div style={{ background:'#fff', borderRadius:16, padding:24, width:420, maxWidth:'90vw' }}>
        <h3 style={{ fontFamily:'Georgia,serif', fontSize:16, color:'#0f2340', margin:'0 0 6px' }}>{title}</h3>
        <p style={{ fontSize:13, color:'#6a7a9a', margin:'0 0 14px' }}>{subtitle}</p>
        {extra}
        <label style={{ display:'block', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, marginBottom:4 }}>
          Motivo * (fica na auditoria)
        </label>
        <textarea value={reason} onChange={(e: any) => setReason(e.target.value)} rows={2}
          style={{ ...input, resize:'vertical', marginBottom:14 }} />
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button onClick={onCancel}
            style={{ padding:'9px 16px', background:'#fff', color:'#6a7a9a', border:'1.5px solid #e2e8f4', borderRadius:9, fontSize:13, fontWeight:700, cursor:'pointer' }}>
            Voltar
          </button>
          <button onClick={onConfirm} disabled={processing}
            style={{ padding:'9px 16px', background: processing ? '#e2e8f4' : confirmColor, color: processing ? '#9aaab0' : '#fff', border:'none', borderRadius:9, fontSize:13, fontWeight:700, cursor: processing ? 'wait' : 'pointer' }}>
            {processing ? 'Processando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  )
}
