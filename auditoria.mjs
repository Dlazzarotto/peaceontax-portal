#!/usr/bin/env node
// ============================================================
//  AUDITORIA DO PORTAL - confere se o que esta instalado
//  corresponde as decisoes tomadas na construcao.
//
//  Roda em qualquer sistema (Windows, Mac, Linux, Claude Code):
//      npm run auditoria
//
//  E a versao portavel do auditoria.ps1. Alem dos invariantes
//  originais, confere tres coisas que o fluxo de copiar arquivos
//  de ZIP introduziu no passado: texto com acentos corrompidos
//  (mojibake), BOM no inicio de arquivos e arquivos .bak versionados.
//
//  Sai com codigo 1 quando algum invariante falha - serve de trava
//  antes do push.
// ============================================================

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { execSync } from 'node:child_process'

const raiz = process.cwd()
const cor = process.stdout.isTTY && !process.env.NO_COLOR
const pinta = (c, t) => (cor ? `\x1b[${c}m${t}\x1b[0m` : t)
const verde = t => pinta('32', t), vermelho = t => pinta('31', t)
const amarelo = t => pinta('33', t), ciano = t => pinta('36', t), cinza = t => pinta('90', t)

let falhas = 0
const titulo = t => console.log('\n' + ciano(`=== ${t} ===`))
const ok = t => console.log(verde('[  OK  ]') + `  ${t}`)
const falta = (t, porque) => { falhas++; console.log(vermelho('[FALTA ]') + `  ${t}`); if (porque) console.log(cinza(`           ${porque}`)) }
const ver = t => console.log(amarelo('[ VER  ]') + `  ${t}`)

function checar(nome, arquivo, padrao, porque) {
  const caminho = join(raiz, arquivo)
  if (!existsSync(caminho)) return falta(nome, `arquivo inexistente: ${arquivo}`)
  const conteudo = readFileSync(caminho, 'utf8')
  const achou = padrao instanceof RegExp ? padrao.test(conteudo) : conteudo.includes(padrao)
  achou ? ok(nome) : falta(nome, porque)
}

// Percorre o projeto ignorando o que nao e codigo-fonte
function* arquivos(dir, exts) {
  for (const nome of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'out', 'public'].includes(nome)) continue
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) yield* arquivos(p, exts)
    else if (exts.some(e => nome.endsWith(e))) yield p
  }
}
const rel = p => relative(raiz, p).split(sep).join('/')

titulo('MOTOR DE REGRAS (os tres pontos precisam do mesmo motor)')
checar('Importacao: casamento por palavra inteira', 'lib/apply-rules.ts', 'casaTexto', "sem isto 'mobil' pega 'Mobilizat'")
checar('Importacao: limpa metadados de wire', 'lib/apply-rules.ts', 'limparRuido', "sem isto 'bk' pega 'BNF BK:ITAU'")
checar('Aplicar regras: palavra inteira', 'app/api/bookkeeping/categorize/route.ts', 'casaTexto', 'motor divergente')
checar('Aplicar regras: limpa metadados', 'app/api/bookkeeping/categorize/route.ts', 'limparRuido', 'motor divergente')
checar('Criar/editar regra: palavra inteira', 'app/api/bookkeeping/rules/route.ts', 'casaTexto', 'terceiro motor esquecido')

titulo('TRANSFERENCIAS E CARTAO')
checar("So com 'transfer to/from'", 'lib/apply-rules.ts', 'sentidoTransferencia', 'espelho por valor gerava falsos')
checar('Conta citada tem que ser do cliente', 'lib/apply-rules.ts', 'contasDeFora', 'dinheiro de fora vira transferencia')
checar('Cartao reconhecido pelo nome', 'app/api/bookkeeping/categorize/route.ts', 'cartaoCitado', 'AMEX EPAYMENT sem 4 digitos')
checar('Pagamento dentro do cartao', 'app/api/bookkeeping/categorize/route.ts', 'ehPagamentoNoCartao', 'quitacao viraria receita')

titulo('NON-PROFIT')
checar('Importacao ignora regras gerais', 'lib/apply-rules.ts', 'nonprofit', 'igreja usaria regras de empresa')
checar('Aplicar regras idem', 'app/api/bookkeeping/categorize/route.ts', 'nonprofit', 'idem')
checar('Lista de regras idem', 'app/api/bookkeeping/rules/route.ts', 'nonprofit', 'idem')

titulo('IMPORTACAO DO QUICKBOOKS')
checar('Confere acesso ao cliente', 'app/api/bookkeeping/import-quickbooks/route.ts', 'canAccessClient', 'equipe importaria em cliente errado sem trava')
checar('Mesmo dedupe do CSV/PDF', 'app/api/bookkeeping/import-quickbooks/route.ts', "onConflict: 'client_id,tx_date,description,amount'", 'reenviar o arquivo duplicaria o livro')
checar('Origem marcada como quickbooks', 'app/api/bookkeeping/import-quickbooks/route.ts', "source: 'quickbooks'", 'nao daria para saber de onde veio o lancamento')
checar('Split sem correspondencia fica pendente (nao inventa categoria)', 'app/api/bookkeeping/import-quickbooks/route.ts', "status: categoria ? 'approved' : 'pending'", 'categoria inexistente entraria no livro')

