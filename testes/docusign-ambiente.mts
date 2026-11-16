// testes/docusign-ambiente.mts — assinatura de teste não vale; sair do teste é mais que trocar endereço
//
// O envio (exigirProducao) e o diagnóstico (/api/signatures/diag) decidem
// "teste ou produção" pela MESMA regra (ambienteDe). O aviso de quem está no
// teste não pode sugerir um servidor concreto: exemplo que parece colável é
// colado, e cada conta mora num servidor.

import { ambienteDe, ehEnderecoDemo, MOTIVO_DEMO, PASSOS_PARA_PRODUCAO } from '../lib/docusign.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const PROD_API = 'https://na2.docusign.net/restapi'
const PROD_OAUTH = 'account.docusign.com'
const DEMO_API = 'https://demo.docusign.net/restapi'
const DEMO_OAUTH = 'account-d.docusign.com'

// ── A regra ──────────────────────────────────────────────────────────────
eq('os dois de produção: produção', ambienteDe({ basePath: PROD_API, oauthBase: PROD_OAUTH }), 'producao')
eq('os dois de teste: demo', ambienteDe({ basePath: DEMO_API, oauthBase: DEMO_OAUTH }), 'demo')
eq('meio caminho (OAuth em produção, API no teste): demo — não assina', ambienteDe({ basePath: DEMO_API, oauthBase: PROD_OAUTH }), 'demo')
eq('meio caminho (API em produção, OAuth no teste): demo', ambienteDe({ basePath: PROD_API, oauthBase: DEMO_OAUTH }), 'demo')
eq('servidores de produção de outras regiões também são produção',
   ['https://na1.docusign.net/restapi', 'https://na3.docusign.net/restapi', 'https://na4.docusign.net/restapi', 'https://eu.docusign.net/restapi', 'https://au.docusign.net/restapi']
     .map(b => ambienteDe({ basePath: b, oauthBase: PROD_OAUTH })), ['producao', 'producao', 'producao', 'producao', 'producao'])
eq('OAuth com https:// na frente ainda é reconhecido como teste', ehEnderecoDemo('https://account-d.docusign.com'), true)
eq('account.docusign.com NÃO é teste (o "-d" é que marca)', ehEnderecoDemo('account.docusign.com'), false)
eq('demo.docusign.net com barra no fim é teste', ehEnderecoDemo('https://demo.docusign.net/restapi/'), true)
eq('um domínio que só CONTÉM "demo" no nome não é o sandbox', ehEnderecoDemo('https://mydemo.docusign.net/restapi'), false)
eq('vazio não é teste (quem decide o padrão é a lib)', ehEnderecoDemo(''), false)

// ── O aviso e a lista ────────────────────────────────────────────────────
const textos = [MOTIVO_DEMO, ...PASSOS_PARA_PRODUCAO].join(' ')
eq('nenhum servidor concreto de exemplo (naN/eu/au) no aviso nem na lista', /\b(na\d|eu|au)\.docusign\.net/.test(textos), false)
eq('o aviso diz que não é só trocar endereços', /não é só trocar endereços/.test(MOTIVO_DEMO), true)
eq('o aviso aponta o diagnóstico', MOTIVO_DEMO.includes('/api/signatures/diag'), true)
eq('o aviso mantém o caminho do teste de propósito', MOTIVO_DEMO.includes('DOCUSIGN_PERMITIR_DEMO=1'), true)
eq('a lista começa pelo Go-Live', /^Go-Live/.test(PASSOS_PARA_PRODUCAO[0]), true)
eq('a lista pede RSA NOVA de produção', PASSOS_PARA_PRODUCAO.some(p => /RSA Keypair NOVA/.test(p) && /DOCUSIGN_PRIVATE_KEY/.test(p)), true)
eq('a lista pede User ID e Account ID de produção', PASSOS_PARA_PRODUCAO.some(p => /DOCUSIGN_USER_ID/.test(p) && /DOCUSIGN_ACCOUNT_ID/.test(p)), true)
eq('a lista diz os dois endereços e manda apagar o teste de propósito',
   PASSOS_PARA_PRODUCAO.some(p => /DOCUSIGN_OAUTH_BASE = account\.docusign\.com/.test(p) && /DOCUSIGN_BASE_PATH/.test(p) && /apague DOCUSIGN_PERMITIR_DEMO/.test(p)), true)
eq('a lista fala do consentimento', PASSOS_PARA_PRODUCAO.some(p => /consentimento/.test(p) && /Allow/.test(p)), true)
eq('a lista avisa do ID Check do 8879', PASSOS_PARA_PRODUCAO.some(p => /8879/.test(p) && /ID Check/.test(p)), true)

console.log(`docusign-ambiente: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
