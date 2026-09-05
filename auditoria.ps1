# ============================================================
#  AUDITORIA DO PORTAL â€” confere se o que estÃ¡ instalado
#  corresponde Ã s decisÃµes tomadas na construÃ§Ã£o.
#  Rode na raiz do projeto:  .\auditoria.ps1
# ============================================================

function Checar($titulo, $arquivo, $padrao, $porque) {
  if (-not (Test-Path $arquivo)) {
    Write-Host ("[FALTA ]  {0}" -f $titulo) -ForegroundColor Red
    Write-Host ("           arquivo inexistente: {0}" -f $arquivo) -ForegroundColor DarkGray
    return
  }
  $achou = Select-String -Path $arquivo -Pattern $padrao -Quiet
  if ($achou) {
    Write-Host ("[  OK  ]  {0}" -f $titulo) -ForegroundColor Green
  } else {
    Write-Host ("[FALTA ]  {0}" -f $titulo) -ForegroundColor Red
    Write-Host ("           {0}" -f $porque) -ForegroundColor DarkGray
  }
}

Write-Host ""
Write-Host "=== MOTOR DE REGRAS (os tres pontos precisam do mesmo motor) ===" -ForegroundColor Cyan
Checar "Importacao: casamento por palavra inteira" ".\lib\apply-rules.ts" "casaTexto" "sem isto 'mobil' pega 'Mobilizat'"
Checar "Importacao: limpa metadados de wire"       ".\lib\apply-rules.ts" "limparRuido" "sem isto 'bk' pega 'BNF BK:ITAU'"
Checar "Aplicar regras: palavra inteira"           ".\app\api\bookkeeping\categorize\route.ts" "casaTexto" "motor divergente"
Checar "Aplicar regras: limpa metadados"           ".\app\api\bookkeeping\categorize\route.ts" "limparRuido" "motor divergente"
Checar "Criar/editar regra: palavra inteira"       ".\app\api\bookkeeping\rules\route.ts" "casaTexto" "terceiro motor esquecido"

Write-Host ""
Write-Host "=== TRANSFERENCIAS E CARTAO ===" -ForegroundColor Cyan
Checar "So com 'transfer to/from'"        ".\lib\apply-rules.ts" "sentidoTransferencia" "espelho por valor gerava falsos"
Checar "Conta citada tem que ser do cliente" ".\lib\apply-rules.ts" "contasDeFora" "dinheiro de fora vira transferencia"
Checar "Cartao reconhecido pelo nome"      ".\app\api\bookkeeping\categorize\route.ts" "cartaoCitado" "AMEX EPAYMENT sem 4 digitos"
Checar "Pagamento dentro do cartao"        ".\app\api\bookkeeping\categorize\route.ts" "ehPagamentoNoCartao" "quitacao viraria receita"

Write-Host ""
Write-Host "=== NON-PROFIT ===" -ForegroundColor Cyan
Checar "Importacao ignora regras gerais"   ".\lib\apply-rules.ts" "nonprofit" "igreja usaria regras de empresa"
Checar "Aplicar regras idem"               ".\app\api\bookkeeping\categorize\route.ts" "nonprofit" "idem"
Checar "Lista de regras idem"              ".\app\api\bookkeeping\rules\route.ts" "nonprofit" "idem"

Write-Host ""
Write-Host "=== DATAS NO PADRAO DOS EUA ===" -ForegroundColor Cyan
Checar "Bookkeeping"    ".\components\BookkeepingTab.tsx" "fmtDate" "datas apareciam como no Brasil"
Checar "Conciliacao"    ".\components\ReconcileTab.tsx" "fmtDate" "idem"

Write-Host ""
Write-Host "=== FINANCEIRO: PERMISSOES EM TODAS AS ROTAS ===" -ForegroundColor Cyan
Checar "Faturas"      ".\app\api\billing\invoices\route.ts" "permissoesFinanceiro" "rota sem controle de acesso"
Checar "Pagamentos"   ".\app\api\billing\payments\route.ts" "permissoesFinanceiro" "rota sem controle de acesso"
Checar "Contratos"    ".\app\api\billing\recurring\route.ts" "permissoesFinanceiro" "rota sem controle de acesso"
Checar "Link Stripe"  ".\app\api\billing\stripe-checkout\route.ts" "permissoesFinanceiro" "qualquer um geraria cobranca"
Checar "Estorno com senha do gerente" ".\app\api\billing\payments\route.ts" "signInWithPassword" "estorno sem confirmacao"
Checar "Fatura nao fica sem itens"   ".\app\api\billing\invoices\route.ts" "desfaz para" "documento vazio (ja aconteceu)"
Checar "Catalogo unico"              ".\app\api\billing\invoices\route.ts" "pricing_items" "duas listas de preco"

Write-Host ""
Write-Host "=== WEBHOOK DO STRIPE: assinatura conferida ===" -ForegroundColor Cyan
Checar "Webhook do Stripe confere a assinatura" ".\app\api\stripe\webhook\route.ts" "constructEvent" "qualquer um marcaria faturas como pagas"

Write-Host ""
Write-Host "=== DUPLICACOES A DECIDIR (nao sao erros, sao escolhas) ===" -ForegroundColor Yellow
$dup = @(
  @{ n = "Orcamentos: modulo Quotes x estimates do faturamento"; a = ".\components\QuotesTab.tsx" },
  @{ n = "Contratos: modulo Plans x recurring_plans";            a = ".\components\PlansTab.tsx" },
  @{ n = "Equipe: staff_roles (permissao) x team_members (CRM)"; a = ".\app\team\page.tsx" },
  @{ n = "Webhook Stripe antigo em /api/stripe/webhook";         a = ".\app\api\stripe\webhook\route.ts" }
)
foreach ($d in $dup) {
  if (Test-Path $d.a) { Write-Host ("[ VER  ]  {0}" -f $d.n) -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "=== MENU DUPLICADO EM QUANTOS LAYOUTS ===" -ForegroundColor Cyan
Get-ChildItem .\app -Recurse -Include layout.tsx |
  Select-String -Pattern "Bookkeeping','/dashboard/bookkeeping'|/invitations" -List |
  ForEach-Object { Write-Host ("   menu em: {0}" -f $_.Path.Replace((Get-Location).Path, '.')) -ForegroundColor DarkGray }

Write-Host ""
Write-Host "Auditoria concluida." -ForegroundColor Cyan

