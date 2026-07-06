'use client'
import { useState, useEffect, useRef } from 'react'
import { getCategories, getCategoryIcon, TAX_YEARS } from '@/lib/documentCategories'

interface Classification {
  doc_type: string
  fiscal_year: number | null
  summary: string
  confidence: number
  ocr_text: string
}

const DOC_LABELS: Record<string,string> = {
  tax_return:'Declaração de Imposto', w2:'W-2', '1099':'1099', w9:'W-9',
  w8ben:'W-8BEN', id_document:'Documento de Identidade', proof_address:'Comprovante de Endereço',
  ein_letter:'EIN Letter', articles:'Articles of Org.', operating_agreement:'Operating Agreement',
  license:'Licença', bank_statement:'Extrato Bancário', receipt_income:'Comprovante de Receita',
  receipt_expense:'Comprovante de Despesa', pl_report:'P&L', balance_sheet:'Balance Sheet',
  annual_report:'Annual Report', sales_tax:'Sales Tax', other:'Outro',
}

const TRANSLATIONS: Record<string, Record<string,string>> = {
  en: { title:'My Documents', selectCat:'Select a category on the left first', dropZone:'Drop file here or click to upload', noDocs:'No documents in this category yet', allDocs:'All Documents', year:'Tax Year', upload:'Upload', uploading:'Uploading…', aiReview:'AI Classification', confirm:'Confirm & Save', skip:'Upload without AI', confidence:'Confidence', suggestedType:'Identified as', summary:'Summary' },
  pt: { title:'Meus Documentos', selectCat:'Selecione uma categoria à esquerda primeiro', dropZone:'Solte o arquivo aqui ou clique para enviar', noDocs:'Nenhum documento nesta categoria ainda', allDocs:'Todos os Documentos', year:'Ano Fiscal', upload:'Enviar', uploading:'Enviando…', aiReview:'Classificação IA', confirm:'Confirmar e Salvar', skip:'Enviar sem IA', confidence:'Confiança', suggestedType:'Identificado como', summary:'Resumo' },
  es: { title:'Mis Documentos', selectCat:'Seleccione una categoría a la izquierda primero', dropZone:'Suelte el archivo aquí o haga clic para subir', noDocs:'No hay documentos en esta categoría aún', allDocs:'Todos los Documentos', year:'Año Fiscal', upload:'Subir', uploading:'Subiendo…', aiReview:'Clasificación IA', confirm:'Confirmar y Guardar', skip:'Subir sin IA', confidence:'Confianza', suggestedType:'Identificado como', summary:'Resumen' },
  zh: { title:'我的文件', selectCat:'请先在左侧选择一个类别', dropZone:'将文件拖放到此处或点击上传', noDocs:'此类别中暂无文件', allDocs:'所有文件', year:'税务年度', upload:'上传', uploading:'上传中…', aiReview:'AI分类', confirm:'确认并保存', skip:'不使用AI上传', confidence:'置信度', suggestedType:'识别为', summary:'摘要' },
}

