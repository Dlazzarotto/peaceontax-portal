// /api/billing/diag-envio?numero=INV-2026-0007
//
// "O cliente diz que não recebeu e não vê nada no portal." Esta rota responde
// POR QUÊ, em vez de alguém adivinhar. SOMENTE LEITURA: não envia nada, não
// muda nada.
//
// Equipe, e só de cliente que a pessoa alcança (canAccessClient).
//
// Existe porque o caso já foi diagnosticado errado três vezes. As causas são
// parecidas por fora e completamente diferentes por dentro:
//
//   1. a fatura nunca saiu do rascunho          → falta clicar Enviar
//   2. o cadastro não tem e-mail                → a equipe põe na ficha
//   3. o Resend não está configurado/verificado → o sócio, no Vercel/Resend
//   4. a fatura está num cadastro e o LOGIN do cliente está em OUTRO
//      (duplicata da importação) → o portal dele fica vazio para sempre,
//      porque o portal procura pelo user_id, não pelo nome
//
// A 4 é a que ninguém adivinha: não há erro em lugar nenhum, os dois
// cadastros existem e cada um está certo sozinho.

import { NextRequest, NextResponse } from 'next/server'
import { getAuth, serviceDb, canAccessClient } from '@/lib/api-auth'
import { chaveDoNome } from '@/lib/import-clientes'
import { porqueNaoTenta, remetenteDoEmail } from '@/lib/email-motivo'

export const dynamic = 'force-dynamic'

