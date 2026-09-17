// POST /api/clients/import — traz a carteira do QuickBooks para o cadastro
//   Body: { csv: string, aplicar?: boolean }
//
// Sem `aplicar`, devolve só o PLANO: quantos entram, quantos já existem,
// quantos estão repetidos no próprio arquivo. Nada é gravado. A equipe
// confere e só então confirma.
//
// Só gerente ou sócio: é a carteira inteira de uma vez.
//
// IMPORTAR NÃO CONVIDA. Cadastrar cliente pela tela manda o convite do portal;
// fazer isso com quase mil e-mails de uma vez seria um desastre. Aqui grava-se
// e pronto — o convite sai depois, um a um, quando a equipe quiser.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { lerCsv, planejarImportacao } from '@/lib/import-clientes'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Insert em blocos: mil linhas de uma vez estoura o limite do payload. */
const BLOCO = 200

export async function POST(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const nivel = await getStaffLevel(auth.userId)
  if (nivel !== 'owner' && nivel !== 'manager') {
    return NextResponse.json({ error: 'Importar a carteira é de gerente ou sócio.' }, { status: 403 })
  }

  const { csv, aplicar } = await req.json().catch(() => ({}))
  if (!csv || typeof csv !== 'string') {
    return NextResponse.json({ error: 'Envie o arquivo CSV.' }, { status: 400 })
  }

  let registros: Record<string, string>[]
  try {
    registros = lerCsv(csv)
  } catch (e) {
    return NextResponse.json({ error: `Não consegui ler o arquivo: ${(e as Error).message}` }, { status: 400 })
  }
  if (!registros.length) return NextResponse.json({ error: 'O arquivo não tem nenhuma linha.' }, { status: 400 })
  if (!('Name' in registros[0])) {
    return NextResponse.json({
      error: 'Este arquivo não parece o export de clientes do QuickBooks — falta a coluna "Name".',
      colunas: Object.keys(registros[0]).slice(0, 10),
    }, { status: 400 })
  }

  const db = serviceDb()
  // Toda a carteira atual, para saber quem já está cadastrado
  const { data: jaCadastrados, error: errLista } = await db.from('clients')
    .select('name, business_name').limit(10000)
  if (errLista) return NextResponse.json({ error: errLista.message }, { status: 500 })

  const plano = planejarImportacao(registros, jaCadastrados || [])

  const resumo = {
    lidos: registros.length,
    novos: plano.novos.length,
    jaExistem: plano.jaExistem.length,
    repetidosNoArquivo: plano.repetidosNoArquivo.length,
    semNome: plano.semNome,
    telefonesDescartados: plano.telefonesDescartados,
    empresas: plano.novos.filter(n => n.type === 'business').length,
    pessoasFisicas: plano.novos.filter(n => n.type === 'individual').length,
    semEmail: plano.novos.filter(n => !n.email).length,
    emailCompartilhado: plano.emailCompartilhado.length,
  }

  if (!aplicar) {
    return NextResponse.json({
      ok: true, previa: true, resumo,
      amostra: plano.novos.slice(0, 15),
      jaExistem: plano.jaExistem.slice(0, 30).map(x => x.name),
      repetidos: plano.repetidosNoArquivo.map(x => x.name),
      emailCompartilhado: plano.emailCompartilhado.slice(0, 20),
    })
  }

  if (!plano.novos.length) {
    return NextResponse.json({ ok: true, resumo, message: 'Nada a importar: todos já estão cadastrados.' })
  }

  const agora = new Date().toISOString()
  const linhas = plano.novos.map(n => ({
    name: n.name, email: n.email, phone: n.phone, type: n.type,
    stage: 'Onboarding', language: 'en', active: true,
    notes: `Importado do QuickBooks em ${agora.slice(0, 10)}.`,
  }))

  let gravados = 0
  const falhas: string[] = []
  for (let i = 0; i < linhas.length; i += BLOCO) {
    const parte = linhas.slice(i, i + BLOCO)
    const { data, error } = await db.from('clients').insert(parte).select('id')
    if (!error) { gravados += data?.length || 0; continue }

    // O insert do Postgres é tudo-ou-nada: UMA linha recusada derruba as 200 do
    // bloco. Quando isso acontece, tenta uma a uma — assim só fica de fora quem
    // realmente não entra, e a mensagem diz QUEM e POR QUÊ, em vez de um
    // "bloco falhou" que não ajuda ninguém.
    console.error('import clientes, bloco', i / BLOCO, error.message, '— tentando linha a linha')
    for (const linha of parte) {
      const { error: e1 } = await db.from('clients').insert(linha)
      if (e1) {
        if (falhas.length < 20) falhas.push(`${linha.name}: ${e1.message}`)
      } else gravados++
    }
  }
  const recusados = linhas.length - gravados

  await db.from('client_audit').insert({
    client_id: null, action: 'import_quickbooks', performed_by: auth.userId,
    next: { ...resumo, gravados, recusados, falhas: falhas.slice(0, 20) },
  }).then(() => null, () => null)

  return NextResponse.json({
    ok: true, resumo, gravados, recusados, falhas,
    message: `${gravados} cliente(s) importado(s).`
      + (plano.jaExistem.length ? ` ${plano.jaExistem.length} já estavam cadastrados e ficaram de fora.` : '')
      + (recusados > 0 ? ` ⚠️ ${recusados} NÃO entraram — o motivo de cada um está abaixo.` : '')
      + ' Nenhum convite foi enviado: o acesso ao portal sai um a um, quando você quiser.',
  })
}
