// /api/firm/users/[id] — uma pessoa da equipe COM LOGIN ([id] = o login)
//
//  PATCH { acao: 'editar', name?, title?, phone?, password? }
//  PATCH { acao: 'nivel', nivel, motivo, senha }    → muda o nível
//  PATCH { acao: 'zerarPin', motivo? }               → apaga o PIN de aprovação
//  PATCH { acao: 'reativar' }                        → desbloqueia e volta à equipe
//  DELETE                                            → bloqueia e tira da equipe
//
// Só o sócio, e ninguém mexe no próprio acesso. A pessoa SEM login (só
// responsável no CRM) se edita em /api/team.
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
// Terceiro, e foi ele que levou à unificação (lib/equipe.ts): EDITAR
// REESCREVIA O NÍVEL. A rota comparava o papel com `user_metadata.role` para
// saber se ele tinha mudado — e a migração do papel tirou o papel de lá. O
// "mudou" dava sempre verdadeiro, e trocar o telefone de quem tem papel de
// sócio e nível de gerente promovia a pessoa a sócia; quem foi promovido em
// Minha Conta voltava a assistente. Agora editar NÃO toca no nível. O nível
// muda por um ato próprio (`acao: 'nivel'`), com a senha do sócio e o
// motivo, gravado na trilha ANTES da mudança.

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { ehDaFirma } from '@/lib/papeis'
import { decidirMudancaDeNivel, papelDoNivel, nivelValido, ROTULO_DO_NIVEL, type StaffLevel } from '@/lib/equipe'
import { membroDoLogin, gravarNaTrilha, vincularNaEquipe, AVISO_MIGRACAO } from '@/lib/equipe-servidor'

/** Só sócio/administrador gerencia a equipe — e nunca a si mesmo. */
async function exigeSocio(alvo: string) {
  const auth = await getAuth()
  if (!auth?.isStaff) {
    return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  }
  const nivel = await getStaffLevel(auth.userId)
  if (nivel !== 'owner') {
    return { erro: NextResponse.json({
      error: 'Somente sócio ou administrador pode gerenciar a equipe.',
    }, { status: 403 }) }
  }
  if (auth.userId === alvo) {
    return { erro: NextResponse.json({
      error: 'Você não altera o próprio acesso. Peça a outro sócio.',
    }, { status: 403 }) }
  }
  return { auth, nivel }
}

