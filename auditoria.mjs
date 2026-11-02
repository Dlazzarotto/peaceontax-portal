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
import { pathToFileURL } from 'node:url'
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
checar('Contratos', 'app/api/billing/contratos/route.ts', 'podeMexerEmContrato', 'rota sem controle de acesso')
checar('Parcelamento', 'app/api/billing/installment-plan/route.ts', 'permissoesFinanceiro', 'rota sem controle de acesso')
checar('Impressao', 'app/api/billing/print/route.ts', 'permissoesFinanceiro', 'rota sem controle de acesso')
checar('Link Stripe', 'app/api/billing/stripe-checkout/route.ts', 'permissoesFinanceiro', 'qualquer um geraria cobranca')
checar('Estorno com senha do gerente', 'app/api/billing/payments/route.ts', 'signInWithPassword', 'estorno sem confirmacao')
checar('Fatura nao fica sem itens', 'app/api/billing/invoices/route.ts', 'desfaz para', 'documento vazio (ja aconteceu)')
checar('Catalogo unico', 'app/api/billing/invoices/route.ts', 'pricing_items', 'duas listas de preco')
checar('Relatorios: so o socio (verRelatorios)', 'app/api/billing/reports/route.ts', 'perms.verRelatorios', 'gerente veria os totais do negocio')
checar('Relatorios: orcamento e rascunho fora do faturamento', 'app/api/billing/reports/route.ts', "not('status', 'in', '(draft,void)')", 'faturamento inflado por rascunho/cancelada')

titulo('COBRANCA PELO STRIPE: O VALOR QUE A TELA MOSTRA E O QUE A ROTA COBRA')
// O botao "Cobrar no cartao" mostrava o valor digitado e a chamada nao o
// mandava; a rota cobrava o saldo inteiro, sempre -- o cliente que ia pagar
// uma parte via o total na pagina do Stripe. Mesma classe do botao x trava:
// cada arquivo sozinho parecia certo. Agora a tela MANDA o valor, tela e rota
// decidem pela mesma regra pura (lib/cobranca-balcao.ts) e a sessao do Stripe
// nasce pelo valor decidido -- nunca mais por `saldo` direto.
checar('A tela manda o valor digitado ao gerar a cobranca', 'app/dashboard/billing/page.tsx',
       /stripe-checkout'[\s\S]{0,400}?body:\s*JSON\.stringify\(\{[^}]*\bvalor\b/,
       'o botao mostra um valor e a rota cobra outro')
