import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = supabaseAdmin()
    const { data: doc } = await db.from('documents').select('*').eq('id', params.id).single()
    if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data: { signedUrl } } = await db.storage
      .from('client-documents')
      .createSignedUrl(doc.storage_path, 3600)

    return NextResponse.json({ document: doc, url: signedUrl })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  try {
    const db = supabaseAdmin()
    const { data: doc } = await db.from('documents').select('storage_path').eq('id', params.id).single()
    if (doc) await db.storage.from('client-documents').remove([doc.storage_path])
    await db.from('documents').delete().eq('id', params.id)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
