// lib/docusign.ts — integração DocuSign via JWT Grant
// Sem dependências novas: JWT RS256 assinado com o crypto nativo do Node.

import { createSign } from 'crypto'

const INTEGRATION_KEY = process.env.DOCUSIGN_INTEGRATION_KEY!
const USER_ID    = process.env.DOCUSIGN_USER_ID!
const ACCOUNT_ID = process.env.DOCUSIGN_ACCOUNT_ID!
const BASE_PATH  = process.env.DOCUSIGN_BASE_PATH || 'https://demo.docusign.net/restapi'
const OAUTH_BASE = process.env.DOCUSIGN_OAUTH_BASE || 'account-d.docusign.com'

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Normaliza a private key vinda do env (Vercel pode achatar as quebras de linha) */
function getPrivateKey(): string {
  let key = process.env.DOCUSIGN_PRIVATE_KEY || ''
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n')
  return key
}

let tokenCache: { token: string; exp: number } | null = null

/** Access token via JWT Grant (cache de ~50 min) */
export async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp) return tokenCache.token

  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    iss: INTEGRATION_KEY,
    sub: USER_ID,
    aud: OAUTH_BASE,
    iat: now,
    exp: now + 3600,
    scope: 'signature impersonation',
  }))

  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  const signature = signer.sign(getPrivateKey())
  const jwt = `${header}.${payload}.${b64url(signature)}`

  const res = await fetch(`https://${OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`DocuSign auth falhou: ${err}`)
  }
  const data = await res.json()
  tokenCache = { token: data.access_token, exp: Date.now() + 50 * 60 * 1000 }
  return data.access_token
}

export interface Signer {
  name: string
  email: string
  title?: string          // cargo (business)
  kba?: boolean           // Knowledge-Based Authentication (Form 8879)
}

export interface EnvelopeDoc {
  name: string            // ex.: "Contrato de Serviços.html" | "Form-8879.pdf"
  base64: string
  fileExtension: 'html' | 'pdf'
}

/**
 * Cria e envia um envelope. Assinatura por âncora de texto:
 * o documento deve conter "/sig1/" (assinante 1) e "/sig2/" (assinante 2) onde a assinatura vai.
 * Para PDFs sem âncora (8879), usa posição fixa por página se anchor não encontrado — 
 * DocuSign exige âncora OU coordenadas; aqui aplicamos âncora com fallback tolerante.
 */
export async function sendEnvelope(params: {
  doc: EnvelopeDoc
  signers: Signer[]
  emailSubject: string
  emailBody?: string
  anchorMode?: boolean    // true: usa /sig1/ /sig2/; false: assinatura livre (signHere flutuante p/ 8879)
}): Promise<{ envelopeId: string }> {
  const token = await getAccessToken()

  const signersPayload = params.signers.map((s, i) => {
    const base: any = {
      email: s.email,
      name: s.name,
      recipientId: String(i + 1),
      routingOrder: String(i + 1),
      tabs: params.anchorMode !== false
        ? {
            signHereTabs: [{ anchorString: `/sig${i + 1}/`, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }],
            dateSignedTabs: [{ anchorString: `/date${i + 1}/`, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0' }],
            ...(s.title ? { titleTabs: [{ anchorString: `/title${i + 1}/`, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '0', value: s.title, locked: 'true' }] } : {}),
          }
        : {
            // 8879: assinatura em posição livre — o assinante clica onde indicado pelo DocuSign
            signHereTabs: [{ documentId: '1', pageNumber: '2', xPosition: '100', yPosition: '540' }],
          },
    }
    if (s.kba) {
      base.identityVerification = undefined // KBA legado via idCheck:
      base.requireIdLookup = 'true'
      base.idCheckConfigurationName = 'ID Check $'
    }
    return base
  })

  const body = {
    emailSubject: params.emailSubject,
    emailBlurb: params.emailBody || '',
    documents: [{
      documentBase64: params.doc.base64,
      name: params.doc.name,
      fileExtension: params.doc.fileExtension,
      documentId: '1',
    }],
    recipients: { signers: signersPayload },
    status: 'sent',
  }

  const res = await fetch(`${BASE_PATH}/v2.1/accounts/${ACCOUNT_ID}/envelopes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`DocuSign envelope falhou: ${err}`)
  }
  const data = await res.json()
  return { envelopeId: data.envelopeId }
}

/** Status do envelope: sent | delivered | completed | declined | voided */
export async function getEnvelopeStatus(envelopeId: string): Promise<string> {
  const token = await getAccessToken()
  const res = await fetch(`${BASE_PATH}/v2.1/accounts/${ACCOUNT_ID}/envelopes/${envelopeId}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Status falhou: ${await res.text()}`)
  const data = await res.json()
  return data.status
}

/** Baixa o PDF assinado (documento combinado) */
export async function downloadSignedPdf(envelopeId: string): Promise<Buffer> {
  const token = await getAccessToken()
  const res = await fetch(`${BASE_PATH}/v2.1/accounts/${ACCOUNT_ID}/envelopes/${envelopeId}/documents/combined`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Download falhou: ${await res.text()}`)
  return Buffer.from(await res.arrayBuffer())
}
