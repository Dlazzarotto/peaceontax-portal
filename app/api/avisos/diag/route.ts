// /api/avisos/diag — por que o cliente não recebeu o e-mail?
//
// GET  — SOMENTE LEITURA. Diz se o envio está configurado e o que falta.
// GET ?teste=alguem@dominio.com — manda UM e-mail de teste e devolve a
//      resposta literal do Resend. É o único jeito de ver "domínio não
//      verificado" ou "remetente não autorizado", que é o que costuma
//      derrubar o envio sem ninguém saber.
//
// Só o sócio: a resposta mostra o remetente e o texto da recusa.
// Nenhum segredo sai daqui — a chave vai mascarada.
//
// Existe pelo mesmo motivo de /api/signatures/diag: a entrega dizia "e-mail
// não enviado" e parava aí. Quem lê precisa saber se o conserto é no Vercel
// (variável), na ficha do cliente (cadastro sem e-mail) ou no painel do
// Resend (domínio).

import { NextRequest, NextResponse } from 'next/server'
import { getAuth } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import { enviarEmail, emailComMarca, remetenteDoEmail, porqueNaoTenta, APP_URL } from '@/lib/avisos'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const mascarar = (v?: string) =>
  !v ? '(ausente)' : v.length <= 10 ? '***' : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} car.)`

export async function GET(req: NextRequest) {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  if ((await getStaffLevel(auth.userId)) !== 'owner') {
    return NextResponse.json({ error: 'Somente o sócio' }, { status: 403 })
  }

  const chave = process.env.RESEND_API_KEY
  const from = remetenteDoEmail()
  const dominio = from.split('@')[1] || '(sem domínio)'

  const passos = [
    {
      passo: 'RESEND_API_KEY no servidor',
      ok: !!chave,
      detalhe: mascarar(chave),
      acao: chave ? undefined
        : 'Sem ela nenhum e-mail sai, e o sistema nem tenta. Vercel → Settings → Environment Variables.',
    },
    {
      passo: 'Remetente (RESEND_FROM_EMAIL)',
      ok: !!process.env.RESEND_FROM_EMAIL,
      detalhe: `${from}${process.env.RESEND_FROM_EMAIL ? '' : ' (padrão do código, não configurado)'}`,
      acao: process.env.RESEND_FROM_EMAIL ? undefined
        : `O código cai em ${from}. Se o domínio ${dominio} não estiver verificado no Resend, TODO envio é recusado.`,
    },
    {
      passo: 'Endereço do portal nos botões (NEXT_PUBLIC_APP_URL)',
      ok: !!process.env.NEXT_PUBLIC_APP_URL,
      detalhe: APP_URL,
      acao: process.env.NEXT_PUBLIC_APP_URL ? undefined
        : 'Sem ela o botão "Ver e pagar a fatura" aponta para o endereço padrão do código.',
    },
  ]

  const teste = (req.nextUrl.searchParams.get('teste') || '').trim()
  let envioDeTeste: unknown = null
  if (teste) {
    const impede = porqueNaoTenta(!!chave, teste)
    envioDeTeste = impede
      ? { tentou: false, motivo: impede }
      : {
          tentou: true,
          para: teste,
          ...(await enviarEmail(
            teste,
            'Teste de envio — Peace on Tax',
            emailComMarca({
              lang: 'pt', nome: null,
              corpoHtml: '<p>Este é um teste de configuração do envio de e-mail. Se você recebeu, o caminho da fatura ao cliente está funcionando.</p>',
            }),
          )),
        }
  }

  return NextResponse.json({
    configurado: passos.every(p => p.ok || p.passo.startsWith('Endereço')),
    remetente: from,
    dominioDoRemetente: dominio,
    passos,
    envioDeTeste,
    comoTestar: `Abra /api/avisos/diag?teste=SEU_EMAIL para mandar um e-mail de verdade e ver a resposta do Resend.`,
    lembrete: 'O aviso no portal do cliente sai mesmo sem e-mail — o cliente vê a fatura em Pagamentos ao entrar.',
  })
}
