// /api/firm/setup/[token] — aceite do convite da equipe
//
// Esta rota não existia: o convite era enviado, a pessoa clicava e a tela
// dizia "Invalid or expired invitation" porque não havia o que chamar.
//
// GET  → devolve os dados do convite (nome, e-mail, papel) para a tela
// POST → cria o login com a senha, grava o papel e REGISTRA O NÍVEL em
//        staff_roles, que é a fonte única de permissão do sistema.
//
// Pública por natureza (quem aceita ainda não tem login), protegida pelo
// token aleatório de 64 caracteres e pela validade de 7 dias.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { nivelDoPapel } from '@/lib/staff-perms'

export const dynamic = 'force-dynamic'

function adminDb() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY
  if (!key) throw new Error('Service key não configurada')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key)
}

async function buscarConvite(token: string) {
  const db = adminDb()
  const { data } = await db.from('staff_invitations')
    .select('id, email, name, role, title, phone, status, expires_at')
    .eq('token', token)
    .maybeSingle()
  return data
}

// ── Dados do convite para a tela ────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const convite = await buscarConvite(params.token)
    if (!convite) {
      return NextResponse.json({ error: 'Convite não encontrado' }, { status: 404 })
    }
    if (convite.status === 'accepted') {
      return NextResponse.json({ error: 'Este convite já foi utilizado' }, { status: 409 })
    }
    if (new Date(convite.expires_at) < new Date()) {
      return NextResponse.json({ error: 'Convite expirado' }, { status: 410 })
    }

    return NextResponse.json({
      name: convite.name,
      email: convite.email,
      role: convite.role || 'staff',
      title: convite.title || '',
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}

// ── Criação da conta ────────────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const { password } = await req.json()
    if (!password || String(password).length < 8) {
      return NextResponse.json({ error: 'A senha precisa de ao menos 8 caracteres' }, { status: 400 })
    }

    const convite = await buscarConvite(params.token)
    if (!convite) return NextResponse.json({ error: 'Convite não encontrado' }, { status: 404 })
    if (convite.status === 'accepted') {
      return NextResponse.json({ error: 'Este convite já foi utilizado' }, { status: 409 })
    }
    if (new Date(convite.expires_at) < new Date()) {
      return NextResponse.json({ error: 'Convite expirado' }, { status: 410 })
    }

    const db = adminDb()
    const papel = convite.role || 'staff'
    const metadata = {
      role: papel,
      full_name: convite.name,
      title: convite.title || '',
      phone: convite.phone || '',
    }

    // Cria o login. Se o e-mail já existir, atualiza a senha em vez de falhar
    // (caso de convite reenviado ou pessoa que já tinha conta).
    let userId: string | null = null

    const { data: criado, error: errCriar } = await db.auth.admin.createUser({
      email: convite.email,
      password: String(password),
      email_confirm: true,
      user_metadata: metadata,
    })

    if (criado?.user) {
      userId = criado.user.id
    } else if (errCriar) {
      const jaExiste = /already|registered|exists/i.test(errCriar.message || '')
      if (!jaExiste) {
        return NextResponse.json({ error: errCriar.message }, { status: 400 })
      }
      // Localiza o usuário existente pelo e-mail
      const { data: lista } = await db.auth.admin.listUsers()
      const achado = lista?.users?.find(
        (u: any) => String(u.email).toLowerCase() === String(convite.email).toLowerCase())
      if (!achado) {
        return NextResponse.json({ error: 'Não foi possível criar a conta. Contate o administrador.' }, { status: 500 })
      }
      userId = achado.id
      await db.auth.admin.updateUserById(userId, {
        password: String(password),
        user_metadata: { ...(achado.user_metadata || {}), ...metadata },
      })
    }

    if (!userId) {
      return NextResponse.json({ error: 'Não foi possível criar a conta' }, { status: 500 })
    }

    // ── A peça que faltava: gravar o nível de permissão ──
    // Admin e Owner viram 'owner'; Manager vira 'manager'; Staff vira 'junior'.
    const nivel = nivelDoPapel(papel)
    const { error: errNivel } = await db.from('staff_roles').upsert({
      user_id: userId,
      level: nivel,
      display_name: convite.name,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    if (errNivel) {
      console.error('staff_roles upsert:', errNivel)
      // Não derruba o cadastro: getStaffLevel tem reserva pelo metadata
    }

    // Marca o convite como usado — o mesmo link não serve duas vezes
    await db.from('staff_invitations').update({
      status: 'accepted',
      registered_at: new Date().toISOString(),
    }).eq('id', convite.id)

    return NextResponse.json({
      ok: true,
      email: convite.email,
      nivel,
      message: `Conta criada com acesso de ${nivel === 'owner' ? 'sócio/administrador' : nivel === 'manager' ? 'gerente' : 'assistente'}.`,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
