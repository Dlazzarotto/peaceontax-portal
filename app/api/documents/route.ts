import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function POST(req: NextRequest) {
  try {
    const formData    = await req.formData()
    const file        = formData.get('file') as File
    const clientId    = formData.get('clientId') as string
    const taxYear     = formData.get('taxYear') as string
    const category    = formData.get('category') as string
    const subcategory = formData.get('subcategory') as string | null

    // Metadados de IA (opcionais — enviados pela tela de documentos quando disponíveis)
    const docType      = formData.get('doc_type') as string | null
    const aiConfidence = formData.get('ai_confidence') as string | null
    const classifiedBy = formData.get('classified_by') as string | null
    const ocrText      = formData.get('ocr_text') as string | null
    const folderId     = formData.get('folder_id') as string | null

    if (!file || !clientId || !taxYear || !category) {
      return NextResponse.json({ error: 'Missing required fields: file, clientId, taxYear, category' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    const path = `${clientId}/${taxYear}/${category.replace(/\//g, '-')}/${safeName}`
    const buffer = await file.arrayBuffer()

    // Upload para o storage
    const { error: uploadErr } = await db.storage
      .from('client-documents')
      .upload(path, buffer, { contentType: file.type })

    if (uploadErr) {
      console.error('Storage upload error:', uploadErr)
      return NextResponse.json({ error: `Storage error: ${uploadErr.message}` }, { status: 500 })
    }

    // Inserir registro no banco com metadados de IA
    const insertPayload: Record<string, any> = {
      client_id:    clientId,
      tax_year:     parseInt(taxYear),
      category,
      subcategory:  subcategory || null,
      file_name:    file.name,
      storage_path: path,
      file_size:    file.size,
      file_type:    file.type,
      uploaded_by:  'firm',
      status:       'uploaded',
    }

    // Adiciona metadados de IA se vieram no form
    if (docType)      insertPayload.doc_type      = docType
    if (aiConfidence) insertPayload.ai_confidence = parseFloat(aiConfidence)
    if (classifiedBy) insertPayload.classified_by = classifiedBy
    if (ocrText)      insertPayload.ocr_text      = ocrText
    if (folderId)     insertPayload.folder_id     = folderId

    const { data: doc, error: insertErr } = await db
      .from('documents')
      .insert(insertPayload)
      .select()
      .single()

    if (insertErr) {
      // Se o insert falhou, remove o arquivo do storage para não deixar órfão
      console.error('DB insert error:', insertErr)
      await db.storage.from('client-documents').remove([path])
      return NextResponse.json({ error: `Database error: ${insertErr.message}` }, { status: 500 })
    }

    return NextResponse.json({ document: doc })

  } catch (err: any) {
    console.error('Unexpected upload error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
