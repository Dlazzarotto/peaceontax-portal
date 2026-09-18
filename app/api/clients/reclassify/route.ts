// /api/clients/reclassify — acertar em lote quem é empresa e quem é pessoa física
//
// GET  → o PLANO, sem gravar nada: quais cadastros hoje marcados como Empresa
//        têm sinal de empresa, quais não têm nenhum, e quais precisam de olho
// POST { ids[], motivo, password } → grava só os ids confirmados
//
// POR QUE ISTO EXISTE
// A importação do QuickBooks lê `Client type`: ORGANIZATION vira empresa. Na
// carteira real muita PESSOA está cadastrada no QuickBooks como organização —
// e desde que o tipo virou fronteira de acesso (assistente atende só pessoa
// física), esses cadastros desapareceram de quem atende o balcão. Consertar
// ficha por ficha, com senha e motivo em cada uma, não se faz com centenas.
//
// NADA É DECIDIDO AQUI SOZINHO. O GET propõe, a equipe confere e o POST grava
// só o que foi marcado — o mesmo desenho da importação, pela mesma razão: o
// que muda quem vê o quê não se aplica em silêncio.
//
// Gerente ou sócio, com senha e motivo.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { permissoesFinanceiro } from '@/lib/billing-perms'
import { propostaParaEmpresa, type Decisao } from '@/lib/tipo-do-cliente'

export const dynamic = 'force-dynamic'

const CAMPOS = 'id, name, business_name, ein, business_type, type, user_id, email'
const BLOCO = 200

async function exigePermissao() {
  const auth = await getAuth()
  if (!auth?.isStaff) {
    return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  }
  const perms = await permissoesFinanceiro(auth.userId)
  if (!perms.editarCliente) {
    return { erro: NextResponse.json({
      error: 'Acertar o tipo dos clientes exige autorização para editar cadastro.',
    }, { status: 403 }) }
  }
  return { auth, perms }
}

export async function GET() {
  const g = await exigePermissao()
  if (g.erro) return g.erro

  const { data, error } = await serviceDb().from('clients')
    .select(CAMPOS).eq('type', 'business').eq('active', true)
    .order('name').limit(3000)

  // Consulta que falha não vira lista vazia.
  if (error) {
    return NextResponse.json({ error: `Não foi possível ler os cadastros: ${error.message}` }, { status: 500 })
  }

  const grupos: Record<Decisao, any[]> = { manter_empresa: [], virar_pessoa: [], revisar: [] }
  for (const c of (data || [])) {
    const p = propostaParaEmpresa(c as any)
    grupos[p.decisao].push({
      id: c.id, name: c.name, business_name: c.business_name,
      ein: c.ein, business_type: c.business_type,
      motivos: p.motivos,
    })
  }

  return NextResponse.json({
    total: (data || []).length,
    resumo: {
      manterEmpresa: grupos.manter_empresa.length,
      virarPessoa:   grupos.virar_pessoa.length,
      revisar:       grupos.revisar.length,
    },
    // `manter_empresa` não vai na resposta inteira: são os que já estão
    // certos, e mandar centenas de linhas que ninguém vai olhar só pesa.
    virarPessoa: grupos.virar_pessoa,
    revisar:     grupos.revisar,
  })
}

