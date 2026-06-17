import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function POST(req: NextRequest) {
  try {
    const formData    = await req.formData()
    const file        = formData.get('file') as File
    const clientId    = formData.get('clientId') as string
    const taxYear     = formData.get('taxYear') as string
    const category    = formData.get('category') as string
    const subcategory = formData.get('subcategory') as string
    if (!file || !clientId || !taxYear || !category) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    const db = supabaseAdmin()
    const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    const path = `${clientId}/${taxYear}/${category.replace(/\//g, '-')}/${safeName}`
    const buffer = await file.arrayBuffer()
    const { error: uploadErr } = await db.storage.from('client-documents').upload(path, buffer, { contentType: file.type })
    if (uploadErr) throw uploadErr
    const { data: doc } = await db.from('documents').insert({ client_id: clientId, tax_year: parseInt(taxYear), category, subcategory: subcategory || null, file_name: file.name, storage_path: path, file_size: file.size, file_type: file.type, uploaded_by: 'firm', status: 'uploaded' }).select().single()
    return NextResponse.json({ document: doc })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
