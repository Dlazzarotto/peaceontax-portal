// /api/signatures/diag — diagnóstico do DocuSign, etapa por etapa.
//
// SOMENTE LEITURA. Não cria envelope, não envia e-mail, não altera nada.
// Nenhum segredo é devolvido: chaves e IDs saem mascarados.
//
// Responde a pergunta "por que o contrato não sai?" em 6 checagens:
//   1. variáveis presentes
//   2. coerência demo x produção (a armadilha do OAUTH_BASE ausente)
//   3. a chave privada é lida pelo Node
//   4. o JWT é aceito e devolve token  -> se faltar consentimento, entrega a URL pronta
//   5. o usuário pertence à conta configurada
//   6. o BASE_PATH aponta para o servidor certo daquela conta

import { NextResponse } from 'next/server'
import { getAuth } from '@/lib/api-auth'
import { getStaffLevel } from '@/lib/staff-perms'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Passo = { passo: string; ok: boolean; detalhe: string; acao?: string }

const mascarar = (v?: string) =>
  !v ? '(ausente)' : v.length <= 10 ? '***' : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} car.)`

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Mesma tolerância da lib: \n literal, espaços no lugar de quebras, PKCS#1. */
function normalizarChave(bruta: string): string | null {
  let k = (bruta || '').trim()
  if (!k) return null
  k = k.replace(/\\n/g, '\n')
  const m = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/.exec(k)
  if (!m) return null
  const corpo = m[2].replace(/[^A-Za-z0-9+/=]/g, '')
  const linhas = corpo.match(/.{1,64}/g)
  if (!linhas || linhas.length < 4) return null
  return `-----BEGIN ${m[1]}-----\n${linhas.join('\n')}\n-----END ${m[1]}-----\n`
}

const ehDemo = (s: string) => /(^|\/\/|\.)(account-d\.docusign\.com|demo\.docusign\.net)/.test(s)

export async function GET() {
  const auth = await getAuth()
  if (!auth?.isStaff) return NextResponse.json({ error: 'Acesso restrito' }, { status: 403 })
  const level = await getStaffLevel(auth.userId)
  if (level !== 'owner' && level !== 'manager') {
    return NextResponse.json({ error: 'Somente manager/owner' }, { status: 403 })
  }

  const IK = process.env.DOCUSIGN_INTEGRATION_KEY || ''
  const USER = process.env.DOCUSIGN_USER_ID || ''
  const ACC = process.env.DOCUSIGN_ACCOUNT_ID || ''
  const BASE_PATH = process.env.DOCUSIGN_BASE_PATH || 'https://demo.docusign.net/restapi'
  const OAUTH = process.env.DOCUSIGN_OAUTH_BASE || 'account-d.docusign.com'
  const KEY_RAW = process.env.DOCUSIGN_PRIVATE_KEY || ''

  const passos: Passo[] = []
  const parar = (extra: Record<string, unknown> = {}) =>
    NextResponse.json({
      ambiente: {
        oauth: OAUTH,
        oauth_definido: !!process.env.DOCUSIGN_OAUTH_BASE,
        base_path: BASE_PATH,
        base_path_definido: !!process.env.DOCUSIGN_BASE_PATH,
        integration_key: mascarar(IK),
        user_id: mascarar(USER),
        account_id: mascarar(ACC),
      },
      passos,
      veredito: passos.find((p) => !p.ok)?.acao || 'Todas as checagens passaram.',
      ...extra,
    })

  // 1 — variáveis presentes
  const faltando = [
    ['DOCUSIGN_INTEGRATION_KEY', IK],
    ['DOCUSIGN_USER_ID', USER],
    ['DOCUSIGN_ACCOUNT_ID', ACC],
    ['DOCUSIGN_PRIVATE_KEY', KEY_RAW],
  ].filter(([, v]) => !v).map(([n]) => n)

  passos.push({
    passo: '1. Variáveis de ambiente',
    ok: faltando.length === 0,
    detalhe: faltando.length ? `Ausentes: ${faltando.join(', ')}` : 'As quatro obrigatórias estão presentes.',
    acao: faltando.length ? `Cadastre ${faltando.join(', ')} no Vercel (Production) e refaça o deploy.` : undefined,
  })
  if (faltando.length) return parar()

  // 2 — coerência demo x produção
  const oauthDemo = ehDemo(OAUTH)
  const pathDemo = ehDemo(BASE_PATH)
  const coerente = oauthDemo === pathDemo
  passos.push({
    passo: '2. Ambiente coerente (demo x produção)',
    ok: coerente,
    detalhe: coerente
      ? `Ambos em ${oauthDemo ? 'DEMO (sandbox)' : 'PRODUÇÃO'}.`
      : `Incoerente: OAuth em ${oauthDemo ? 'DEMO' : 'PRODUÇÃO'} e API em ${pathDemo ? 'DEMO' : 'PRODUÇÃO'}.`,
    acao: coerente
      ? undefined
      : oauthDemo
        ? 'Defina DOCUSIGN_OAUTH_BASE = account.docusign.com no Vercel (a API já está em produção).'
        : 'Defina DOCUSIGN_OAUTH_BASE = account-d.docusign.com, ou aponte DOCUSIGN_BASE_PATH para produção.',
  })
  if (!coerente) return parar()

  // 3 — leitura da chave privada
  const pem = normalizarChave(KEY_RAW)
  let chave: crypto.KeyObject | null = null
  try {
    if (!pem) throw new Error('Não foi encontrado um bloco PEM válido na variável.')
    chave = crypto.createPrivateKey(pem)
  } catch (e: any) {
    passos.push({
      passo: '3. Chave privada RSA',
      ok: false,
      detalhe: e?.message || 'Falha ao carregar a chave.',
      acao: 'Recole a chave no Vercel. Se tiver senha, gere uma sem senha: openssl pkcs8 -topk8 -nocrypt -in chave.key -out chave-pkcs8.key',
    })
    return parar()
  }
  passos.push({
    passo: '3. Chave privada RSA',
    ok: true,
    detalhe: `Lida pelo Node (${chave.asymmetricKeyType?.toUpperCase() || 'RSA'}, ${
      (chave.asymmetricKeyDetails as any)?.modulusLength || '?'
    } bits).`,
  })

  // 4 — token JWT
  const agora = Math.floor(Date.now() / 1000)
  const cabecalho = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const corpo = b64url(
    JSON.stringify({
      iss: IK,
      sub: USER,
      aud: OAUTH,
      iat: agora,
      exp: agora + 3600,
      scope: 'signature impersonation',
    }),
  )
  const assinado = crypto.sign('RSA-SHA256', Buffer.from(`${cabecalho}.${corpo}`), chave)
  const jwt = `${cabecalho}.${corpo}.${b64url(assinado)}`

  const urlConsentimento =
    `https://${OAUTH}/oauth/auth?response_type=code&scope=signature%20impersonation` +
    `&client_id=${encodeURIComponent(IK)}&redirect_uri=https%3A%2F%2Fwww.docusign.com`

  let token = ''
  try {
    const r = await fetch(`https://${OAUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    })
    const txt = await r.text()
    let j: any = {}
    try { j = JSON.parse(txt) } catch { /* resposta não-JSON */ }

    if (!r.ok || !j.access_token) {
      const erro = j.error || `HTTP ${r.status}`
      const desc = j.error_description || txt.slice(0, 200)
      const mapa: Record<string, string> = {
        consent_required:
          'Falta o consentimento único do usuário. Abra a URL em urlConsentimento (logado com o usuário DocuSign do portal) e clique em Allow. Depois tente enviar o contrato de novo.',
        invalid_grant:
          'O DocuSign recusou o JWT. Causas: DOCUSIGN_USER_ID não é o User ID do usuário (é um GUID, não o e-mail), a Integration Key é de outro ambiente, ou a chave pública não corresponde à privada.',
        invalid_client: 'A Integration Key não existe neste ambiente. Confira se ela é do mesmo ambiente do OAUTH_BASE.',
        unauthorized_client: 'A aplicação não está autorizada a impersonar este usuário. Verifique o consentimento e o escopo.',
      }
      passos.push({
        passo: '4. Token JWT (autenticação)',
        ok: false,
        detalhe: `${erro} — ${desc}`,
        acao: mapa[erro] || 'Erro não mapeado; use o detalhe acima.',
      })
      return parar(erro === 'consent_required' ? { urlConsentimento } : {})
    }
    token = j.access_token
  } catch (e: any) {
    passos.push({
      passo: '4. Token JWT (autenticação)',
      ok: false,
      detalhe: e?.message || 'Falha de rede ao falar com o DocuSign.',
      acao: 'Verifique se o domínio do OAUTH_BASE está correto.',
    })
    return parar()
  }
  passos.push({ passo: '4. Token JWT (autenticação)', ok: true, detalhe: 'Token obtido com sucesso.' })

  // 5 e 6 — conta e servidor
  try {
    const r = await fetch(`https://${OAUTH}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const info: any = await r.json()
    const contas: any[] = Array.isArray(info?.accounts) ? info.accounts : []
    const alvo = contas.find((c) => String(c.account_id).toLowerCase() === ACC.toLowerCase())

    passos.push({
      passo: '5. Usuário pertence à conta configurada',
      ok: !!alvo,
      detalhe: alvo
        ? `Conta "${alvo.account_name}" encontrada.`
        : `DOCUSIGN_ACCOUNT_ID não está entre as ${contas.length} conta(s) do usuário.`,
      acao: alvo
        ? undefined
        : `Corrija DOCUSIGN_ACCOUNT_ID. Contas disponíveis: ${
            contas.map((c) => `${c.account_name} = ${c.account_id}`).join(' | ') || 'nenhuma'
          }`,
    })
    if (!alvo) return parar()

    const esperado = `${String(alvo.base_uri).replace(/\/$/, '')}/restapi`
    const bate = BASE_PATH.replace(/\/$/, '').toLowerCase() === esperado.toLowerCase()
    passos.push({
      passo: '6. BASE_PATH aponta para o servidor da conta',
      ok: bate,
      detalhe: bate ? `Correto: ${esperado}` : `Configurado ${BASE_PATH}, mas esta conta vive em ${esperado}`,
      acao: bate ? undefined : `Defina DOCUSIGN_BASE_PATH = ${esperado} no Vercel e refaça o deploy.`,
    })
  } catch (e: any) {
    passos.push({
      passo: '5. Usuário pertence à conta configurada',
      ok: false,
      detalhe: e?.message || 'Falha ao consultar o userinfo.',
      acao: 'Erro inesperado; me mande este retorno.',
    })
  }

  return parar()
}
