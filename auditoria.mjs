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

// Invariante pela AUSENCIA: as vezes o que importa e o que o arquivo NAO faz.
function recusar(nome, arquivo, padrao, porque) {
  const caminho = join(raiz, arquivo)
  if (!existsSync(caminho)) return falta(nome, `arquivo inexistente: ${arquivo}`)
  const conteudo = readFileSync(caminho, 'utf8')
  const achou = padrao instanceof RegExp ? padrao.test(conteudo) : conteudo.includes(padrao)
  achou ? falta(nome, porque) : ok(nome)
}

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
checar('Editar regra grava o escopo (global x cliente)', 'app/api/bookkeeping/rules/route.ts', 'client_id: novoClientId', 'trocar de Global para Cliente respondia ok e nao gravava')
checar('Regra geral nao fica presa a conta de um cliente', 'app/api/bookkeeping/rules/route.ts', 'const contaFinal', 'regra de todos os clientes com conta bancaria de um so')

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
checar('Relatorios: so o socio (verRelatorios)', 'app/api/billing/reports/route.ts', 'perms.verRelatorios', 'gerente veria os totais do negocio')
checar('Relatorios: orcamento e rascunho fora do faturamento', 'app/api/billing/reports/route.ts', "not('status', 'in', '(draft,void)')", 'faturamento inflado por rascunho/cancelada')

titulo('RELATORIOS: NADA DE FORA ENTRA NO SCRIPT')
checar('Barra: destino vai em atributo, nao dentro do script', 'lib/relatorio-barra.ts', 'data-destino=', 'parametro com </script> injetaria codigo na sessao da equipe')
checar('Barra: escapa o que sai em HTML', 'lib/relatorio-barra.ts', 'export function escaparHtml', 'nome de conta da URL viraria HTML')
checar('Detalhe da conta: mes validado antes de virar URL', 'app/api/bookkeeping/category-detail/route.ts', 'const month = mesBruto &&', 'mes cru voltaria para o link do Voltar')
checar('Detalhe da conta: categoria escapada', 'app/api/bookkeeping/category-detail/route.ts', 'escaparHtml(category)', 'XSS refletido pelo nome da conta')

titulo('IMPRESSOS: VOLTAR E CELULAR')
checar('Barra tem destino fixo alem do Voltar', 'lib/relatorio-barra.ts', 'data-painel=', 'Voltar depende do historico; sem destino fixo nao ha volta garantida')
checar('Todo impresso declara o viewport', 'lib/relatorio-barra.ts', 'export const META_RELATORIO', 'celular renderiza a ~980px e a barra sai do alcance')
for (const imp of [
  'app/api/bookkeeping/pnl/route.ts',
  'app/api/bookkeeping/vendors/route.ts',
  'app/api/bookkeeping/balance-sheet/route.ts',
  'app/api/bookkeeping/category-detail/route.ts',
  'app/api/billing/print/route.ts',
  'app/api/quotes/[id]/document/route.ts',
  'lib/relatorios-financeiro.ts',
  'lib/contract-html.ts',
]) checar(`Viewport em ${imp.split('/').pop()}`, imp, 'META_RELATORIO', 'impresso ilegivel no celular')

titulo('MENU DA FIRMA')
checar('Menu num componente so', 'components/FirmNav.tsx', 'export default function FirmNav', 'menu duplicado em quatro layouts, cada um com itens diferentes')
checar('Menu recolhe ao escolher', 'components/FirmNav.tsx', 'const fechar = ()', 'sanfona ficava aberta depois de escolher (era <details> nativo)')
for (const lay of ['app/dashboard/layout.tsx', 'app/clients/layout.tsx', 'app/invitations/layout.tsx', 'app/settings/layout.tsx'])
  checar(`Layout usa o FirmNav: ${lay.split('/')[1]}`, lay, 'FirmNav', 'layout com menu proprio volta a divergir')

