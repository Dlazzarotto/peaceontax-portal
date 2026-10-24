// /api/firm/users — a EQUIPE num lugar só (lib/equipe.ts)
//
//  GET   → a lista única: quem tem login, quem só existe no CRM como
//          responsável e quem tem convite pendente. Sócio e gerente veem
//          (o gerente via isto em Minha Conta); só o sócio age.
//  POST  { email, name, nivel, title?, phone? } → convida (só o sócio)
//
// CORREÇÃO DE SEGURANÇA: antes qualquer login da equipe (inclusive
// assistente) podia listar todos os usuários e convidar alguém como
// Admin. Agora só sócio/administrador convida.
//
// Três defeitos que saíram com a unificação:
//  - `listUsers()` sem página devolvia os 50 primeiros logins. Com centenas
//    de clientes no portal, gente da equipe sumia da tela.
//  - "Reenviar" criava um convite novo sem matar o anterior: um link velho,
//    com outro nível, continuava abrindo a conta por sete dias.
//  - Convidar quem já tinha login regravava o nível pelo convite. Convite é
//    para quem ainda não tem login (decidirConvite).

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { ehDaFirma } from '@/lib/papeis'
import { decidirConvite, montarListaDaEquipe, ROTULO_DO_NIVEL } from '@/lib/equipe'
import { todosOsLogins, lerMembros, AVISO_MIGRACAO } from '@/lib/equipe-servidor'
import { buscaLiteral } from '@/lib/clientes-grupos'
import { escaparHtml } from '@/lib/relatorio-barra'

const PORTAL_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax-portal.vercel.app'
const FIRM_NAME  = 'Peace on Tax'

/** Só sócio/administrador gerencia a equipe. Ver a lista: sócio e gerente. */
async function exigeNivel(quem: 'socio' | 'gerente') {
  const auth = await getAuth()
  if (!auth?.isStaff) {
    return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  }
  const nivel = await getStaffLevel(auth.userId)
  const pode = nivel === 'owner' || (quem === 'gerente' && nivel === 'manager')
  if (!pode) {
    return { erro: NextResponse.json({
      error: quem === 'socio'
        ? 'Somente sócio ou administrador pode gerenciar a equipe.'
        : 'A lista da equipe é do sócio e do gerente.',
    }, { status: 403 }) }
  }
  return { auth, nivel }
}

