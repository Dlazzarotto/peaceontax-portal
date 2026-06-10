import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const clientId = formData.get('clientId') as string
    const folderPath = formData.get('folderPath') as string
    if (!file || !clientId || !folderPath) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    const db = supabaseAdmin()
    const fileName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    const storagePath = `${clientId}/${folderPath}/${fileName}`
    const buffer = await file.arrayBuffer()
    const { error: uploadErr } = await db.storage.from('client-documents').upload(storagePath, buffer, { contentType: file.type })
    if (uploadErr) throw uploadErr
    const { data: doc } = await db.from('documents').insert({ client_id: clientId, folder_path: folderPath, file_name: file.name, storage_path: storagePath, file_size: file.size, status: 'uploaded' }).select().single()
    return NextResponse.json({ document: doc })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