titulo('CADASTRO DE CLIENTE')
checar('Corpo do pedido nao vai direto para o insert', 'app/api/clients/route.ts', 'camposDoCliente', 'qualquer campo enviado entrava na tabela, inclusive user_id')
checar('Cadastrar manda o convite de acesso', 'app/api/clients/route.ts', 'deveConvidar', 'cliente ficava cadastrado sem nunca receber o login')
checar('Convite sai so pela equipe', 'app/api/send-invite/route.ts', 'auth?.isStaff', 'cliente logado convidava em nome da firma')
checar('Emitir fatura cadastra cliente novo', 'app/dashboard/billing/page.tsx', 'salvarNovoCliente', 'era preciso sair do Financeiro e recomecar a fatura')

recusar('Importar NAO chama o convite', 'app/api/clients/import/route.ts', 'send-invite', 'quase mil convites de uma vez')
checar('Importar diz que nao convidou', 'app/api/clients/import/route.ts', 'Nenhum convite foi enviado', 'a equipe ficaria sem saber que o acesso nao saiu')
checar('Importar mostra o plano antes de gravar', 'app/api/clients/import/route.ts', 'if (!aplicar)', 'gravaria a carteira inteira sem ninguem conferir')
checar('Duplicata e nome, nao e-mail', 'lib/import-clientes.ts', 'export function chaveDoNome', 'dono e empresa dividem o e-mail e sao clientes diferentes')
checar('Importar e de gerente ou socio', 'app/api/clients/import/route.ts', "nivel !== 'owner'", 'qualquer assistente traria a carteira inteira')

checar('Clientes entram por tipo, nao num quadro so', 'app/clients/page.tsx', "params.get('tipo')", 'empresa do ano todo e temporada misturadas no mesmo quadro')
checar('Contagem dos cartoes e feita no banco', 'app/api/clients/route.ts', "resumo') === '1'", 'traria mil cadastros so para contar no navegador')
checar('Situacao da etapa num modulo puro', 'lib/clientes-grupos.ts', 'export function situacaoDaEtapa', 'duas telas contariam o mesmo indicador de jeitos diferentes')
checar('Busca de cliente escapa o curinga', 'lib/clientes-grupos.ts', 'export function buscaLiteral', 'buscar 100% casava com 1000')
checar('Convite do portal na lista de clientes', 'app/clients/page.tsx', 'const convidar =', 'importado ficaria sem caminho para receber o acesso')
checar('Aceitar convite completa o cadastro existente', 'app/api/invite/[token]/route.ts', 'invite.client_id || null', 'criava um SEGUNDO cadastro da mesma pessoa')
checar('Convite guarda de quem e', 'app/api/send-invite/route.ts', 'client_id:    clientId || null', 'o aceite nao saberia qual cadastro completar')