type Passo = { passo: string; ok: boolean; detalhe: string; acao?: string }

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })

  const numero = (req.nextUrl.searchParams.get('numero') || '').trim()
  if (!numero) {
    return NextResponse.json({
      error: 'Diga o número da fatura: /api/billing/diag-envio?numero=INV-2026-0007',
    }, { status: 400 })
  }

  const db = serviceDb()

  const { data: inv, error: errInv } = await db.from('invoices')
    .select('id, number, status, total, paid_total, issue_date, client_id, created_at')
    .eq('number', numero).maybeSingle()
  if (errInv) return NextResponse.json({ error: `Fatura: ${errInv.message}` }, { status: 500 })
  if (!inv) return NextResponse.json({ error: `Não existe fatura com o número ${numero}.` }, { status: 404 })

  if (!(await canAccessClient(auth, inv.client_id))) {
    return NextResponse.json({ error: 'Sem acesso ao cliente desta fatura' }, { status: 403 })
  }

  const [
    { data: cli, error: errCli },
    { data: trilha, error: errTrilha },
  ] = await Promise.all([
    db.from('clients').select('id, name, business_name, email, user_id, active, type')
      .eq('id', inv.client_id).maybeSingle(),
    db.from('invoice_audit').select('action, created_at, next')
      .eq('invoice_id', inv.id).in('action', ['sent', 'resent', 'reminded'])
      .order('created_at', { ascending: false }).limit(5),
  ])
  if (errCli)    return NextResponse.json({ error: `Cliente: ${errCli.message}` }, { status: 500 })
  if (errTrilha) return NextResponse.json({ error: `Trilha: ${errTrilha.message}` }, { status: 500 })
  if (!cli)      return NextResponse.json({ error: 'A fatura aponta para um cliente que não existe.' }, { status: 500 })

  // Cadastros que podem ser a MESMA pessoa: mesmo e-mail, ou mesmo nome pela
  // chave que a importação usa (ignora maiúscula, acento e pontuação).
  const { data: todos, error: errTodos } = await db.from('clients')
    .select('id, name, business_name, email, user_id, active')
    .neq('id', cli.id).limit(2000)
  if (errTodos) return NextResponse.json({ error: `Cadastros: ${errTodos.message}` }, { status: 500 })

  const chave = chaveDoNome(cli.business_name || cli.name || '')
  const email = String(cli.email || '').trim().toLowerCase()
  const irmaos = (todos || []).filter((c: any) =>
    (email && String(c.email || '').trim().toLowerCase() === email) ||
    (chave && chaveDoNome(c.business_name || c.name || '') === chave))

  const { count: avisos, error: errAvisos } = await db.from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', cli.id).eq('channel', 'portal')
  if (errAvisos) return NextResponse.json({ error: `Avisos do portal: ${errAvisos.message}` }, { status: 500 })

  const ultimoEnvio: any = (trilha || [])[0] || null
  const VISIVEL = ['sent', 'partial', 'overdue', 'paid']
  const nome = cli.business_name || cli.name || '—'

  const passos: Passo[] = [
    {
      passo: '1. A fatura saiu do rascunho?',
      ok: inv.status !== 'draft',
      detalhe: `${inv.number} está como "${inv.status}"`,
      acao: inv.status === 'draft'
        ? 'É ISTO: rascunho nunca aparece ao cliente e não dispara e-mail. Abra Financeiro e clique Enviar nesta fatura.'
        : undefined,
    },
    {
      passo: '2. A fatura apareceria no portal?',
      ok: VISIVEL.includes(inv.status),
      detalhe: VISIVEL.includes(inv.status)
        ? 'o status é um dos que o portal mostra'
        : `o portal só mostra ${VISIVEL.join(', ')}`,
    },
    {
      passo: '3. O cadastro da fatura tem LOGIN ligado?',
      ok: !!cli.user_id,
      detalhe: cli.user_id ? `${nome} tem login` : `${nome} NÃO tem login ligado (user_id vazio)`,
      acao: cli.user_id ? undefined
        : 'Sem login ligado, nenhum portal mostra esta fatura — não há para quem mostrar. Convide o cliente pela ficha, ou gere a senha provisória.',
    },
    {
      passo: '4. O cadastro tem e-mail?',
      ok: !!(cli.email && cli.email.includes('@')),
      detalhe: cli.email ? cli.email : 'sem e-mail no cadastro',
      acao: cli.email && cli.email.includes('@') ? undefined
        : 'Sem e-mail no cadastro, o aviso sai só no portal. Ponha o e-mail na ficha e use Reenviar.',
    },
    {
      passo: '5. Existe OUTRO cadastro que pode ser a mesma pessoa?',
      ok: irmaos.length === 0,
      detalhe: irmaos.length === 0
        ? 'nenhum'
        : irmaos.map((c: any) =>
            `${c.business_name || c.name}${c.email ? ` <${c.email}>` : ' (sem e-mail)'}` +
            `${c.user_id ? ' — COM login' : ' — sem login'}`).join(' · '),
      acao: irmaos.length === 0 ? undefined
        : irmaos.some((c: any) => c.user_id) && !cli.user_id
          ? 'PROVAVELMENTE É ISTO: a fatura está num cadastro SEM login, e o cliente entra por OUTRO cadastro que tem login. O portal procura pelo user_id, então ele nunca vai ver esta fatura. Decida qual cadastro fica e emita por ele.'
          : 'Há cadastro parecido. Confira se a fatura foi emitida para o cadastro certo.',
    },
    {
      passo: '6. O envio ficou registrado na trilha?',
      ok: !!ultimoEnvio,
      detalhe: ultimoEnvio
        ? `${ultimoEnvio.action} em ${new Date(ultimoEnvio.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
        : 'nenhum envio registrado — ninguém clicou Enviar nesta fatura',
    },
    {
      passo: '7. O que o e-mail respondeu no último envio?',
      ok: ultimoEnvio?.next?.email === true,
      detalhe: !ultimoEnvio ? 'não houve envio'
        : ultimoEnvio.next?.email === true ? 'o e-mail saiu'
        : ultimoEnvio.next?.emailMotivo || ultimoEnvio.next?.motivo
          || 'o envio é anterior a esta versão, que passou a gravar o motivo',
    },
    {
      passo: '8. O aviso no portal foi gravado?',
      ok: (avisos ?? 0) > 0,
      detalhe: `${avisos ?? 0} aviso(s) no portal deste cadastro`,
      acao: (avisos ?? 0) === 0
        ? 'Nenhum aviso gravado. Se a fatura foi enviada, a gravação falhou — veja os passos acima.'
        : undefined,
    },
    {
      passo: '9. O envio de e-mail está configurado?',
      ok: !porqueNaoTenta(!!process.env.RESEND_API_KEY, 'teste@exemplo.com'),
      detalhe: `remetente ${remetenteDoEmail()}`,
      acao: process.env.RESEND_API_KEY ? undefined
        : 'Falta RESEND_API_KEY no Vercel. Nenhum e-mail sai para ninguém — veja /api/avisos/diag.',
    },
  ]

  const problemas = passos.filter(p => !p.ok && p.acao)
  return NextResponse.json({
    fatura: { numero: inv.number, status: inv.status, total: inv.total, emitida: inv.issue_date },
    cliente: { id: cli.id, nome, email: cli.email || null, temLogin: !!cli.user_id },
    passos,
    // A primeira ação é a que resolve; as outras costumam ser consequência.
    facaIsto: problemas.length ? problemas[0].acao : 'Nada aqui explica o caso — me mande esta resposta inteira.',
    aindaAssim: 'Se o e-mail é o único problema, /api/avisos/diag?teste=SEU_EMAIL devolve a resposta literal do Resend.',
  })
}
