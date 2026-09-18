// /api/documents/[id] — abre ou apaga um documento
//
// CORREÇÃO DE SEGURANÇA: sem conferência de quem chamava. Qualquer pessoa
// logada pedia o link assinado de QUALQUER documento — declaração, W-2,
// extrato — bastando o id. E apagava.
//
// BAIXAR NÃO É VER. Ver que o documento existe na lista é uma coisa; tirar
// uma cópia do W-2 do cliente é outra — o arquivo é o que sai do prédio. O
// GET exige a autorização `baixarArquivo` (gerente e sócio a têm por nível).
// O cliente segue baixando os PRÓPRIOS documentos: a restrição é da equipe.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, canAccessClient, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro } from '@/lib/billing-perms'

async function documento(id: string) {
  const { data } = await serviceDb().from('documents')
    .select('*').eq('id', id).maybeSingle()
  return data
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getAuth()
  if (!auth) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  try {
    const doc = await documento(params.id)
    if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!(await canAccessClient(auth, doc.client_id)))
      return NextResponse.json({ error: 'Sem acesso' }, { status: 403 })

    if (auth.isStaff && !(await permissoesFinanceiro(auth.userId)).baixarArquivo) {
      return NextResponse.json({
        error: 'Baixar arquivo do cliente exige autorização — fale com o sócio. ' +
               'Ver a lista de documentos continua liberado.',
      }, { status: 403 })
    }

    const { data } = await serviceDb().storage
      .from('client-documents').createSignedUrl(doc.storage_path, 3600)
    return NextResponse.json({ document: doc, url: data?.signedUrl })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  // Apagar documento do cliente é da equipe. O cliente envia, não remove.
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  try {
    const db = serviceDb()
    const doc = await documento(params.id)
    if (doc?.storage_path) await db.storage.from('client-documents').remove([doc.storage_path])
    await db.from('documents').delete().eq('id', params.id)
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