titulo('DATAS NO PADRAO DOS EUA')
checar('Bookkeeping', 'components/BookkeepingTab.tsx', 'fmtDate', 'datas apareciam como no Brasil')
checar('Conciliacao', 'components/ReconcileTab.tsx', 'fmtDate', 'idem')

titulo('FINANCEIRO: PERMISSOES EM TODAS AS ROTAS')
checar('Faturas', 'app/api/billing/invoices/route.ts', 'permissoesFinanceiro', 'rota sem controle de acesso')
checar('Pagamentos', 'app/api/billing/payments/route.ts', 'permissoesFinanceiro', 'rota sem controle de acesso')
checar('Contratos', 'app/api/billing/recurring/route.ts', 'permissoesFinanceiro', 'rota sem controle de acesso')
checar('Parcelamento', 'app/api/billing/installment-plan/route.ts', 'permissoesFinanceiro', 'rota sem controle de acesso')
checar('Impressao', 'app/api/billing/print/route.ts', 'permissoesFinanceiro', 'rota sem controle de acesso')
checar('Link Stripe', 'app/api/billing/stripe-checkout/route.ts', 'permissoesFinanceiro', 'qualquer um geraria cobranca')
checar('Estorno com senha do gerente', 'app/api/billing/payments/route.ts', 'signInWithPassword', 'estorno sem confirmacao')
checar('Fatura nao fica sem itens', 'app/api/billing/invoices/route.ts', 'desfaz para', 'documento vazio (ja aconteceu)')
checar('Catalogo unico', 'app/api/billing/invoices/route.ts', 'pricing_items', 'duas listas de preco')

titulo('PAGAMENTO PELO PORTAL')
checar('Fatura: so o dono do cadastro paga', 'app/api/portal/billing/checkout/route.ts', ".eq('client_id', c.id)", 'cliente pagaria fatura de outro')
checar('Fatura: as tres formas num link so', 'app/api/portal/billing/checkout/route.ts', "['card', 'us_bank_account', 'klarna']", 'cliente nao escolheria Klarna/ACH')
checar('Plano: so plano liberado pela equipe (awaiting_*)', 'app/api/portal/plan-checkout/route.ts', "['awaiting_entry', 'awaiting_setup']", 'rascunho apareceria para o cliente')
checar('Sessao dos planos numa lib so', 'lib/plan-checkout.ts', 'criarSessaoDoPlano', 'tres rotas montando a sessao de tres jeitos')
checar('Webhook: forma real vem do PaymentIntent', 'app/api/stripe/webhook/route.ts', 'formaDoPagamento', 'cartao entraria como Klarna quando as duas sao oferecidas')
checar('Webhook: ACH confirmado dias depois', 'app/api/stripe/webhook/route.ts', 'checkout.session.async_payment_succeeded', 'debito em conta nunca seria registrado')
checar('Fatura enviada avisa o cliente', 'app/api/billing/invoices/route.ts', 'avisarClienteDaFatura', 'cliente nao saberia que tem fatura')

titulo('CONTRATO ASSINADO NO PORTAL')
checar('Assinatura conferida pela API, nao pelo parametro de retorno', 'app/api/portal/contract-return/route.ts', 'getRecipients', 'qualquer um "assinaria" trocando a URL')
checar('Assinatura do cliente marcada na trilha', 'app/api/portal/contract-return/route.ts', "'contract_signed_by_client'", 'nao haveria prova de quando o cliente assinou')
checar('Debito so depois do contrato', 'app/api/portal/plan-checkout/route.ts', 'contratoPendenteDoPlano', 'cliente cadastraria conta antes de autorizar o debito')
checar('Tela de assinatura gerada na hora (clientUserId)', 'lib/docusign.ts', 'createRecipientView', 'sem assinatura embutida o cliente nao assina no portal')

titulo('WEBHOOKS: assinatura conferida')
checar('Stripe (constructEvent valida a assinatura)', 'app/api/stripe/webhook/route.ts', 'constructEvent', 'qualquer um marcaria faturas como pagas')
checar('Twilio WhatsApp (X-Twilio-Signature)', 'app/api/whatsapp/webhook/route.ts', /validarAssinatura|validateRequest|X-Twilio-Signature/i, 'qualquer um inseriria mensagem falsa na conversa')
checar('Twilio SMS (X-Twilio-Signature)', 'app/api/sms/webhook/route.ts', 'validarAssinaturaTwilio', 'qualquer um cancelaria o consentimento de um cliente')
checar('Webhook de SMS liberado no middleware', 'middleware.ts', '/api/sms/webhook', 'a Twilio receberia 401 e reenviaria para sempre')

