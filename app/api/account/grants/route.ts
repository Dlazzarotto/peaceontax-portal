// /api/account/grants — autorizações individuais da equipe
//
// GET  ?userId=…  → nível, autorizações gravadas, conjunto final e conflitos
// POST            → autoriza ou retira UMA chave, com motivo obrigatório
//
// Só sócio. Ninguém mexe no próprio acesso, e sócio não recebe concessão
// negativa: tirar poder de sócio se faz mudando o NÍVEL, à vista, em
// Settings → Team — não por uma chave solta que passa despercebida.
//
// A tabela é append-only: cada decisão grava uma linha com quem autorizou,
// o motivo e o conflito de separação de funções, se houve. O estado atual
// é a view staff_grants_atual. Estado e histórico não podem discordar
// porque são a mesma coisa.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb } from '@/lib/api-auth'
import { getStaffLevel, concessoesDe } from '@/lib/staff-perms'
import {
  PERMISSOES, CHAVES, permissoesDe, conflitoDeSeparacao, conflitosDoConjunto,
  type ChavePermissao,
} from '@/lib/permissoes'

async function exigeSocio(alvo?: string) {
  const auth = await getAuth()
  if (!auth?.isStaff) {
    return { erro: NextResponse.json({ error: 'Acesso restrito' }, { status: 403 }) }
  }
  if ((await getStaffLevel(auth.userId)) !== 'owner') {
    return { erro: NextResponse.json({
      error: 'Somente o sócio autoriza permissões da equipe.',
    }, { status: 403 }) }
  }
  if (alvo && alvo === auth.userId) {
    return { erro: NextResponse.json({
      error: 'Você não altera as próprias permissões.',
    }, { status: 403 }) }
  }
  return { auth }
}

export async function GET(req: NextRequest) {
  const alvo = req.nextUrl.searchParams.get('userId') || ''
  const guarda = await exigeSocio()
  if (guarda.erro) return guarda.erro
  if (!alvo) return NextResponse.json({ error: 'userId obrigatório' }, { status: 400 })

  const nivel = await getStaffLevel(alvo)
  const concessoes = nivel === 'owner' ? {} : await concessoesDe(alvo)
  const conjunto = permissoesDe(nivel, concessoes)

  return NextResponse.json({
    nivel,
    // O sócio tem tudo e é imune: a tela mostra isso em vez de oferecer
    // botões que não fariam nada.
    imune: nivel === 'owner',
    permissoes: PERMISSOES,
    concessoes,
    conjunto,
    conflitos: conflitosDoConjunto(conjunto),
  })
}

export async function POST(req: NextRequest) {
  let corpo: any
  try { corpo = await req.json() } catch { corpo = {} }
  const { targetUserId, chave, conceder, motivo } = corpo || {}

  const guarda = await exigeSocio(String(targetUserId || ''))
  if (guarda.erro) return guarda.erro

  if (!targetUserId) return NextResponse.json({ error: 'targetUserId obrigatório' }, { status: 400 })
  if (!(CHAVES as string[]).includes(String(chave)))
    return NextResponse.json({ error: 'Permissão desconhecida.' }, { status: 400 })
  if (typeof conceder !== 'boolean')
    return NextResponse.json({ error: 'Informe se está autorizando ou retirando.' }, { status: 400 })

  const razao = String(motivo || '').trim()
  if (razao.length < 3)
    return NextResponse.json({
      error: 'Escreva o motivo — ele fica na trilha e é o que explica a autorização depois.',
    }, { status: 400 })

  const nivel = await getStaffLevel(String(targetUserId))
  if (nivel === 'owner')
    return NextResponse.json({
      error: 'Sócio tem acesso completo. Para mudar, altere o nível em Settings → Team.',
    }, { status: 400 })

  // O conjunto COMO FICARÁ — é sobre ele que se calcula o conflito.
  const atuais = await concessoesDe(String(targetUserId))
  const conjunto = permissoesDe(nivel, { ...atuais, [chave as ChavePermissao]: conceder })
  const conflito = conflitoDeSeparacao(chave as ChavePermissao, conceder, conjunto)

  const { error } = await serviceDb().from('staff_grants').insert({
    user_id:       String(targetUserId),
    chave:         String(chave),
    concedido:     conceder,
    concedido_por: guarda.auth!.userId,
    motivo:        razao,
    conflito,
  })
  if (error) {
    // A migração pode não ter rodado ainda — dizer isso é mais útil que
    // repassar "relation does not exist".
    const faltaTabela = /staff_grants/.test(error.message) && /exist/i.test(error.message)
    return NextResponse.json({
      error: faltaTabela
        ? 'A tabela de autorizações ainda não existe — rode sql/permissoes-por-pessoa-v1.sql.'
        : error.message,
    }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    conjunto,
    conflito,
    conflitos: conflitosDoConjunto(conjunto),
  })
}
