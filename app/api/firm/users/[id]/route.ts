// /api/firm/users/[id] — altera ou desativa um membro da equipe
//
// CORREÇÃO DE SEGURANÇA (grave): esta rota NÃO CONFERIA QUEM CHAMAVA.
// O middleware exige apenas sessão — a de um cliente serve — e aqui dentro
// usava-se a service role key com `role` e `password` vindos do corpo. Ou
// seja, qualquer pessoa logada podia:
//   PATCH  /api/firm/users/<id-dela>   {"role":"firm"}      → virar firma
//   PATCH  /api/firm/users/<id-do-socio> {"password":"..."} → assumir a conta do sócio
//   DELETE /api/firm/users/<id>                             → banir qualquer um
// Agora só sócio/administrador passa, e ninguém mexe no próprio papel.
//
// Segundo defeito, silencioso: `user_metadata = { role, ... }` SUBSTITUÍA o
// metadata inteiro. Corpo sem `role` rebaixava um membro da firma a cliente,
// e a flag must_change_password sumia. Agora é mesclagem.
//
// Terceiro: mudar o papel aqui não tocava em staff_roles, que é a fonte de
// permissão real — a tela dizia "Manager" e o sistema tratava como junior.
// Sincroniza, sim, mas SÓ quando o papel muda: o nível pode ter sido afinado
// à mão em /api/account/team, e uma edição de telefone não pode promover
// ninguém.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, nivelDoPapel } from '@/lib/staff-perms'

const PAPEIS = ['firm', 'admin', 'manager', 'staff']

/** Só sócio/administrador gerencia a equipe — e nunca a si mesmo. */
async function exigeSocio(alvo: string) {
  const auth = await getAuth()
  if (!auth?.isStaff) {
    return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  }
  if ((await getStaffLevel(auth.userId)) !== 'owner') {
    return { erro: NextResponse.json({
      error: 'Somente sócio ou administrador pode gerenciar a equipe.',
    }, { status: 403 }) }
  }
  if (auth.userId === alvo) {
    return { erro: NextResponse.json({
      error: 'Você não altera o próprio acesso. Peça a outro sócio.',
    }, { status: 403 }) }
  }
  return { auth }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guarda = await exigeSocio(params.id)
  if (guarda.erro) return guarda.erro

  try {
    const { name, role, title, phone, password, reactivate } = await req.json()
    const db = serviceDb()

    if (reactivate) {
      const { data, error } = await db.auth.admin.updateUserById(params.id, { ban_duration: 'none' })
      if (error) throw error
      return NextResponse.json({ user: data.user })
    }

    // Estado atual: mesclamos em cima dele, nunca substituímos
    const { data: atual } = await db.auth.admin.getUserById(params.id)
    if (!atual?.user) {
      return NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 })
    }
    const metaAtual = (atual.user.user_metadata || {}) as Record<string, unknown>
    const appAtual  = (atual.user.app_metadata  || {}) as Record<string, unknown>

    // Papel só muda para um da lista. Omitido ou inválido: fica o que era.
    //
    // O papel é lido de app_metadata, e é lá que ele é gravado: user_metadata
    // é gravável pelo próprio dono do login (ver lib/papeis.ts). O papel
    // deixa de ir para user_metadata — ter a mesma informação nos dois
    // lugares é ter duas versões dela, e a de baixo é a forjável.
    const papel = PAPEIS.includes(String(role)) ? String(role) : String(appAtual.role || 'staff')

    const updates: any = {
      app_metadata: { ...appAtual, role: papel },
      user_metadata: {
        ...metaAtual,
        role:      undefined,
        full_name: name  !== undefined ? name  : metaAtual.full_name,
        title:     title !== undefined ? title : (metaAtual.title || ''),
        phone:     phone !== undefined ? phone : (metaAtual.phone || ''),
      },
    }
    if (password) {
      if (String(password).length < 8) {
        return NextResponse.json({ error: 'A senha precisa de ao menos 8 caracteres' }, { status: 400 })
      }
      updates.password = String(password)
    }

    const { data, error } = await db.auth.admin.updateUserById(params.id, updates)
    if (error) throw error

    // staff_roles é a permissão real — sem isto a tela diz Manager e o
    // sistema continua tratando como assistente.
    //
    // Mas SÓ quando o papel realmente mudou, ou quando ainda não há registro.
    // O nível pode ter sido afinado à mão em /api/account/team: existe hoje
    // quem tem papel 'firm' e nível 'manager' de propósito. Sincronizar em
    // toda gravação faria uma edição de telefone promover essa pessoa a sócia
    // — e ela passaria a ver o faturamento consolidado, calada.
    const { data: registro } = await db.from('staff_roles')
      .select('level').eq('user_id', params.id).maybeSingle()

    const papelMudou = papel !== String(metaAtual.role || '')
    let nivel = (registro?.level as string) || nivelDoPapel(papel)

    if (papelMudou || !registro) {
      nivel = nivelDoPapel(papel)
      const { error: errNivel } = await db.from('staff_roles').upsert({
        user_id:      params.id,
        level:        nivel,
        display_name: (updates.user_metadata.full_name as string) || null,
        updated_at:   new Date().toISOString(),
      }, { onConflict: 'user_id' })
      if (errNivel) {
        return NextResponse.json({
          error: `Login atualizado, mas o nível de permissão não gravou: ${errNivel.message}`,
        }, { status: 500 })
      }
    }

    return NextResponse.json({ user: data.user, nivel })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  const guarda = await exigeSocio(params.id)
  if (guarda.erro) return guarda.erro

  try {
    // Banir preserva o histórico; apagar o login órfãozaria tudo que ele assinou.
    const { error } = await serviceDb().auth.admin.updateUserById(params.id, { ban_duration: '87600h' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
