// GET  /api/signatures/status?clientId=...       — lista solicitações do cliente
// POST /api/signatures/status { id }             — consulta o DocuSign, atualiza status
//   e, quando completed, baixa o PDF assinado e arquiva em Signed Documents do cliente.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getEnvelopeStatus, downloadSignedPdf } from '@/lib/docusign'

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  if (!clientId) return NextResponse.json({ error: 'clientId obrigatório' }, { status: 400 })

  const { data, error } = await serviceDb()
    .from('signature_requests')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ requests: data || [] })
}

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'id obrigatório' }, { status: 400 })

  const db = serviceDb()
  const { data: sig } = await db.from('signature_requests').select('*').eq('id', id).single()
  if (!sig) return NextResponse.json({ error: 'Solicitação não encontrada' }, { status: 404 })
  if (!(await canAccessClient(auth, sig.client_id))) {
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  }

  try {
    const status = await getEnvelopeStatus(sig.envelope_id)

    // Sem mudança
    if (status === sig.status) return NextResponse.json({ ok: true, status, changed: false })

    const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() }

    // COMPLETO: baixa o PDF assinado e arquiva na pasta do cliente
    if (status === 'completed' && !sig.signed_document_id) {
      const pdf = await downloadSignedPdf(sig.envelope_id)
      const year = sig.fiscal_year || new Date().getFullYear()
      const fileName = sig.kind === 'form8879'
        ? `Form-8879-${year}-SIGNED.pdf`
        : `Contrato-${year}-SIGNED.pdf`
      const storagePath = `${sig.client_id}/${year}/Signed Documents/${Date.now()}-${fileName}`

      const { error: upErr } = await db.storage
        .from('client-documents')
        .upload(storagePath, pdf, { contentType: 'application/pdf', upsert: true })

      if (!upErr) {
        const { data: doc } = await db.from('documents').insert({
          client_id: sig.client_id,
          tax_year: year,
          category: 'Signed Documents',
          file_name: fileName,
          storage_path: storagePath,
          file_size: pdf.length,
          file_type: 'application/pdf',
          uploaded_by: 'system',
          status: 'approved',
          doc_type: sig.kind === 'form8879' ? 'form_8879_signed' : 'contract_signed',
        }).select('id').single()
        update.signed_document_id = doc?.id ?? null
      }
      update.completed_at = new Date().toISOString()
    }

    await db.from('signature_requests').update(update).eq('id', id)

    // Contrato de plano assinado → registra no plano
    if (status === 'completed' && sig.plan_id) {
      await db.from('plan_audit').insert({
        plan_id: sig.plan_id, action: 'contract_signed', performed_by: auth.userId,
        snapshot: { envelopeId: sig.envelope_id },
      })
    }

    return NextResponse.json({ ok: true, status, changed: true })
  } catch (e) {
    console.error('Status check error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