export default function ClientDocumentsPage() {
  const [client,       setClient]       = useState<any>(null)
  const [clientId,     setClientId]     = useState<string|null>(null)
  const [docs,         setDocs]         = useState<any[]>([])
  const [loading,      setLoading]      = useState(true)
  const [year,         setYear]         = useState(new Date().getFullYear())
  const [cat,          setCat]          = useState<string|null>(null)
  const [uploading,    setUploading]    = useState(false)
  const [drag,         setDrag]         = useState(false)
  const [pendingFile,  setPendingFile]  = useState<File|null>(null)
  const [classifying,  setClassifying]  = useState(false)
  const [classification, setClassification] = useState<Classification|null>(null)
  const [needsReview,  setNeedsReview]  = useState(false)
  const [suggestedFolderId, setSuggestedFolderId] = useState<string|null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/portal/documents')
      const d   = await res.json()
      setClient(d.client)
      setClientId(d.client?.id ?? null)
      setDocs(d.documents || [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const categories = client ? getCategories(client.type) : {}
  const yearDocs   = docs.filter(d => d.tax_year === year)
  const catDocs    = cat ? yearDocs.filter(d => d.category === cat) : yearDocs

  const lang = client?.language || 'en'
  const t = TRANSLATIONS[lang] || TRANSLATIONS.en

  // --- Classificar com IA antes de subir ---
  const handleFileChosen = async (file: File) => {
    setPendingFile(file)
    setClassification(null)
    setNeedsReview(false)

    // Se não tiver clientId ainda, sobe direto
    if (!clientId) { await upload(file, null); return }

    setClassifying(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('clientId', clientId)
      const res  = await fetch('/api/fase1/classify', { method:'POST', body:fd })
      const data = await res.json()

      if (data.classification) {
        setClassification(data.classification)
        setSuggestedFolderId(data.suggestedFolderId ?? null)

        if (data.classification.confidence >= 0.95 && !data.needsReview) {
          // Alta confiança: sobe automaticamente
          await upload(file, data.classification, data.suggestedFolderId)
          setPendingFile(null); setClassification(null)
        } else {
          // Baixa confiança: mostra revisão
          setNeedsReview(true)
        }
      } else {
        // Classificação falhou: sobe direto
        await upload(file, null)
        setPendingFile(null)
      }
    } catch {
      await upload(file, null)
      setPendingFile(null)
    } finally {
      setClassifying(false)
    }
  }

  const upload = async (file: File, cls: Classification|null, folderId?: string|null) => {
    if (!cat && !cls?.doc_type) { alert(t.selectCat); return }
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('taxYear', String(cls?.fiscal_year || year))
    fd.append('category', cat || cls?.doc_type || 'other')
    fd.append('uploadedBy', 'client')
    // Metadados IA — aproveitados quando a rota /api/portal/documents for atualizada
    if (cls) {
      fd.append('doc_type',       cls.doc_type)
      fd.append('ai_confidence',  String(cls.confidence))
      fd.append('classified_by',  'ai')
      fd.append('ocr_text',       cls.ocr_text || '')
      if (folderId) fd.append('folder_id', folderId)
    }
    const res = await fetch('/api/portal/documents', { method:'POST', body:fd })
    const d   = await res.json()
    setUploading(false)
    if (d.error) alert(d.error)
    else { setClassification(null); setPendingFile(null); setNeedsReview(false); load() }
  }

  const openDoc = async (docId: string) => {
    const res = await fetch(`/api/documents/${docId}`)
    const d   = await res.json()
    if (d.url) window.open(d.url, '_blank')
  }

  const formatSize = (b: number) => {
    if (!b) return ''
    if (b < 1024)    return `${b} B`
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`
    return `${(b/1048576).toFixed(1)} MB`
  }

  const confidenceColor = (c: number) => c >= 0.95 ? '#1a6b4a' : c >= 0.75 ? '#a05c00' : '#b91c1c'
  const confidenceBg    = (c: number) => c >= 0.95 ? '#e8f5ee'  : c >= 0.75 ? '#fff7e0'  : '#fee2e2'

  if (loading) return <div style={{ padding:40, textAlign:'center', color:'#6a7a9a' }}>Loading…</div>

  return (
    <div>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:22, color:'#0f2340', marginBottom:20 }}>{t.title}</h1>

      <div style={{ display:'grid', gridTemplateColumns:'220px 1fr', gap:20 }}>

        {/* ---- Sidebar ---- */}
        <div>
          <div style={{ background:'#fff', borderRadius:12, padding:14, border:'1px solid #e2e8f4', marginBottom:12 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, marginBottom:8 }}>{t.year}</div>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={{ width:'100%', padding:'8px 10px', border:'1.5px solid #e2e8f4', borderRadius:8, fontSize:14, fontWeight:700, color:'#0f2340', outline:'none' }}>
              {TAX_YEARS.map(y => <option key={y}>{y}</option>)}
            </select>
          </div>
          <div style={{ background:'#fff', borderRadius:12, border:'1px solid #e2e8f4', overflow:'hidden' }}>
            <div onClick={() => setCat(null)} style={{ padding:'10px 14px', cursor:'pointer', background:!cat ? '#0f2340' : 'transparent', color:!cat ? '#fff' : '#3a4a5a', fontSize:13, fontWeight:!cat ? 700 : 400, display:'flex', justifyContent:'space-between' }}>
              <span>📋 {t.allDocs}</span>
              <span style={{ opacity:0.7, fontSize:11 }}>{yearDocs.length}</span>
            </div>
            {Object.keys(categories).map(c => {
              const count = yearDocs.filter(d => d.category === c).length
              return (
                <div key={c} onClick={() => setCat(c)} style={{ padding:'9px 14px', cursor:'pointer', background:cat === c ? '#f0f4ff' : 'transparent', color:cat === c ? '#0f2340' : '#4a5a6a', fontSize:13, fontWeight:cat === c ? 700 : 400, display:'flex', justifyContent:'space-between', borderTop:'1px solid #f0f4fa' }}>
                  <span>{getCategoryIcon(c)} {c}</span>
                  {count > 0 && <span style={{ fontSize:11, background:'#0f234020', color:'#0f2340', padding:'1px 7px', borderRadius:20, fontWeight:700 }}>{count}</span>}
                </div>
              )
            })}
          </div>
        </div>

        {/* ---- Área principal ---- */}
        <div>

          {/* Aviso de classificação em andamento */}
          {classifying && (
            <div style={{ background:'#f0f4ff', border:'2px solid #2D3278', borderRadius:12, padding:'14px 18px', marginBottom:16, display:'flex', alignItems:'center', gap:12 }}>
              <span style={{ fontSize:22 }}>🔎</span>
              <div>
                <div style={{ fontWeight:700, color:'#2D3278', fontSize:15 }}>{t.aiReview}</div>
                <div style={{ fontSize:13, color:'#4a5a8a' }}>Lendo e classificando "{pendingFile?.name}"…</div>
              </div>
            </div>
          )}

          {/* Painel de revisão IA (confiança < 95%) */}
          {needsReview && classification && pendingFile && (
            <div style={{ background:'#fff', border:'2px solid #2D3278', borderRadius:14, padding:18, marginBottom:16 }}>
              <div style={{ fontWeight:700, color:'#2D3278', fontSize:16, marginBottom:12 }}>📋 {t.aiReview} — {t.selectCat}</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
                <div style={{ background:'#f8faff', borderRadius:10, padding:'10px 14px' }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', marginBottom:4 }}>{t.suggestedType}</div>
                  <div style={{ fontSize:14, fontWeight:700, color:'#0f2340' }}>{DOC_LABELS[classification.doc_type] ?? classification.doc_type}</div>
                  {classification.fiscal_year && <div style={{ fontSize:12, color:'#6a7a9a' }}>Ano {classification.fiscal_year}</div>}
                </div>
                <div style={{ background:'#f8faff', borderRadius:10, padding:'10px 14px' }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', marginBottom:4 }}>{t.confidence}</div>
                  <div style={{ fontSize:20, fontWeight:700, color: confidenceColor(classification.confidence), background: confidenceBg(classification.confidence), display:'inline-block', padding:'2px 12px', borderRadius:20 }}>
                    {Math.round(classification.confidence * 100)}%
                  </div>
                </div>
              </div>
              {classification.summary && (
                <div style={{ fontSize:13, color:'#4a5a6a', marginBottom:14, background:'#f8faff', borderRadius:8, padding:'8px 12px' }}>
                  <strong>{t.summary}:</strong> {classification.summary}
                </div>
              )}
              <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                <button
                  onClick={() => upload(pendingFile, classification, suggestedFolderId)}
                  disabled={uploading}
                  style={{ minHeight:44, padding:'0 20px', background:'#2D3278', color:'#fff', border:'none', borderRadius:10, fontSize:14, fontWeight:700, cursor:'pointer', opacity: uploading ? 0.6 : 1 }}>
                  {uploading ? t.uploading : `✓ ${t.confirm}`}
                </button>
                <button
                  onClick={() => upload(pendingFile, null)}
                  disabled={uploading}
                  style={{ minHeight:44, padding:'0 20px', background:'#fff', color:'#2D3278', border:'2px solid #2D3278', borderRadius:10, fontSize:14, fontWeight:600, cursor:'pointer' }}>
                  {t.skip}
                </button>
                <button
                  onClick={() => { setPendingFile(null); setClassification(null); setNeedsReview(false) }}
                  style={{ minHeight:44, padding:'0 16px', background:'transparent', color:'#9aaab0', border:'none', borderRadius:10, fontSize:14, cursor:'pointer' }}>
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {/* Zona de upload (esconde durante revisão) */}
          {!needsReview && cat && (
            <div
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) handleFileChosen(f) }}
              onClick={() => !classifying && fileRef.current?.click()}
              style={{ border:`2px dashed ${drag ? '#2D3278' : '#e2e8f4'}`, borderRadius:12, padding:'20px', textAlign:'center', cursor: classifying ? 'wait' : 'pointer', background: drag ? '#f0f4ff' : '#fafbff', marginBottom:16, transition:'all 0.15s' }}>
              <input ref={fileRef} type="file" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileChosen(f) }} style={{ display:'none' }} />
              <div style={{ fontSize:28, marginBottom:6 }}>📂</div>
              <div style={{ fontSize:13, color: uploading||classifying ? '#1a6b4a' : '#6a7a9a', fontWeight: uploading||classifying ? 700 : 400 }}>
                {uploading ? t.uploading : classifying ? '🔎 Classificando com IA…' : t.dropZone}
              </div>
              <div style={{ fontSize:11, color:'#9aaab0', marginTop:4 }}>PDF, Word, Excel, Images — max 50MB</div>
              {clientId && !classifying && !uploading && (
                <div style={{ fontSize:11, color:'#2D3278', marginTop:6, fontWeight:600 }}>✨ IA irá classificar e sugerir a pasta automaticamente</div>
              )}
            </div>
          )}

          {!cat && !needsReview && (
            <div style={{ background:'#fff8e8', border:'1px solid #e0b84a', borderRadius:10, padding:'12px 16px', marginBottom:16, fontSize:13, color:'#7a5a00' }}>
              💡 {t.selectCat}
            </div>
          )}

          {/* Lista de documentos */}
          <div style={{ background:'#fff', borderRadius:14, border:'1px solid #e2e8f4', overflow:'hidden' }}>
            <div style={{ padding:'12px 16px', borderBottom:'1px solid #e2e8f4', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ fontFamily:'Georgia,serif', fontSize:15, color:'#0f2340', fontWeight:700 }}>
                {cat ? `${getCategoryIcon(cat)} ${cat}` : `${t.allDocs} — ${year}`}
              </div>
              <div style={{ fontSize:12, color:'#6a7a9a' }}>{catDocs.length} file{catDocs.length !== 1 ? 's' : ''}</div>
            </div>
            {catDocs.length === 0 ? (
              <div style={{ padding:40, textAlign:'center', color:'#9aaab0' }}>
                <div style={{ fontSize:36, marginBottom:10 }}>📁</div>
                <div style={{ fontSize:14, color:'#6a7a9a' }}>{t.noDocs}</div>
              </div>
            ) : (
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr style={{ background:'#f8faff' }}>
                    {['File','Category','Size','Status','Date'].map(h => (
                      <th key={h} style={{ padding:'9px 14px', textAlign:'left', fontSize:11, fontWeight:700, color:'#6a7a9a', textTransform:'uppercase', letterSpacing:0.5, borderBottom:'1px solid #e2e8f4' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catDocs.map(doc => (
                    <tr key={doc.id} style={{ borderBottom:'1px solid #f0f4fa', cursor:'pointer' }} onClick={() => openDoc(doc.id)}>
                      <td style={{ padding:'10px 14px' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <span style={{ fontSize:18 }}>{doc.file_type?.includes('pdf') ? '📄' : doc.file_type?.includes('image') ? '🖼' : '📎'}</span>
                          <span style={{ fontSize:13, fontWeight:700, color:'#1a2a3a' }}>{doc.file_name}</span>
                        </div>
                      </td>
                      <td style={{ padding:'10px 14px', fontSize:12, color:'#6a7a9a' }}>
                        {doc.doc_type ? (DOC_LABELS[doc.doc_type] ?? doc.category) : doc.category}
                        {doc.ai_confidence && (
                          <span style={{ marginLeft:6, fontSize:10, background:'#f0f4ff', color:'#2D3278', padding:'1px 6px', borderRadius:10, fontWeight:700 }}>
                            IA {Math.round(doc.ai_confidence * 100)}%
                          </span>
                        )}
                      </td>
                      <td style={{ padding:'10px 14px', fontSize:12, color:'#6a7a9a' }}>{formatSize(doc.file_size)}</td>
                      <td style={{ padding:'10px 14px' }}>
                        <span style={{ fontSize:11, padding:'2px 8px', borderRadius:20, fontWeight:700, background: doc.status === 'approved' ? '#e8f5ee' : '#f0f4fa', color: doc.status === 'approved' ? '#1a6b4a' : '#6a7a9a' }}>{doc.status}</span>
                      </td>
                      <td style={{ padding:'10px 14px', fontSize:12, color:'#6a7a9a' }}>{new Date(doc.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric' })}</td>
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

