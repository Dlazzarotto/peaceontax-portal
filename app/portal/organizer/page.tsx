'use client'
import { useState, useEffect } from 'react'

const STAGES = [
  { key: 'Onboarding',      icon: '👋', label: 'Onboarding',        desc: 'Welcome! We\'re getting your account set up.' },
  { key: 'Gathering Docs',  icon: '📁', label: 'Gathering Documents', desc: 'Please upload your documents in the Documents section.' },
  { key: 'In Preparation',  icon: '⚙️',  label: 'In Preparation',     desc: 'Our team is working on your return.' },
  { key: 'Under Review',    icon: '🔍', label: 'Under Review',        desc: 'Your return is being reviewed for accuracy.' },
  { key: 'Filed',           icon: '✅', label: 'Filed',               desc: 'Your return has been filed with the IRS.' },
  { key: 'Complete',        icon: '🎉', label: 'Complete',            desc: 'All done! Your return is complete.' },
]

const T: Record<string, any> = {
  en: { title: 'Tax Organizer', status: 'Return Status', year: 'Tax Year 2024', assignedTo: 'Assigned to', checklist: 'Document Checklist', checklistDesc: 'Documents we need from you', needed: 'Needed', received: 'Received', notApplicable: 'N/A' },
  pt: { title: 'Organizador Fiscal', status: 'Status da Declaração', year: 'Ano Fiscal 2024', assignedTo: 'Responsável', checklist: 'Lista de Documentos', checklistDesc: 'Documentos que precisamos de você', needed: 'Necessário', received: 'Recebido', notApplicable: 'N/A' },
  es: { title: 'Organizador Fiscal', status: 'Estado de la Declaración', year: 'Año Fiscal 2024', assignedTo: 'Asignado a', checklist: 'Lista de Documentos', checklistDesc: 'Documentos que necesitamos de usted', needed: 'Necesario', received: 'Recibido', notApplicable: 'N/A' },
  zh: { title: '税务组织器', status: '申报状态', year: '2024税务年度', assignedTo: '负责人', checklist: '文件清单', checklistDesc: '我们需要您提供的文件', needed: '需要', received: '已收到', notApplicable: '不适用' },
}

const INDIVIDUAL_CHECKLIST = [
  { id: 'w2', label: 'W-2 Wage Statement', required: true },
  { id: '1099nec', label: '1099-NEC / Freelance Income', required: false },
  { id: '1099int', label: '1099-INT Interest Income', required: false },
  { id: '1099div', label: '1099-DIV Dividend Income', required: false },
  { id: '1099r', label: '1099-R Retirement Distribution', required: false },
  { id: '1098', label: '1098 Mortgage Interest', required: false },
  { id: 'charity', label: 'Charitable Donation Receipts', required: false },
  { id: 'medical', label: 'Medical Expense Receipts', required: false },
  { id: 'health', label: 'Health Insurance (1095-A/B/C)', required: true },
  { id: 'prior', label: 'Prior Year Tax Return', required: false },
  { id: 'id', label: 'Government-Issued ID', required: true },
  { id: 'ssn', label: 'Social Security Card', required: true },
]

const BUSINESS_CHECKLIST = [
  { id: 'pl', label: 'Profit & Loss Statement', required: true },
  { id: 'bank', label: 'Bank Statements (all accounts)', required: true },
  { id: 'payroll', label: 'Payroll Reports / W-2s Issued', required: true },
  { id: '941', label: '941 Quarterly Payroll Returns', required: true },
  { id: '1099s', label: '1099s Issued to Contractors', required: false },
  { id: 'receipts', label: 'Business Expense Receipts', required: true },
  { id: 'assets', label: 'Fixed Asset Purchases', required: false },
  { id: 'mileage', label: 'Mileage / Vehicle Log', required: false },
  { id: 'prior', label: 'Prior Year Return', required: false },
  { id: 'corp', label: 'Articles / Operating Agreement', required: false },
]

