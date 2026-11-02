// /api/firm/setup/[token] — aceite do convite da equipe
//
// Esta rota não existia: o convite era enviado, a pessoa clicava e a tela
// dizia "Invalid or expired invitation" porque não havia o que chamar.
//
// GET  → devolve os dados do convite (nome, e-mail, papel) para a tela
// POST → cria o login com a senha, grava o papel e LIGA a pessoa à sua linha
//        em team_members, onde mora o nível (lib/equipe.ts). A linha que o
//        CRM já tinha é completada, não duplicada.
//
// Pública por natureza (quem aceita ainda não tem login), protegida pelo
// token aleatório de 64 caracteres e pela validade de 7 dias.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getStaffLevel, nivelDoPapel } from '@/lib/staff-perms'
import { ehDaFirma } from '@/lib/papeis'
import { todosOsLogins, vincularNaEquipe } from '@/lib/equipe-servidor'
import { buscaLiteral } from '@/lib/clientes-grupos'

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
    // O PAPEL vai para app_metadata, que só a service role escreve.
    // user_metadata é gravável pelo próprio usuário pelo navegador -- papel
    // ali seria um crachá que a pessoa reescreve sozinha (lib/papeis.ts).
    const appMetadata  = { role: papel }
    const metadata = {
      full_name: convite.name,
      title: convite.title || '',
      phone: convite.phone || '',
    }

    // Cria o login. Se o e-mail já existir, atualiza a senha em vez de falhar
    // (caso de convite reenviado ou pessoa que já tinha conta).
    let userId: string | null = null
    let papelFinal = papel

    const { data: criado, error: errCriar } = await db.auth.admin.createUser({
      email: convite.email,
      password: String(password),
      email_confirm: true,
      app_metadata: appMetadata,
      user_metadata: metadata,
    })

    if (criado?.user) {
      userId = criado.user.id
    } else if (errCriar) {
      const jaExiste = /already|registered|exists/i.test(errCriar.message || '')
      if (!jaExiste) {
        return NextResponse.json({ error: errCriar.message }, { status: 400 })
      }
      // Localiza o usuário existente pelo e-mail — em TODAS as páginas: o
      // listUsers() sem página só olhava os 50 primeiros logins.
      const { logins, erro: errLogins } = await todosOsLogins(db)
      if (errLogins) {
        return NextResponse.json({ error: `Não foi possível conferir os logins: ${errLogins}` }, { status: 500 })
      }
      const achado = logins.find(
        u => String(u.email).toLowerCase() === String(convite.email).toLowerCase())
      if (!achado) {
        return NextResponse.json({ error: 'Não foi possível criar a conta. Contate o administrador.' }, { status: 500 })
      }
      userId = achado.id
      const { data: atual } = await db.auth.admin.getUserById(userId)
      const appAtual = (atual?.user?.app_metadata || {}) as Record<string, unknown>
      // Quem JÁ É da firma mantém o papel: o nível dele mora na equipe e só
      // muda pelo sócio. Um convite antigo, aceito depois de a pessoa ter
      // sido rebaixada, regravava o papel — e o papel é a reserva do nível.
      papelFinal = ehDaFirma(appAtual.role) ? String(appAtual.role) : papel
      await db.auth.admin.updateUserById(userId, {
        password: String(password),
        app_metadata:  { ...appAtual, role: papelFinal },
        // role sai de user_metadata: fica um lugar so, e o forjavel nao e ele
        user_metadata: { ...(atual?.user?.user_metadata || {}), ...metadata, role: undefined },
      })
    }

    if (!userId) {
      return NextResponse.json({ error: 'Não foi possível criar a conta' }, { status: 500 })
    }

    // ── A pessoa na equipe: o nível mora aqui ──
    // Admin e Owner viram 'owner'; Manager vira 'manager'; Staff vira 'junior'.
    // Quem já tinha linha não tem o nível tocado (vincularNaEquipe).
    const vinculo = await vincularNaEquipe({
      userId, email: convite.email, nome: convite.name, nivel: nivelDoPapel(papelFinal),
    }, db)
    if (vinculo.erro) {
      // Não derruba o cadastro: sem a linha, getStaffLevel usa o papel do
      // login — o mesmo nível do convite. A tela Equipe mostra a pessoa como
      // "sem cadastro" para o sócio acertar.
      console.error('equipe: vinculo do convite', vinculo.acao, vinculo.erro)
    }
    const nivel = await getStaffLevel(userId)

    // Marca o convite como usado — o mesmo link não serve duas vezes
    await db.from('staff_invitations').update({
      status: 'accepted',
      registered_at: new Date().toISOString(),
    }).eq('id', convite.id)

    // E os OUTROS convites pendentes do mesmo e-mail deixam de valer: o
    // "Reenviar" criava um link novo sem matar o anterior, e um link velho
    // com outro nível continuava abrindo a conta por sete dias.
    await db.from('staff_invitations')
      .update({ expires_at: new Date().toISOString() })
      .ilike('email', buscaLiteral(convite.email))
      .eq('status', 'pending')
      .neq('id', convite.id)

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
