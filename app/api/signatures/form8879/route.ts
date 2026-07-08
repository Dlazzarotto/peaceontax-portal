// POST /api/signatures/form8879 — envia a Form 8879 (PDF do ProSeries) para assinatura com KBA
// FormData: file (PDF), clientId, fiscalYear, signer1Name, signer1Email, signer1Title?,
//           signer2Name?, signer2Email? (cônjuge MFJ), kba ('true' default)
// SÓ manager/owner. KBA obrigatório por padrão (IRS Pub. 1345 para assinatura remota).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { sendEnvelope, type Signer } from '@/lib/docusign'

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner enviam a 8879' }, { status: 403 })
  }

  const form = await req.formData()
  const file = form.get('file') as File | null
  const clientId = form.get('clientId') as string
  const fiscalYear = parseInt(form.get('fiscalYear') as string)
  const s1Name = (form.get('signer1Name') as string || '').trim()
  const s1Email = (form.get('signer1Email') as string || '').trim()
  const s1Title = (form.get('signer1Title') as string || '').trim()
  const s2Name = (form.get('signer2Name') as string || '').trim()
  const s2Email = (form.get('signer2Email') as string || '').trim()
  const kba = (form.get('kba') as string) !== 'false'   // default TRUE

  if (!file || !clientId || !fiscalYear || !s1Name || !s1Email) {
    return NextResponse.json({ error: 'file, clientId, fiscalYear, signer1Name e signer1Email obrigatórios' }, { status: 400 })
  }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    return NextResponse.json({ error: 'Apenas PDF' }, { status: 400 })
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'PDF acima de 10MB' }, { status: 400 })
  }
  if (!(await canAccessClient(auth, clientId))) {
    return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
  }

  const signers: Signer[] = [{ name: s1Name, email: s1Email, title: s1Title || undefined, kba }]
  if (s2Name && s2Email) signers.push({ name: s2Name, email: s2Email, kba })

  const pdfBase64 = Buffer.from(await file.arrayBuffer()).toString('base64')

  try {
    const { envelopeId } = await sendEnvelope({
      doc: { name: `Form-8879-${fiscalYear}.pdf`, base64: pdfBase64, fileExtension: 'pdf' },
      signers,
      emailSubject: `IRS e-file authorization (Form 8879) — Tax Year ${fiscalYear} — Peace on Tax`,
      emailBody: 'Please review and sign your IRS e-file authorization. Identity verification (KBA) is required by the IRS for remote signatures. Questions: (833) 732-2327.',
      anchorMode: false,   // PDF do ProSeries não tem âncoras — assinatura posicionada
    })

    const db = serviceDb()
    const { data: sig } = await db.from('signature_requests').insert({
      client_id: clientId, kind: 'form8879', envelope_id: envelopeId,
      signers, kba, fiscal_year: fiscalYear, created_by: auth.userId,
    }).select('id').single()

    return NextResponse.json({ ok: true, envelopeId, id: sig?.id })
  } catch (e) {
    console.error('8879 send error:', e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