export default function OrganizerPage() {
  const [client,    setClient]    = useState<any>(null)
  const [loading,   setLoading]   = useState(true)
  const [checklist, setChecklist] = useState<Record<string, 'needed'|'received'|'na'>>({})

  useEffect(() => {
    fetch('/api/portal/documents')
      .then(r => r.json())
      .then(d => { setClient(d.client); setLoading(false) })
  }, [])

  const lang = client?.language || 'en'
  const t    = T[lang] || T.en
  const items = client?.type === 'business' ? BUSINESS_CHECKLIST : INDIVIDUAL_CHECKLIST
  const currentStageIdx = STAGES.findIndex(s => s.key === client?.stage) || 0

  const setItem = (id: string, val: 'needed'|'received'|'na') =>
    setChecklist(p => ({...p, [id]: val}))

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6a7a9a' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', marginBottom: 20 }}>{t.title}</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Return Status */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 22, border: '1px solid #e2e8f4' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', marginBottom: 6 }}>{t.status}</h2>
          <p style={{ fontSize: 12, color: '#6a7a9a', marginBottom: 20 }}>{t.year}</p>

          {STAGES.map((stage, i) => {
            const isDone    = i < currentStageIdx
            const isCurrent = i === currentStageIdx
            return (
              <div key={stage.key} style={{ display: 'flex', gap: 14, marginBottom: 16, opacity: i > currentStageIdx ? 0.4 : 1 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: isDone ? '#1a6b4a' : isCurrent ? '#2D3278' : '#e2e8f4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: isDone || isCurrent ? '#fff' : '#9aaab0' }}>
                    {isDone ? '✓' : stage.icon}
                  </div>
                  {i < STAGES.length - 1 && <div style={{ width: 2, height: 20, background: isDone ? '#1a6b4a' : '#e2e8f4', marginTop: 4 }} />}
                </div>
                <div style={{ paddingTop: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: isCurrent ? 700 : 400, color: isCurrent ? '#2D3278' : isDone ? '#1a6b4a' : '#3a4a5a' }}>{stage.label}</div>
                  {isCurrent && <div style={{ fontSize: 12, color: '#6a7a9a', marginTop: 3 }}>{stage.desc}</div>}
                </div>
              </div>
            )
          })}

          {client?.assignee && (
            <div style={{ marginTop: 16, padding: '12px 14px', background: '#f0f4fa', borderRadius: 10, fontSize: 13 }}>
              <span style={{ color: '#6a7a9a' }}>{t.assignedTo}: </span>
              <strong style={{ color: '#0f2340' }}>{client.assignee}</strong>
            </div>
          )}
        </div>

        {/* Document Checklist */}
        <div style={{ background: '#fff', borderRadius: 14, padding: 22, border: '1px solid #e2e8f4' }}>
          <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 16, color: '#0f2340', marginBottom: 4 }}>{t.checklist}</h2>
          <p style={{ fontSize: 12, color: '#6a7a9a', marginBottom: 16 }}>{t.checklistDesc}</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {items.map(item => {
              const status = checklist[item.id] || 'needed'
              return (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 9, background: status === 'received' ? '#e8f5ee' : status === 'na' ? '#f8faff' : '#fff', border: '1px solid #e2e8f4' }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 13, color: status === 'received' ? '#1a6b4a' : '#1a2a3a', fontWeight: item.required ? 600 : 400, textDecoration: status === 'na' ? 'line-through' : 'none' }}>
                      {item.label}
                    </span>
                    {item.required && status === 'needed' && <span style={{ fontSize: 10, color: '#b02020', marginLeft: 6, fontWeight: 700 }}>Required</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['needed','received','na'] as const).map(s => (
                      <button key={s} onClick={() => setItem(item.id, s)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 6, border: status === s ? '2px solid #2D3278' : '1px solid #e2e8f4', background: status === s ? '#2D3278' : '#fff', color: status === s ? '#fff' : '#6a7a9a', cursor: 'pointer', fontWeight: 700 }}>
                        {s === 'needed' ? t.needed : s === 'received' ? t.received : t.notApplicable}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