checar('A tela decide o valor pela mesma regra da rota', 'app/dashboard/billing/page.tsx',
       /decidirValorDaCobranca\(/, 'previa da tela diverge da trava')
checar('A rota decide o valor pela regra pura, com o valor pedido', 'app/api/billing/stripe-checkout/route.ts',
       /decidirValorDaCobranca\(\{[\s\S]{0,200}?pedido:\s*body\.valor/, 'rota ignora o valor pedido')
recusar('A sessao do Stripe nao nasce pelo saldo direto', 'app/api/billing/stripe-checkout/route.ts',
        /unit_amount\]':\s*String\(Math\.round\(saldo \* 100\)\)/, 'cobrar o saldo inteiro era o defeito')
checar('A sessao do Stripe nasce pelo valor decidido', 'app/api/billing/stripe-checkout/route.ts',
       /unit_amount\]':\s*String\(Math\.round\(valor \* 100\)\)/, 'o valor decidido tem de ser o cobrado')

titulo('RELATORIOS: NADA DE FORA ENTRA NO SCRIPT')
checar('Barra: destino vai em atributo, nao dentro do script', 'lib/relatorio-barra.ts', 'data-destino=', 'parametro com </script> injetaria codigo na sessao da equipe')
checar('Barra: escapa o que sai em HTML', 'lib/relatorio-barra.ts', 'export function escaparHtml', 'nome de conta da URL viraria HTML')
// O periodo (from/to ou year/month) e remontado na URL do "Voltar ao P&L":
// so entra o que periodoDosParametros validou (data que existe), nunca o
// parametro cru.
checar('Detalhe da conta: periodo validado antes de virar URL', 'app/api/bookkeeping/category-detail/route.ts', /const periodo = periodoDosParametros\(/, 'from/to crus voltariam para o link do Voltar')
recusar('Detalhe da conta: o link do Voltar nao leva parametro cru', 'app/api/bookkeeping/category-detail/route.ts', /pnlUrl[\s\S]{0,200}?sp\.get\(/, 'so data validada entra na URL do P&L')
checar('Detalhe da conta: categoria escapada', 'app/api/bookkeeping/category-detail/route.ts', 'escaparHtml(category)', 'XSS refletido pelo nome da conta')

titulo('RELATORIO CONTABIL: UM PERIODO, FILTRO POR DATA, TODAS AS LINHAS')
// P&L, Balanco, Fornecedores/1099 e o detalhe por conta liam com
// .limit(10000)/.limit(20000) -- o PostgREST corta em 1000 e NAO avisa, e o
// numero de imposto saia truncado em silencio para cliente com mais de mil
// lancamentos aprovados no ano. E cada rota lia o periodo do seu jeito (year,
// year+month, 31/12 fixo), enquanto a tela oferecia so ano e mes. Agora a
// conversao do periodo e UMA (lib/periodo-relatorio.ts: from/to ou year, e
// asOf no Balanco, que e "em tal data"), o filtro e por tx_date (fiscal_year
// nasce dela e so sabe o ano) e a leitura e paginada (lib/paginar.ts). As
// tres telas que abrem relatorio usam o mesmo seletor, senao a tela oferece
// um periodo que a rota nao entende.
{
  const ROTAS = {
    'app/api/bookkeeping/pnl/route.ts':             /periodoDosParametros\(/,
    'app/api/bookkeeping/category-detail/route.ts': /periodoDosParametros\(/,
    'app/api/bookkeeping/vendors/route.ts':         /periodoDosParametros\(/,
    'app/api/bookkeeping/balance-sheet/route.ts':   /dataDeCorteDosParametros\(/,
  }
  for (const [arq, periodo] of Object.entries(ROTAS)) {
    const nome = arq.split('/').slice(-2)[0]
    if (!existsSync(join(raiz, arq))) { falta(`${nome}: periodo unico e leitura paginada`, `arquivo inexistente: ${arq}`); continue }
    // Sem comentarios: o comentario que explica o defeito cita `.limit(10000)`
    const codigo = readFileSync(join(raiz, arq), 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    if (!periodo.test(codigo)) falta(`${nome} le o periodo por lib/periodo-relatorio`, 'rota com conta propria de periodo diverge da tela e das irmas')
    else if (/\.limit\(\s*\d{4,}\s*\)/.test(codigo)) falta(`${nome} le todas as linhas`, '.limit(N) a partir de 1000 e truncamento silencioso: o PostgREST para em 1000')
    else if (/\.eq\(\s*'fiscal_year'/.test(codigo)) falta(`${nome} filtra por tx_date`, 'fiscal_year so sabe o ano; trimestre e mes precisam da data')
    // O generico (`todasAsLinhas<T>(`) fica entre o nome e o parentese
    else if (!/todasAsLinhas(<[\s\S]{0,200}?>)?\s*\(/.test(codigo)) falta(`${nome} le todas as linhas`, 'sem todasAsLinhas a leitura para em 1000')
    else ok(`${nome}: periodo unico, filtro por data e leitura paginada`)
  }
  for (const tela of ['components/BookkeepingTab.tsx', 'components/portal/ClientReports.tsx', 'app/dashboard/billing/page.tsx']) {
    checar(`${tela.split('/').pop()} usa o seletor de periodo da casa`, tela, /<SeletorPeriodo\b/, 'periodo calculado na tela diverge do que a rota entende')
  }
  // "Hoje" dos atalhos e o dia do ESCRITORIO, nao o relogio do navegador em UTC
  recusar('O seletor nao usa toISOString para "hoje"', 'components/SeletorPeriodo.tsx', /toISOString\(/, 'as 21h de Malden "este mes" ja era o mes seguinte')
  checar('O seletor usa o dia da firma', 'components/SeletorPeriodo.tsx', /dataDaFirma\(/, 'o atalho tem de nascer no dia do escritorio')
}

titulo('1099: A CONTA MARCADA NO PLANO DECIDE, COM O LIMITE DO ANO')
// A lista fixa no codigo (Contract Labor e Subcontractors) deixava de fora
// advogado, aluguel e toda conta nova, e ninguem fora do codigo mudava isso.
// Decisao do socio: um botao em cada conta de despesa do plano de contas
// (bookkeeping_categories.form_1099), e TODA despesa paga na conta marcada
// entra. Tres regras de lei que a lista nao tinha: o limite muda com o ano
// (600 ate 2025, 2000 a partir de 2026), cartao de credito e PayPal, Venmo e
// Cash App vao no 1099-K e ficam fora, e grafias do mesmo prestador somam
// juntas. A regra mora em lib/relatorio-1099.ts, testada.
{
  const V = 'app/api/bookkeeping/vendors/route.ts'
  recusar('O 1099 nao usa lista fixa de contas', V, /CATS_1099/, 'a lista fixa ignora a marca que o socio poe no plano de contas')
  checar('O 1099 apura pelo modulo puro', V, /apurar1099\(\{/, 'conta de 1099 feita na rota diverge da testada')
  recusar('A rota do 1099 nao fixa o limite', V, />=\s*(600|2000)\b/, 'o limite muda com o ano: 600 ate 2025, 2000 a partir de 2026')
  checar('O limite do 1099 muda em 2026', 'lib/relatorio-1099.ts', /desde:\s*2026,\s*valor:\s*2000/, 'pagamento a partir de 2026 tem limite de US$ 2.000')
  checar('O cartao de credito fica fora do 1099', V, /type === 'credit_card'/, 'pagamento no cartao vai no 1099-K, nao no NEC/MISC')
  // A RECUSA, nao a mencao: a funcao aparece tambem na linha que tira a marca
  // de quem muda de grupo, e a primeira versao passava com a recusa desligada.
  // A regra saiu da rota para lib/plano-de-contas.ts (a tela e a rota chamam
  // a mesma), e o banco recusa de novo na gravacao.
  checar('A marca do 1099 so vai em conta de despesa', 'lib/plano-de-contas.ts',
         /if \(f && !ehContaDeDespesa\(kind\)\) return recusa\('Só conta de despesa vai para o 1099\.'\)/,
         'receita marcada para o 1099 nao faz sentido')
  checar('O banco tambem recusa 1099 fora de despesa', 'sql/plano-de-contas-edicao-funcao-v1.sql',
         /p_form_1099 is not null and \(p_form_1099 not in \('NEC', 'MISC'\) or not v_despesa\)/,
         'a gravacao aceitaria a marca numa conta de receita')
  checar('A tela marca o 1099 pela rota', 'app/dashboard/accounts/page.tsx', /form1099:/, 'botao do 1099 sem chamada a rota')
}

titulo('PLANO DE CONTAS: EDITAR E UMA TRANSACAO, E A CONTA DO SISTEMA NAO MUDA')
// O lancamento guarda o NOME da conta, e o P&L trata nome que o plano nao tem
// como DESPESA (`kindMap[c] || 'expense'`). A rota renomeava a conta e depois,
// em idas separadas e sem olhar erro, os lancamentos, as regras e as
// sub-contas: um renomear pela metade mandava a receita da conta antiga para
// as despesas de todos os clientes, e a tela dizia "conta atualizada". Apagar
// tinha o mesmo desenho. E renomear 'Transfer' ou 'Credit Card Payment' fazia
// o motor seguir gravando o nome antigo: toda transferencia nova virava
// despesa. Agora a regra e de lib/plano-de-contas.ts (a tela e a rota chamam a
// mesma) e a gravacao e uma funcao do banco, com trilha, tudo ou nada.
{
  const R = 'app/api/bookkeeping/categories/route.ts'
  const T = 'app/dashboard/accounts/page.tsx'
  const M = 'lib/plano-de-contas.ts'
  const F = 'sql/plano-de-contas-edicao-funcao-v1.sql'
  checar('Editar passa pela regra testada', R, /planoDaEdicao\(\{/, 'regra de edicao feita na rota diverge da que a tela mostra e o teste confere')
  checar('Editar grava numa transacao do banco', R, /db\.rpc\('editar_conta_do_plano'/, 'renomear em idas separadas deixa o livro pela metade quando uma falha')
  checar('Apagar passa pela regra e pela transacao', R, /planoDaRemocao\(\{[\s\S]*?db\.rpc\('apagar_conta_do_plano'/, 'apagar com o movimento em idas separadas deixa lancamento com nome de conta que sumiu')
  checar('Desativar confere lancamento E regra, e grava pela transacao', R,
         /recusaDaDesativacao\([\s\S]{0,400}?db\.rpc\('situacao_da_conta_do_plano'/,
         'regra apontando para conta inativa segue lancando nela a cada importacao')
  // Pela AUSENCIA: a rota nao mexe em lancamento, regra, conta a pagar nem no
  // proprio plano por fora da funcao (o insert do POST e a unica escrita).
  recusar('A rota nao reescreve lancamento, regra ou conta a pagar por conta propria', R,
          /\.from\('(bank_transactions|bookkeeping_rules|firm_bills)'\)\s*\.(update|delete|insert)\(/,
          'a cascata fora da transacao e o defeito que isto conserta')
  recusar('A rota nao altera nem apaga conta por fora da transacao', R,
          /\.from\('bookkeeping_categories'\)\s*\.(update|delete)\(/,
          'conta alterada sem a cascata e sem a trilha')
  recusar('Sub-conta nao se acha por LIKE', R, /\.like\(\s*'name'/,
          'LIKE le "_" e "%" do nome como curinga: renomear Meals_Entertainment levava MealsXEntertainment junto')
  checar('A funcao acha sub-conta pelo prefixo exato', F, /left\(f\.name, char_length\(v_prefixo\)\) = v_prefixo/,
         'sem o prefixo exato a cascata pega conta de outro nome')
  {
    const sql = existsSync(join(raiz, F)) ? readFileSync(join(raiz, F), 'utf8') : ''
    const contar = re => (sql.match(re) || []).length
    contar(/for update;/g) >= 3 && contar(/'mudou_no_meio'/g) >= 3
      ? ok('As tres funcoes travam a conta e recusam se ela mudou desde a leitura')
      : falta('As tres funcoes travam a conta e recusam se ela mudou desde a leitura',
              'duas edicoes ao mesmo tempo deixariam os lancamentos com o nome de uma e a conta com o da outra')
    contar(/insert into bookkeeping_category_audit/g) >= 3
      ? ok('As tres funcoes gravam a trilha na mesma transacao')
      : falta('As tres funcoes gravam a trilha na mesma transacao', 'mudanca no plano de todos os clientes sem rastro (principio 2)')
    const motivoNasDuas = contar(/'motivo_obrigatorio'/g) >= 2
    motivoNasDuas
      ? ok('O banco recusa editar ou apagar conta em uso sem motivo')
      : falta('O banco recusa editar ou apagar conta em uso sem motivo', 'trilha de mudanca no livro nascendo sem o porque')
  }
  checar('Conta em uso mudando pede motivo', R, /if \(plano\.exigeMotivo && motivo\.length < MOTIVO_MINIMO\)/, 'a mudanca alcanca o livro de todos os clientes')
  checar('Mudar o grupo de conta em uso pede a senha', R, /if \(plano\.exigeSenha\) \{\s*const recusa = await conferirSenha\(/,
         'o grupo muda o P&L e o Balanco de anos ja declarados (principio 3)')
  checar('A senha vem do grupo que muda numa conta em uso', M, /const exigeSenha = mudouGrupo && lancamentos > 0/,
         'pedir senha onde nao precisa ensina a digitar sem ler; nao pedir onde precisa e o principio 3 quebrado')
  checar('A tela mostra a previa pela mesma regra da rota', T, /planoDaEdicao\(\{/, 'a tela que calcula por conta propria promete o que a rota recusa')
  checar('Cada conta da lista tem o Editar', T, /lista\.map\(c => \{[\s\S]*?abrirEdicao\(c\)[\s\S]{0,200}?Editar/, 'o botao de editar e por conta, na propria linha')
  // As contas que o CODIGO grava pelo nome: todo literal que os pontos que
  // escrevem `category:` usam tem de estar na lista do sistema. Pega o motor
  // ganhando uma conta nova sem a trava. Nao segue variavel (`cat`, `cat0`):
  // os literais delas sao os mesmos dois, ja na lista.
  {
    const mod = existsSync(join(raiz, M)) ? readFileSync(join(raiz, M), 'utf8') : ''
    const bloco = (/export const CONTAS_DO_SISTEMA[^{]*\{([\s\S]*?)\n\}/.exec(mod) || [])[1] || ''
    const literais = new Set([...bloco.matchAll(/^\s*'([^']+)':/gm)].map(m => m[1]))
    const constantes = new Set([...bloco.matchAll(/^\s*\[(CONTA_[A-Z_]+)\]:/gm)].map(m => m[1]))
    const usados = [], ids = []
    for (const arq of ['lib/apply-rules.ts', 'app/api/bookkeeping/categorize/route.ts', 'app/api/bookkeeping/rules/route.ts',
                       'app/api/bookkeeping/transfer-match/route.ts', 'lib/caixa-recebimentos.ts', 'lib/deposito-match.ts']) {
      if (!existsSync(join(raiz, arq))) continue
      const src = readFileSync(join(raiz, arq), 'utf8')
      for (const m of src.matchAll(/\bcategory:\s*([^,\n}]+)/g)) {
        for (const l of m[1].matchAll(/'([^']+)'/g)) usados.push({ nome: l[1], arq })
        for (const k of m[1].matchAll(/\b(CONTA_[A-Z_]+)\b/g)) ids.push({ nome: k[1], arq })
      }
    }
    if (!bloco || usados.length === 0 || ids.length === 0) {
      falta('Conta que o codigo grava pelo nome e conta do sistema',
            'ancora perdida: nao achei CONTAS_DO_SISTEMA ou nenhum `category:` com nome fixo -- a conferencia nao estaria conferindo nada')
    } else {
      const soltos = [...usados.filter(u => !literais.has(u.nome)), ...ids.filter(u => !constantes.has(u.nome))]
      soltos.length === 0
        ? ok(`Conta que o codigo grava pelo nome e conta do sistema (${new Set(usados.map(u => u.nome)).size} literais, ${new Set(ids.map(u => u.nome)).size} constantes)`)
        : falta('Conta que o codigo grava pelo nome e conta do sistema',
                `fora de CONTAS_DO_SISTEMA: ${soltos.map(s => `"${s.nome}" (${s.arq})`).join(', ')} -- renomear a conta faria o codigo gravar um nome que o plano nao tem, e o P&L o contaria como despesa`)
    }
  }
  checar('A rota recusa nome repetido sem diferenca de caixa ao criar', R, /chaveDaConta\(c\.name\) === chaveDaConta\(clean\)/,
         '"office supplies" ao lado de "Office Supplies" divide o P&L de todos os clientes em duas linhas')
}

titulo('IMPRESSO NAO PUBLICA TEXTO DO BANCO SEM ESCAPAR')
// O nome do cliente e digitado por ele no aceite do convite, o payee nasce da
// descricao do extrato e o nome da conta bancaria vem do Plaid. Os quatro
// impressos interpolavam isso cru no HTML: um nome com <script> rodava na
// sessao de quem abrisse o relatorio, inclusive a do socio.
// O padrao olha a POSICAO de texto (depois de `>`, do travessao e dos icones),
// nao qualquer interpolacao: `${g.cat}` dentro do argumento de catLink, que
// escapa, nao e saida de HTML.
{
  const CRU = /(>|— |🏦 |💳 )\s*\$\{\s*(displayName|name|[a-z]\.payee|[a-z]\.name|g\.cat|c)\s*\}/
  for (const arq of ['app/api/bookkeeping/pnl/route.ts', 'app/api/bookkeeping/balance-sheet/route.ts',
                     'app/api/bookkeeping/vendors/route.ts', 'app/api/bookkeeping/category-detail/route.ts']) {
    recusar(`${arq.split('/').slice(-2)[0]} escapa o que vem do banco`, arq, CRU,
            'nome de cliente, payee ou conta sem escaparHtml vira HTML na sessao da equipe')
  }
}

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
checar('Webhook: forma real tambem na entrada', 'app/api/stripe/webhook/route.ts', 'metodo: metodoDoTipo(pag.tipo)', 'entrada por ACH entraria no livro como cartao')
checar('Ancora respeita as 48h do Stripe (e a regua do contrato)', 'lib/plan-checkout.ts', 'ancoraDoDebito(', 'cadastro do debito falha quando o dia acordado esta perto')
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

{
  // O PAPEL NAO PODE SAIR DE user_metadata.
  // user_metadata e gravavel pelo proprio dono do login: com a sessao dele e
  // a anon key do navegador, `auth.updateUser({ data: { role: 'owner' } })`
  // virava firma -- e owner, porque getStaffLevel tambem caia ali. O papel
  // mora em app_metadata, que so a service role escreve.
  // Acesso DIRETO a propriedade, sem medir distancia: medir distancia ja deu
  // falso positivo aqui (user_metadata?.full_name numa linha e .role na
  // seguinte) e ja deixou passar defeito quando a distancia mudou.
  const LE = /user_metadata\s*(\?\.|\.)\s*role\b|user_metadata\s*\[\s*['"]role['"]\s*\]/
  const ESCREVE = /user_metadata:\s*\{[^}]{0,400}?\brole:\s*['"]/s
  let leem = [], escrevem = []
  const candidatos = [...arquivos(join(raiz, 'app'), ['.ts', '.tsx']),
                      ...arquivos(join(raiz, 'lib'), ['.ts']),
                      join(raiz, 'middleware.ts')]
  for (const arq of candidatos) {
    const txt = readFileSync(arq, 'utf8')
    // comentario explicando o historico nao conta
    const codigo = txt.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    if (LE.test(codigo)) leem.push(rel(arq))
    if (ESCREVE.test(codigo)) escrevem.push(rel(arq))
  }
  leem.length
    ? falta('Ninguem LE o papel de user_metadata', `use papelDoLogin/app_metadata: ${leem.join(', ')}`)
    : ok('Ninguem LE o papel de user_metadata')
  escrevem.length
    ? falta('Ninguem GRAVA o papel em user_metadata', `grave em app_metadata: ${escrevem.join(', ')}`)
    : ok('Ninguem GRAVA o papel em user_metadata')
  // Nos arquivos que DECIDEM acesso, user_metadata nao aparece em codigo de
  // jeito nenhum -- nem numa leitura que a janela do regex acima nao cubra.
  // (A primeira versao desta invariante nao pegou a troca de app_ por user_
  // em lib/papeis.ts: o regex media distancia, e a distancia mudou.)
  for (const arq of ['lib/papeis.ts', 'lib/api-auth.ts', 'lib/staff-perms.ts', 'middleware.ts']) {
    const txt = readFileSync(join(raiz, arq), 'utf8')
    const codigo = txt.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const tocaUser = /user_metadata/.test(codigo)
    if (tocaUser) falta(`${arq} nao toca em user_metadata`, 'o campo que o proprio usuario escreve nao decide acesso')
    else ok(`${arq} nao toca em user_metadata`)
  }
  checar('lib/papeis.ts le app_metadata', 'lib/papeis.ts', /app_metadata[\s\S]{0,60}\.role|\.role[\s\S]{0,60}app_metadata|app_metadata as Record/, 'o papel voltou para o campo que o usuario escreve')
}

titulo('AUDITORIA FINANCEIRA: AS TRAVAS DE DINHEIRO')
// Conferir-e-gravar em dois passos nao vale sob concorrencia. O que decide
// dinheiro tem de ser UM passo, no banco.
checar('Estorno manual e atomico no banco', 'app/api/billing/payments/route.ts',
       /rpc\('estornar_recebimento'/,
       'gravar o rastro e apagar o recebimento em dois passos perde o rastro e duplica o estorno')
recusar('Estorno nao grava rastro com erro descartado', 'app/api/billing/payments/route.ts',
        /payment_reversals'\)\.insert\([\s\S]{0,300}?then\(\(\) => null/,
        'se o rastro falhar o recebimento tem de FICAR -- principio 2')
checar('Recebimento acima do saldo e recusado pelo banco', 'sql/recebimento-seguro-v1.sql',
       /Recebimento acima do saldo/, 'a rota confere antes de gravar; a janela fica aberta')
checar('Cronograma e piso da parcela num modulo puro', 'lib/cronograma-parcelas.ts',
       /MINIMO_POR_PARCELA/, 'dinheiro com arredondamento sem teste')
recusar('A rota nao monta cronograma por conta propria', 'app/api/billing/installment-plan/route.ts',
        /function montarCronograma/, 'a conta tem de ser a mesma do modulo testado')
recusar('Relatorio nao corta o periodo em UTC', 'app/api/billing/reports/route.ts',
        /T23:59:59Z`\)/,
        'recebimento das 20h do ultimo dia caia no mes seguinte')
checar('Relatorio usa a janela do escritorio', 'app/api/billing/reports/route.ts',
       /janelaDaFirma\(/, 'o corte do periodo e o do dia da firma')

titulo('A TELA PEDE A MESMA CHAVE QUE A ROTA EXIGE')
// A FALHA DE METODO QUE ISTO FECHA
// As auditorias anteriores olhavam ARQUIVOS: quem chama a rota, qual cliente
// ela alcanca, RLS, erro engolido. Nenhuma perguntou se o BOTAO e a TRAVA
// pedem a mesma coisa -- e eles vivem em arquivos diferentes, entao conferir
// cada um sozinho nunca acha a discrepancia.
// Custou caro: o botao Enviar pedia `cancelar` e a rota exigia `enviar`, e a
// fatura ficava rascunho -- sem chegar ao cliente e sem e-mail. O botao
// Estornar pedia `estornar` e a rota barrava antes em `receber`.
//
// Duas conferencias: a AUTOMATICA, que casa `perms?.X && ... acao(_, 'Y')`
// da tela com `action === 'Y' ... !perms.Z` da rota; e a TABELA, para os
// botoes cujo destino nao da para deduzir lendo.
{
  const tela = readFileSync(join(raiz, 'app/dashboard/billing/page.tsx'), 'utf8')
  const rota = readFileSync(join(raiz, 'app/api/billing/invoices/route.ts'), 'utf8')

  // rota: qual chave cada acao exige
  const exigePorAcao = new Map()
  for (const m of rota.matchAll(/action === '(\w+)'[\s\S]{0,400}?!perms\.(\w+)/g)) {
    if (!exigePorAcao.has(m[1])) exigePorAcao.set(m[1], m[2])
  }

  // tela: qual chave libera cada acao.
  // O `perms` IMEDIATAMENTE ANTERIOR, nao "algum dentro de 400 caracteres" --
  // a primeira versao disto casou `perms?.editar` com o acao('duplicate') da
  // linha seguinte e acusou um defeito que nao existe. Medir distancia de
  // regex ja custou caro neste projeto mais de uma vez.
  const guardas = [...tela.matchAll(/perms\?\.(\w+)/g)].map(m => ({ i: m.index, chave: m[1] }))
  const pedePorAcao = new Map()
  for (const m of tela.matchAll(/acao\([^,]+,\s*'(\w+)'/g)) {
    const antes = guardas.filter(g => g.i < m.index)
    if (!antes.length) continue
    const chave = antes[antes.length - 1].chave
    if (!pedePorAcao.has(m[1])) pedePorAcao.set(m[1], chave)
  }

  let divergem = []
  for (const [acao, pede] of pedePorAcao) {
    const exige = exigePorAcao.get(acao)
    if (!exige) continue
    if (pede !== exige) divergem.push(`${acao}: tela pede ${pede}, rota exige ${exige}`)
  }
  divergem.length
    ? falta('Botao e trava pedem a mesma chave (automatico)', divergem.join(' · '))
    : ok(`Botao e trava pedem a mesma chave (${pedePorAcao.size} acoes conferidas)`)

  // Os que nao dao para deduzir: cada linha e [o que faz, tela, chave da tela, rota, chave da rota]
  const PARES = [
    ['Receber',                'app/dashboard/billing/page.tsx', 'receber',       'app/api/billing/payments/route.ts',         'receber'],
    ['Estornar',               'app/dashboard/billing/page.tsx', 'estornar',      'app/api/billing/payments/route.ts',         'estornar'],
    ['Cobrar de novo',         'app/dashboard/billing/page.tsx', 'receber',       'app/api/billing/recharge/route.ts',         'receber'],
    ['Cancelar parcelamento',  'app/dashboard/billing/page.tsx', 'cancelar',      'app/api/billing/installment-plan/route.ts', 'cancelar'],
    ['Agendar parcelas',       'app/dashboard/billing/page.tsx', 'receber',       'app/api/billing/installment-plan/route.ts', 'receber'],
    ['Relatorios',             'app/dashboard/billing/page.tsx', 'verRelatorios', 'app/api/billing/reports/route.ts',          'verRelatorios'],
  ]
  let semPar = []
  for (const [oque, arqTela, chaveTela, arqRota, chaveRota] of PARES) {
    const t = readFileSync(join(raiz, arqTela), 'utf8')
    const r = readFileSync(join(raiz, arqRota), 'utf8')
    if (!new RegExp(`perms\\??\\.${chaveTela}\\b`).test(t)) semPar.push(`${oque}: a tela nao pede ${chaveTela}`)
    if (!new RegExp(`!perms\\.${chaveRota}\\b`).test(r)) semPar.push(`${oque}: a rota nao exige ${chaveRota}`)
  }
  semPar.length
    ? falta('Botao e trava pedem a mesma chave (tabela)', semPar.join(' · '))
    : ok(`Botao e trava pedem a mesma chave (${PARES.length} pares declarados)`)

  // CONTRATO RECORRENTE: a trava e por NIVEL (socio ou gerente), nao por
  // chave de `perms` -- decisao do socio, porque `receber` tambem se concede
  // a uma pessoa, e com a concessao um assistente passava a definir quanto a
  // carteira paga todo mes.
  //
  // Casar dois textos ("a tela pede X, a rota exige X") nao serve aqui: a
  // regra e uma expressao. Entao a conferencia e mais forte -- A TELA NAO
  // DECIDE. Ela usa a resposta que o servidor mandou pronta, e e o GET que
  // liga as duas pontas. Sem esse elo, botao e trava voltam a poder divergir,
  // que e a falha de metodo que mais custou neste projeto.
  {
    const rota = readFileSync(join(raiz, 'app/api/billing/contratos/route.ts'), 'utf8')
    const tela = readFileSync(join(raiz, 'app/dashboard/billing/page.tsx'), 'utf8')
    const problemas = []

    if (!/const podeMexerEmContrato\s*=\s*\(nivel[\s\S]{0,160}?'owner'[\s\S]{0,60}?'manager'/.test(rota)) {
      problemas.push('a rota nao define podeMexerEmContrato por nivel (owner/manager)')
    }
    // As DUAS portas de escrita: criar e alterar. O nivel vem de
    // getStaffLevel (team_members), nao de `perms`: a concessao individual
    // de `receber` nao pode abrir o contrato.
    const guardas = (rota.match(/if \(!podeMexerEmContrato\(await getStaffLevel\(auth\.userId\)\)\)/g) || []).length
    if (guardas < 2) problemas.push(`so ${guardas} rota(s) de escrita travam por nivel -- esperado POST e PATCH`)
    // O elo: o GET manda a resposta pronta, calculada pela MESMA funcao.
    if (!/podeContrato:\s*podeMexerEmContrato\(nivel\)/.test(rota)) {
      problemas.push('o GET nao manda podeContrato calculado por podeMexerEmContrato')
    }
    // E a tela OBEDECE, em vez de recalcular a regra por conta propria.
    if (!/const podeContrato = !!planosDados\.podeContrato/.test(tela)) {
      problemas.push('a tela nao le podeContrato do servidor')
    }
    // Estreito de proposito: olha a ATRIBUICAO de podeContrato, nao qualquer
    // mencao a nivel na tela. A primeira versao desta conferencia acusou a
    // aba de Autorizacao, que le o nivel por motivo proprio e nao tem nada a
    // ver com contrato -- invariante que reprova codigo certo ensina a
    // cadastrar excecao.
    if (/podeContrato\s*=\s*(?!!!planosDados)[\s\S]{0,120}?nivel/.test(tela)) {
      problemas.push('a tela calcula podeContrato a partir do nivel -- ela tem de obedecer o servidor')
    }
    problemas.length
      ? falta('Contrato recorrente: a trava e por nivel e a tela obedece', problemas.join(' · '))
      : ok('Contrato recorrente: trava por nivel no POST e no PATCH, e a tela obedece o servidor')
  }

  // O estorno tem chave PROPRIA: barrar antes em `receber` torna `estornar`
  // sozinho inutil, e separar as duas coisas e o motivo de existirem duas.
  recusar('Estorno nao e barrado por `receber` antes da chave dele',
          'app/api/billing/payments/route.ts',
          /permissoesFinanceiro\(auth\.userId\)\s*\n\s*if \(!perms\.receber\)/,
          'quem recebe `estornar` sem `receber` via o botao e levava 403')
}

titulo('MANDAR DOCUMENTO AO CLIENTE PEDE A CHAVE `enviar`')
// A tela pedia `cancelar` para o botao Enviar e a rota exigia `enviar`: quem
// recebesse a autorizacao de enviar continuava sem o botao, e a fatura ficava
// rascunho para sempre -- nao chega ao portal do cliente nem sai e-mail.
// Reenviar e Cobrar tinham o mesmo acoplamento, nos dois lados.
recusar('Tela: Enviar nao depende de `cancelar`', 'app/dashboard/billing/page.tsx',
        /status === 'draft' && perms\?\.cancelar/,
        'o botao sumia para quem PODE enviar, e a fatura ficava rascunho')
checar('Tela: Enviar depende de `enviar`', 'app/dashboard/billing/page.tsx',
       /status === 'draft' && perms\?\.enviar/, 'a tela e a rota tem de pedir a mesma chave')
recusar('Rota: reenviar/cobrar nao depende de `cancelar`', 'app/api/billing/invoices/route.ts',
        /action === 'remind'[\s\S]{0,200}?!perms\.cancelar/,
        'mandar documento ao cliente e ENVIAR; soltar cancelar soltava o envio junto')

titulo('POR QUE O CLIENTE NAO RECEBEU: HA COMO PERGUNTAR')
// O caso "o cliente nao recebeu e nao ve nada no portal" ja foi diagnosticado
// errado tres vezes. As causas sao parecidas por fora e diferentes por
// dentro, e a pior nao tem erro em lugar nenhum: a fatura esta num cadastro e
// o LOGIN do cliente esta em OUTRO (duplicata da importacao). O portal procura
// pelo user_id, entao aquele cliente nunca ve aquela fatura.
checar('Ha diagnostico por fatura', 'app/api/billing/diag-envio/route.ts',
       /numero=INV/, 'sem ele, a proxima vez tambem sera por adivinhacao')
checar('O diagnostico procura cadastro duplicado', 'app/api/billing/diag-envio/route.ts',
       /chaveDoNome/, 'a causa que ninguem adivinha e a duplicata da importacao')
recusar('Aviso no portal nao falha em silencio', 'lib/avisos.ts',
        /chat_messages'\)[\s\S]{0,200}?then\(\(\) => null/,
        'quando o e-mail nao sai, o portal e o unico canal que resta')

titulo('E-MAIL AO CLIENTE: O RESULTADO NAO SE DESCARTA')
// enviarEmail devolve { ok, motivo }. Descartar isso e o que fazia "o cliente
// nao recebeu a fatura" nao ter pista nenhuma -- nem para quem enviou, nem
// depois na trilha. Tres dos cinco pontos de envio faziam `await
// enviarEmail(...)` e seguiam em frente.
{
  let descartam = []
  const candidatos = [...arquivos(join(raiz, 'app/api'), ['route.ts']),
                      ...arquivos(join(raiz, 'lib'), ['.ts'])]
  for (const arq of candidatos) {
    const txt = readFileSync(arq, 'utf8')
    if (rel(arq) === 'lib/avisos.ts') continue          // e quem define
    const codigo = txt.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    // `await enviarEmail(` no inicio de uma expressao, sem nada recebendo
    if (/(^|[;{}]\s*)\s*await\s+enviarEmail\s*\(/m.test(codigo)) descartam.push(rel(arq))
  }
  descartam.length
    ? falta('Resultado de enviarEmail nao se descarta', `guarde o { ok, motivo }: ${descartam.join(', ')}`)
    : ok('Resultado de enviarEmail nao se descarta')
  checar('Ha diagnostico de e-mail para o socio', 'app/api/avisos/diag/route.ts',
         /porqueNaoTenta|RESEND_API_KEY/, 'sem ele "o cliente nao recebeu" nao tem por onde comecar')
  checar('O diagnostico reusa a regra do envio', 'app/api/avisos/diag/route.ts',
         /from '@\/lib\/avisos'/, 'diagnostico que calcula por conta propria mente quando o envio muda')
}

titulo('CONSULTA LADO A LADO NAO PODE TER ERRO ENGOLIDO')
// Num Promise.all, conferir o erro de UMA consulta e ignorar o das outras faz
// a consulta que falhou virar lista vazia -- e lista vazia, na tela, e uma
// afirmacao: "nao ha servico cadastrado", "nao ha pagamento". Foi o que
// escondeu o catalogo de servicos da fatura, e no impresso teria mandado
// embora uma fatura SEM ITENS, ou sem os pagamentos ja feitos.
// Ignorar de proposito e legitimo -- entao capture o erro e nao o use, que
// ai a decisao aparece no codigo em vez de sumir na desestruturacao.
{
  const BLOCO = /const\s*\[(.*?)\]\s*=\s*await\s+Promise\.all/gs
  let engolidos = []
  for (const arq of arquivos(join(raiz, 'app/api'), ['route.ts'])) {
    const txt = readFileSync(arq, 'utf8')
    for (const m of txt.matchAll(BLOCO)) {
      const campos = m[1].match(/\{[^{}]*\}/g) || []
      const semErro = campos.filter(c => c.includes('data') && !c.includes('error'))
      // A primeira versao so acusava quando ALGUM irmao conferia o erro -- e
      // deixou passar o /api/portal/billing, onde NENHUM dos quatro conferia.
      // Era justamente o pior caso: o portal do cliente mostrando zero, que
      // na tela e uma afirmacao ("voce nao tem nada para pagar").
      if (semErro.length) {
        const linha = txt.slice(0, m.index).split('\n').length
        engolidos.push(`${rel(arq)}:${linha}`)
      }
    }
  }
  engolidos.length
    ? falta('Consulta lado a lado nao tem erro engolido', `capture o error: ${engolidos.join(', ')}`)
    : ok('Consulta lado a lado nao tem erro engolido')
}

titulo('ROTA DE EQUIPE QUE RECEBE UM CLIENTE PASSA PELO ESCOPO')
// Conferir QUEM chama (isStaff) nao e conferir QUAL CLIENTE. O escopo por
// TIPO -- assistente em pessoa fisica, empresa exige verEmpresas -- e
// canAccessClient. Nove rotas ficaram de fora quando o escopo foi criado
// (entre elas clients/profile e clients/access): bastava passar o id de uma
// empresa. Resumo que agrega a carteira usa clientesOcultos.
{
  const PEGA_CLIENTE = /(searchParams\.get\(['"]clientId|\bclientId\b\s*[,}]|clientId\s*=\s*(body|await))/
  let fora = []
  for (const arq of arquivos(join(raiz, 'app/api'), ['route.ts'])) {
    const txt = readFileSync(arq, 'utf8')
    const codigo = txt.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    // A CHAMADA, nao o import: trocar a chamada por `true` e deixar o
    // import deixaria a invariante passar (testado -- passava).
    const semImports = codigo.split('\n').filter(l => !/^\s*import\b/.test(l)).join('\n')
    if (/\b(canAccessClient|clientesOcultos)\s*\(/.test(semImports)) continue
    if (!/isStaff/.test(codigo)) continue
    if (PEGA_CLIENTE.test(codigo)) fora.push(rel(arq))
  }
  fora.length
    ? falta('Toda rota de equipe com clientId passa pelo escopo', `sem canAccessClient: ${fora.join(', ')}`)
    : ok('Toda rota de equipe com clientId passa pelo escopo')
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
    'app/api/agenda/tipos/route.ts',
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

  // VERBO POR VERBO. Conferir o ARQUIVO deixou passar /api/send-invite: o
  // POST tinha getAuth e o GET nao, e o GET entregava a lista de convites --
  // com o TOKEN que cria a conta -- a qualquer cliente logado no portal.
  // Cada GET/POST/PUT/PATCH/DELETE exportado precisa conferir quem chama no
  // proprio corpo, ou chamar uma funcao do mesmo arquivo que confere (a
  // relacao e seguida em cadeia: helper que chama helper que confere vale).
  // Comentario sai antes: o comentario que EXPLICA o getAuth nao confere nada.
  const semComentario = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const verbosSoltos = []
  let verbosVistos = 0
  for (const arq of arquivos(join(raiz, 'app', 'api'), ['route.ts'])) {
    const nome = rel(arq)
    if (ABERTAS.includes(nome)) continue
    const cod = semComentario(readFileSync(arq, 'utf8'))
    const funcs = [...cod.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*(?:async\s*)?\(/g)]
      .map(m => ({ nome: m[1] || m[2], i: m.index }))
    // O corpo vai ate a proxima funcao: corta CEDO, nunca tarde -- erra para
    // o lado de acusar, nunca para o de deixar passar.
    const corpo = (i) => {
      const prox = funcs.filter(f => f.i > i + 30).map(f => f.i)
      return cod.slice(i, prox.length ? Math.min(...prox) : cod.length)
    }
    const conferem = new Set()
    for (let volta = 0; volta < 4; volta++) for (const f of funcs) {
      const c = corpo(f.i)
      if (CONFERE.test(c) || [...conferem].some(n => new RegExp(`\\b${n}\\(`).test(c))) conferem.add(f.nome)
    }
    for (const v of cod.matchAll(/export\s+(?:async\s+function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE)\b/g)) {
      verbosVistos++
      const c = corpo(v.index)
      const ok = CONFERE.test(c) ||
        [...conferem].some(n => n !== v[1] && new RegExp(`\\b${n}\\(`).test(c))
      if (!ok) verbosSoltos.push(`${nome} ${v[1]}`)
    }
  }
  if (verbosVistos === 0)
    falta('Cada verbo de cada rota confere quem chama', 'nenhum verbo exportado encontrado -- a conferencia perdeu a ancora')
  else if (verbosSoltos.length)
    falta('Cada verbo de cada rota confere quem chama', `sem conferencia no proprio verbo: ${verbosSoltos.join(', ')}`)
  else
    ok(`Cada verbo de cada rota confere quem chama (${verbosVistos} verbos)`)
}

titulo('O NAVEGADOR NAO LE TABELA DIRETO')
// Quem trabalha as tabelas e o servidor, com a service role; o navegador vai
// por rota de /api. sql/rls-tabelas-expostas-v3.sql dizia ter conferido
// "zero .from() em client component" -- e havia dois: a pagina publica
// /agendar lia meeting_types com a anon key, e a agenda da equipe lia e
// gravava staff_availability com a sessao. Fechar as tabelas tiraria as duas
// telas do ar. Esta conferencia e a que faltava: todo arquivo do navegador
// ("use client", ou que cria cliente de navegador) sem consulta a tabela.
// Array.from, storage.from (arquivo, nao tabela) e Buffer.from ficam fora.
{
  const semComent = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const doNavegador = []
  for (const arq of [...arquivos(join(raiz, 'app'), ['.tsx', '.ts']),
                     ...arquivos(join(raiz, 'components'), ['.tsx', '.ts']),
                     ...arquivos(join(raiz, 'lib'), ['.tsx', '.ts'])]) {
    const bruto = readFileSync(arq, 'utf8'), cod = semComent(bruto)
    if (/^\s*['"]use client['"]/.test(bruto) || /createBrowserClient\(|supabaseBrowser\(/.test(cod)) doNavegador.push([arq, cod])
  }
  const diretos = []
  for (const [arq, cod] of doNavegador) {
    const achados = [...cod.matchAll(/(\w+|\))\s*\.from\(\s*['"`](\w+)/g)]
      .filter(m => !['Array', 'storage', 'Buffer'].includes(m[1]))
    if (achados.length) diretos.push(`${rel(arq)} (${[...new Set(achados.map(m => m[2]))].join(', ')})`)
  }
  if (!doNavegador.length)
    falta('O navegador nao le tabela direto', 'nenhum arquivo do navegador encontrado -- ancora perdida e FALHA')
  else if (diretos.length)
    falta('O navegador nao le tabela direto',
      `${diretos.join(' · ')} -- va por rota de /api; fechar as tabelas (rls-tabelas-expostas-v3) tiraria a tela do ar`)
  else ok(`O navegador nao le tabela direto (${doNavegador.length} arquivos do navegador)`)
}

titulo('EXCEDENTE DE TRANSACOES: SO CONTA, E COM A FRANQUIA MENSAL')
// A franquia do contrato e POR MES e era comparada com a contagem do ANO
// inteiro: 100/mes contra 590 no ano dava "$612,50 a cobrar" -- e um botao
// lancava isso na fatura do Stripe. A conta tem um lugar so
// (lib/excedente-transacoes.ts), as duas telas usam, e cobrar e faturamento.
recusar('Excedente nao cobra pelo bookkeeping (sem POST)', 'app/api/bookkeeping/overage/route.ts',
  /export\s+(async\s+function|const)\s+POST\b/, 'cobrar excedente e faturamento: alcada de quem emite e de quem da baixa')
recusar('Excedente nao chama o Stripe', 'app/api/bookkeeping/overage/route.ts',
  /from ['"]stripe['"]|new Stripe\(/, 'o contador nao pode lancar item na assinatura do cliente')
recusar('A tela do bookkeeping nao manda cobrar excedente', 'components/BookkeepingTab.tsx',
  /\/api\/bookkeeping\/overage['"`][\s\S]{0,80}method:\s*['"]POST/, 'o botao de cobrar excedente voltou')
for (const arq of ['app/api/bookkeeping/overage/route.ts', 'app/api/bookkeeping/overview/route.ts']) {
  checar(`${arq.split('/').slice(-2, -1)[0]}: franquia pelo modulo unico`, arq,
    // As DUAS chamadas no arquivo, sem medir distancia entre elas (medir
    // distancia de regex ja acusou defeito que nao existia).
    /^(?=[\s\S]*\bvigenciaNoAno\()(?=[\s\S]*\bapurarExcedente\()/,
    'duas telas calculando o mesmo numero de jeitos diferentes -- foi assim que 100/mes virou 100/ano')
}
recusar('Central nao compara franquia mensal com o ano', 'app/api/bookkeeping/overview/route.ts',
  /yearLimit:\s*plan\?\.included_transactions/, 'included_transactions e POR MES')


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
  // A lista vale a da migracao MAIS RECENTE que define o CHECK: a v2 troca
  // o da v1 inteiro. Olhar so a v1 acusaria divergencia a cada chave nova.
  const dirSqlP = join(raiz, 'sql')
  const versoes = existsSync(dirSqlP)
    ? readdirSync(dirSqlP)
        .filter(f => /^permissoes-por-pessoa-v\d+\.sql$/.test(f))
        .sort((a, b) => Number(a.match(/v(\d+)/)[1]) - Number(b.match(/v(\d+)/)[1]))
    : []
  const comCheck = versoes.filter(f =>
    /chave in \(/.test(readFileSync(join(dirSqlP, f), 'utf8')))
  const sql = comCheck.length
    ? readFileSync(join(dirSqlP, comCheck[comCheck.length - 1]), 'utf8') : ''
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

titulo('LIVRO DE MIGRACOES: A CHAVE E O CAMINHO')
// migrar.mjs consulta por `sql/<arquivo>.sql`. Registro anotado a mao com o
// nome curto vira linha orfa e --pendentes segue mandando rodar de novo.
checar('migrar.mjs monta a chave com o caminho', 'scripts/migrar.mjs',
       /const nome = `sql\/\$\{f\}`/,
       'mudou a forma da chave — o CLAUDE.md e os registros manuais precisam acompanhar')
checar('O CLAUDE.md avisa sobre a chave', 'CLAUDE.md',
       /A chave do livro é o CAMINHO/,
       'sem esse aviso, o registro manual sai com o nome curto')

titulo('ESCOPO DA LISTA DE FATURAS E PORTA UNICA DO CADASTRO')
checar('O corte do dia e o do escritorio', 'lib/dia-da-firma.ts',
       /America\/New_York/, 'sem fuso proprio a lista zera as 20h de Malden')
// A lista e do DIA e de QUEM EMITIU. Antes a trava era um `if` solto na
// rota; agora a regra mora em `decidirConsulta` (lib/escopo-faturas.ts), a
// tela chama a MESMA funcao e so o SOCIO e ilimitado. Sao quatro elos, e
// qualquer um que caia devolve a carteira inteira a quem abrir a tela.
{
  const rota = readFileSync(join(raiz, 'app/api/billing/invoices/route.ts'), 'utf8')
  const problemas = []
  if (!/decidirConsulta\(/.test(rota)) problemas.push('a rota nao chama decidirConsulta -- a regra voltou para dentro dela')
  if (!/decisao\.precisaAutorizacao[\s\S]{0,200}status: 403/.test(rota)) {
    problemas.push('a rota nao RECUSA quando falta autorizacao -- lista curta sem explicacao e afirmacao falsa')
  }
  // Dois fatos INDEPENDENTES, nao um por distancia: medir distancia de regex
  // ja acusou defeito que nao existia neste projeto, e o comentario que
  // explica o corte do dia fica justamente entre as duas linhas.
  if (!/q = q\.eq\('created_by', decisao\.filtro\.createdBy\)/.test(rota)) {
    problemas.push('a rota nao aplica o filtro de emissor que decidirConsulta devolveu')
  }
  if (!/q = q\.gte\('created_at', corteDeHoje\(\)\)/.test(rota)) {
    problemas.push('o corte do dia do ESCRITORIO sumiu -- a lista zeraria as 20h de Malden')
  }
  if (!/perms\.nivel === 'owner'/.test(rota)) problemas.push('a rota nao reserva o acesso ilimitado ao socio')
  problemas.length
    ? falta('A lista e do dia e de quem emitiu', problemas.join(' · '))
    : ok('A lista e do dia e de quem emitiu (decidirConsulta, recusa, corte do escritorio, socio ilimitado)')
}
recusar('Enviar nao pega carona em cancelar', 'app/api/billing/invoices/route.ts',
        /if \(!perms\.cancelar\) return NextResponse\.json\(\{ error: 'Enviar/,
        'soltar cancelar passaria a soltar o envio junto, calado')
checar('Enviar tem trava propria', 'app/api/billing/invoices/route.ts',
       /if \(!perms\.enviar\)/, 'a acao send precisa conferir perms.enviar')
// O "criar e enviar" e o "virar fatura e enviar" passam pela MESMA funcao,
// e ela comeca pela trava. Conferir so a primeira chamada deixaria a
// segunda furar a permissao sem ninguem ver.
{
  const inv = readFileSync(join(raiz, 'app/api/billing/invoices/route.ts'), 'utf8')
  const corpoEnviarJa = (() => {
    const i = inv.indexOf('async function enviarJa(')
    if (i < 0) return ''
    const resto = inv.slice(i)
    const j = resto.slice(1).search(/\n(export )?(async )?function /)
    return j < 0 ? resto : resto.slice(0, j + 1)
  })()
  if (!corpoEnviarJa) falta('Criar e enviar passa pela mesma trava', 'enviarJa nao encontrada -- ancora perdida e FALHA')
  else if (!(corpoEnviarJa.indexOf('if (!perms.enviar) return') >= 0
             && corpoEnviarJa.indexOf('if (!perms.enviar) return') < corpoEnviarJa.indexOf('.update(')))
    falta('Criar e enviar passa pela mesma trava', 'enviarJa tem de recusar (if (!perms.enviar) return) ANTES de mudar o status')
  else if (!/b\.enviarAgora\s*\?\s*await enviarJa\(/.test(inv) || !/corpo\.enviarAgora\s*\?\s*await enviarJa\(/.test(inv))
    falta('Criar e enviar passa pela mesma trava', 'o POST e a conversao do orcamento tem de enviar por enviarJa')
  else ok('Criar e enviar passa pela mesma trava')
}
// Fechar a lista e deixar o ?id= aberto e fechar a porta e esquecer a
// janela: bastaria o id para ver a fatura de qualquer um.
checar('O ?id= respeita o mesmo escopo', 'app/api/billing/invoices/route.ts',
       /const minha = doc\.created_by === auth\.userId[\s\S]{0,200}!semLimite[\s\S]{0,120}!autorizado/,
       'filtrar a lista e deixar o id aberto e fechar a porta e esquecer a janela')
// A janela de consulta e lida do ESTADO gravado, e consulta que falha NAO
// pode virar "sem janela" -- isso trancaria quem acabou de ser autorizado,
// e a pessoa concluiria que a senha nao pegou.
checar('A janela de consulta nao vira "sem janela" quando a consulta falha',
       'app/api/billing/invoices/route.ts',
       /errJanela[\s\S]{0,160}does not exist[\s\S]{0,200}status: 500/,
       'erro de leitura engolido tranca quem acabou de ser autorizado')
checar('Cadastro de cliente so muda com autorizacao', 'app/api/clients/profile/route.ts',
       /!perms\.editarCliente/, 'a rota do cadastro precisa exigir editarCliente')
checar('E com senha e motivo', 'app/api/clients/profile/route.ts',
       /signInWithPassword/, 'regra 3: acao sensivel pede senha e motivo')
recusar('A ficha nao e a segunda porta do cadastro', 'app/api/clients/[id]/route.ts',
        /camposDoCliente/,
        'PATCH da ficha aceitava nome, e-mail e telefone sem senha, motivo nem trilha')
checar('A ficha so move o fluxo', 'app/api/clients/[id]/route.ts',
       /CAMPOS_DE_FLUXO = \['stage', 'assignee', 'notes'\]/,
       'a lista de campos do fluxo mudou — confira se nao entrou dado de cadastro')

titulo('PARCELAMENTO: ENTRADA EM DOLAR E CANCELAMENTO')
checar('A conta da entrada vive num modulo so', 'lib/entrada-parcelamento.ts',
       /export function entradaDoPedido/, 'a conta da entrada sumiu')
checar('A rota usa o modulo', 'app/api/billing/installment-plan/route.ts',
       /entradaDoPedido\(\{ saldo/, 'a rota voltou a calcular a entrada sozinha')
checar('A previa da tela usa o MESMO modulo', 'app/dashboard/billing/page.tsx',
       /entradaDoPedido\(\{ saldo: f\.saldo/,
       'tela e servidor calculando a entrada separados mostram numeros diferentes')
recusar('O campo nao pede mais porcentagem', 'app/dashboard/billing/page.tsx',
        /ENTRADA %/, 'para uma entrada de $250 era preciso digitar 25')
checar('Cancelar parcelamento tem caminho proprio', 'lib/parcelamento.ts',
       /'plano_cancelado'/, 'o cancelamento do plano precisa do proprio motivo')
checar('E deixa a fatura em aberto', 'lib/parcelamento.ts',
       /plano_cancelado'\)\s*\{[\s\S]{0,120}payment_plan: 'full'/,
       'cancelar o plano sem reabrir a fatura esconde o saldo devido')
{
  // Contar caracteres entre dois trechos e frageil: o que importa e que as
  // pecas estejam DENTRO do PATCH, nao a distancia entre elas.
  const arq = 'app/api/billing/installment-plan/route.ts'
  const todo = existsSync(join(raiz, arq)) ? readFileSync(join(raiz, arq), 'utf8') : ''
  const i = todo.indexOf('export async function PATCH')
  const patch = i >= 0 ? todo.slice(i) : ''
  const exige = (nome, re, porque) =>
    re.test(patch) ? ok(nome) : falta(nome, patch ? porque : 'PATCH nao encontrado na rota')
  exige('Cancelar exige senha', /signInWithPassword/,
        'parar uma regua de cobranca e acao sensivel — principio 3')
  exige('Cancelar exige motivo', /motivo\.length < 5/, 'sem motivo a trilha nao explica nada')
  exige('Cancelar exige permissao', /!perms\.cancelar/, 'qualquer um pararia a cobranca')
  exige('Cancelar chama a rotina unica', /encerrarParcelamento\(/,
        'cancelar por fora de lib/parcelamento deixa debito orfao no Stripe')
  exige('O cliente e avisado', /avisarNoPortal\(/,
        'o cliente tinha um acordo e um debito automatico: precisa saber que acabou')
  exige('Fica na trilha da fatura', /installment_plan_cancelled/, 'sem rastro na fatura')
  exige('Plano ja encerrado nao cancela de novo', /'cancelled', 'completed'/,
        'rodaria de novo e tentaria cancelar no Stripe algo que nao existe')
  exige('O aviso ao cliente separa proposta de cobranca', /nuncaComecou\s*$/m,
        'dizer que o debito "nao sera mais cobrado" a quem nunca foi cobrado assusta sem motivo')
  checar('A recusa do POST leva o plano existente', arq, /planoExistente: \{ id: ja\.id/,
         'mandar procurar o botao em outra aba e onde a equipe travava')
  // Dentro de criarParcelamento, nao em qualquer lugar do arquivo: o trecho
  // ja morou no criarContrato, que nunca recebe esta recusa, e a conferencia
  // por arquivo passava com o caminho morto.
  {
    const tela = readFileSync(join(raiz, 'app/dashboard/billing/page.tsx'), 'utf8')
    const i = tela.indexOf('const criarParcelamento = async')
    const j = i >= 0 ? tela.indexOf('\n  const ', i + 10) : -1
    const corpo = i >= 0 ? tela.slice(i, j < 0 ? undefined : j) : ''
    if (!corpo) falta('A tela abre o cancelamento na propria recusa', 'criarParcelamento nao encontrado -- ancora perdida e FALHA')
    else if (/d\?\.planoExistente/.test(corpo) && /setPcCancelar\(pl\)/.test(corpo)) ok('A tela abre o cancelamento na propria recusa')
    else falta('A tela abre o cancelamento na propria recusa', 'a recusa tem de oferecer o caminho, nao so o texto -- e no criarParcelamento, que e quem a recebe')
  }
  // Quem decide e o SERVIDOR: a rota devolve `nuncaComecou` e a tela obedece.
  // Este invariante pedia o contrario (a tela lendo os ids do Stripe) e foi
  // justamente esse select que fez a lista de parcelamentos desaparecer.
  checar('A rota decide se o plano chegou a cobrar', arq,
         /nuncaComecou: Number\(p\.paid_installments/,
         'sem isso o modal fala de um debito que nunca existiu')
  checar('A tela obedece o servidor', 'app/dashboard/billing/page.tsx',
         /!!pl\?\.nuncaComecou/, 'a tela voltou a decidir por conta propria')
}


titulo('SCHEMA DO BANCO NAO PODE SER INVISIVEL')
// O gatilho que mantem paid_total/status vivia so no banco. Um comentario
// errado no codigo ("o banco recusa valor parcial") passou a valer como
// regra e ninguem tinha como conferir — a afirmacao era falsa.
checar('O gatilho do saldo esta versionado', 'sql/gatilho-saldo-da-fatura-v1.sql',
       /atualiza_saldo_da_fatura/, 'sem o arquivo, a regra volta a ser folclore')
recusar('Ninguem afirma que o banco recusa parcial', 'app/api/billing/payments/route.ts',
        /banco recusa valor parcial/,
        'o gatilho nao valida nada; pagamento parcial e aceito em qualquer forma')


titulo('CONSULTA QUE FALHA NAO PODE VIRAR LISTA VAZIA')
// Duas vezes o mesmo padrao custou tempo: a importacao que gravou zero e
// pintou de verde, e a aba de parcelamentos que dizia "nenhum" quando a
// consulta tinha falhado. `[]` e verdadeiro em JS; erro tem de vir primeiro.
checar('O GET dos parcelamentos confere o erro', 'app/api/billing/installment-plan/route.ts',
       /error: errPlanos/, 'erro ignorado devolve lista vazia e a tela diz "nenhum"')
checar('A tela trata o erro ANTES da lista', 'app/dashboard/billing/page.tsx',
       /if \(d\?\.error\) \{ setMsg\(`⚠️ \$\{d\.error\}`\); return \}/,
       'checar d.plans primeiro engole o erro, porque lista vazia e truthy')
recusar('A tela nao pede os ids do Stripe na lista', 'app/dashboard/billing/page.tsx',
        /pl\?\.stripe_subscription_id/,
        'pedir essas colunas no select principal foi o que fez a lista desaparecer')


titulo('STATUS DA FATURA E TIPO DO CLIENTE')
checar('O status tem UMA definicao no banco', 'sql/status-da-fatura-v2.sql',
       /create or replace function public\.recalcular_status_da_fatura/,
       'sem a funcao, gatilho e estorno voltam a calcular status separados')
checar('Vencimento vence a entrada', 'sql/status-da-fatura-v2.sql',
       /due_date < public\.data_da_firma\(\) then 'overdue'[\s\S]{0,120}soma > 0 then 'partial'/,
       'se partial vier antes, vencida com entrada sai da lista de vencidas')
checar('O vencimento usa o fuso da firma', 'sql/status-da-fatura-v2.sql',
       /America\/New_York/, 'current_date e UTC: a fatura vencia as 20h de Malden')
recusar('O estorno nao escreve status na mao', 'lib/estorno-stripe.ts',
        /status: Number\(inv\.paid_total \|\| 0\) > 0 \? 'partial' : 'sent'/,
        'era a segunda definicao de status, e com o mesmo defeito do gatilho')
checar('O estorno chama a funcao unica', 'lib/estorno-stripe.ts',
       /rpc\('recalcular_status_da_fatura'/, 'sem isto a fatura reaberta fica com status velho')
checar('Tipo do cliente e editavel', 'app/api/clients/profile/route.ts',
       /'type',/, 'a equipe erra o tipo no cadastro e nao havia como consertar')
checar('Trocar o tipo sincroniza o login', 'app/api/clients/profile/route.ts',
       /trocaDeTipo && current\.user_id/,
       'user_metadata.client_type ficaria divergente do cadastro')
checar('Trocar o tipo tem acao propria na trilha', 'app/api/clients/profile/route.ts',
       /'type_changed'/, 'trocar tipo nao e uma edicao de perfil qualquer')


titulo('CODIGO DE AUTORIZACAO: UM CODIGO, UMA COBRANCA')
checar('A regra do codigo vive num modulo so', 'lib/codigo-autorizacao.ts',
       /export const ALFABETO/, 'o modulo do codigo sumiu')
checar('O alfabeto nao tem caractere ambiguo', 'lib/codigo-autorizacao.ts',
       /ALFABETO = 'ACDEFGHJKMNPQRTUVWXY34679'/,
       'o codigo e DITADO: O x 0 e I x 1 fazem a equipe errar')
// A funcao mora em arquivo SEPARADO da tabela: o SQL Editor do Supabase
// reescreve todo script que contem `create table` e o separador dessa
// reescrita nao entende tag nomeada, partindo o corpo da funcao no meio.
checar('O consumo e atomico no banco', 'sql/codigo-de-autorizacao-funcao-v1.sql',
       /update public\.approval_codes[\s\S]{0,400}usado_em is null[\s\S]{0,200}returning/,
       'conferir antes e gravar depois deixa dois atendentes usarem o mesmo codigo')
recusar('Arquivo que cria tabela nao define funcao', 'sql/codigo-de-autorizacao-v1.sql',
        /create or replace function/i,
        'o SQL Editor do Supabase quebra o corpo da funcao quando o script cria tabela')
{
  // O SQL Editor do Supabase reescreve todo script em que ele acha "tabela
  // criada sem RLS" -- e ele conta como tabela a VARIAVEL de um
  // `select ... into <var>` de plpgsql. Ao reescrever, corta um bloco no
  // meio. Arquivo que cria tabela, portanto, nao atribui variavel por
  // consulta: subconsulta no lugar.
  let arriscados = []
  for (const d of ['.', 'sql']) {
    const dir = join(raiz, d)
    if (!existsSync(dir)) continue
    for (const nome of readdirSync(dir)) {
      if (!nome.endsWith('.sql')) continue
      const arq = join(dir, nome)
      const txt = readFileSync(arq, 'utf8')
      const codigo = txt.split('\n').filter(l => !/^\s*--/.test(l)).join('\n')
      // Excecao unica e nomeada: em whatsapp-atendimento-v1 a variavel e
      // NECESSARIA -- ela descobre qual e a coluna de telefone de clients
      // para montar SQL dinamico. Reescrever seria mudar o que a migracao
      // FAZ, e ela ja foi aplicada. Se um dia precisar rodar de novo, o
      // aviso de RLS do editor tem de ser RECUSADO.
      if (rel(arq) === 'sql/whatsapp-atendimento-v1.sql') continue
      if (!/^\s*create\s+table/im.test(codigo)) continue
      if (/\bselect\b[^;]*\binto\b/is.test(codigo)) arriscados.push(rel(arq))
    }
  }
  arriscados.length
    ? falta('Arquivo que cria tabela nao atribui variavel por consulta',
            `o editor do Supabase inventa tabela com o nome da variavel: ${arriscados.join(', ')}`)
    : ok('Arquivo que cria tabela nao atribui variavel por consulta')
}
checar('O codigo guarda O QUE autorizou', 'sql/codigo-de-autorizacao-v1.sql',
       /invoice_id[\s\S]{0,200}valor[\s\S]{0,200}forma/,
       'sem fatura, valor e forma nao ha rastro de o que foi autorizado')
checar('So gerente ou socio gera', 'app/api/account/approval-code/route.ts',
       /podeAprovar\(nivel\)/, 'qualquer um geraria a propria autorizacao')
checar('Gerar um novo encerra o anterior', 'app/api/account/approval-code/route.ts',
       /\.is\('usado_em', null\)[\s\S]{0,200}expira_em/,
       'tres cliques deixariam tres autorizacoes vivas')
checar('O recebimento consome o codigo', 'app/api/billing/payments/route.ts',
       /rpc\('consumir_codigo_de_autorizacao'/, 'sem isto o codigo nao vale nada')
checar('Nivel de quem emitiu e conferido no uso', 'app/api/billing/payments/route.ts',
       /podeAprovar\(await getStaffLevel\(String\(linha\.emitido_por\)\)\)/,
       'quem deixou de ser gerente nao pode autorizar por codigo antigo')
checar('A trilha diz se foi codigo ou senha', 'app/api/billing/payments/route.ts',
       /aprovadoVia: aprovador\.via/,
       '"aprovado por X" nao diz se X estava presente ou emprestou a senha')


titulo('DOCUSIGN: SANDBOX NAO ASSINA DE VERDADE')
// A tarja vermelha "for demonstration purposes only" no e-mail do cliente
// mostrou que as variaveis de producao nunca foram definidas: o codigo cai no
// sandbox por padrao. Assinatura de sandbox nao vale — nem o contrato, nem o
// 8879 que autoriza o e-file perante o IRS.
checar('O codigo sabe em que ambiente esta', 'lib/docusign.ts',
       /export function ambienteDocusign/, 'sem isso ninguem descobre que esta no sandbox')
checar('E recusa assinar no sandbox', 'lib/docusign.ts',
       /export function exigirProducao/, 'coletar assinatura sem valor e pior que nao coletar')
for (const r of ['app/api/signatures/contract/route.ts', 'app/api/signatures/form8879/route.ts'])
  checar(`${r.split('/')[3]} exige producao`, r, /exigirProducao\(\)/,
         'a rota voltaria a enviar envelope de sandbox')
checar('As variaveis do DocuSign estao no .env.example', '.env.example',
       /DOCUSIGN_BASE_PATH/,
       'nao estavam documentadas — foi por isso que ninguem definiu e caiu no sandbox')


titulo('ASSISTENTE FICA EM PESSOA FISICA, SEM BAIXAR ARQUIVO')
// Era `if (auth.isStaff) return true`: toda a equipe via os quase mil
// cadastros. O socio decidiu que quem atende o balcao fica em pessoa fisica.
checar('canAccessClient olha o TIPO do cliente', 'lib/api-auth.ts',
       /data\.type !== "business"/,
       'sem isso toda a equipe volta a ver a carteira de empresas')
checar('E consulta a autorizacao verEmpresas', 'lib/api-auth.ts',
       /verEmpresas/, 'o funil de ~40 rotas precisa decidir isto aqui')
recusar('canAccessClient nao libera staff de saida', 'lib/api-auth.ts',
        /if \(auth\.isStaff\) return true;/,
        'era esta linha que dava a carteira inteira a todo mundo')
checar('serviceDb mora fora do api-auth', 'lib/service-db.ts',
       /export function serviceDb/,
       'api-auth -> staff-perms -> api-auth e ciclo; controle de acesso nao pode depender de ordem de carga')
checar('A lista de clientes filtra por tipo', 'app/api/clients/route.ts',
       /TIPOS_VISIVEIS/, 'a lista voltaria a trazer empresas para quem nao pode abri-las')
checar('Pedir empresas sem autorizacao RECUSA', 'app/api/clients/route.ts',
       /tipoPedido === 'business' && !perms\.verEmpresas/,
       'trocar em silencio por pessoa fisica devolve uma lista que nao e a pedida')
checar('Baixar arquivo exige autorizacao', 'app/api/documents/[id]/route.ts',
       /baixarArquivo/, 'ver que o documento existe nao e tirar copia do W-2')
checar('O cartao Empresas segue o servidor', 'app/clients/page.tsx',
       /tiposVisiveis\.includes\('business'\)/,
       'a tela nao deve adivinhar o escopo — o servidor e quem conta')


titulo('ACERTAR EMPRESA x PESSOA FISICA EM LOTE')
// A importacao le `Client type` do QuickBooks: ORGANIZATION vira empresa, e
// na carteira real muita PESSOA esta assim. Desde que o tipo virou fronteira
// de acesso, esses cadastros desapareceram de quem atende o balcao.
checar('O criterio vive num modulo puro', 'lib/tipo-do-cliente.ts',
       /export function propostaParaEmpresa/, 'o criterio do tipo sumiu')
checar('Sinal FORTE e FRACO sao separados', 'lib/tipo-do-cliente.ts',
       /fortes: string\[\][\s\S]{0,80}fracos: string\[\]/,
       'palavra de ramo nao pode decidir: "Market" e "Auto" tambem sao sobrenome')
checar('Sem sinal nenhum e que vira pessoa', 'lib/tipo-do-cliente.ts',
       /if \(fracos\.length\) return \{ decisao: 'revisar'/,
       'empresa marcada como pessoa fisica abre a carteira a quem nao deveria ver')
checar('A previa nao grava nada', 'app/api/clients/reclassify/route.ts',
       /export async function GET/, 'o plano tem de vir antes da gravacao')
// Contar caracteres entre dois trechos e fragil — ja errei isso duas vezes
// hoje. Duas conferencias, uma por peca.
checar('Gravar pede motivo', 'app/api/clients/reclassify/route.ts',
       /motivo\.length < 5/, 'sem motivo a ficha nao explica a mudanca')
checar('Gravar pede senha', 'app/api/clients/reclassify/route.ts',
       /signInWithPassword/, 'mudar tipo em lote muda quem ve a carteira')
checar('So grava o que AINDA e empresa', 'app/api/clients/reclassify/route.ts',
       /\.in\('id', ids\)\.eq\('type', 'business'\)/,
       'entre a previa e o clique alguem pode ter mexido')
checar('Bloco com recuo por linha', 'app/api/clients/reclassify/route.ts',
       /for \(const c of parte\)/,
       'update do Postgres e tudo ou nada: um cadastro ruim derrubaria 199')
checar('A trilha e POR CLIENTE', 'app/api/clients/reclassify/route.ts',
       /action: 'type_changed'/, 'uma linha de resumo nao aparece na ficha do cliente')
checar('O login do cliente e sincronizado', 'app/api/clients/reclassify/route.ts',
       /client_type: 'individual'/, 'a copia no user_metadata ficaria divergente')
checar('A resposta diz o que NAO foi feito', 'app/api/clients/reclassify/route.ts',
       /jaNaoEramEmpresa/, 'devolver so o numero bonito esconde o problema')


titulo('PAYEE SUGERE A CONTA, NAO GRAVA')
// Escolher o payee gravava a conta do ultimo lancamento dele. Funciona para o
// fornecedor que sempre cai na mesma conta e erra sempre para o que nao cai —
// ha cliente com o mesmo payee em contas diferentes. E a ultima, sozinha,
// ESCONDE que existem outras.
checar('A contagem vive num modulo puro', 'lib/payee-contas.ts',
       /export function historicoDoPayee/, 'o historico do payee sumiu')
checar('A rota devolve TODAS as contas', 'app/api/bookkeeping/payee-category/route.ts',
       /contas: h\.contas/, 'so a ultima esconde que o payee usa varias')
checar('E avisa quando ha mais de uma', 'app/api/bookkeeping/payee-category/route.ts',
       /variado: h\.variado/, 'sem o aviso quem lanca nao sabe que precisa pensar')
checar('A tela usa o MESMO modulo da rota', 'components/BookkeepingTab.tsx',
       /historicoDoPayee\(/,
       'tela e servidor contando diferente mostram numeros diferentes')
recusar('Escolher o payee nao grava a conta', 'components/BookkeepingTab.tsx',
        /body: JSON\.stringify\(\{ id, category: cat, status: 'auto' \}\)/,
        'era isto que aplicava a conta sozinha ao escolher o payee')
checar('Aplicar a sugestao e um clique', 'components/BookkeepingTab.tsx',
       /const aplicarSugestao = async/, 'sugerir sem um jeito rapido de aceitar so atrasa')
checar('O aceite vai para Reconhecidas, nao ao registro', 'components/BookkeepingTab.tsx',
       /id, category, status: 'auto'/,
       "sem status 'auto' o servidor marca 'reviewed' e pula a aprovacao")
checar('O curinga do LIKE no payee e escapado', 'app/api/bookkeeping/payee-category/route.ts',
       /ilike\('payee', buscaLiteral\(payee\)\)/,
       'um payee chamado "100%" casaria com qualquer coisa comecando em 100')
checar('Consulta que falha nao vira payee sem historico',
       'app/api/bookkeeping/payee-category/route.ts', /errHist/,
       'diria que nao ha sugestao quando ha, e o lancador escolheria no escuro')

titulo('TABELA NOVA NASCE FECHADA PARA O NAVEGADOR')
// No Supabase, tabela nova no schema public ja vem com privilegio para anon e
// authenticated -- a RLS e que segura. Sem `enable row level security`, a
// tabela responde pelo PostgREST a qualquer um com a anon key, que esta no
// navegador de todo mundo que entra no portal. Foi o que aconteceu com
// staff_grants: uma linha inserida de fora concedia qualquer autorizacao.
{
  const sqls = []
  for (const d of ['.', 'sql']) {
    const dir = join(raiz, d)
    if (!existsSync(dir)) continue
    for (const nome of readdirSync(dir)) if (nome.endsWith('.sql')) sqls.push(join(dir, nome))
  }
  const tudo = sqls.map(f => readFileSync(f, 'utf8')).join('\n').toLowerCase()
  const criadas = new Map()
  for (const f of sqls) {
    const txt = readFileSync(f, 'utf8')
    for (const m of txt.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi))
      if (!criadas.has(m[1].toLowerCase())) criadas.set(m[1].toLowerCase(), rel(f))
  }
  let abertas = 0
  for (const [tabela, arq] of [...criadas].sort()) {
    const temRls = new RegExp(`alter\\s+table\\s+(?:public\\.)?${tabela}\\s+enable\\s+row\\s+level\\s+security`).test(tudo)
    if (!temRls) { abertas++; falta(`${tabela} sem RLS (${arq})`, 'tabela em public sem RLS responde ao PostgREST com a anon key') }
  }
  if (!abertas) ok(`as ${criadas.size} tabelas ligam RLS na propria migracao`)
}

titulo('VIEW NOVA TAMBEM NASCE FECHADA')
// View roda com o DONO, nao com quem consulta: RLS na tabela de baixo nao
// protege quem le pela view. Foi assim que wa_relatorio_atendimento
// entregava o historico de atendimento com a anon key, embora
// wa_conversations e wa_messages estivessem fechadas.
{
  const sqls = []
  for (const d of ['.', 'sql']) {
    const dir = join(raiz, d)
    if (!existsSync(dir)) continue
    for (const nome of readdirSync(dir)) if (nome.endsWith('.sql')) sqls.push(join(dir, nome))
  }
  const tudo = sqls.map(f => readFileSync(f, 'utf8')).join('\n').toLowerCase()
  const views = new Map()
  for (const f of sqls) {
    const txt = readFileSync(f, 'utf8')
    for (const m of txt.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi))
      if (!views.has(m[1].toLowerCase())) views.set(m[1].toLowerCase(), rel(f))
  }
  let abertas = 0
  for (const [v, arq] of [...views].sort()) {
    if (!new RegExp(`revoke\\s+all\\s+on\\s+(?:public\\.)?${v}\\s+from`).test(tudo)) {
      abertas++
      falta(`view ${v} sem revoke (${arq})`, 'view roda com o dono: a RLS da tabela nao protege quem le por ela')
    }
  }
  if (!abertas) ok(`as ${views.size} views tiram o privilegio de anon/authenticated`)
}

titulo('POLICY NAO DECIDE POR CAMPO QUE O CLIENTE FORJA')
// Uma policy de RLS em tabela do schema public NAO pode decidir acesso por
// user_metadata / raw_user_meta_data -- esse campo o PROPRIO dono do login
// reescreve (`auth.updateUser({ data: { role: 'firm' } })` com a anon key) --
// nem liberar a tabela com `using (true)`. Foi o buraco que
// sql/rls-tabelas-expostas-v2.sql fechou: pela RLS do PostgREST, que e porta
// separada do app, um cliente do portal forjava o papel e lia dado de
// qualquer cliente, e `public_read_invite_by_token (using true)` entregava os
// TOKENS de convite a quem tivesse a anon key, sem login. O papel mora em
// app_metadata (so a service role escreve la) e quem le essas tabelas e o
// servidor com a service role, que passa por cima da RLS. Policy por
// app_metadata, por auth.uid() ou por `coluna = true` (ex.: `active = true`)
// NAO casa aqui. storage.* e auth.* ficam de fora (grant proprio; o storage e
// divida anotada no cabecalho da v2).
{
  const sqls = []
  for (const d of ['.', 'sql']) {
    const dir = join(raiz, d)
    if (!existsSync(dir)) continue
    for (const nome of readdirSync(dir)) if (nome.endsWith('.sql')) sqls.push(join(dir, nome))
  }
  let conferidas = 0
  let forjaveis = 0
  for (const f of sqls) {
    const txt = readFileSync(f, 'utf8')
    // Cada `create policy ... ;` inteiro. Lazy ate o PRIMEIRO ponto-e-virgula
    // (nao ha `;` dentro do corpo de uma policy); [\s\S] atravessa linhas e
    // parenteses -- [^)]* nao atravessaria o `(select ...)` do USING.
    for (const m of txt.matchAll(/create\s+policy[\s\S]{0,1500}?;/gi)) {
      const stmt = m[0]
      // Alvo: `on [schema.]tabela` logo apos o nome. Pula schema != public.
      const alvo = stmt.match(/\bon\s+(?:("?[a-z_][a-z0-9_]*"?)\.)?"?[a-z_][a-z0-9_]*"?/i)
      const esquema = alvo && alvo[1] ? alvo[1].replace(/"/g, '').toLowerCase() : 'public'
      if (esquema !== 'public') continue
      conferidas++
      const leUserMeta = /user_meta/i.test(stmt)                         // user_metadata e raw_user_meta_data
      const liberaGeral = /\busing\s*\(\s*true\s*\)/i.test(stmt)
                       || /\bwith\s+check\s*\(\s*true\s*\)/i.test(stmt)
      if (leUserMeta || liberaGeral) {
        forjaveis++
        const nm = stmt.match(/create\s+policy\s+"?([^"\n(]+?)"?\s+on\b/i)
        falta(`policy forjavel em ${rel(f)}: ${nm ? nm[1].trim() : '?'}`,
          leUserMeta
            ? 'decide por user_metadata/raw_user_meta_data -- campo que o cliente reescreve; use app_metadata ou a service role'
            : 'using (true) libera a tabela para a anon key')
      }
    }
  }
  // Ancora perdida e FALHA: se o padrao de create policy nao casou em lugar
  // nenhum, a invariante nao esta conferindo nada -- e esse ja foi o modo de
  // falhar que passou despercebido aqui antes.
  if (conferidas === 0) falta('nenhuma create policy conferida', 'ancora perdida: o padrao `create policy` nao casou em nenhum .sql')
  else if (!forjaveis) ok(`as ${conferidas} policies de tabela public nao decidem por campo forjavel`)
}

titulo('CAIXA DA FIRMA (a Peace on Tax como cliente de si mesma)')
// A firma e uma LINHA em `clients` marcada com `is_firm`: assim o livro dela
// usa o mesmo motor dos clientes (Plaid, regras, plano de contas, P&L) em vez
// de uma segunda implementacao -- a quarta copia do motor de classificacao.
// O preco e que a firma aparece por padrao em toda tela que lista cliente, o
// contrario do padrao da casa. O que paga esse preco sao as travas abaixo.
{
  // DENTRO do corpo de canAccessClient, nao "em algum lugar do arquivo":
  // clientesOcultos, logo abaixo, tambem cita idDaFirma e owner, e a
  // invariante passava com a trava da firma REMOVIDA. Medir por distancia ou
  // por "aparece depois" ja acusou defeito que nao existia e deixou passar
  // defeito que existia -- por isso aqui se recorta a funcao.
  const t = readFileSync(join(raiz, 'lib/api-auth.ts'), 'utf8')
  const i = t.indexOf('export async function canAccessClient')
  const corpo = i < 0 ? '' : t.slice(i, t.indexOf('export ', i + 40))
  const temFirma = /idDaFirma/.test(corpo)
  const temSocio = /['"]owner['"]/.test(corpo)
  temFirma && temSocio
    ? ok('O funil de acesso conhece a firma')
    : falta('O funil de acesso conhece a firma',
        'canAccessClient precisa liberar a linha da firma SO para o socio -- gerente tem verEmpresas por nivel e abriria a folha de pagamento da firma')
}
checar('A firma sai das listas (seletor de fatura, contrato, bookkeeping)',
  'lib/api-auth.ts', /clientesOcultos[\s\S]*?idDaFirma/,
  'sem o id da firma no conjunto oculto, ela vira um cliente a quem faturar por engano')
recusar('O nome antigo do escopo nao volta',
  'lib/api-auth.ts', /empresasVedadas/,
  'empresasVedadas dizia so metade: o conjunto agora esconde tambem a firma, e o nome tem de dizer isso')
checar('A firma fica fora da lista de clientes',
  'app/api/clients/route.ts', /query = query\.neq\('id', firma\)/,
  'a firma apareceria no quadro de clientes como uma empresa qualquer')
{
  const t = readFileSync(join(raiz, 'app/api/clients/route.ts'), 'utf8')
  const contagens = (t.match(/q = q\.neq\('id', firma\)/g) || []).length
  contagens >= 2
    ? ok('E fora das CONTAGENS (cartoes de Empresas e Pessoa fisica)')
    : falta('E fora das CONTAGENS (cartoes de Empresas e Pessoa fisica)',
        'contar a firma junto erra o numero que o socio le no cartao -- faltam filtros em contar()/totalDe()')
}
checar('A lista geral de fornecedores tambem passa pelo escopo',
  'app/api/bookkeeping/payees/route.ts', /clientesOcultos\s*\(/,
  '?all=1 agrega a carteira inteira (nome de cada cliente e com quem gasta) e nao recebe clientId -- ficou fora quando o escopo por tipo foi criado')
checar('O caixa da firma e so do socio',
  'app/api/caixa/firma/route.ts', /getStaffLevel\([\s\S]*?\)\)\s*===\s*['"]owner['"]/,
  'sem isto o livro da firma abre para gerente, que tem verEmpresas por nivel')
checar('A marca da firma nao vem do corpo do pedido',
  'app/api/caixa/firma/route.ts', /camposDaFirma\(body\)/,
  'corpo inteiro no update deixaria marcar um CLIENTE como firma -- e o cliente marcado sumiria de todas as listas')
recusar('E nem por um caminho indireto',
  'app/api/caixa/firma/route.ts', /body\.is_firm|body\?\.is_firm|\.\.\.body/,
  'is_firm so pode vir de MARCA_DA_FIRMA')
checar('Uma firma, e uma so (indice unico no banco)',
  'sql/caixa-da-firma-v1.sql', /create unique index if not exists clients_uma_firma[\s\S]*?where is_firm/,
  'duas linhas marcadas dariam dois caixas, e o codigo pega "a" firma')
recusar('O aviso de migracao nao chuta qual coluna falta',
  'app/api/caixa/firma/route.ts', /code === '42703'\s*\|\|/,
  'concluir "falta a migracao do caixa" de QUALQUER 42703 manda o socio rodar a migracao errada -- ele roda, nao acha nada e segue sem saber o que quebrou')
checar('A coluna que falta nao derruba o funil de acesso',
  'lib/caixa-firma.ts', /if \(error\) return null/,
  'o codigo sobe na Vercel antes de a migracao rodar a mao: exigir is_firm ali faria canAccessClient recusar TUDO entre o deploy e a migracao')


titulo('CONCILIACAO DE DEPOSITO (contabilidade fiscal x caixa diario)')
// A firma fecha o livro por REGIME DE CAIXA: a despesa vem do extrato e a
// receita vem do RECEBIMENTO da fatura, que fica numa conta de passagem
// ("Recebimentos a depositar") ate o deposito esvazia-la. No repasse do
// Stripe, a diferenca entre o bruto e o que cai no banco e a TAXA -- sem
// lanca-la, a receita bruta nao fecha com o 1099-K e a taxa nao e deduzida.
checar('A conciliacao e UMA operacao no banco',
  'app/api/caixa/depositos/route.ts', /rpc\('conciliar_deposito'/,
  'sao cinco escritas que valem juntas ou nenhuma -- metade gravada e livro sem conserto')
recusar('E a rota nao lanca nada por fora dela',
  'app/api/caixa/depositos/route.ts', /from\('bank_transactions'\)[\s\S]{0,80}\.(insert|upsert|delete)\(/,
  'lancamento fora da RPC escapa da transacao e da conferencia de valor')
{
  // O valor NAO pode vir do navegador: a tela manda ids, o banco soma.
  const t = readFileSync(join(raiz, 'app/api/caixa/depositos/route.ts'), 'utf8')
  const mandaValor = /p_(bruto|taxa|valor)\s*:/.test(t) || /body\?\.(bruto|valor|taxa)\b/.test(t)
  mandaValor
    ? falta('O valor e recalculado no banco, nunca recebido',
        'numero vindo do navegador nao pode lancar despesa nem receita')
    : ok('O valor e recalculado no banco, nunca recebido')
}
{
  // O indice tem de ser UNICO (senao sincronizar duas vezes dobra a receita
  // do ano) e SIMPLES: `on conflict (payment_id)` nao infere indice PARCIAL,
  // e o PostgREST nao tem como mandar o predicado junto. A v1 criou parcial
  // e a tela falhou em producao com "no unique or exclusion constraint
  // matching the ON CONFLICT specification"; a v2 troca.
  const v2 = readFileSync(join(raiz, 'sql/caixa-conciliacao-v2.sql'), 'utf8')
  const criaUnico = /create unique index if not exists bank_tx_um_por_recebimento[\s\S]{0,80}\(payment_id\)/.test(v2)
  const semPredicado = !/create unique index if not exists bank_tx_um_por_recebimento[\s\S]{0,120}where/.test(v2)
  criaUnico && semPredicado
    ? ok('Sincronizar duas vezes nao dobra a receita (indice unico e SIMPLES)')
    : falta('Sincronizar duas vezes nao dobra a receita (indice unico e SIMPLES)',
        'unico, para nao dobrar a receita; simples, porque `on conflict (payment_id)` nao enxerga indice parcial')
}
{
  // A rotina NAO pode depender da FORMA do indice. Ela dependia: usava
  // `on conflict (payment_id)`, que nao infere indice PARCIAL, e em
  // producao nenhum recebimento entrava. Agora e insert puro + 23505
  // tratado linha a linha -- funciona com indice parcial, simples, ou
  // enquanto a migracao nao roda. O indice segue sendo quem garante que a
  // receita nao dobre; a rotina so nao depende do formato dele.
  const t = readFileSync(join(raiz, 'lib/caixa-recebimentos.ts'), 'utf8')
  const codigo = t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const semOnConflict = !/onConflict/.test(codigo)
  const trataDuplicata = /ehDuplicata\(/.test(codigo) && /23505/.test(codigo)
  semOnConflict && trataDuplicata
    ? ok('A sincronizacao nao depende da forma do indice')
    : falta('A sincronizacao nao depende da forma do indice',
        '`on conflict (payment_id)` nao infere indice parcial: ja derrubou a sincronizacao inteira em producao. Use insert puro e trate 23505.')
}
checar('Estorno DEPOIS do deposito nao se apaga em silencio',
  'lib/caixa-recebimentos.ts', /podeApagar\s*=\s*sobrando\.filter\([\s\S]{0,60}?!\s*\w+\.deposit_tx_id/,
  'o dinheiro ja entrou no banco: apagar a linha deixaria o deposito sem explicacao -- a lista do delete tem de excluir o que ja foi depositado')
checar('Reembolso dentro do repasse nao vira taxa',
  'lib/stripe-repasse.ts', /bt\.type === 'refund'[\s\S]{0,200}det\.reembolsos\s*\+=/,
  'devolucao ao cliente tambem encolhe o repasse -- somada a taxa, vira despesa que nao existiu e receita que continua lancada')
checar('E a tela avisa quando ha reembolso no repasse',
  'app/api/caixa/depositos/route.ts', /reembolsos\s*<\s*0/,
  'sem o aviso, a devolucao entra como taxa e a receita continua lancada')
checar('Deposito maior que os recebimentos e RECUSADO',
  'sql/caixa-conciliacao-funcao-v1.sql', /falta_recebimento/,
  'entrou dinheiro sem recebimento lancado: nao e taxa negativa, e fatura que ninguem baixou')
checar('Da para desfazer a conciliacao',
  'sql/caixa-conciliacao-funcao-v1.sql', /create or replace function public\.desconciliar_deposito/,
  'sem desfazer, errar a selecao so se conserta com SQL na mao')
recusar('A funcao nao atribui variavel por consulta',
  'sql/caixa-conciliacao-funcao-v1.sql', /select[\s\S]{0,200}?\sinto\s+v_/i,
  'o detector de RLS do SQL Editor le `select ... into <var>` como criacao de tabela e reescreve o arquivo')
{
  // Tela e trava tem de fazer a MESMA conta -- a falha que mais custou caro
  // aqui foi botao e rota pedindo coisas diferentes.
  const tela = readFileSync(join(raiz, 'components/CaixaDepositos.tsx'), 'utf8')
  const rota = readFileSync(join(raiz, 'app/api/caixa/depositos/route.ts'), 'utf8')
  const mesma = /from '@\/lib\/deposito-match'/.test(tela) && /conferirDeposito/.test(tela)
             && /from '@\/lib\/deposito-match'/.test(rota)
  mesma
    ? ok('A tela e a rota fazem a MESMA conta do deposito')
    : falta('A tela e a rota fazem a MESMA conta do deposito',
        'duas contas diferentes para o mesmo numero e o defeito que a auditoria existe para pegar')
}


titulo('A CREDENCIAL DO BANCO NO CI')
// A primeira execucao do workflow falhou com erro de SOCKET LOCAL tendo o
// secret gravado: o psql aceita URI ou NOME DE BANCO no primeiro argumento,
// e texto sem `postgresql://` vira nome de banco. O erro fala de socket e o
// defeito e o formato do texto -- ninguem liga uma coisa a outra.
{
  // DENTRO de viaPsql, nao "em algum lugar do arquivo": a conferencia do
  // modo --credencial usa as mesmas palavras, e a invariante passava com a
  // trava REMOVIDA do caminho que de fato chama o psql. Terceira vez que
  // "aparece no arquivo" engana -- por isso aqui se recorta a funcao.
  const t = readFileSync(join(raiz, 'scripts/migrar.mjs'), 'utf8')
  const i = t.indexOf('function viaPsql')
  const corpo = i < 0 ? '' : t.slice(i, t.indexOf('\nasync function', i) + 1)
  const confere = /credencialDoPostgres\(/.test(corpo)
  const usaOerro = /cred\.erro/.test(corpo)
  const passaAoPsql = /spawnSync\('psql', \[cred\.url/.test(corpo)
  confere && usaOerro && passaAoPsql
    ? ok('O formato da cadeia e conferido antes do psql')
    : falta('O formato da cadeia e conferido antes do psql',
        'sem isso o defeito aparece como erro de socket tres passos adiante, falando de uma coisa que nao tem nada a ver')
}
checar('E o job do GitHub confere no passo da credencial',
  '.github/workflows/migrar.yml', /migrar\.mjs --credencial/,
  'o passo que diz "credencial" tem de ser o que falha quando a credencial esta errada')
checar('Senha com caractere especial tem saida sem codificacao',
  'scripts/migrar.mjs', /PGPASSWORD: cred\.senha/,
  'dentro da URI o psql corta no PRIMEIRO @ (conferido no PG 16): senha com @ vira erro de "host name". Por variavel de ambiente nao ha parser nenhum.')
checar('E o workflow passa o segundo secret',
  '.github/workflows/migrar.yml', /SUPABASE_DB_PASSWORD: \$\{\{ secrets\.SUPABASE_DB_PASSWORD \}\}/,
  'sem isso a saida existe no script e nao chega ao job')
{
  // A trava do texto de exemplo tem de vir ANTES do atalho da senha
  // separada: na primeira versao ela ficou depois, e no caminho
  // RECOMENDADO nao rodava -- foi assim que `postgres.SEUREF` chegou ao
  // servidor. Ordem, nao presenca.
  const t = readFileSync(join(raiz, 'scripts/credencial-postgres.mjs'), 'utf8')
  const iExemplo = t.indexOf('EXEMPLO.test(')
  const iAtalho = t.indexOf('if (senha) {')
  iExemplo > 0 && iAtalho > 0 && iExemplo < iAtalho
    ? ok('Texto de exemplo e recusado antes do atalho da senha separada')
    : falta('Texto de exemplo e recusado antes do atalho da senha separada',
        'depois do atalho, a trava nao roda justamente no caminho recomendado')
}
checar('E a API de gestao passa pela MESMA trava',
  'scripts/migrar.mjs', /async function viaApi[\s\S]{0,500}?exigirRefCerto\(ref\)/,
  'a primeira versao so cobria o psql: pela API um SUPABASE_PROJECT_REF de outro projeto passava direto. Meia trava e pior que nenhuma.')
checar('Migracao no projeto ERRADO e recusada',
  'scripts/migrar.mjs', /exigirProjetoCerto\(cred\.url\)[\s\S]{0,200}spawnSync\('psql'/,
  'a cadeia de OUTRO projeto Supabase cria as tabelas onde ninguem olha e deixa o certo sem elas -- e isso nao tem desfazer. A conferencia tem de vir ANTES do psql.')
recusar('A mensagem de erro nunca imprime a cadeia',
  'scripts/credencial-postgres.mjs', /\$\{limpo(?!\.length\})|\$\{original|\$\{cru\b|\$\{senha\b/,
  'isto vai para log de CI, e `usuario:senha@host` poe a senha nos primeiros caracteres -- o GitHub so mascara o secret INTEIRO, um trecho passa limpo. '
  + 'A primeira versao proibia `limpo.slice(` e acusou o corte do esquema, que nao imprime nada. O perigo e a INTERPOLACAO do valor num texto -- `${limpo.length}` e liberado de proposito: o TAMANHO ajuda a diagnosticar e nao revela nada.')


titulo('SAIR SEM DERRUBAR O NODE (Windows)')
// `process.exit` com a conexao HTTP da API ainda aberta aborta o Node no
// Windows DEPOIS de imprimir a mensagem:
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\\win\\async.c
// O diagnostico aparece e o usuario leva um crash em cima. Onde ja houve
// rede, o certo e marcar exitCode e deixar o Node fechar o que abriu.
recusar('O fim do script nao chama process.exit',
  'scripts/migrar.mjs', /main\(\)\.catch\([\s\S]{0,160}?process\.exit\(/,
  'com a conexao aberta isso vira Assertion failed no Windows -- use process.exitCode')

titulo('CAMINHO DE ARQUIVO A PARTIR DO MODULO (Windows)')
// `new URL(..., import.meta.url).pathname` devolve `/C:/Users/...` no
// Windows -- com a barra na frente -- e o `join` monta `C:\C:\Users\...`.
// Aconteceu de verdade na maquina do socio:
//   ENOENT: no such file or directory, scandir 'C:\C:\Users\...\sql'
// Nunca apareceu aqui porque estes scripts so tinham rodado em Linux.
{
  // Procura a EXPRESSAO no codigo, nao a palavra no arquivo. A primeira
  // versao dispensava o arquivo que mencionasse `fileURLToPath` em qualquer
  // lugar -- e o proprio comentario que explica o defeito menciona. Passou
  // com o defeito de volta. Terceira vez que "aparece no arquivo" engana.
  let ruins = []
  for (const arq of [...arquivos(join(raiz, 'scripts'), ['.mjs', '.ts']),
                     ...arquivos(join(raiz, 'testes'), ['.mjs', '.mts'])]) {
    const codigo = readFileSync(arq, 'utf8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    if (/import\.meta\.url\s*\)?\s*\.pathname/.test(codigo)) ruins.push(rel(arq))
  }
  ruins.length
    ? falta('Caminho de arquivo sai de fileURLToPath, nunca de .pathname',
        `usa .pathname: ${ruins.join(', ')} -- no Windows isso vira C:\\C:\\...`)
    : ok('Caminho de arquivo sai de fileURLToPath, nunca de .pathname')
}


titulo('OS ARQUIVOS DE COLAR ESTAO EM DIA E NA ORDEM')
// Os arquivos de `colar-no-sql-editor/` gerados por juntar-para-colar.mjs sao
// COPIAS das migracoes, para quem nao tem psql nem token. Duas conferencias,
// para CADA um deles (antes so o do caixa era conferido, com a lista de
// fontes escrita aqui a mao -- o segundo pacote nasceu sem conferencia
// nenhuma, embora o commit dele dissesse o contrario):
//
//  1. EM DIA. Copia que envelhece em silencio e pior que copia nenhuma:
//     alguem cola a versao antiga achando que aplicou a nova. O pacote e
//     regerado em memoria, a partir da linha `-- Origem:` dele, e comparado.
//  2. NA ORDEM. A ordem do pacote tem de respeitar DEPENDE_DE. Funcao antes
//     da tabela quebra no SQL Editor, e quem cola nao tem como saber que a
//     culpa e da ordem do arquivo, nao do SQL.
//
// Ancora perdida e FALHA: pacote gerado sem `-- Origem:`, ou nenhum pacote
// gerado encontrado, quer dizer que nao se esta conferindo nada.
{
  const { montar } = await import(pathToFileURL(join(raiz, 'scripts/juntar-para-colar.mjs')).href)
  const { DEPENDE_DE } = await import(pathToFileURL(join(raiz, 'scripts/ordem-das-migracoes.mjs')).href)
  const pasta = 'colar-no-sql-editor'
  const MARCA = 'GERADO por scripts/juntar-para-colar.mjs'
  const gerados = existsSync(join(raiz, pasta))
    ? readdirSync(join(raiz, pasta)).filter(f => f.endsWith('.sql'))
        .map(f => `${pasta}/${f}`)
        .filter(f => readFileSync(join(raiz, f), 'utf8').includes(MARCA))
    : []
  if (gerados.length === 0) {
    falta('Os arquivos de colar estao em dia e na ordem',
      `nenhum arquivo em ${pasta}/ traz "${MARCA}" -- a conferencia perdeu a ancora`)
  }
  for (const saida of gerados) {
    const texto = readFileSync(join(raiz, saida), 'utf8')
    const m = texto.match(/^-- Origem: (.+)$/m)
    if (!m) {
      falta(`${saida}: em dia e na ordem`, 'sem a linha "-- Origem:" -- nao da para saber de quais migracoes ele e copia')
      continue
    }
    const fontes = m[1].split(',').map(x => x.trim()).filter(Boolean)
    const sumidas = fontes.filter(f => !existsSync(join(raiz, f)))
    if (sumidas.length) {
      falta(`${saida}: em dia e na ordem`, `copia de arquivo que nao existe mais: ${sumidas.join(', ')}`)
      continue
    }
    const esperado = montar(fontes, (a) => readFileSync(join(raiz, a), 'utf8'))
    texto === esperado
      ? ok(`${saida}: em dia com as ${fontes.length} migracoes`)
      : falta(`${saida}: em dia com as migracoes`,
          `regere: node scripts/juntar-para-colar.mjs ${saida} ${fontes.join(' ')}`)
    const fora = []
    for (const [arq, deps] of Object.entries(DEPENDE_DE)) {
      const i = fontes.indexOf(arq)
      if (i < 0) continue
      for (const d of deps) {
        const j = fontes.indexOf(d)
        if (j > i) fora.push(`${d} vem depois de ${arq}`)
      }
    }
    fora.length
      ? falta(`${saida}: na ordem de DEPENDE_DE`, fora.join('; '))
      : ok(`${saida}: na ordem de DEPENDE_DE`)
  }
}


titulo('CONTAS A PAGAR (caixa diario, NAO contabilidade)')
// O livro da firma e por regime de caixa e a despesa vem do extrato. Se a
// conta a pagar virasse lancamento, a MESMA despesa entraria duas vezes --
// uma na emissao e outra no pagamento -- e o P&L sairia dobrado onde
// houvesse boleto. Pagar aqui so FECHA a conta e a amarra ao debito que ja
// existe no banco.
recusar('Conta a pagar nao vira lancamento contabil',
  'app/api/caixa/contas/route.ts', /from\('bank_transactions'\)[\s\S]{0,120}\.(insert|upsert)\(/,
  'a despesa ja vem do extrato: lancar aqui a contaria DUAS vezes no ano')
checar('Pagar exige o debito do extrato',
  'app/api/caixa/contas/route.ts', /acao === 'pagar'[\s\S]{0,400}?Escolha o débito do extrato/,
  'conta marcada como paga sem debito nenhum deixa a projecao de caixa mentindo')
checar('Um debito do banco paga UMA conta',
  'sql/contas-a-pagar-v1.sql', /create unique index if not exists firm_bills_um_pagamento[\s\S]{0,120}paid_tx_id is not null/,
  'sem o indice, dois cliques fazem a firma "pagar" o dobro no papel')
{
  // Sem os comentarios e por RAMO. Tres destas invariantes passaram com o
  // defeito reintroduzido: uma porque `23505` estava no comentario que
  // EXPLICA o defeito, outra porque `.eq('status','aberta')` tambem existe
  // no ramo de cancelar, e a terceira porque trocar `camposDaConta(body)`
  // por `body` nao casa com nenhum padrao de `...body`.
  const t = readFileSync(join(raiz, 'app/api/caixa/contas/route.ts'), 'utf8')
  const codigo = t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const iPagar = codigo.indexOf("b.acao === 'pagar'")
  const ramoPagar = iPagar < 0 ? '' : codigo.slice(iPagar, codigo.indexOf("b.acao === 'cancelar'", iPagar))

  // Variavel antes do teste, sempre: linha iniciada por `/` depois de `)`
  // o JavaScript le como DIVISAO, e o arquivo nem compila.
  const explicaOIndice = /\(error as any\)\.code === '23505'/.test(codigo)
  const travaNoPagar   = /\.eq\('status', 'aberta'\)/.test(ramoPagar)
  const filtraNoPost   = /camposDaConta\(body\)/.test(codigo)
  const filtraNoEditar = /camposDaConta\(b\)/.test(codigo)

  explicaOIndice
    ? ok('E a rota explica quando esbarra nele')
    : falta('E a rota explica quando esbarra nele',
        'o erro cru do Postgres nao diz que o debito ja fechou outra conta')

  travaNoPagar
    ? ok('Pagar duas vezes em paralelo nao passa')
    : falta('Pagar duas vezes em paralelo nao passa',
        'o status no WHERE do UPDATE de PAGAR e o que faz duas abas abertas nao pagarem a mesma conta duas vezes')

  filtraNoPost && filtraNoEditar
    ? ok('O corpo do pedido nao grava status nem pagamento')
    : falta('O corpo do pedido nao grava status nem pagamento',
        'status ou paid_tx_id vindos de fora dariam conta "paga" sem debito no extrato -- o corpo passa por camposDaConta no POST e no editar')
}
checar('Cancelar preserva e pede motivo',
  'app/api/caixa/contas/route.ts', /cancel_reason: motivo/,
  'principio 2: nada se apaga sem rastro')
checar('A conta a pagar e so do socio',
  'app/api/caixa/contas/route.ts', /getStaffLevel\([\s\S]{0,40}?\)\s*!==\s*'owner'/,
  'e o dinheiro da firma')


titulo('TODA ORIGEM QUE O CODIGO GRAVA CABE NO CHECK')
// `bank_transactions.source` tem CHECK com lista fechada, e o CHECK nasceu
// no PAINEL -- nao estava em arquivo nenhum. O caixa da firma trouxe
// `recebimento`, `deposito` e `taxa`, e a sincronizacao morreu em producao
// com "violates check constraint bank_transactions_source_check". Agora a
// lista mora em sql/caixa-origens-v1.sql e isto confere que o codigo e ela
// nao divergem.
{
  // So o ARRAY do CHECK, nao o arquivo: o bloco de conferencia e os
  // comentarios tambem citam 'recebimento', e a invariante passava com o
  // valor REMOVIDO da lista. Quarta vez nesta sessao que "aparece no
  // arquivo" engana.
  const arqOrigens = join(raiz, 'sql/caixa-origens-v1.sql')
  const texto = existsSync(arqOrigens) ? readFileSync(arqOrigens, 'utf8') : ''
  // A ancora e o `unnest(array[...])` da UNIAO -- a lista que o codigo grava.
  // Se ela sumir, isto precisa GRITAR, nao virar lista vazia: sem ancora a
  // conferencia nao confere nada, e esse e justamente o modo de falhar que
  // ja passou despercebido aqui.
  const iArray = texto.indexOf('unnest(array[')
  const lista = iArray < 0 ? null : texto.slice(iArray, texto.indexOf(']', iArray))
  const usados = new Set()
  for (const arq of [...arquivos(join(raiz, 'lib'), ['.ts']),
                     ...arquivos(join(raiz, 'app'), ['.ts'])]) {
    const t = readFileSync(arq, 'utf8')
    if (!/from\(['"]bank_transactions['"]\)/.test(t)) continue
    for (const m of t.matchAll(/source:\s*'([a-z_]+)'/g)) usados.add(m[1])
  }
  // As que a FUNCAO do banco grava tambem contam -- elas nao aparecem em .ts
  for (const o of ['deposito', 'taxa']) usados.add(o)

  const fora = lista === null ? [] : Array.from(usados).filter(o => !new RegExp(`'${o}'`).test(lista))
  if (lista === null)
    falta('Toda origem que o codigo grava cabe no CHECK de source',
      'nao achei o `unnest(array[` em sql/caixa-origens-v1.sql -- a conferencia perdeu a ancora e nao esta conferindo nada')
  else if (fora.length)
    falta('Toda origem que o codigo grava cabe no CHECK de source',
      `fora de sql/caixa-origens-v1.sql: ${fora.join(', ')} -- o insert vai falhar com "violates check constraint"`)
  else
    ok(`Toda origem que o codigo grava cabe no CHECK de source (${usados.size})`)
}


titulo('ARQUIVOS .bak VERSIONADOS (nao deviam ir para o Git)')
let baks = []
try { baks = execSync('git ls-files', { cwd: raiz, encoding: 'utf8' }).split('\n').filter(f => f.endsWith('.bak')) } catch {}
baks.length ? baks.forEach(b => ver(b)) : ok('nenhum')

titulo('O FLUXO DE CAIXA NAO SOMA A CONTA DE PASSAGEM')
// O livro da firma guarda, na MESMA tabela, o extrato e a conta de passagem
// ("Recebimentos a depositar"). A passagem existe para a receita fechar pelo
// BRUTO (e a bruta que vai no 1099-K), mas nao e dinheiro no banco: o cheque
// recebido e ainda nao depositado ja esta la. Somar as duas conta o mesmo
// deposito DUAS VEZES e antecipa dinheiro que nao chegou.
//
// Quem grava origem de passagem sao duas pecas: lib/caixa-recebimentos.ts
// ('recebimento') e a funcao conciliar_deposito ('deposito' e 'taxa'). Se
// uma quarta aparecer e nao entrar em ORIGENS_DE_PASSAGEM, o fluxo passa a
// contar errado em silencio -- nada quebra, o numero so fica maior.
{
  const arqFluxo = join(raiz, 'lib/fluxo-de-caixa.ts')
  if (!existsSync(arqFluxo)) {
    falta('O fluxo de caixa nao soma a conta de passagem', 'lib/fluxo-de-caixa.ts nao existe')
  } else {
    const t = readFileSync(arqFluxo, 'utf8')
    // So o ARRAY, nunca o arquivo: o cabecalho deste modulo cita as tres
    // origens para EXPLICAR a regra, e procurar no arquivo inteiro faria a
    // invariante passar com a origem removida da lista.
    const i = t.indexOf('export const ORIGENS_DE_PASSAGEM')
    const lista = i < 0 ? null : t.slice(i, t.indexOf(']', i))

    // Quem de fato escreve passagem, lido das pecas que escrevem.
    const daPassagem = new Set()
    const recs = join(raiz, 'lib/caixa-recebimentos.ts')
    if (existsSync(recs))
      for (const m of readFileSync(recs, 'utf8').matchAll(/source:\s*'([a-z_]+)'/g)) daPassagem.add(m[1])
    const func = join(raiz, 'sql/caixa-conciliacao-funcao-v1.sql')
    if (existsSync(func)) {
      const sql = readFileSync(func, 'utf8')
      const del = /source\s+in\s*\(([^)]*)\)/i.exec(sql)
      if (del) for (const m of del[1].matchAll(/'([a-z_]+)'/g)) daPassagem.add(m[1])
    }

    // O fluxo tem de FILTRAR, nao so declarar a lista.
    const filtra = /const lista = \(txs \|\| \[\]\)\.filter\(ehDoExtrato\)/.test(t)
    const fora = lista === null ? [] : Array.from(daPassagem).filter(o => !new RegExp(`'${o}'`).test(lista))

    if (lista === null)
      falta('O fluxo de caixa nao soma a conta de passagem',
        'nao achei ORIGENS_DE_PASSAGEM em lib/fluxo-de-caixa.ts -- a conferencia perdeu a ancora')
    else if (!filtra)
      falta('O fluxo de caixa nao soma a conta de passagem',
        'movimentoDeBanco nao filtra por ehDoExtrato -- o deposito entra duas vezes no realizado')
    else if (fora.length)
      falta('O fluxo de caixa nao soma a conta de passagem',
        `fora de ORIGENS_DE_PASSAGEM: ${fora.join(', ')} -- o fluxo vai contar essas linhas como dinheiro no banco`)
    else
      ok(`O fluxo de caixa nao soma a conta de passagem (${daPassagem.size} origens de passagem)`)
  }
}


titulo('O CAIXA DA FIRMA E SO DO SOCIO')
// A linha da firma guarda a folha de pagamento e o resultado da casa.
// `verEmpresas` nao serve de trava aqui: o gerente a tem POR NIVEL. Entao
// toda rota de /api/caixa/ confere o nivel e recusa quem nao for owner --
// uma rota nova que esqueca isso abre tudo para o gerente sem avisar.
{
  const semSocio = []
  const dirCaixa = join(raiz, 'app/api/caixa')
  for (const p of (existsSync(dirCaixa) ? arquivos(dirCaixa, ['route.ts']) : [])) {
    const t = readFileSync(p, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    if (!/getStaffLevel/.test(t) || !/'owner'/.test(t)) semSocio.push(rel(p))
  }
  semSocio.length
    ? falta('O caixa da firma e so do socio', `sem conferir o nivel: ${semSocio.join(', ')}`)
    : ok('O caixa da firma e so do socio (todas as rotas de /api/caixa/)')
}


titulo('O WORKFLOW DA MIGRACAO LEVA AS DUAS CREDENCIAIS EM TODO PASSO')
// scripts/migrar.mjs aceita dois caminhos: psql (SUPABASE_DB_URL) e a API de
// gestao (SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF). `escolherExecutor`
// decide pelo que ESTA NO AMBIENTE -- entao um passo que esqueca uma das
// variaveis nao quebra: ele muda de caminho, ou fica sem credencial nenhuma,
// no meio do job. "--pendentes" diria uma coisa e "aplicar" outra.
// Falha silenciosa num job que aplica migracao em banco de producao.
{
  const arq = join(raiz, '.github/workflows/migrar.yml')
  const PRECISA = ['SUPABASE_DB_URL', 'SUPABASE_DB_PASSWORD',
                   'SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF']
  if (!existsSync(arq)) {
    falta('O workflow da migracao leva as duas credenciais', '.github/workflows/migrar.yml nao existe')
  } else {
    // Corta por passo (`      - name:` / `      - uses:`) e olha so os que
    // rodam o migrar.mjs. Ancora perdida (nenhum passo encontrado) e FALHA,
    // nunca "tudo certo": sem passo nenhum isto nao estaria conferindo nada.
    // Tira os COMENTARIOS antes de casar: o cabecalho deste workflow explica
    // o migrar.mjs, e as explicacoes caem dentro do passo seguinte. A
    // primeira versao desta invariante acusou dois "passos" que eram so
    // comentario -- a mesma armadilha de sempre: a palavra esta no arquivo,
    // nao no codigo.
    const semComentario = readFileSync(arq, 'utf8')
      .split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    // O primeiro pedaco e tudo o que vem ANTES do primeiro passo (name do
    // workflow, on:, concurrency:) -- nao e passo, entao sai com slice(1).
    const passos = semComentario.split(/\n {6}- (?=name:|uses:)/).slice(1)
    const comScript = passos.filter(b => b.includes('node scripts/migrar.mjs'))
    const incompletos = comScript
      .map(b => {
        const nome = (/name:\s*(.+)/.exec(b) || [, '?'])[1].trim()
        const faltando = PRECISA.filter(v => !new RegExp(`${v}:\\s*\\$\\{\\{`).test(b))
        return faltando.length ? `${nome} (sem ${faltando.join(', ')})` : null
      })
      .filter(Boolean)

    if (comScript.length === 0)
      falta('O workflow da migracao leva as duas credenciais',
        'nenhum passo com migrar.mjs encontrado -- a conferencia perdeu a ancora e nao esta conferindo nada')
    else if (incompletos.length)
      falta('O workflow da migracao leva as duas credenciais',
        `${incompletos.join(' · ')} -- o passo muda de caminho no meio do job, sem erro`)
    else
      ok(`O workflow da migracao leva as duas credenciais em todo passo (${comScript.length})`)
  }
}


titulo('A ORDEM DAS MIGRACOES APONTA PARA ARQUIVO QUE EXISTE')
// `migrar.mjs` aplicava as pendentes em ordem ALFABETICA, e ela esta
// invertida em dois casos reais: a funcao do codigo de autorizacao vinha
// antes da tabela ('f' < 'v'), e recebimento-seguro-v1 antes de
// status-da-fatura-v2 ('r' < 's'), que o proprio arquivo diz vir primeiro.
// Agora a ordem e DECLARADA em scripts/ordem-das-migracoes.mjs.
//
// Declaracao que aponta para arquivo inexistente e PIOR que nenhuma: some
// em silencio quando alguem renomeia um .sql, e a ordem volta a ser a
// alfabetica sem ninguem notar.
{
  const { DEPENDE_DE } = await import(`file://${join(raiz, 'scripts/ordem-das-migracoes.mjs')}`)
  const pares = Object.entries(DEPENDE_DE)
  const sumidos = []
  for (const [arq, deps] of pares) {
    if (!existsSync(join(raiz, arq))) sumidos.push(arq)
    for (const d of deps) if (!existsSync(join(raiz, d))) sumidos.push(`${d} (exigida por ${arq})`)
  }
  // Zero declaracoes tambem e falha: o mapa vazio nao ordena nada, e as duas
  // inversoes reais voltariam a passar.
  if (pares.length === 0)
    falta('A ordem das migracoes aponta para arquivo que existe',
      'DEPENDE_DE esta vazio -- a ordem voltou a ser a alfabetica, que esta invertida em dois casos reais')
  else if (sumidos.length)
    falta('A ordem das migracoes aponta para arquivo que existe',
      `nao existem: ${sumidos.join(', ')} -- a dependencia some em silencio e a ordem volta a alfabetica`)
  else
    ok(`A ordem das migracoes aponta para arquivo que existe (${pares.length} declaracoes)`)

  // A ordenacao recebe o conjunto do que esta APLICADO, e o livro e um Map.
  // A funcao aceitava "Set ou objeto" e o migrar.mjs passava o Map cru:
  // `aplicados[x]` dava sempre undefined e TODA dependencia de migracao ja
  // aplicada parecia faltar -- o --pendentes do GitHub recusou a
  // equipe-unica-v1 (exit 3) com a dependencia dela listada como ok. Os
  // testes passavam com Set: o defeito estava na LIGACAO entre os modulos.
  const semComent = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const mig = semComent(readFileSync(join(raiz, 'scripts/migrar.mjs'), 'utf8'))
  const ord = semComent(readFileSync(join(raiz, 'scripts/ordem-das-migracoes.mjs'), 'utf8'))
  const chamadas = mig.match(/ordenarPorDependencia\([^\n]*/g) || []
  const problemas = []
  if (!chamadas.length) problemas.push('migrar.mjs nao chama ordenarPorDependencia -- ancora perdida e FALHA')
  for (const c of chamadas)
    if (!/ordenarPorDependencia\(paraAplicar, aplicadasParaDependencia\(livro, noDisco\)\)/.test(c))
      problemas.push(`chamada sem o conjunto do que esta ok: ${c.trim().slice(0, 90)}`)
  if (!/if \(!\(aplicados instanceof Set\)\) \{\s*throw new TypeError/.test(ord))
    problemas.push('ordenarPorDependencia voltou a aceitar o livro cru em silencio')
  problemas.length
    ? falta('A ordem das migracoes recebe o que esta aplicado, nao o livro cru', problemas.join(' · '))
    : ok('A ordem das migracoes recebe o que esta aplicado (Set de ok), nao o livro cru')
}


titulo('A LISTA DE PENDENTES SAI NUA (--so-nomes)')
// O workflow faz PENDENTES=$(node scripts/migrar.mjs --pendentes --so-nomes)
// e passa CADA LINHA adiante como nome de arquivo. Qualquer coisa que o
// script escreva no STDOUT ali vira uma "migracao" inexistente.
//
// Era o caso de `Conexao: psql`, que ia por console.log. Nunca tinha
// aparecido porque o aplicar automatico nunca chegou a rodar ate o fim --
// o defeito esperava a primeira vez que alguem apertasse o botao.
{
  const arq = join(raiz, 'scripts/migrar.mjs')
  const t = existsSync(arq)
    ? readFileSync(arq, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')
    : ''
  // A linha da conexao e o caso conhecido; ela tem de ir para o stderr.
  const porStdout = /console\.log\(`Conexão: /.test(t)
  const porStderr = /console\.error\(`Conexão: /.test(t)
  if (!t)
    falta('A lista de pendentes sai nua', 'scripts/migrar.mjs nao existe')
  else if (porStdout)
    falta('A lista de pendentes sai nua',
      '`Conexão:` vai por console.log -- entra na lista que o workflow passa como nome de arquivo')
  else if (!porStderr)
    falta('A lista de pendentes sai nua',
      'nao achei a linha `Conexão:` -- a conferencia perdeu a ancora e nao esta conferindo nada')
  else
    ok('A lista de pendentes sai nua (--so-nomes nao leva diagnostico)')
}


titulo('NENHUM ARQUIVO EM sql/ E PACOTE DE OUTRAS MIGRACOES')
// `sql/pendentes-parte-2.sql` embalava SEIS migracoes num arquivo so, para
// colar de uma vez no SQL Editor. Dentro de sql/ isso faz duas coisas
// ruins: vira mais uma PENDENTE no livro, e o `aplicar` automatico roda o
// pacote E as seis individuais. E uma COPIA, e copia que envelhece em
// silencio e pior que copia nenhuma -- a mesma razao pela qual
// colar-no-sql-editor/ fica fora de sql/. Movido para la.
//
// O sinal e CONTEUDO EMBUTIDO, nao mencao: conta quantas outras migracoes
// tem a PRIMEIRA LINHA delas (`-- sql/x.sql`) dentro deste arquivo. Contar
// mencoes (`/sql\/[\w-]+\.sql/`) deu falso positivo na primeira versao --
// rls-tabelas-expostas-v1 cita tres irmas em comentario e e legitima. Pelo
// cabecalho embutido: o pacote marca 7, a maior migracao legitima marca 1.
{
  const dir = join(raiz, 'sql')
  const nomes = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    : []
  const cabecalho = (f) => readFileSync(join(dir, f), 'utf8').split('\n')[0].trim()
  const cabecalhos = nomes
    .map(f => [f, cabecalho(f)])
    .filter(([, c]) => c.startsWith('-- sql/'))

  const pacotes = []
  for (const f of nomes) {
    const t = readFileSync(join(dir, f), 'utf8')
    const embute = cabecalhos.filter(([o, c]) => o !== f && t.includes(c)).length
    if (embute >= 3) pacotes.push(`sql/${f} (embute ${embute})`)
  }
  // Sem cabecalho padronizado nao da para conferir nada -- isso precisa
  // gritar, nao virar "tudo certo".
  if (cabecalhos.length < 3)
    falta('Nenhum arquivo em sql/ e pacote de outras migracoes',
      'quase nenhum .sql comeca com `-- sql/<nome>.sql` -- a conferencia perdeu a ancora')
  else if (pacotes.length)
    falta('Nenhum arquivo em sql/ e pacote de outras migracoes',
      `${pacotes.join(', ')} -- vira PENDENTE no livro e o aplicar roda o pacote E as individuais; mova para colar-no-sql-editor/`)
  else
    ok(`Nenhum arquivo em sql/ e pacote de outras migracoes (${cabecalhos.length} conferidos)`)
}

titulo('LISTA FLUTUANTE NAO SE POSICIONA NA MAO')
// O autocomplete do payee punha a lista SEMPRE abaixo do campo
// (`top: r.bottom + 4`), com position:fixed e maxHeight fixo. Na ULTIMA
// LINHA da tabela ela nascia fora da janela -- e `fixed` nao rola, entao
// nao havia como alcanca-la. Quem lanca o cheque via a sugestao pela
// metade. A conta passou para lib/lista-flutuante.ts, pura e com teste.
//
// Quem voltar a calcular na mao repete o defeito, e ele so aparece na
// ultima linha -- ninguem olha a ultima linha ao conferir uma mudanca.
{
  const suspeitos = []
  let olhados = 0
  for (const p of [...arquivos(join(raiz, 'components'), ['.tsx']),
                   ...arquivos(join(raiz, 'app'), ['.tsx'])]) {
    const t = readFileSync(p, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    if (!/getBoundingClientRect/.test(t)) continue
    olhados++
    if (/posicionarLista/.test(t)) continue
    // `r.bottom + N` / `rect.top - N` sao a conta na mao.
    if (/\b\w+\.(bottom|top)\s*[-+]\s*\d/.test(t)) suspeitos.push(rel(p))
  }
  suspeitos.length
    ? falta('Lista flutuante nao se posiciona na mao',
        `${suspeitos.join(', ')} -- use posicionarLista de lib/lista-flutuante.ts; na ultima linha a lista sai da janela e fixed nao rola`)
    : ok(`Lista flutuante nao se posiciona na mao (${olhados} arquivo(s) com getBoundingClientRect)`)
}


titulo('A EQUIPE NUM LUGAR SO: O NIVEL MORA EM team_members')
// Decisao do socio: "juntar tudo como team member". Eram tres cadastros da
// mesma gente -- team_members (o CRM), auth.users (o login) e staff_roles (o
// nivel) -- com tres telas, e eles discordavam. E havia um defeito mudo entre
// eles: editar o telefone em Team Members comparava o papel com
// user_metadata.role, que a migracao do papel esvaziou, achava que o papel
// tinha mudado e REESCREVIA o nivel pelo papel. Gerente com papel de socio
// virava socio; quem foi promovido em Minha Conta voltava a assistente.
{
  const semComent = t => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const ler = a => existsSync(join(raiz, a)) ? semComent(readFileSync(join(raiz, a), 'utf8')) : ''
  // O corpo de uma funcao, da assinatura ate a proxima funcao de topo.
  // Ancora perdida devolve '' -- e vazio e FALHA abaixo, nunca "nada achado".
  const corpoDe = (txt, assinatura) => {
    const i = txt.indexOf(assinatura)
    if (i < 0) return ''
    const resto = txt.slice(i + assinatura.length)
    const j = resto.search(/\n(export )?(async )?function /)
    return j < 0 ? resto : resto.slice(0, j)
  }
  const fontes = [...arquivos(join(raiz, 'app'), ['.ts', '.tsx']),
                  ...arquivos(join(raiz, 'lib'), ['.ts']),
                  ...arquivos(join(raiz, 'components'), ['.ts', '.tsx'])]

  // 1. staff_roles esta CONGELADA (sql/equipe-unica-v1.sql). So staff-perms
  //    le, e so quando a coluna nova ainda nao existe; ninguem grava.
  const leemAntiga = [], gravamAntiga = [], gravamNivel = [], listam = []
  const PODEM_GRAVAR_NIVEL = ['app/api/firm/users/[id]/route.ts', 'lib/equipe-servidor.ts']
  for (const arq of fontes) {
    const cod = semComent(readFileSync(arq, 'utf8'))
    const nome = rel(arq)
    if (/from\(\s*['"]staff_roles['"]\s*\)/.test(cod) && nome !== 'lib/staff-perms.ts') leemAntiga.push(nome)
    if (/from\(\s*['"]staff_roles['"]\s*\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\(/.test(cod)) gravamAntiga.push(nome)
    // 2. Quem grava o NIVEL: a acao de nivel e o aceite do convite, e so.
    if (!PODEM_GRAVAR_NIVEL.includes(nome)
        && /from\(\s*['"]team_members['"]\s*\)[\s\S]{0,60}?\.(insert|update|upsert)\(/.test(cod)
        && /\blevel\s*:/.test(cod)) gravamNivel.push(nome)
    // 3. listUsers so com pagina, num lugar so (todosOsLogins).
    if (/\.listUsers\(/.test(cod) && nome !== 'lib/equipe-servidor.ts') listam.push(nome)
  }
  leemAntiga.length
    ? falta('Ninguem le o nivel em staff_roles', `o nivel mora em team_members (getStaffLevel): ${leemAntiga.join(', ')}`)
    : ok('Ninguem le o nivel em staff_roles')
  gravamAntiga.length
    ? falta('Ninguem grava em staff_roles', `ela esta congelada -- a mudanca se perderia: ${gravamAntiga.join(', ')}`)
    : ok('Ninguem grava em staff_roles')
  gravamNivel.length
    ? falta('O nivel so se grava pela acao de nivel e pelo aceite', `com senha, motivo e trilha: ${gravamNivel.join(', ')}`)
    : ok('O nivel so se grava pela acao de nivel e pelo aceite')
  listam.length
    ? falta('Lista de logins so pagina por pagina', `listUsers() sem pagina devolve 50; use todosOsLogins: ${listam.join(', ')}`)
    : ok('Lista de logins so pagina por pagina')
  checar('A lista de logins para na pagina VAZIA, nao na curta', 'lib/equipe-servidor.ts',
         /if \(!users\.length\) return/,
         'se o servidor limitar a pagina abaixo do pedido, "veio menos" pararia cedo e cortaria a equipe sem aviso')

  // 4. A leitura antiga so quando a coluna falta; erro nao cai na reserva.
  const perms = ler('lib/staff-perms.ts')
  const gsl = corpoDe(perms, 'export async function getStaffLevel')
  const vmp = corpoDe(perms, 'export async function validateManagerPin')
  if (!gsl || !vmp) falta('Ancoras de lib/staff-perms.ts', 'getStaffLevel ou validateManagerPin nao encontrados -- a conferencia nao conferiria nada')
  else {
    if (/colunaAusente\(error\) \? await nivelNaTabelaAntiga/.test(gsl)) ok('getStaffLevel so le staff_roles quando a coluna nova falta')
    else falta('getStaffLevel so le staff_roles quando a coluna nova falta', 'a tabela antiga esta congelada e mente depois da migracao')
    const iErro = gsl.indexOf("if (nivel === 'erro') return 'junior'")
    const iReserva = gsl.indexOf('getUserById')
    if (iErro >= 0 && iReserva > iErro) ok('Consulta do nivel que falha NAO cai na reserva do papel')
    else falta('Consulta do nivel que falha NAO cai na reserva do papel', 'um gerente com papel firm viraria socio num tropeco de rede')
    if (/data && data\.active === false\) nivel = 'junior'/.test(gsl)) ok('Quem saiu da equipe vale assistente, sem cair na reserva')
    else falta('Quem saiu da equipe vale assistente, sem cair na reserva', 'a sessao aberta do desligado manteria o poder')
    if (/\.eq\('active', true\)/.test(vmp)) ok('PIN de quem saiu nao aprova')
    else falta('PIN de quem saiu nao aprova', 'o PIN do gerente desligado liberava desconto e troca de acesso no balcao')
  }

  // 5. Mudar o nivel: a regra unica, a senha do socio, a trilha ANTES.
  const rota = ler('app/api/firm/users/[id]/route.ts')
  const mudar = corpoDe(rota, 'async function mudarNivel')
  const editar = corpoDe(rota, 'async function editar')
  if (!mudar || !editar) falta('Ancoras de /api/firm/users/[id]', 'mudarNivel ou editar nao encontrados -- a conferencia nao conferiria nada')
  else {
    if (/decidirMudancaDeNivel\(/.test(mudar) && /signInWithPassword\(/.test(mudar)) ok('Mudar o nivel passa pela regra unica e pela senha do socio')
    else falta('Mudar o nivel passa pela regra unica e pela senha do socio', 'o nivel e a raiz da matriz inteira (principio 3)')
    const iTrilha = mudar.search(/gravarNaTrilha\(\{[\s\S]{0,200}?acao:\s*'nivel'/)
    const iGrava = mudar.search(/from\('team_members'\)\.update\(/)
    if (iTrilha >= 0 && iGrava > iTrilha && /if \(errTrilha\) \{[\s\S]{0,40}?return/.test(mudar)) ok('A trilha do nivel vem ANTES, e falhar recusa a mudanca')
    else falta('A trilha do nivel vem ANTES, e falhar recusa a mudanca', 'poder que muda sem rastro e pior que mudanca nao feita (principio 2)')
    if (/\blevel\b|nivelDoPapel|papelDoNivel|app_metadata/.test(editar)) falta('Editar nome e telefone NAO toca no nivel', 'foi assim que uma edicao de telefone promoveu gerente a socio')
    else ok('Editar nome e telefone NAO toca no nivel')
    if (/papelDoNivel\(/.test(mudar)) ok('O papel da porta acompanha o nivel')
    else falta('O papel da porta acompanha o nivel', 'o papel e a reserva do nivel; os dois discordando e o defeito')
  }
  recusar('O CRM nao escolhe nivel nem funcao pelo corpo', 'app/api/team/route.ts',
          /\bb\.(level|role)\b/,
          'a coluna role era um rotulo que qualquer assistente trocava, e a tela mostrava Socio')

  // 6. Uma definicao de nivel so: o Atendimento pergunta a getStaffLevel.
  const wa = ler('lib/wa-auth.ts')
  if (!/staff_roles/.test(wa) && /getStaffLevel\(/.test(wa)) ok('O Atendimento usa o mesmo nivel do resto do sistema')
  else falta('O Atendimento usa o mesmo nivel do resto do sistema', "varria staff_roles por texto e lia 'admin' como gerente")

  // 7. Convite e para quem nao tem login, e o anterior deixa de valer.
  const conv = ler('app/api/firm/users/route.ts')
  const iVelho = conv.search(/update\(\{\s*expires_at:/)
  const iNovo = conv.search(/from\('staff_invitations'\)\.insert\(/)
  if (/decidirConvite\(/.test(conv) && iVelho >= 0 && iNovo > iVelho) ok('Convite novo encerra o anterior e recusa quem ja tem login')
  else falta('Convite novo encerra o anterior e recusa quem ja tem login', 'um link velho com outro nivel abria a conta por sete dias')
  const aceite = ler('app/api/firm/setup/[token]/route.ts')
  if (/vincularNaEquipe\(/.test(aceite) && !/staff_roles/.test(aceite)) ok('O aceite do convite completa a linha da equipe')
  else falta('O aceite do convite completa a linha da equipe', 'inserir sempre punha a pessoa duas vezes no seletor do CRM')

  // 8. A migracao fecha team_members e congela staff_roles.
  checar('A migracao fecha team_members para o navegador', 'sql/equipe-unica-v1.sql',
         'revoke all on public.team_members from anon, authenticated',
         'o nivel mora la: aberta, um cliente logado gravaria owner na propria linha')
  checar('A migracao congela staff_roles', 'sql/equipe-unica-v1.sql',
         'revoke insert, update, delete, truncate on public.staff_roles from service_role',
         'sem isso o codigo antigo gravaria o nivel la entre a migracao e o deploy, e a mudanca se perderia')
}

titulo('AS PARCELAS SAO AGENDADAS NO STRIPE (iterations saiu da API)')
// As parcelas NUNCA foram cobradas: o agendamento mandava `iterations`, que a
// API do Stripe removeu na 2025-09-30.clover, e o sistema fala na
// 2026-06-24.dahlia. O Stripe recusava, o webhook respondia 500 com um
// console.error, a entrada paga nao chegava a fatura e o portal oferecia
// pagar a entrada de novo. O typecheck passava: o SDK instalado ainda declara
// o campo. Quem confere e isto.
{
  const semComent = t => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const ler = a => existsSync(join(raiz, a)) ? semComent(readFileSync(join(raiz, a), 'utf8')) : ''

  // 1. Nenhum codigo manda `iterations` ao Stripe.
  const comIterations = []
  for (const arq of [...arquivos(join(raiz, 'app'), ['.ts', '.tsx']), ...arquivos(join(raiz, 'lib'), ['.ts'])]) {
    if (/\biterations\s*:/.test(semComent(readFileSync(arq, 'utf8')))) comIterations.push(rel(arq))
  }
  comIterations.length
    ? falta('Nenhuma fase de agendamento usa iterations', `a API recusa (2025-09-30.clover): ${comIterations.join(', ')}`)
    : ok('Nenhuma fase de agendamento usa iterations')

  // 2. O agendamento mora num lugar so: duration, e o que ja existe e reaproveitado.
  const ag = ler('lib/agendamento-parcelas.ts')
  {
    const iAchar = ag.indexOf('await agendamentoExistente(stripe, plano.stripe_customer_id, plano.id)')
    const iCriar = ag.indexOf('stripe.subscriptionSchedules.create(')
    if (/duration: f\.duration/.test(ag) && iAchar >= 0 && iCriar > iAchar)
      ok('Agendamento por duration, reaproveitando o que ja existe')
    else falta('Agendamento por duration, reaproveitando o que ja existe',
      'sem procurar antes, o reenvio do evento ou a equipe agendando criam DOIS agendamentos: cada parcela cobrada duas vezes')
  }

  // 3. O webhook: a entrada entra na fatura ANTES do agendamento, e a falha avisa.
  const wh = ler('app/api/stripe/webhook/route.ts')
  {
    const problemas = []
    if (/function criarAgendamento|subscriptionSchedules\.create\(/.test(wh)) problemas.push('o webhook voltou a montar o agendamento por conta propria')
    const i = wh.indexOf('async function handleInstallmentEntry(')
    const j = wh.indexOf('\nasync function ', i + 10)
    const entry = i >= 0 ? wh.slice(i, j < 0 ? undefined : j) : ''
    if (!entry) problemas.push('handleInstallmentEntry nao encontrado -- ancora perdida e FALHA')
    else {
      const iLanca = entry.indexOf('lancarRecebimentoStripe(db, {')
      const iAgenda = entry.indexOf('agendarOuAvisar(')
      if (!(iLanca >= 0 && iAgenda > iLanca)) problemas.push('a entrada paga nao e lancada ANTES do agendamento')
      // A decisao (pura, testada) vem antes de lancar e de agendar, e o que
      // ela recusa sai da funcao: plano encerrado nao volta a cobrar, entrada
      // devolvida nao e entrada, a segunda entrada vira alerta de estorno.
      const iDecide = entry.indexOf('decidirEntradaDoWebhook({')
      if (!(iDecide >= 0 && iLanca > iDecide)) problemas.push('a decisao da entrada nao vem antes de lancar e agendar')
      if (!/if \(decisao\.acao === 'nada'\) return/.test(entry)
          || !/if \(decisao\.acao === 'alertar'\) \{[\s\S]{0,1500}?await falhaNoParcelamento\(db, plan, decisao\.tipo, motivo\)\s*return\s*\}/.test(entry))
        problemas.push('o que a decisao recusa segue adiante (plano cancelado reativado, entrada devolvida lancada)')
      if (!/devolvido: pag\.devolvido, contestado: pag\.contestado/.test(entry)) problemas.push('a decisao nao recebe a devolucao e a contestacao da cobranca')
    }
    // O mandato (parcelamento sem entrada) so poe a cobrar o plano que espera o cliente.
    {
      const k = wh.indexOf('async function handleInstallmentSetup(')
      const setup = k >= 0 ? wh.slice(k, wh.indexOf('\nasync function ', k + 10)) : ''
      const iGuarda = setup.indexOf('!ESPERANDO_O_CLIENTE.includes(String(plan.status))'), iAg = setup.indexOf('agendarOuAvisar(')
      if (!setup) problemas.push('handleInstallmentSetup nao encontrado -- ancora perdida e FALHA')
      else if (!(iGuarda >= 0 && iAg > iGuarda)) problemas.push('o mandato reativa plano cancelado ou que ja andou (a guarda era so "ativo")')
    }
    if ((wh.match(/await agendarOuAvisar\(/g) || []).length < 2) problemas.push('entrada e mandato nao passam pelos dois o mesmo caminho')
    if (!/catch \(e\) \{\s*await falhaNoParcelamento\(db, plan, 'agendamento_falhou'[\s\S]{0,200}?throw e/.test(wh)) problemas.push('falha no agendamento nao avisa a equipe (volta a ser so console.error)')
    problemas.length
      ? falta('Webhook: entrada lancada antes, falha avisada', problemas.join(' · '))
      : ok('Webhook: entrada lancada antes, falha avisada; encerrado nao volta, devolvida nao conta, em dobro vira estorno')
  }

  // 3b. A cobranca diz o que aconteceu DEPOIS: o status da sessao continua
  //     'paid' depois do reembolso.
  if (/devolvido: Number\(charge\?\.amount_refunded \|\| 0\) \/ 100/.test(ag) && /contestado: !!charge\?\.disputed/.test(ag)
      && /export function entradaIntegra\(p: PagamentoDaSessao\): boolean \{\s*return p\.modo === 'payment' && p\.concluido && !\(p\.devolvido > 0\) && !p\.contestado/.test(ag))
    ok('Entrada devolvida ou contestada nao conta como paga')
  else falta('Entrada devolvida ou contestada nao conta como paga',
    'payment_status continua paid depois do reembolso: a entrada devolvida seria lancada e as parcelas agendadas')

  // 4. Entrada paga nao se oferece de novo (o link novo cobraria outra vez).
  const ck = ler('lib/plan-checkout.ts'), pb = ler('app/api/portal/billing/route.ts'), pc = ler('app/api/portal/plan-checkout/route.ts')
  if (/entrada > 0 && plan\.entry_paid_at\) \{\s*throw new Error/.test(ck)
      && /!\(p\.kind === 'installment' && p\.entry_paid_at/.test(pb)
      && /plan\.kind === 'installment' && plan\.entry_paid_at/.test(pc))
    ok('Entrada ja paga nao se cobra de novo (checkout, portal e rota)')
  else falta('Entrada ja paga nao se cobra de novo (checkout, portal e rota)', 'o cliente do plano travado pagava a entrada outra vez')

  // 5. A equipe agenda o que travou: Stripe primeiro, conta fechada, trilha antes.
  const ip = ler('app/api/billing/installment-plan/route.ts')
  {
    const problemas = []
    const iBranch = ip.indexOf("if (b.action === 'agendar') {")
    if (iBranch < 0 || !/if \(b\.action === 'agendar'\) \{\s*if \(!perms\.receber\)/.test(ip)) problemas.push("a acao 'agendar' nao exige receber")
    const i = ip.indexOf('async function agendarParcelamentoTravado(')
    const corpo = i >= 0 ? ip.slice(i) : ''
    if (!corpo) problemas.push('agendarParcelamentoTravado nao encontrado -- ancora perdida e FALHA')
    else {
      if (!/conferirSenhaPropria\(db, auth\.userId, b\.password\)/.test(corpo)) problemas.push('sem senha')
      if (!/motivo\.length < 5/.test(corpo)) problemas.push('sem motivo')
      if (!/oQueOClienteFez\(plano\)/.test(corpo)) problemas.push('decide pelo banco, nao pelo Stripe')
      if (!/A conta não fecha/.test(corpo)) problemas.push('agenda sem conferir que as parcelas somam o saldo da fatura')
      const iTrilha = corpo.indexOf("action: 'scheduled_by_staff'")
      const iAgenda = corpo.indexOf('agendarParcelas(')
      if (!(iTrilha >= 0 && iAgenda > iTrilha)) problemas.push('a trilha nao vem antes do agendamento')
      if (!/installment_rescheduled/.test(corpo)) problemas.push('o cronograma nao anda para a nova 1a parcela')
    }
    // Cancelar "como proposta" um plano cuja entrada foi paga dizia ao cliente que nada foi cobrado.
    const iCancel = ip.indexOf('export async function PATCH')
    const cancel = iCancel >= 0 ? ip.slice(iCancel) : ''
    const iConf = cancel.indexOf('entrada = await entradaNoStripe(plano)'), iEnc = cancel.indexOf('encerrarParcelamento(')
    if (!(iConf >= 0 && iEnc > iConf)) problemas.push('cancelar nao confere no Stripe se a entrada foi paga')
    if (!/const pago = entrada\.integra\s*\n/.test(cancel) || !/const nuncaComecou = planoNuncaComecou\(plano\) && !entradaVoltou/.test(cancel))
      problemas.push('cancelar lanca a entrada que voltou, ou diz ao cliente que nada foi cobrado')
    if (!/const entradasPagas = feitos\.filter\(f => entradaIntegra\(f\) && f\.paymentMethod\)/.test(ip))
      problemas.push('agendar conta como entrada a que foi devolvida ou contestada')
    if (!/&& !p\?\.entry_paid_at/.test(ip)) problemas.push('entrada paga ainda conta como "nunca comecou"')
    problemas.length
      ? falta('Agendar o parcelamento travado: Stripe, conta, senha e trilha', problemas.join(' · '))
      : ok('Agendar o parcelamento travado: Stripe, conta fechada, senha, motivo e trilha antes')
  }
  checar('A tela oferece agendar a quem tem receber', 'app/dashboard/billing/page.tsx',
         /pl\.podeAgendar && pcDados\.perms\?\.receber/, 'o botao some ou aparece para quem a rota recusa')
  checar('O alerta de plano parado nao diz "nada foi cobrado" a quem pagou', 'lib/planos-parados.ts',
         /plano\.kind === 'installment' && plano\.entry_paid_at/, 'a equipe ligava cobrando quem ja tinha pago')
}

titulo('ORCAMENTOS NUM LUGAR SO: O FINANCEIRO')
// Decisao do socio. O modulo Quotes (aba da ficha do cliente) era uma segunda
// tabela de orcamentos, com link de pagamento proprio: o dinheiro entrava
// fora do livro (sem invoice_payments, sem conta de passagem, sem conciliar
// com o repasse do Stripe). E o orcamento do Financeiro chegava ao cliente
// como "Fatura ... Ver e pagar", num portal que so listava faturas.
{
  const semComent = t => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const ler = a => existsSync(join(raiz, a)) ? semComent(readFileSync(join(raiz, a), 'utf8')) : ''

  // 1. O modulo saiu, e ninguem mais grava na tabela dele.
  const sairam = ['components/QuotesTab.tsx', 'app/api/quotes/route.ts', 'app/api/quotes/[id]/route.ts',
                  'app/api/quotes/perms/route.ts', 'app/api/stripe/checkout/route.ts',
                  'app/api/portal/quote/route.ts', 'lib/pricing-db.ts']
  const voltaram = sairam.filter(a => existsSync(join(raiz, a)))
  if (voltaram.length) falta('O modulo Quotes saiu', `voltaram: ${voltaram.join(', ')}`)
  else ok('O modulo Quotes saiu')
  // A ponte (traz os abertos), o webhook (link antigo ainda pago) e o
  // impresso (recibo do que ja foi pago) sao os unicos que ainda tocam nela.
  const PODEM = ['app/api/billing/orcamentos-antigos/route.ts', 'app/api/stripe/webhook/route.ts',
                 'app/api/quotes/[id]/document/route.ts']
  const gravam = []
  for (const arq of [...arquivos(join(raiz, 'app'), ['.ts', '.tsx']), ...arquivos(join(raiz, 'lib'), ['.ts']),
                     ...arquivos(join(raiz, 'components'), ['.ts', '.tsx'])]) {
    const nome = rel(arq)
    if (PODEM.includes(nome)) continue
    if (/from\(\s*['"]quotes['"]\s*\)/.test(semComent(readFileSync(arq, 'utf8')))) gravam.push(nome)
  }
  if (gravam.length) falta('Ninguem mais usa a tabela quotes', `o orcamento mora no Financeiro: ${gravam.join(', ')}`)
  else ok('Ninguem mais usa a tabela quotes')

  // 2. Quem se paga e a FATURA.
  checar('Recebimento manual recusa orcamento', 'app/api/billing/payments/route.ts',
         /if \(inv\.doc_type === 'estimate'\) \{\s*return NextResponse\.json/,
         'o recebimento lancado num orcamento nao e de fatura nenhuma')
  checar('O QR do balcao recusa orcamento', 'app/api/billing/cobranca-balcao/route.ts',
         /if \(inv\.doc_type === 'estimate'\)\s*return \{ erro:/,
         'a sessao do Stripe com o id do orcamento lancaria o pagamento nele')
  const tela = ler('app/dashboard/billing/page.tsx')
  if (/perms\?\.receber && inv\.doc_type !== 'estimate'/.test(tela)
      && /inv\.doc_type !== 'estimate' && inv\.status !== 'draft' && inv\.status !== 'void' && inv\.saldo > 0 && perms\?\.enviar/.test(tela))
    ok('A tela nao oferece cobrar nem receber orcamento')
  else falta('A tela nao oferece cobrar nem receber orcamento', 'Receber, Lembrete e QR apareciam num orcamento enviado')

  // 3. Orcamento vira fatura UMA vez, ligado a ela.
  const rota = ler('app/api/billing/invoices/route.ts')
  const conv = (() => {
    const i = rota.indexOf("if (action === 'converter') {")
    if (i < 0) return ''
    const j = rota.indexOf("if (action === 'duplicate')", i)
    return rota.slice(i, j < 0 ? undefined : j)
  })()
  if (!conv) falta('Orcamento vira fatura uma vez so', "acao 'converter' nao encontrada -- ancora perdida e FALHA")
  else {
    const iConfere = conv.search(/\.eq\('converted_from', inv\.id\)\.eq\('doc_type', 'invoice'\)/)
    const iCria = conv.search(/from\('invoices'\)\.insert\(/)
    if (iConfere >= 0 && iCria > iConfere && /converted_from: inv\.id/.test(conv) && /if \(!perms\.criar\)/.test(conv))
      ok('Orcamento vira fatura uma vez so')
    else falta('Orcamento vira fatura uma vez so', 'confere a fatura que ja existe ANTES de criar, liga por converted_from e exige criar')
  }

  // 4. O orcamento chega como orcamento, e o cliente o ve.
  checar('O aviso do orcamento nao e o da fatura', 'lib/aviso-da-fatura.ts',
         /const t = inv\.doc_type === 'estimate' \? \(TO\[lang\] \|\| TO\.en\)/,
         'o cliente recebia "Fatura EST-... Ver e pagar" e nao achava nada no portal')
  checar('O portal lista os orcamentos enviados', 'app/api/portal/billing/route.ts',
         /orcamentos: \(orcs \|\| \[\]\)/, 'o aviso manda o cliente a Pagamentos -> Orcamentos')
  checar('A pagina do portal mostra os orcamentos', 'app/portal/payments/page.tsx',
         /orcamentos\.map\(/, 'sem isso o aviso do orcamento volta a apontar para o nada')
  checar('Pagamentos do portal: consulta que falha nao vira "nada a pagar"', 'app/portal/payments/page.tsx',
         /if \(!ok \|\| d\?\.error\) \{ setFalhou\(true\)/,
         'o erro virava saldo zero com o check verde -- o cliente acreditava e a firma nao recebia')

  // 5. O calculo da declaracao: catalogo e documentos que falham nao viram preco.
  const calc = ler('app/api/billing/orcamento-automatico/route.ts')
  if (/itensDaDeclaracao\(/.test(calc) && /for \(const \[oque, err\] of/.test(calc) && /cliente\.type === 'business'/.test(calc))
    ok('O calculo da declaracao nao engole erro e nao calcula empresa')
  else falta('O calculo da declaracao nao engole erro e nao calcula empresa', 'catalogo vazio vira "a base nao existe"; documentos vazios viram so a base')
  checar('O calculo conta active nulo como ativo', 'lib/orcamento-automatico.ts',
         /c && c\.active !== false \? c : null/, 'servico com active nulo sumia do orcamento (lib/catalogo-precos.ts)')

  // 6. Quem chama nao e QUAL cliente: cada verbo confere o dono do documento.
  const iPatch = rota.indexOf('export async function PATCH')
  const iSend = rota.indexOf("if (action === 'send')", iPatch)
  const trechoPatch = iPatch >= 0 && iSend > iPatch ? rota.slice(iPatch, iSend) : ''
  if (/canAccessClient\(auth, inv\.client_id\)/.test(trechoPatch)
      && /export async function DELETE[\s\S]*?canAccessClient\(auth, inv\.client_id\)/.test(rota))
    ok('PATCH e DELETE do Financeiro conferem o dono do documento')
  else falta('PATCH e DELETE do Financeiro conferem o dono do documento', 'por autorizacao, quem envia sem verEmpresas agia pelo id na fatura de uma empresa')
  const pags = ler('app/api/billing/payments/route.ts')
  if ((pags.match(/canAccessClient\(auth, (inv|pag)\.client_id\)/g) || []).length >= 3)
    ok('Recebimentos conferem o dono (lista, estorno e baixa)')
  else falta('Recebimentos conferem o dono (lista, estorno e baixa)', 'a lista de pagamentos de uma empresa saia pelo id da fatura')
  checar('A lista do Financeiro obedece ao escopo', 'app/api/billing/invoices/route.ts',
         /const visiveis = \(invoices \|\| \[\]\)\.filter\(\(i: any\) => !escopo\.ocultos\.has\(i\.client_id\)\)/,
         'o seletor escondia o cliente e a lista mostrava as faturas dele')
}


titulo('CONTRATO RECORRENTE NUM LUGAR SO (payment_plans)')
// Decisao do socio: os PLANOS (ficha do cliente) e os CONTRATOS RECORRENTES
// (Financeiro) eram dois cadastros do mesmo acordo. Os planos cobravam
// (Stripe, webhook) e eram um valor so, mensal; os contratos tinham a regra
// (itens, desconto, prazo, intervalo) e NUNCA cobraram -- nada lia a tabela.
// Ficou o motor dos planos (as assinaturas ativas vivem nele) com a regra
// dos contratos; a rotina diaria emite a fatura do contrato por fatura.
{
  const semComent = t => t.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const ler = a => existsSync(join(raiz, a)) ? semComent(readFileSync(join(raiz, a), 'utf8')) : ''

  // 1. Um cadastro so: a aba e as rotas antigas sairam, e ninguem grava na
  //    tabela antiga (a migracao a congela; codigo que voltasse a gravar
  //    levaria erro de permissao em producao, calado no meio de uma tela).
  const sairam = ['components/PlansTab.tsx', 'app/api/plans/route.ts', 'app/api/plans/checkout/route.ts',
                  'app/api/plans/pause/route.ts', 'app/api/billing/recurring/route.ts']
  const voltaram = sairam.filter(a => existsSync(join(raiz, a)))
  if (voltaram.length) falta('Os Planos sairam: o contrato tem um cadastro so', `voltaram: ${voltaram.join(', ')}`)
  else ok('Os Planos sairam: o contrato tem um cadastro so')
  const naAntiga = []
  for (const arq of [...arquivos(join(raiz, 'app'), ['.ts', '.tsx']), ...arquivos(join(raiz, 'lib'), ['.ts']),
                     ...arquivos(join(raiz, 'components'), ['.ts', '.tsx'])]) {
    if (/from\(\s*['"]recurring_plan(s|_items|_audit)['"]\s*\)|\/api\/plans\b|\/api\/billing\/recurring\b/.test(semComent(readFileSync(arq, 'utf8')))) naAntiga.push(rel(arq))
  }
  if (naAntiga.length) falta('Ninguem usa o cadastro antigo', `recurring_plans esta congelada e /api/plans saiu: ${naAntiga.join(', ')}`)
  else ok('Ninguem usa o cadastro antigo')

  // 2. A rotina diaria existe, roda todo dia e so abre com o CRON_SECRET.
  checar('Rotina dos contratos agendada na Vercel', 'vercel.json', '/api/cron/contratos',
         'a rota existiria e nenhuma fatura de contrato sairia -- de novo o "nunca cobrou"')
  const cron = ler('app/api/cron/contratos/route.ts')
  if (/if \(!process\.env\.CRON_SECRET\)/.test(cron) && /timingSafeEqual\(/.test(cron) && /emitirFaturasDosContratos\(serviceDb\(\), \{\s*hoje: dataDaFirma\(\)/.test(cron))
    ok('Rotina dos contratos: CRON_SECRET e o dia do escritorio')
  else falta('Rotina dos contratos: CRON_SECRET e o dia do escritorio', 'sem a variavel a rota fica aberta; em UTC, as 20h de Malden ja e amanha')

  // 3. QUANDO e QUANTO e a regra pura (com teste); a rotina so executa --
  //    e nao emite duas vezes o mesmo periodo, nem pula um.
  const emi = ler('lib/emissao-contratos.ts')
  {
    const iDecide = emi.indexOf('decidirEmissao(p, ')
    const iConfere = emi.search(/\.eq\('plan_id', p\.id\)\.eq\('competencia', d\.competencia\)/)
    const iNumera = emi.indexOf("rpc('next_invoice_number'")
    const problemas = []
    if (iDecide < 0) problemas.push('nao usa decidirEmissao')
    if (!(iConfere >= 0 && iNumera > iConfere)) problemas.push('nao confere o periodo ANTES de numerar')
    if (!/errInv\.code === '23505'/.test(emi)) problemas.push('nao trata a corrida (23505) como ja emitida')
    if (!/\.eq\('id', p\.id\)\.eq\('next_charge_date', de\)/.test(emi)) problemas.push('a regua anda sem a condicao do valor lido')
    if (!/email: aviso\.email, motivo: aviso\.motivo/.test(emi)) problemas.push('o resultado do e-mail nao vai para a trilha')
    if (/stripe/i.test(emi)) problemas.push('a rotina da FATURA fala com o Stripe -- quem cobra no debito e a assinatura')
    problemas.length
      ? falta('Rotina dos contratos: uma fatura por periodo, a regua anda um passo', problemas.join(' · '))
      : ok('Rotina dos contratos: uma fatura por periodo, a regua anda um passo')
  }

  // 4. Debito e fatura sao acordos diferentes: quem tem fatura nao recebe
  //    "vamos debitar", nao ganha assinatura, e o debito segue a regua.
  checar('Aviso de debito pula o contrato por fatura', 'lib/billing-reminders.ts',
         /if \(p\.collection_method === 'fatura'\) continue/,
         'o cliente por fatura ouviria "vamos debitar" de um debito que nao existe')
  const ck = ler('lib/plan-checkout.ts')
  if (/plan\.kind !== 'installment' && plan\.collection_method === 'fatura'\) \{\s*throw new Error/.test(ck)
      && /recurring: recorrenciaDoStripe\(plan\.billing_interval\)/.test(ck)
      && /ancoraDoDebito\(normalizarDiaCobranca\(plan\.due_day\), plan\.start_date, plan\.billing_interval/.test(ck)
      && !/recurring: \{ interval: 'month', interval_count: 1 \}/.test(ck))
    ok('Debito: assinatura no intervalo e na regua do contrato; fatura nao vira assinatura')
  else falta('Debito: assinatura no intervalo e na regua do contrato; fatura nao vira assinatura',
             'o trimestral era mensal no Stripe -- cobrava o valor do trimestre TODO MES')
  checar('Assinar o contrato por fatura nao leva ao cadastro do debito', 'app/api/portal/contract-return/route.ts',
         /plan\.collection_method !== 'fatura' && \['draft', 'awaiting_entry', 'awaiting_setup'\]\.includes\(plan\.status\)/,
         'o cliente que assinou um contrato por fatura cairia numa assinatura do Stripe')
  checar('Enviar o contrato por fatura nao o poe "aguardando o debito"', 'app/api/signatures/contract/route.ts',
         /if \(\['draft'\]\.includes\(plan\.status\) && !porFatura\)/,
         'o portal ofereceria um debito que o contrato nao tem, e a ativacao (so de rascunho) ficaria impossivel')

  // 5. O valor e o de CADA COBRANCA; a receita mensal divide pelo intervalo.
  checar('Receita recorrente mensal divide pelo intervalo', 'lib/relatorios-financeiro.ts',
         /mensal: valorMensalEquivalente\(p\.monthly_amount, p\.billing_interval\)/,
         'o trimestral somado como mes triplicava o numero em que o socio decide')
  const rel1 = ler('app/api/billing/reports/route.ts'), dash = ler('app/dashboard/page.tsx')
  if (/select\('id, kind, status, description, monthly_amount, billing_interval/.test(rel1)
      && /select\('id, kind, status, monthly_amount, billing_interval/.test(dash))
    ok('Relatorio e painel leem o intervalo do contrato')
  else falta('Relatorio e painel leem o intervalo do contrato', 'sem a coluna, valorMensalEquivalente trata tudo como mensal')

  // 6. A fatura do debito diz os itens so quando a conta bate com o cobrado.
  checar('Fatura do debito: itens so quando batem com o cobrado', 'app/api/stripe/webhook/route.ts',
         /const detalhe = linhasDaMensalidade\(linhasDoPlano \|\| \[\], plan\.discount, valor\)/,
         'a fatura diria um valor que nao foi o debitado')

  // 7. Editar: a trilha ANTES, o Stripe ANTES de gravar, e o valor e derivado
  //    no banco (salvar_itens_do_plano) -- nunca escrito a parte.
  const rota = ler('app/api/billing/contratos/route.ts')
  {
    const i = rota.indexOf('const pode = decidirEdicao(plano)')
    const ed = i >= 0 ? rota.slice(i) : ''
    const problemas = []
    if (!ed) problemas.push('trecho de edicao nao encontrado -- ancora perdida e FALHA')
    else {
      const iT = ed.indexOf("trilha(db, plano, 'edited'"), iS = ed.indexOf('stripe.subscriptions.update(sub.id'), iG = ed.indexOf('gravarItens(db, plano.id')
      if (!(iT >= 0 && iS > iT && iG > iS)) problemas.push('a ordem nao e trilha -> Stripe -> gravar')
      if (/monthly_amount:/.test(ed)) problemas.push('a edicao escreve monthly_amount a parte das linhas')
      // Na chamada que MUDA o preco, nao em qualquer lugar do trecho: a
      // reversao (se gravar falhar) tem o mesmo texto, e a primeira versao
      // desta conferencia passava com o proporcional de volta na mudanca.
      if (!(iS >= 0 && ed.slice(iS, iS + 400).includes("proration_behavior: 'none'")))
        problemas.push('o preco novo cobraria proporcional')
    }
    if (!/rpc\('salvar_itens_do_plano'/.test(rota)) problemas.push('as linhas nao passam pela funcao do banco')
    if (!/Intervalo, dia e forma de cobrar não mudam/.test(rota)) problemas.push('intervalo e forma viraram editaveis')
    if (!/O Stripe não cancelou a assinatura — o contrato continua ativo/.test(rota)) problemas.push('encerrar engole a recusa do Stripe')
    problemas.length
      ? falta('Contrato: editar e encerrar com trilha antes e Stripe primeiro', problemas.join(' · '))
      : ok('Contrato: editar e encerrar com trilha antes e Stripe primeiro')
  }

  // 8. Quem chama nao e QUAL cliente: o escopo por tipo em todo verbo.
  {
    const inst = ler('app/api/billing/installment-plan/route.ts'), sig = ler('app/api/signatures/contract/route.ts')
    const problemas = []
    if (!/const visiveis = \(planos \|\| \[\]\)\.filter\(\(p: any\) => !escopo\.ocultos\.has\(p\.client_id\)\)/.test(rota)) problemas.push('contratos: a lista nao filtra')
    if (!/canAccessClient\(auth, b\.clientId\)/.test(rota) || !/canAccessClient\(auth, plano\.client_id\)/.test(rota)) problemas.push('contratos: POST ou PATCH sem o dono')
    if (!/clientesOcultos\(auth\)/.test(inst) || !/canAccessClient\(auth, inv\.client_id\)/.test(inst) || !/canAccessClient\(auth, plano\.client_id\)/.test(inst)) problemas.push('parcelamentos: lista, criar ou cancelar sem o escopo')
    if ((sig.match(/canAccessClient\(auth, plan\.client_id\)/g) || []).length < 2) problemas.push('contrato do DocuSign: previa ou envio sem o dono')
    problemas.length
      ? falta('Contrato e parcelamento obedecem ao escopo por tipo', problemas.join(' · '))
      : ok('Contrato e parcelamento obedecem ao escopo por tipo (lista, criar, mexer, DocuSign)')
  }

  // 9. O contrato que vai ao DocuSign escapa o que vem da URL e do banco: o
  //    `title` da previa vinha da querystring direto para o HTML.
  const ch = ler('lib/contract-html.ts')
  if (/const signerTitle = params\.signerTitle \? esc\(params\.signerTitle\) : null/.test(ch)
      && /esc\(client\.email\)/.test(ch) && !/\$\{client\.(name|email|business_name)\}/.test(ch))
    ok('Contrato em HTML escapa a URL e o banco')
  else falta('Contrato em HTML escapa a URL e o banco', 'um link com <script> no cargo rodaria na sessao do socio')

  // 10. O parcelamento antigo (sem fatura) so se desiste como PROPOSTA depois
  //     de perguntar ao Stripe. Ate 10/2026 o agendamento travava depois da
  //     entrada paga, e o plano ficava com cara de proposta: desistir dizia
  //     ao cliente que nada foi cobrado.
  {
    const ip = ler('app/api/billing/installment-plan/route.ts')
    const i = ip.indexOf('async function desistirDaPropostaAntiga(')
    const corpo = i >= 0 ? ip.slice(i, ip.indexOf('\n}\n', i)) : ''
    const iConf = corpo.indexOf('entrada = await entradaNoStripe(plano)'), iCanc = corpo.indexOf("status: 'cancelled'")
    if (!corpo) falta('Proposta antiga so se desiste depois de perguntar ao Stripe', 'desistirDaPropostaAntiga nao encontrada -- ancora perdida e FALHA')
    else if (!(iConf >= 0 && iCanc > iConf) || !/entry_paid_at: quando\.toISOString\(\)/.test(corpo)
             || !/const pago = entrada\.integra\s*\n/.test(corpo) || !/avisarNoPortal\(db, plano\.client_id, entradaVoltou\s*\?/.test(corpo))
      falta('Proposta antiga so se desiste depois de perguntar ao Stripe',
            'a entrada paga no Stripe nao e conferida (ou nao fica registrada) antes de desistir: o cliente ouviria que nada foi cobrado')
    else ok('Proposta antiga so se desiste depois de perguntar ao Stripe')
  }
}

titulo('DUPLICACOES A DECIDIR (nao sao erros, sao escolhas)')
// Resolvidas: Plans x recurring_plans (sql/contrato-unico-v1.sql), Quotes x
// estimates (orcamentos no Financeiro), staff_roles x team_members
// (sql/equipe-unica-v1.sql). Duplicacao nova entra aqui com o arquivo que a denuncia.
for (const d of [
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