/** O login da pessoa — e ele tem de ser da FIRMA: esta rota não mexe em cliente. */
async function loginDaEquipe(id: string) {
  const { data, error } = await serviceDb().auth.admin.getUserById(id)
  if (error || !data?.user) {
    return { erro: NextResponse.json({ error: 'Usuário não encontrado' }, { status: 404 }) }
  }
  if (!ehDaFirma(data.user.app_metadata?.role)) {
    return { erro: NextResponse.json({ error: 'Este login não é da equipe.' }, { status: 400 }) }
  }
  return { user: data.user }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guarda = await exigeSocio(params.id)
  if (guarda.erro) return guarda.erro

  let corpo: any
  try { corpo = await req.json() } catch { corpo = {} }
  // A tela antiga mandava { reactivate: true }; o resto sem `acao` é edição.
  const acao = corpo?.acao || (corpo?.reactivate ? 'reativar' : 'editar')

  try {
    if (acao === 'reativar') return await reativar(params.id, guarda.auth!.userId)
    if (acao === 'nivel')    return await mudarNivel(params.id, guarda.auth!.userId, guarda.nivel!, corpo)
    if (acao === 'zerarPin') return await zerarPin(params.id, guarda.auth!.userId, corpo)
    if (acao === 'editar')   return await editar(params.id, guarda.auth!.userId, corpo)
    return NextResponse.json({ error: 'Ação desconhecida.' }, { status: 400 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// ── Editar: nome, cargo, telefone (e senha, se o sócio quiser) ──
// NÃO toca no nível — essa é a correção que motivou a unificação.
async function editar(id: string, porQuem: string, corpo: any) {
  const { name, title, phone, password } = corpo || {}
  const alvo = await loginDaEquipe(id)
  if (alvo.erro) return alvo.erro

  const db = serviceDb()
  const metaAtual = (alvo.user.user_metadata || {}) as Record<string, unknown>
  const nome = name !== undefined ? String(name).trim() : undefined
  if (nome !== undefined && nome.length < 2) {
    return NextResponse.json({ error: 'Nome muito curto.' }, { status: 400 })
  }

  const updates: any = {
    user_metadata: {
      ...metaAtual,
      // O papel mora em app_metadata (lib/papeis.ts); aqui ele nem entra.
      role:      undefined,
      full_name: nome  !== undefined ? nome  : metaAtual.full_name,
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

  const { data, error } = await db.auth.admin.updateUserById(id, updates)
  if (error) throw error

  // O nome também é o da equipe — é o que aparece como responsável no CRM.
  const { membro, erro: errMembro } = await membroDoLogin(id, db)
  let renomeados = 0
  let aviso: string | null = errMembro
  if (membro && nome && nome !== membro.name) {
    const { error: errNome } = await db.from('team_members')
      .update({ name: nome, updated_at: new Date().toISOString() }).eq('id', membro.id)
    if (errNome) {
      aviso = /duplicate|unique/i.test(errNome.message)
        ? 'O login foi atualizado, mas já existe alguém com esse nome na equipe — o nome do CRM ficou o antigo.'
        : `O login foi atualizado, mas o nome da equipe não: ${errNome.message}`
    } else {
      // Os clientes apontam para o responsável pelo NOME.
      const { data: mudou } = await db.from('clients')
        .update({ assignee: nome }).eq('assignee', membro.name).select('id')
      renomeados = (mudou || []).length
      await gravarNaTrilha({
        memberId: String(membro.id), userId: id, acao: 'editado', porQuem,
        antes: { name: membro.name }, depois: { name: nome, clientesRenomeados: renomeados },
      }, db)
    }
  }

  return NextResponse.json({ user: data.user, renomeados, aviso })
}

// ── Mudar o nível: senha do sócio, motivo, trilha ANTES ──
async function mudarNivel(id: string, porQuem: string, nivelDeQuem: StaffLevel, corpo: any) {
  const alvo = await loginDaEquipe(id)
  if (alvo.erro) return alvo.erro

  const db = serviceDb()
  const { membro, erro } = await membroDoLogin(id, db)
  if (erro) return NextResponse.json({ error: erro }, { status: erro === AVISO_MIGRACAO ? 409 : 500 })

  const nivelAtual = membro ? (nivelValido(membro.level) ?? 'junior') : await getStaffLevel(id)
  const d = decidirMudancaDeNivel({
    quemChama: { userId: porQuem, nivel: nivelDeQuem },
    alvo: { userId: id, nivel: nivelAtual, semCadastro: !membro },
    novo: corpo?.nivel,
    motivo: corpo?.motivo,
  })
  if (d.ok === false) return NextResponse.json({ error: d.erro }, { status: d.status })

  // A senha do PRÓPRIO sócio, conferida no servidor (princípio 3): o nível é
  // a raiz da matriz inteira — quem recebe, quem estorna, quem vê os totais.
  const senha = String(corpo?.senha || '')
  if (!senha) return NextResponse.json({ error: 'Digite a sua senha para confirmar.' }, { status: 400 })
  const { data: eu } = await db.auth.admin.getUserById(porQuem)
  if (!eu?.user?.email) return NextResponse.json({ error: 'Seu login não foi encontrado.' }, { status: 403 })
  const conferir = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)
  const { error: errSenha } = await conferir.auth.signInWithPassword({ email: eu.user.email, password: senha })
  if (errSenha) return NextResponse.json({ error: 'Senha incorreta.' }, { status: 403 })

  const papelAtual = String(alvo.user.app_metadata?.role || '')
  const papelNovo = papelDoNivel(d.nivel, papelAtual)

  // A trilha vem ANTES: se ela falhar, a mudança não acontece. Poder que
  // muda sem rastro é pior que mudança não feita (princípio 2).
  const errTrilha = await gravarNaTrilha({
    memberId: membro ? String(membro.id) : null, userId: id, acao: 'nivel', porQuem,
    motivo: d.motivo,
    antes:  { level: nivelAtual, papel: papelAtual, pin: !!membro?.approval_pin_hash },
    depois: { level: d.nivel, papel: papelNovo, pin: d.zerarPin ? false : !!membro?.approval_pin_hash },
  }, db)
  if (errTrilha) {
    return NextResponse.json({ error: `A trilha não gravou — o nível NÃO mudou. ${errTrilha}` }, { status: 500 })
  }

  if (membro) {
    const upd: Record<string, unknown> = { level: d.nivel, updated_at: new Date().toISOString() }
    if (d.zerarPin) upd.approval_pin_hash = null
    const { error: errNivel } = await db.from('team_members').update(upd).eq('id', membro.id)
    if (errNivel) return NextResponse.json({ error: `O nível não gravou: ${errNivel.message}` }, { status: 500 })
  } else {
    // Login da firma sem linha na equipe: a linha nasce agora, com o nível novo.
    const v = await vincularNaEquipe({
      userId: id, email: String(alvo.user.email || ''),
      nome: String(alvo.user.user_metadata?.full_name || ''), nivel: d.nivel,
    }, db)
    if (!v.ok) return NextResponse.json({ error: `O nível não gravou: ${v.erro}` }, { status: 500 })
  }

  // O papel da porta acompanha o nível: é a reserva de getStaffLevel, e os
  // dois discordando é o que fazia um gerente virar sócio num tropeço.
  let aviso: string | null = null
  if (papelNovo !== papelAtual) {
    const { error: errPapel } = await db.auth.admin.updateUserById(id, {
      app_metadata: { ...(alvo.user.app_metadata || {}), role: papelNovo },
    })
    if (errPapel) aviso = `O nível mudou, mas o papel do login não acompanhou: ${errPapel.message}`
  }

  return NextResponse.json({
    ok: true, nivel: d.nivel, aviso,
    mensagem: `${ROTULO_DO_NIVEL[nivelAtual]} → ${ROTULO_DO_NIVEL[d.nivel]}${d.zerarPin && membro?.approval_pin_hash ? ' · o PIN de aprovação foi apagado (assistente não aprova)' : ''}.`,
  })
}

// ── Zerar o PIN de aprovação ──
async function zerarPin(id: string, porQuem: string, corpo: any) {
  const db = serviceDb()
  const { membro, erro } = await membroDoLogin(id, db)
  if (erro) return NextResponse.json({ error: erro }, { status: erro === AVISO_MIGRACAO ? 409 : 500 })
  if (!membro?.approval_pin_hash) return NextResponse.json({ error: 'Esta pessoa não tem PIN.' }, { status: 400 })

  const errTrilha = await gravarNaTrilha({
    memberId: String(membro.id), userId: id, acao: 'pin_zerado', porQuem,
    motivo: String(corpo?.motivo || '').trim() || null,
  }, db)
  if (errTrilha) return NextResponse.json({ error: `A trilha não gravou — o PIN continua. ${errTrilha}` }, { status: 500 })

  const { error } = await db.from('team_members')
    .update({ approval_pin_hash: null, updated_at: new Date().toISOString() }).eq('id', membro.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── Reativar: desbloqueia o login e volta ao seletor do CRM ──
async function reativar(id: string, porQuem: string) {
  const alvo = await loginDaEquipe(id)
  if (alvo.erro) return alvo.erro
  const db = serviceDb()
  const { data, error } = await db.auth.admin.updateUserById(id, { ban_duration: 'none' })
  if (error) throw error

  const { membro, erro } = await membroDoLogin(id, db)
  let aviso: string | null = erro
  if (membro) {
    const { error: errAtivo } = await db.from('team_members')
      .update({ active: true, updated_at: new Date().toISOString() }).eq('id', membro.id)
    // Login livre e linha inativa: getStaffLevel trata como assistente — o
    // lado seguro. A tela mostra o aviso para tentar de novo.
    if (errAtivo) aviso = `O login voltou, mas a linha da equipe não: ${errAtivo.message}`
    else await gravarNaTrilha({ memberId: String(membro.id), userId: id, acao: 'reativado', porQuem }, db)
  }
  return NextResponse.json({ user: data.user, aviso })
}

// ── Desativar: bloqueia o login e tira do seletor do CRM ──
export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  const guarda = await exigeSocio(params.id)
  if (guarda.erro) return guarda.erro

  try {
    const alvo = await loginDaEquipe(params.id)
    if (alvo.erro) return alvo.erro
    // Banir preserva o histórico; apagar o login órfãozaria tudo que ele assinou.
    const db = serviceDb()
    const { error } = await db.auth.admin.updateUserById(params.id, { ban_duration: '87600h' })
    if (error) throw error

    // A linha fica (o nome continua nos clientes que a pessoa atendeu), mas
    // sai do seletor — e com ela o PIN: inativo não aprova (validateManagerPin).
    const { membro, erro } = await membroDoLogin(params.id, db)
    let aviso: string | null = erro
    if (membro) {
      const { error: errAtivo } = await db.from('team_members')
        .update({ active: false, updated_at: new Date().toISOString() }).eq('id', membro.id)
      if (errAtivo) aviso = `O login foi bloqueado, mas a linha da equipe continua ativa: ${errAtivo.message}`
      else await gravarNaTrilha({
        memberId: String(membro.id), userId: params.id, acao: 'desativado', porQuem: guarda.auth!.userId,
      }, db)
    }
    return NextResponse.json({ success: true, aviso })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