export async function POST(req: NextRequest) {
  const g = await exigePermissao()
  if (g.erro) return g.erro
  const auth = g.auth!

  const b = await req.json().catch(() => ({} as any))
  const ids: string[] = Array.isArray(b.ids) ? b.ids.filter((x: any) => typeof x === 'string') : []
  const motivo = String(b.motivo || '').trim()

  if (!ids.length) return NextResponse.json({ error: 'Nenhum cadastro marcado.' }, { status: 400 })
  if (motivo.length < 5) {
    return NextResponse.json({
      error: 'Descreva o motivo (mínimo 5 caracteres). Ele fica na ficha de cada cliente.',
    }, { status: 400 })
  }
  if (!b.password) return NextResponse.json({ error: 'Confirme com a sua senha.' }, { status: 400 })

  const db = serviceDb()

  // Senha da própria pessoa: mudar de tipo em lote muda quem vê a carteira.
  {
    const { data: quem } = await db.auth.admin.getUserById(auth.userId)
    const email = quem?.user?.email
    if (!email) return NextResponse.json({ error: 'Não foi possível identificar seu login.' }, { status: 400 })
    const sbAuth = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
    const { error: pwErr } = await sbAuth.auth.signInWithPassword({ email, password: String(b.password).trim() })
    if (pwErr) {
      const m = pwErr.message || ''
      if (/rate|too many|429/i.test(m)) {
        return NextResponse.json({ error: 'Muitas tentativas. Aguarde 1 minuto.' }, { status: 429 })
      }
      return NextResponse.json({ error: `Senha não confere para ${email}.` }, { status: 401 })
    }
  }

  // Só o que está como empresa AGORA. Entre a prévia e o clique alguém pode
  // ter mexido, e reaplicar sobre pessoa física seria gravar sem mudança.
  const { data: alvos, error: errAlvos } = await db.from('clients')
    .select(CAMPOS).in('id', ids).eq('type', 'business')
  if (errAlvos) return NextResponse.json({ error: errAlvos.message }, { status: 500 })

  const podem = (alvos || [])
  const fora = ids.length - podem.length

  let gravados = 0
  const falhas: { id: string; name: string; erro: string }[] = []

  for (let i = 0; i < podem.length; i += BLOCO) {
    const parte = podem.slice(i, i + BLOCO)
    const { error } = await db.from('clients')
      .update({ type: 'individual', updated_at: new Date().toISOString() })
      .in('id', parte.map(c => c.id))

    if (!error) { gravados += parte.length; continue }

    // O insert/update do Postgres é tudo ou nada: sem o recuo por linha, um
    // cadastro problemático derrubaria os outros 199 — já aconteceu na
    // importação da carteira.
    for (const c of parte) {
      const { error: e1 } = await db.from('clients')
        .update({ type: 'individual', updated_at: new Date().toISOString() })
        .eq('id', c.id)
      if (e1) falhas.push({ id: c.id, name: c.name, erro: e1.message })
      else gravados++
    }
  }

  const acertados = podem.filter(c => !falhas.some(f => f.id === c.id))

  // A trilha é POR CLIENTE: quem abrir a ficha daqui a um ano precisa ver
  // que o tipo mudou, quem mudou e por quê — não só uma linha de resumo.
  if (acertados.length) {
    const trilha = acertados.map(c => ({
      client_id: c.id, action: 'type_changed', reason: motivo,
      performed_by: auth.userId,
      previous_state: { type: 'business' },
      new_state: { type: 'individual', em_lote: true },
    }))
    for (let i = 0; i < trilha.length; i += BLOCO) {
      const { error } = await db.from('client_audit').insert(trilha.slice(i, i + BLOCO))
      if (error) console.error('[reclassify] trilha nao gravada:', error.message)
    }
  }

  // A cópia do tipo no login do cliente tem de acompanhar (o convite e a
  // senha provisória gravam `client_type` no user_metadata).
  let loginsSincronizados = 0
  for (const c of acertados) {
    if (!c.user_id) continue
    try {
      const { data: u } = await db.auth.admin.getUserById(c.user_id)
      if (!u?.user) continue
      await db.auth.admin.updateUserById(c.user_id, {
        user_metadata: { ...(u.user.user_metadata || {}), client_type: 'individual' },
      })
      loginsSincronizados++
    } catch (e) {
      console.error('[reclassify] metadata do login:', (e as Error).message)
    }
  }

  return NextResponse.json({
    ok: true,
    gravados, loginsSincronizados,
    // Honestidade sobre o que NÃO foi feito: a importação já ensinou que
    // devolver só o número bonito esconde o problema.
    jaNaoEramEmpresa: fora,
    falhas,
    message: `${gravados} cadastro(s) passaram a Pessoa física` +
      (loginsSincronizados ? ` · ${loginsSincronizados} login(s) sincronizado(s)` : '') +
      (fora ? ` · ${fora} já não estavam como Empresa` : '') +
      (falhas.length ? ` · ${falhas.length} falharam` : '') + '.',
  })
}
