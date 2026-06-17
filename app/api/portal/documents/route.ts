import { NextRequest, NextResponse } from 'next/server'
import { getUser } from '@/lib/supabase-server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function GET() {
  try {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const db = supabaseAdmin()
    const { data: client } = await db.from('clients').select('*').eq('user_id', user.id).single()
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    const { data: documents } = await db.from('documents').select('*').eq('client_id', client.id).order('created_at', { ascending: false })
    return NextResponse.json({ client, documents: documents || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const db = supabaseAdmin()
    const { data: client } = await db.from('clients').select('id').eq('user_id', user.id).single()
    if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    const formData    = await req.formData()
    const file        = formData.get('file') as File
    const taxYear     = formData.get('taxYear') as string
    const category    = formData.get('category') as string
    const subcategory = formData.get('subcategory') as string
    if (!file || !taxYear || !category) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`
    const path = `${client.id}/${taxYear}/${category.replace(/\//g, '-')}/${safeName}`
    const buffer = await file.arrayBuffer()
    const { error: uploadErr } = await db.storage.from('client-documents').upload(path, buffer, { contentType: file.type })
    if (uploadErr) throw uploadErr
    const { data: doc } = await db.from('documents').insert({ client_id: client.id, tax_year: parseInt(taxYear), category, subcategory: subcategory || null, file_name: file.name, storage_path: path, file_size: file.size, file_type: file.type, uploaded_by: 'client', status: 'uploaded' }).select().single()
    return NextResponse.json({ document: doc })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