function buildInviteEmail(nomeCru: string, emailCru: string, setupUrl: string, nivel: keyof typeof ROTULO_DO_NIVEL) {
  const roleLabel = { owner: 'Partner', manager: 'Manager', junior: 'Staff' }[nivel] || 'Staff'
  // O nome e o e-mail vêm do formulário: escapados, como todo impresso.
  const name = escaparHtml(nomeCru)
  const email = escaparHtml(emailCru)
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f0f4fa;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4fa;padding:40px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#2D3278,#1a1f5e);border-radius:16px 16px 0 0;padding:28px;text-align:center;">
    <div style="font-size:28px;margin-bottom:8px;">📒</div>
    <h1 style="color:#fff;font-size:20px;margin:0;font-family:Georgia,serif;">${FIRM_NAME}</h1>
    <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:4px 0 0;">Team Portal Access</p>
  </td></tr>
  <tr><td style="background:#fff;padding:32px 36px;">
    <h2 style="color:#2D3278;font-size:20px;margin:0 0 12px;font-family:Georgia,serif;">Welcome to the team, ${name}!</h2>
    <p style="color:#3a4a5a;font-size:15px;line-height:1.7;margin:0 0 16px;">
      You have been added to the <strong>${FIRM_NAME}</strong> portal as <strong>${roleLabel}</strong>.
    </p>
    <p style="color:#3a4a5a;font-size:14px;line-height:1.6;margin:0 0 24px;">
      Click the button below to create your password and access the portal. This link expires in <strong>7 days</strong>.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${setupUrl}" style="background:linear-gradient(135deg,#2D3278,#1a1f5e);color:#fff;padding:14px 36px;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;display:inline-block;">Create My Password →</a>
    </div>
    <div style="background:#f8faff;border-radius:10px;padding:14px 16px;font-size:13px;color:#6a7a9a;">
      <strong style="color:#0f2340;">Your login email:</strong> ${email}
    </div>
  </td></tr>
  <tr><td style="background:#f0f4fa;border-radius:0 0 16px 16px;padding:16px;text-align:center;">
    <p style="color:#9aaab0;font-size:11px;margin:0;">🔒 Secure &amp; encrypted · ${FIRM_NAME} · Massachusetts</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`
}

export async function GET() {
  const guarda = await exigeNivel('gerente')
  if (guarda.erro) return guarda.erro

  const db = serviceDb()
  const [equipe, logins, convites] = await Promise.all([
    lerMembros(db),
    todosOsLogins(db),
    db.from('staff_invitations')
      .select('id, email, name, role, title, phone, status, expires_at')
      .eq('status', 'pending'),
  ])
  // Lista cortada é uma afirmação falsa ("não há mais ninguém"): falha à vista.
  if (logins.erro) return NextResponse.json({ error: `Não foi possível ler os logins: ${logins.erro}` }, { status: 500 })
  if (convites.error) return NextResponse.json({ error: `Não foi possível ler os convites: ${convites.error.message}` }, { status: 500 })
  if (equipe.erro && !equipe.semMigracao) return NextResponse.json({ error: equipe.erro }, { status: 500 })

  const pessoas = montarListaDaEquipe({
    membros: equipe.membros,
    logins: logins.logins,
    convites: (convites.data || []) as any[],
    ehDaFirma,
    agora: new Date(),
  })

  // Antes da migração não há linha da equipe: o nível de cada login ainda
  // mora em staff_roles, e getStaffLevel sabe ler de lá. A tela mostra o
  // aviso e não oferece ação — a gravação recusaria.
  if (equipe.semMigracao) {
    for (const p of pessoas) if (p.userId) p.nivel = await getStaffLevel(p.userId)
  }

  return NextResponse.json({
    pessoas,
    eu: guarda.auth!.userId,
    podeGerenciar: guarda.nivel === 'owner',
    semMigracao: equipe.semMigracao,
    aviso: equipe.semMigracao ? AVISO_MIGRACAO : null,
  })
}

export async function POST(req: NextRequest) {
  const guarda = await exigeNivel('socio')
  if (guarda.erro) return guarda.erro

  try {
    const { email, name, nivel, title, phone } = await req.json()
    const nome = String(name || '').trim()
    if (nome.length < 2) return NextResponse.json({ error: 'Informe o nome de quem entra na equipe.' }, { status: 400 })

    const db = serviceDb()
    const { logins, erro } = await todosOsLogins(db)
    if (erro) return NextResponse.json({ error: `Não foi possível conferir os logins: ${erro}` }, { status: 500 })

    const d = decidirConvite({ email, nivel, logins, ehDaFirma })
    if (d.ok === false) return NextResponse.json({ error: d.erro }, { status: d.status })

    // O convite novo é o que vale: os pendentes do mesmo e-mail deixam de
    // abrir a conta (vencem agora, e a tela os tira da lista).
    const { error: errVelhos } = await db.from('staff_invitations')
      .update({ expires_at: new Date().toISOString() })
      .ilike('email', buscaLiteral(d.email))
      .eq('status', 'pending')
    if (errVelhos) return NextResponse.json({ error: `Não foi possível encerrar o convite anterior: ${errVelhos.message}` }, { status: 500 })

    const token = randomBytes(32).toString('hex')
    const setupUrl = `${PORTAL_URL}/staff-setup/${token}`

    const { error: invErr } = await db.from('staff_invitations').insert({
      email: d.email, name: nome, role: d.papel, title: title||'', phone: phone||'',
      token,
      status:     'pending',
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    })
    if (invErr) throw invErr

    const resendKey = process.env.RESEND_API_KEY
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'noreply@peaceontax.com'
    let emailSent   = false
    let motivoEmail: string | null = resendKey ? null : 'RESEND_API_KEY não configurada no Vercel'

    if (resendKey) {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:     `${FIRM_NAME} <${fromEmail}>`,
            to:       [d.email],
            subject:  `You have been invited to ${FIRM_NAME} Portal`,
            html:     buildInviteEmail(nome, d.email, setupUrl, d.nivel),
            reply_to: 'info@peaceontax.com',
          }),
        })
        if (emailRes.ok) emailSent = true
        else {
          const r = await emailRes.json().catch(() => ({}))
          motivoEmail = `o Resend recusou: ${r?.message || emailRes.status}`
          console.error('Resend:', r)
        }
      } catch (e) {
        motivoEmail = `falha ao chamar o Resend: ${(e as Error).message}`
        console.error('Email failed:', e)
      }
    }

    return NextResponse.json({ success: true, setupUrl, emailSent, motivoEmail })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
