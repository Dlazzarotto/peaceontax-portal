'use client'
// SignaturesTab — envio e acompanhamento de assinaturas DocuSign
// Form 8879 (com KBA, 1-2 assinantes) + status de contratos de planos

import { useState, useEffect, useRef } from 'react'

interface SigRequest {
  id: string; kind: 'contract'|'form8879'; envelope_id: string
  status: string; signers: { name:string; email:string; title?:string }[]
  kba: boolean; fiscal_year: number|null
  signed_document_id: string|null; completed_at: string|null; created_at: string
}

interface Props { clientId: string; clientName: string; clientEmail: string; clientType: string }

const STATUS_LABEL: Record<string,string> = {
  sent:'📤 Enviado', delivered:'👀 Visualizado', completed:'✅ Assinado',
  declined:'❌ Recusado', voided:'🚫 Anulado',
}
const STATUS_COLOR: Record<string,string> = {
  sent:'#c06010', delivered:'#2D3278', completed:'#1a6b4a', declined:'#b02020', voided:'#9aaab0',
}

export default function SignaturesTab({ clientId, clientName, clientEmail, clientType }: Props) {
  const [requests, setRequests] = useState<SigRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // Form 8879
  const [show8879, setShow8879] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear() - 1)
  const [s1Name, setS1Name] = useState(clientName)
  const [s1Email, setS1Email] = useState(clientEmail)
  const [s1Title, setS1Title] = useState('')
  const [hasSpouse, setHasSpouse] = useState(false)
  const [s2Name, setS2Name] = useState('')
  const [s2Email, setS2Email] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')

  const YEARS = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 1 - i)

  const load = async () => {
    setLoading(true)
    const r = await fetch(`/api/signatures/status?clientId=${clientId}`)
    const d = await r.json()
    setRequests(d.requests || []); setLoading(false)
  }
  useEffect(() => { load() }, [clientId])

  const send8879 = async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) { setMsg('Selecione o PDF da Form 8879.'); return }
    if (!s1Name.trim() || !s1Email.includes('@')) { setMsg('Assinante 1: nome e e-mail válidos.'); return }
    if (hasSpouse && (!s2Name.trim() || !s2Email.includes('@'))) { setMsg('Cônjuge: nome e e-mail válidos.'); return }

    setBusy(true); setMsg('')
    const fd = new FormData()
    fd.append('file', file)
    fd.append('clientId', clientId)
    fd.append('fiscalYear', String(year))
    fd.append('signer1Name', s1Name.trim())
    fd.append('signer1Email', s1Email.trim())
    if (s1Title.trim()) fd.append('signer1Title', s1Title.trim())
    if (hasSpouse) { fd.append('signer2Name', s2Name.trim()); fd.append('signer2Email', s2Email.trim()) }
    fd.append('kba', 'true')

    const r = await fetch('/api/signatures/form8879', { method: 'POST', body: fd })
    const d = await r.json()
    if (d.ok) {
      setMsg('✓ Form 8879 enviada para assinatura com verificação de identidade (KBA).')
      setShow8879(false); setFileName(''); if (fileRef.current) fileRef.current.value = ''
      load()
    } else setMsg(`Erro: ${d.error}`)
    setBusy(false)
  }

  const checkStatus = async (id: string) => {
    setBusy(true); setMsg('')
    const r = await fetch('/api/signatures/status', {
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ id }),
    })
    const d = await r.json()
    if (d.ok) {
      setMsg(d.changed
        ? (d.status === 'completed' ? '✓ Assinado! PDF arquivado em Signed Documents.' : `Status atualizado: ${STATUS_LABEL[d.status] || d.status}`)
        : 'Sem mudança de status ainda.')
      load()
    } else setMsg(`Erro: ${d.error}`)
    setBusy(false)
  }

  const btn = (bg: string, disabled = false) => ({
    padding:'9px 16px', background: disabled ? '#e2e8f4' : bg,
    color: disabled ? '#9aaab0' : '#fff', border:'none', borderRadius:8,
    fontSize:13, fontWeight:700, cursor: disabled ? 'not-allowed' : 'pointer',
  })
  const outlineBtn = (color: string) => ({
    padding:'9px 16px', background:'#fff', color, border:`1.5px solid ${color}`,
    borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer',
  })
  const input = { padding:'9px 11px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:14, outline:'none' }
  const label = { display:'block', fontSize:12, fontWeight:700, color:'#6a7a9a', marginBottom:4 }

  return (
    <div>
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        <button onClick={() => setShow8879(s => !s)} style={outlineBtn('#5a1a8a')}>
          ✍️ Enviar Form 8879
        </button>
        <span style={{ fontSize:12, color:'#9aaab0', alignSelf:'center' }}>
          Contratos de planos são enviados pela aba 📆 Planos.
        </span>
      </div>

      {/* Form 8879 */}
      {show8879 && (
        <div style={{ background:'#fff', borderRadius:14, padding:20, border:'2px solid #5a1a8a', marginBottom:16 }}>
          <h3 style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', margin:'0 0 6px' }}>
            ✍️ Form 8879 — autorização de e-file (com KBA)
          </h3>
          <p style={{ fontSize:12.5, color:'#6a7a9a', margin:'0 0 14px' }}>
            A verificação de identidade (KBA) é exigida pelo IRS (Pub. 1345) para assinatura remota.
            O assinante responderá perguntas de identidade antes de assinar.
          </p>

          <div style={{ marginBottom:12 }}>
            <label style={label}>PDF da Form 8879 (gerado no ProSeries)</label>
            <input ref={fileRef} type="file" accept=".pdf"
              onChange={e => setFileName(e.target.files?.[0]?.name || '')}
              style={{ fontSize:13 }} />
            {fileName && <span style={{ fontSize:12, color:'#1a6b4a', marginLeft:8 }}>✓ {fileName}</span>}
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:12, marginBottom:12 }}>
            <div>
              <label style={label}>Ano fiscal</label>
              <select value={year} onChange={e => setYear(Number(e.target.value))} style={{ ...input, width:'100%', cursor:'pointer' }}>
                {YEARS.map(y => <option key={y}>{y}</option>)}
              </select>
            </div>
            <div>
              <label style={label}>Assinante — nome</label>
              <input value={s1Name} onChange={e => setS1Name(e.target.value)} style={{ ...input, width:'100%' }} />
            </div>
            <div>
              <label style={label}>Assinante — e-mail</label>
              <input value={s1Email} onChange={e => setS1Email(e.target.value)} style={{ ...input, width:'100%' }} />
            </div>
            {clientType === 'business' && (
              <div>
                <label style={label}>Cargo (officer)</label>
                <input value={s1Title} onChange={e => setS1Title(e.target.value)} placeholder="President, Member…" style={{ ...input, width:'100%' }} />
              </div>
            )}
          </div>

          {clientType !== 'business' && (
            <>
              <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, color:'#3a4a5a', marginBottom:12, cursor:'pointer' }}>
                <input type="checkbox" checked={hasSpouse} onChange={e => setHasSpouse(e.target.checked)}
                  style={{ width:18, height:18 }} />
                Declaração conjunta (MFJ) — cônjuge também assina
              </label>
              {hasSpouse && (
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
                  <div>
                    <label style={label}>Cônjuge — nome</label>
                    <input value={s2Name} onChange={e => setS2Name(e.target.value)} style={{ ...input, width:'100%' }} />
                  </div>
                  <div>
                    <label style={label}>Cônjuge — e-mail</label>
                    <input value={s2Email} onChange={e => setS2Email(e.target.value)} style={{ ...input, width:'100%' }} />
                  </div>
                </div>
              )}
            </>
          )}

          <button onClick={send8879} disabled={busy} style={btn('#5a1a8a', busy)}>
            {busy ? 'Enviando…' : '📤 Enviar para assinatura'}
          </button>
        </div>
      )}

      {msg && (
        <p style={{ fontSize:13, fontWeight:600, marginBottom:12,
          color: msg.startsWith('✓') ? '#1a6b4a' : msg.startsWith('Sem') ? '#6a7a9a' : '#b02020' }}>{msg}</p>
      )}

      {/* Lista */}
      {loading ? <p style={{ color:'#6a7a9a', fontSize:13 }}>Carregando…</p> :
       requests.length === 0 ? (
        <div style={{ background:'#fff', borderRadius:14, padding:40, border:'1px solid #e2e8f4', textAlign:'center', color:'#9aaab0' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>✍️</div>
          <div style={{ fontSize:13 }}>Nenhuma assinatura enviada ainda.</div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {requests.map(r => (
            <div key={r.id} style={{ background:'#fff', borderRadius:14, padding:18, border:'1px solid #e2e8f4' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, flexWrap:'wrap', gap:8 }}>
                <div>
                  <span style={{ fontSize:15, fontWeight:700, color:'#0f2340' }}>
                    {r.kind === 'form8879' ? `✍️ Form 8879 — ${r.fiscal_year}` : '📝 Contrato de serviço'}
                  </span>
                  {r.kba && <span style={{ marginLeft:8, fontSize:10, padding:'2px 8px', borderRadius:20, fontWeight:700, background:'#5a1a8a15', color:'#5a1a8a' }}>KBA</span>}
                  <span style={{ marginLeft:8, fontSize:11, padding:'2px 10px', borderRadius:20, fontWeight:700,
                    background:`${STATUS_COLOR[r.status]}18`, color:STATUS_COLOR[r.status] }}>
                    {STATUS_LABEL[r.status] || r.status}
                  </span>
                </div>
                <span style={{ fontSize:11, color:'#9aaab0' }}>
                  {new Date(r.created_at).toLocaleDateString('pt-BR')}
                </span>
              </div>

              <div style={{ fontSize:13, color:'#5a6a7a', marginBottom:10 }}>
                Assinante(s): {r.signers.map(s => `${s.name}${s.title ? ` (${s.title})` : ''}`).join(' · ')}
              </div>

              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                {!['completed','declined','voided'].includes(r.status) && (
                  <button onClick={() => checkStatus(r.id)} disabled={busy} style={outlineBtn('#2D3278')}>
                    🔄 Atualizar status
                  </button>
                )}
                {r.status === 'completed' && r.signed_document_id && (
                  <span style={{ fontSize:13, color:'#1a6b4a', fontWeight:600, alignSelf:'center' }}>
                    ✅ PDF assinado arquivado em Signed Documents
                    {r.completed_at && ` — ${new Date(r.completed_at).toLocaleDateString('pt-BR')}`}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
