import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'
import { getAuth, canAccessClient } from '@/lib/api-auth'

// CORRECAO DE SEGURANCA: sem conferencia de quem chamava — qualquer pessoa
// logada gravava arquivo na pasta de qualquer cliente.
export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Nao autenticado' }, { status: 401 })
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const clientId = formData.get('clientId') as string
    const folderPath = formData.get('folderPath') as string
    if (!file || !clientId) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    if (!(await canAccessClient(auth, clientId)))
      return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })
    const db = supabaseAdmin()
    const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    const path = `${clientId}/${folderPath||'general'}/${safeName}`
    const buffer = await file.arrayBuffer()
    const { error: uploadErr } = await db.storage.from('client-documents').upload(path, buffer, { contentType: file.type })
    if (uploadErr) throw uploadErr
    const { data: doc } = await db.from('documents').insert({ client_id: clientId, folder_path: folderPath, file_name: file.name, storage_path: path, file_size: file.size, status: 'uploaded' }).select().single()
    return NextResponse.json({ document: doc })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
