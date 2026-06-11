import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-browser'

// GET — list all clients
export async function GET(req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const { searchParams } = new URL(req.url)
    const type   = searchParams.get('type')
    const search = searchParams.get('search')
    const active = searchParams.get('active')

    let query = db.from('clients').select('*').order('name')

    if (type)   query = query.eq('type', type)
    if (active !== null) query = query.eq('active', active !== 'false')
    if (search) query = query.ilike('name', `%${search}%`)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ clients: data || [] })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// POST — create new client
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const db = supabaseAdmin()

    const { data: client, error } = await db
      .from('clients')
      .insert({
        name:          body.name,
        email:         body.email,
        phone:         body.phone || null,
        type:          body.type,
        language:      body.language || 'en',
        assignee:      body.assignee || null,
        stage:         body.stage || 'Onboarding',
        notes:         body.notes || null,
        business_name: body.business_name || null,
        ein:           body.ein || null,
        business_type: body.business_type || null,
        industry:      body.industry || null,
        ssn_last4:     body.ssn_last4 || null,
        filing_status: body.filing_status || null,
        address_line1: body.address_line1 || null,
        address_line2: body.address_line2 || null,
        city:          body.city || null,
        state:         body.state || 'MA',
        zip:           body.zip || null,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ client })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