titulo('PAGAMENTO PELO PORTAL')
checar('Fatura: so o dono do cadastro paga', 'app/api/portal/billing/checkout/route.ts', ".eq('client_id', c.id)", 'cliente pagaria fatura de outro')
checar('Fatura: as tres formas num link so', 'lib/stripe-formas.ts', "FORMAS_DO_CLIENTE = ['card', 'us_bank_account', 'klarna']", 'cliente nao escolheria Klarna/ACH')
checar('Fatura: o portal usa a lista unica de formas', 'app/api/portal/billing/checkout/route.ts', 'FORMAS_DO_CLIENTE', 'o portal ofereceria formas diferentes do resto')
checar('Forma inativa na conta nao derruba a sessao', 'lib/stripe-formas.ts', 'sessaoComFormasDisponiveis', 'sem ACH ativo ninguem pagava nem cadastrava debito')
checar('Plano: a sessao passa pela lista de formas disponiveis', 'lib/plan-checkout.ts', 'sessaoComFormasDisponiveis', 'cadastro de debito morreria inteiro por uma forma desativada')
checar('Plaid: idioma do cliente nao bloqueia o banco', 'app/api/plaid/link-token/route.ts', 'idiomaDoPlaid', 'cliente que nao fala ingles nao conectava a conta')
checar('Contrato do fluxo antigo tambem assina no portal', 'app/api/portal/contract-sign/route.ts', 'tornarAssinanteEmbutido', 'cliente ficava sem botao e a fatura parcelada travada')
checar('Plano: so plano liberado pela equipe (awaiting_*)', 'app/api/portal/plan-checkout/route.ts', "['awaiting_entry', 'awaiting_setup']", 'rascunho apareceria para o cliente')
checar('Sessao dos planos numa lib so', 'lib/plan-checkout.ts', 'criarSessaoDoPlano', 'tres rotas montando a sessao de tres jeitos')
checar('Parcela vem da invoice, nao de contador', 'lib/parcela-stripe.ts', 'export async function parcelaDaInvoice', 'evento fora de ordem dava baixa na parcela errada')
checar('Total de parcelas e recontado, nao incrementado', 'lib/parcela-stripe.ts', 'export async function recontarParcelas', 'paid_installments divergia do cronograma')
checar('Webhook usa a lib da parcela', 'app/api/stripe/webhook/route.ts', "from '@/lib/parcela-stripe'", 'webhook voltaria a contar na mao')
checar('Webhook: cobranca anulada no Stripe cancela a fatura aqui', 'app/api/stripe/webhook/route.ts', "event.type === 'invoice.voided'", 'fatura anulada la seguia no contas a receber aqui')
checar('Um plano, uma assinatura', 'app/api/stripe/webhook/route.ts', 'cancelarAssinaturaDuplicada', 'cadastro concluido duas vezes cobrava o cliente em dobro para sempre')
checar('Recobranca e idempotente', 'app/api/billing/recharge/route.ts', 'idempotencyKey', 'dois cliques cobravam duas vezes do cliente')
checar('Plano parado avisa a equipe', 'lib/planos-parados.ts', 'export async function alertarPlanosParados', 'plano esperando o cliente ficava parado para sempre sem ninguem ver')
checar('Cron roda o aviso de plano parado', 'app/api/cron/billing-reminders/route.ts', 'alertarPlanosParados', 'a rotina existiria sem ninguem chamar')
checar('Pagamento fora do Checkout da baixa', 'app/api/stripe/webhook/route.ts', "event.type === 'payment_intent.succeeded'", 'cobranca no leitor seria aprovada e a fatura nunca quitaria')
checar('Um pagamento, dois eventos, um lancamento', 'lib/recebimento-stripe.ts', 'export function filtroDeRecebimento', 'sessao e intent chegam sem ordem e lancariam o recebimento duas vezes')
checar('Os dois caminhos usam o mesmo filtro', 'app/api/stripe/webhook/route.ts', 'filtroDeRecebimento', 'cada caminho olhando so a propria chave volta a duplicar')
checar('Depois do recebimento e uma rotina so', 'app/api/stripe/webhook/route.ts', 'async function depoisDoRecebimento', 'baixa por outro caminho nao encerraria parcelamento nem sairia da linha de cobranca')
checar('Fatura quitada sai com carimbo', 'app/api/billing/print/route.ts', 'carimbo-palavra', 'cliente do balcao saia sem comprovante de quitacao')
checar('Webhook: forma real vem do PaymentIntent', 'app/api/stripe/webhook/route.ts', 'formaDoPagamento', 'cartao entraria como Klarna quando as duas sao oferecidas')
checar('ACH em transito tem estado proprio', 'lib/ach-transito.ts', 'export async function marcarAchEmTransito', 'fatura com dinheiro a caminho era igual a nao paga')
checar('Baixa manual avisa do ACH a caminho', 'app/api/billing/payments/route.ts', 'precisaConfirmarAch', 'Zelle registrado no meio do ACH virava baixa em dobro')
checar('Lembrete nao cobra quem ja pagou por ACH', 'app/api/billing/invoices/route.ts', 'achEmTransito(inv)', 'cliente recebia cobranca do que ja tinha mandado')
checar('Sessao expirada tira a fatura do limbo', 'app/api/stripe/webhook/route.ts', "event.type === 'checkout.session.expired'", 'fatura ficava esperando um ACH que nunca vem')
checar('ACH parado no caminho avisa a equipe', 'lib/ach-transito.ts', 'export async function alertarAchParado', 'debito sem confirmacao ficava invisivel')
checar('Webhook: ACH confirmado dias depois', 'app/api/stripe/webhook/route.ts', 'checkout.session.async_payment_succeeded', 'debito em conta nunca seria registrado')
checar('Webhook: entrada por ACH so ativa com dinheiro confirmado', 'app/api/stripe/webhook/route.ts', "'entry_processing'", 'parcelamento comecaria com entrada que o banco pode devolver')
checar('Webhook: forma real tambem na entrada', 'app/api/stripe/webhook/route.ts', 'metodoEntrada', 'entrada por ACH entraria no livro como cartao')
checar('Ancora respeita as 48h do Stripe', 'lib/plan-checkout.ts', 'ancoraDeCobranca', 'cadastro do debito falha quando o dia acordado esta perto')
checar('Portal: fatura sabe se o plano aceita acao', 'app/api/portal/billing/route.ts', 'podeCadastrar', 'fatura parcelada ativa mostraria botao Pagar que a rota recusa')
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
checar('Aviso de cobranca usa a lib de avisos (marca e erro tratados)', 'lib/billing-reminders.ts', "from '@/lib/avisos'", 'e-mail duplicado sai com rodape antigo e derruba o cron na falha de rede')
checar('Formato do cliente vem de um lugar so', 'lib/format.ts', 'export function fmtUS', 'cada tela com a sua data e a sua moeda')
checar('Volta do DocuSign alcanca a rota (senao vira JSON 401)', 'middleware.ts', '/api/portal/contract-return', 'sessao expirada devolveria JSON cru em vez do login')
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
const exts = ['.ts', '.tsx', '.sql', '.md', '.mjs', '.ps1']
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

