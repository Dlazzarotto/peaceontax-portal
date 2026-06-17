'use client'
import { useState, useEffect, useRef } from 'react'
import { getCategories, getCategoryIcon, TAX_YEARS } from '@/lib/documentCategories'

export default function ClientDocumentsPage() {
  const [client,    setClient]    = useState<any>(null)
  const [docs,      setDocs]      = useState<any[]>([])
  const [loading,   setLoading]   = useState(true)
  const [year,      setYear]      = useState(new Date().getFullYear())
  const [cat,       setCat]       = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [drag,      setDrag]      = useState(false)
  const [copied,    setCopied]    = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/portal/documents')
      const d   = await res.json()
      setClient(d.client)
      setDocs(d.documents || [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const categories = client ? getCategories(client.type) : {}
  const yearDocs   = docs.filter(d => d.tax_year === year)
  const catDocs    = cat ? yearDocs.filter(d => d.category === cat) : yearDocs

  const upload = async (file: File) => {
    if (!cat) { alert('Please select a category first'); return }
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('taxYear', String(year))
    fd.append('category', cat)
    fd.append('uploadedBy', 'client')
    const res = await fetch('/api/portal/documents', { method: 'POST', body: fd })
    const d   = await res.json()
    setUploading(false)
    if (d.error) alert(d.error)
    else load()
  }

  const openDoc = async (docId: string) => {
    const res = await fetch(`/api/documents/${docId}`)
    const d   = await res.json()
    if (d.url) window.open(d.url, '_blank')
  }

  const formatSize = (b: number) => {
    if (!b) return ''
    if (b < 1024) return `${b} B`
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`
    return `${(b/1048576).toFixed(1)} MB`
  }

  const T: Record<string, any> = {
    en: { title: 'My Documents', selectCat: 'Select a category on the left first', dropZone: 'Drop file here or click to upload', noDocs: 'No documents in this category yet', allDocs: 'All Documents', year: 'Tax Year', upload: 'Upload', uploading: 'Uploading…' },
    pt: { title: 'Meus Documentos', selectCat: 'Selecione uma categoria à esquerda primeiro', dropZone: 'Solte o arquivo aqui ou clique para enviar', noDocs: 'Nenhum documento nesta categoria ainda', allDocs: 'Todos os Documentos', year: 'Ano Fiscal', upload: 'Enviar', uploading: 'Enviando…' },
    es: { title: 'Mis Documentos', selectCat: 'Seleccione una categoría a la izquierda primero', dropZone: 'Suelte el archivo aquí o haga clic para subir', noDocs: 'No hay documentos en esta categoría aún', allDocs: 'Todos los Documentos', year: 'Año Fiscal', upload: 'Subir', uploading: 'Subiendo…' },
    zh: { title: '我的文件', selectCat: '请先在左侧选择一个类别', dropZone: '将文件拖放到此处或点击上传', noDocs: '此类别中暂无文件', allDocs: '所有文件', year: '税务年度', upload: '上传', uploading: '上传中…' },
  }
  const lang = client?.language || 'en'
  const t = T[lang] || T.en

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6a7a9a' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: '#0f2340', marginBottom: 20 }}>{t.title}</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20 }}>
        {/* Sidebar */}
        <div>
          <div style={{ background: '#fff', borderRadius: 12, padding: 14, border: '1px solid #e2e8f4', marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6a7a9a', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{t.year}</div>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ width: '100%', padding: '8px 10px', border: '1.5px solid #e2e8f4', borderRadius: 8, fontSize: 14, fontWeight: 700, color: '#0f2340', outline: 'none' }}>
              {TAX_YEARS.map(y => <option key={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e2e8f4', overflow: 'hidden' }}>
            <div onClick={() => setCat(null)} style={{ padding: '10px 14px', cursor: 'pointer', background: !cat ? '#0f2340' : 'transparent', color: !cat ? '#fff' : '#3a4a5a', fontSize: 13, fontWeight: !cat ? 700 : 400, display: 'flex', justifyContent: 'space-between' }}>
              <span>📋 {t.allDocs}</span>
              <span style={{ opacity: 0.7, fontSize: 11 }}>{yearDocs.length}</span>
            </div>
            {Object.keys(categories).map(c => {
              const count = yearDocs.filter(d => d.category === c).length
              return (
                <div key={c} onClick={() => setCat(c)} style={{ padding: '9px 14px', cursor: 'pointer', background: cat === c ? '#f0f4ff' : 'transparent', color: cat === c ? '#0f2340' : '#4a5a6a', fontSize: 13, fontWeight: cat === c ? 700 : 400, display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #f0f4fa' }}>
                  <span>{getCategoryIcon(c)} {c}</span>
                  {count > 0 && <span style={{ fontSize: 11, background: '#0f234020', color: '#0f2340', padding: '1px 7px', borderRadius: 20, fontWeight: 700 }}>{count}</span>}
                </div>
              )
            })}
          </div>
        </div>

        {/* Main */}
        <div>
          {/* Upload zone */}
          {cat && (
            <div
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) upload(f) }}
              onClick={() => fileRef.current?.click()}
              style={{ border: `2px dashed ${drag ? '#0f2340' : '#e2e8f4'}`, borderRadius: 12, padding: '20px', textAlign: 'center', cursor: 'pointer', background: drag ? '#f0f4ff' : '#fafbff', marginBottom: 16, transition: 'all 0.15s' }}
            >
              <input ref={fileRef} type="file" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f) }} style={{ display: 'none' }} />
              <div style={{ fontSize: 28, marginBottom: 6 }}>📂</div>
              <div style={{ fontSize: 13, color: uploading ? '#1a6b4a' : '#6a7a9a', fontWeight: uploading ? 700 : 400 }}>
                {uploading ? t.uploading : t.dropZone}
              </div>
              <div style={{ fontSize: 11, color: '#9aaab0', marginTop: 4 }}>PDF, Word, Excel, Images — max 50MB</div>
            </div>
          )}

          {!cat && (
            <div style={{ background: '#fff8e8', border: '1px solid #e0b84a', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#7a5a00' }}>
              💡 {t.selectCat}
            </div>
          )}

          {/* Document list */}
          <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f4', overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontFamily: 'Georgia,serif', fontSize: 15, color: '#0f2340', fontWeight: 700 }}>
                {cat ? `${getCategoryIcon(cat)} ${cat}` : `${t.allDocs} — ${year}`}
              </div>
              <div style={{ fontSize: 12, color: '#6a7a9a' }}>{catDocs.length} file{catDocs.length !== 1 ? 's' : ''}</div>
            </div>
            {catDocs.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9aaab0' }}>
                <div style={{ fontSize: 36, marginBottom: 10 }}>📁</div>
                <div style={{ fontSize: 14, color: '#6a7a9a' }}>{t.noDocs}</div>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8faff' }}>
                    {['File','Category','Size','Status','Date'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6a7a9a', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e2e8f4' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catDocs.map(doc => (
                    <tr key={doc.id} style={{ borderBottom: '1px solid #f0f4fa', cursor: 'pointer' }} onClick={() => openDoc(doc.id)}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 18 }}>{doc.file_type?.includes('pdf') ? '📄' : doc.file_type?.includes('image') ? '🖼' : '📎'}</span>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#1a2a3a' }}>{doc.file_name}</span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#6a7a9a' }}>{doc.category}</td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#6a7a9a' }}>{formatSize(doc.file_size)}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, fontWeight: 700, background: doc.status === 'approved' ? '#e8f5ee' : '#f0f4fa', color: doc.status === 'approved' ? '#1a6b4a' : '#6a7a9a' }}>{doc.status}</span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: '#6a7a9a' }}>{new Date(doc.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