titulo('COMUNICACAO: travas dentro da biblioteca')
checar('SMS: consentimento/STOP conferidos no envio', 'lib/sms.ts', /consent|opt_out|STOP/i, 'fluxo novo poderia burlar por esquecimento')
checar('SMS: consentimento do portal passa pela lib', 'app/api/portal/sms-consent/route.ts', 'registrarConsentimento', 'trilha (IP, hora, texto) ficaria incompleta')
checar('SMS: texto do consentimento versionado', 'lib/sms-consent-text.ts', 'SMS_CONSENT_VERSION', 'registro antigo nao saberia o que o cliente leu')
checar('SMS: START sem opt-in anterior nao vira consentimento', 'app/api/sms/webhook/route.ts', "eq('action', 'opt_in')", 'um START criaria consentimento do nada')

titulo('ACESSO: APIs publicas sao lista fechada')
checar('Middleware exige sessao nas demais APIs', 'middleware.ts', 'API_PUBLIC', 'toda /api/ ficaria aberta sem login')
checar('Cron liberado no middleware', 'middleware.ts', "'/api/cron'", 'a Vercel receberia 401 e o aviso nunca sairia')
checar('Cron exige CRON_SECRET (recusa sem a variavel)', 'app/api/cron/billing-reminders/route.ts', 'CRON_SECRET', 'qualquer um dispararia avisos')

titulo('AVISO DE COBRANCA (3 dias antes do debito)')
checar('Agendado na Vercel', 'vercel.json', '/api/cron/billing-reminders', 'rota existe mas nunca roda')
checar('SMS sai pela lib (consentimento conferido)', 'lib/billing-reminders.ts', 'enviarSms', 'aviso burlaria as travas de consentimento')
checar('Idempotente (chave por plano e data)', 'lib/billing-reminders.ts', 'chaveUnica', 'cron rodando duas vezes avisaria duas vezes')
checar('Fica na trilha (plan_audit)', 'lib/billing-reminders.ts', "'reminder_sent'", 'numa contestacao nao haveria prova do aviso')
checar('Datas pelas mesmas regras do checkout', 'lib/billing-reminders.ts', 'nextBillingDayET', 'aviso em dia diferente do debito')

titulo('TEXTO: acentos corrompidos (mojibake) e BOM')
// Mojibake: UTF-8 lido como Latin-1 e gravado de novo em UTF-8 (o "a" com til
// vira "A" com til seguido de libra; o travessao vira "a" com circunflexo e euro).
// Em portugues, "Ã" so aparece em maiusculas (NÃO, PRESTAÇÃO) e nunca seguido
// de um caractere da faixa U+0080-U+00BF - por isso o padrao nao da falso positivo.
const mojibake = /[\u00C3\u00C2][\u0080-\u00BF]|\u00E2\u20AC/
const exts = ['.ts', '.tsx', '.sql', '.md', '.mjs']
let corrompidos = 0, boms = 0
for (const p of arquivos(raiz, exts)) {
  const texto = readFileSync(p, 'utf8')
  if (texto.charCodeAt(0) === 0xFEFF) { boms++; ver(`BOM no inicio de ${rel(p)}`) }
  const linhas = texto.split('\n')
  for (let i = 0; i < linhas.length; i++) {
    if (mojibake.test(linhas[i])) {
      corrompidos++
      falta(`acentos corrompidos em ${rel(p)}:${i + 1}`, linhas[i].trim().slice(0, 90))
    }
  }
}
if (!corrompidos) ok('nenhum arquivo com acentos corrompidos')
if (!boms) ok('nenhum arquivo com BOM')

titulo('ARQUIVOS .bak VERSIONADOS (nao deviam ir para o Git)')
let baks = []
try { baks = execSync('git ls-files', { cwd: raiz, encoding: 'utf8' }).split('\n').filter(f => f.endsWith('.bak')) } catch {}
baks.length ? baks.forEach(b => ver(b)) : ok('nenhum')

titulo('DUPLICACOES A DECIDIR (nao sao erros, sao escolhas)')
for (const d of [
  ['Orcamentos: modulo Quotes x estimates do faturamento', 'components/QuotesTab.tsx'],
  ['Contratos: modulo Plans x recurring_plans', 'components/PlansTab.tsx'],
  ['Equipe: staff_roles (permissao) x team_members (CRM)', 'app/team/page.tsx'],
]) if (existsSync(join(raiz, d[1]))) ver(d[0])

titulo('MENU DUPLICADO EM QUANTOS LAYOUTS')
for (const p of arquivos(join(raiz, 'app'), ['layout.tsx'])) {
  const t = readFileSync(p, 'utf8')
  if (/dashboard\/bookkeeping|\/invitations/.test(t)) console.log(cinza(`   menu em: ${rel(p)}`))
}

console.log()
if (falhas) {
  console.log(vermelho(`Auditoria concluida com ${falhas} falha(s).`))
  process.exit(1)
}
console.log(ciano('Auditoria concluida sem falhas.'))