titulo('FIRMA x CLIENTE SE DECIDE NUM LUGAR SO (lib/papeis.ts)')
// O convite da equipe grava role = firm|admin|manager|staff; a porta de
// entrada lia role === 'firm'. Quem entrava como staff (o padrao do
// formulario) virava CLIENTE e caia no portal. Agora todos perguntam a
// lib/papeis.ts — e nenhum outro arquivo pode repetir a comparacao.
checar('lib/papeis.ts existe', 'lib/papeis.ts', /export function ehDaFirma/, 'a fonte unica sumiu')
for (const alvo of ['middleware.ts', 'lib/supabase-server.ts', 'lib/api-auth.ts']) {
  checar(`${alvo} pergunta a lib/papeis`, alvo, /from ['"]@\/lib\/papeis['"]/, 'voltou a decidir sozinho')
}
{
  // Ler user_metadata.role e compara-lo com 'firm' e o que nao pode se
  // repetir. Comparar a variavel ja calculada por papelDoLogin e normal.
  const CRU = /(user_)?metadata[^\n]{0,40}\.role\s*===\s*['"]firm['"]/
  let repetem = []
  for (const arq of arquivos(join(raiz, 'app'), ['.ts', '.tsx']))
    if (CRU.test(readFileSync(arq, 'utf8'))) repetem.push(rel(arq))
  for (const arq of ['middleware.ts', 'lib/supabase-server.ts', 'lib/api-auth.ts'])
    if (CRU.test(readFileSync(join(raiz, arq), 'utf8'))) repetem.push(arq)
  repetem.length
    ? falta('Ninguem repete a comparacao role === "firm"', `use ehDaFirma: ${repetem.join(', ')}`)
    : ok('Ninguem repete a comparacao role === "firm"')
}

titulo('TODA ROTA DE API CONFERE QUEM CHAMA')
// /api/firm/users/[id] nao conferia e usava a service role key: qualquer
// cliente logado virava firma ou trocava a senha do socio.
{
  // Rotas abertas de proposito — a mesma lista de API_PUBLIC do middleware,
  // mais o logout (so encerra a propria sessao).
  const ABERTAS = [
    'app/api/agenda/slots/route.ts',
    'app/api/agenda/bookings/route.ts',
    'app/api/invite/[token]/route.ts',
    'app/api/firm/setup/[token]/route.ts',
    'app/api/auth/logout/route.ts',
  ]
  // getAuth() (equipe x cliente), getUser() + filtro por user_id (rotas do
  // portal), nivel da equipe (WhatsApp), CRON_SECRET, assinatura do Stripe
  // e assinatura da Twilio (o header chega em minusculo).
  const CONFERE = /getAuth\(|getUser\(|autorDaRequisicao\(|CRON_SECRET|constructEvent|twilio-signature/i
  const soltas = []
  for (const arq of arquivos(join(raiz, 'app', 'api'), ['route.ts'])) {
    const nome = rel(arq)
    if (ABERTAS.includes(nome)) continue
    if (!CONFERE.test(readFileSync(arq, 'utf8'))) soltas.push(nome)
  }
  soltas.length
    ? falta('Nenhuma rota de API sem conferencia', `sem getAuth: ${soltas.join(', ')}`)
    : ok('Nenhuma rota de API sem conferencia')
}

titulo('AUTORIZACOES POR PESSOA (nivel + concessoes)')
checar('lib/permissoes.ts existe', 'lib/permissoes.ts', /export function permissoesDe/,
       'o modulo que monta o conjunto sumiu')
checar('O financeiro monta pelo modulo puro', 'lib/billing-perms.ts',
       /from ['"]@\/lib\/permissoes['"]/,
       'billing-perms voltou a calcular a matriz sozinho — duas definicoes divergem em silencio')
checar('Concessao e lida do banco', 'lib/staff-perms.ts', /staff_grants_atual/,
       'sem ler a view, a autorizacao dada na tela nao vale nada')
checar('So o socio autoriza', 'app/api/account/grants/route.ts', /!== 'owner'/,
       'a rota de autorizacoes precisa exigir socio')
checar('Motivo e obrigatorio na autorizacao', 'app/api/account/grants/route.ts',
       /razao\.length < 3/, 'acao sensivel pede motivo — principio 3')
{
  // A lista de chaves vive em dois lugares: o modulo e o CHECK do SQL.
  // Divergir em silencio significa autorizacao que a tela oferece e o banco
  // recusa — ou pior, chave gravada que o codigo nunca le.
  const mod = readFileSync(join(raiz, 'lib/permissoes.ts'), 'utf8')
  const sql = existsSync(join(raiz, 'sql/permissoes-por-pessoa-v1.sql'))
    ? readFileSync(join(raiz, 'sql/permissoes-por-pessoa-v1.sql'), 'utf8') : ''
  const noModulo = Array.from(mod.matchAll(/chave:\s*'([a-zA-Z]+)'/g)).map(m => m[1]).sort()
  const bloco = (sql.match(/chave in \(([^)]*)\)/s) || [])[1] || ''
  const noSql = Array.from(bloco.matchAll(/'([a-zA-Z]+)'/g)).map(m => m[1]).sort()
  JSON.stringify(noModulo) === JSON.stringify(noSql) && noModulo.length
    ? ok('Chaves do modulo e do CHECK do SQL batem')
    : falta('Chaves do modulo e do CHECK do SQL batem',
            `modulo: ${noModulo.join(',')} | sql: ${noSql.join(',')}`)
}

titulo('RECEBIMENTO: CARTAO E ZELLE SOZINHO, O RESTO COM APROVACAO')
checar('A regra mora num modulo so', 'lib/recebimento-aprovacao.ts',
       /export const FORMAS_LIVRES/, 'a lista de formas livres sumiu')
checar('A rota de pagamento aplica a regra', 'app/api/billing/payments/route.ts',
       /exigeAprovacao\(method\)/,
       'sem isto o dinheiro em especie entra sem aprovacao de gerente')
checar('Senha certa nao basta: confere o nivel', 'app/api/billing/payments/route.ts',
       /podeAprovar\(await getStaffLevel/,
       'qualquer login valido aprovaria — inclusive o de um cliente')
checar('Quem aprovou fica na trilha', 'app/api/billing/payments/route.ts',
       /aprovadoPor/, 'aprovacao sem registro nao e aprovacao')
recusar('A trava nao vive so na tela', 'app/dashboard/billing/page.tsx',
        /approverPassword['"]?\s*:\s*apSenha\s*\}\s*\)\s*\}\s*$/m,
        'a conferencia tem de estar na rota, nao so no componente')

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
