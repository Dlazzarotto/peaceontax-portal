# Peace on Tax OS — Especificação do Sistema

**Documento vivo** · Atualizado em 3 de setembro de 2026

---

## 1. O que é

Sistema próprio da **Peace on Tax Corp** para operar uma firma de contabilidade e impostos: relacionamento com o cliente, escrituração contábil (bookkeeping), contratos, cobrança e comunicação — substituindo a combinação de QuickBooks, planilhas e conversas soltas por WhatsApp.

**Quem usa:** a equipe da firma (sócio, gerente, assistente) e os próprios clientes, cada um com sua área.

**Onde roda:** Next.js 14 na Vercel · banco Supabase (PostgreSQL) · repositório no GitHub, com publicação automática a cada `git push`.

---

## 2. Princípios que orientam as decisões

Estes princípios foram estabelecidos ao longo da construção e explicam por que o sistema é como é:

1. **Quem emite não dá baixa.** Separação de funções no financeiro — o assistente emite fatura, mas não registra pagamento.
2. **Nada se apaga sem rastro.** Cancelar preserva o documento; apagar é exceção restrita e bloqueada quando há dinheiro envolvido.
3. **Toda ação sensível pede senha e motivo.** Editar fatura, estornar pagamento, lançar manualmente, alterar conta bancária.
4. **O cliente é da firma, não da pessoa.** Comunicação sai como Peace on Tax; a autoria fica registrada por dentro.
5. **Documento que sai leva a marca.** Logo, endereço e contato em contrato, fatura, orçamento e relatórios.
6. **Consentimento é prova, não formalidade.** Autorização de cobrança e de mensagens fica gravada com data, hora, IP e origem.
7. **O motor decide sozinho, a IA não.** Transferências e pagamentos de cartão são identificados por regra determinística, nunca por inferência.

---

## 3. Níveis de acesso

Fonte única de permissão: tabela `staff_roles`. O convite escolhe um papel, que é traduzido para um dos três níveis.

| Convite | Nível | Alcance |
|---|---|---|
| Owner · Admin | `owner` | tudo, inclusive relatórios e totais do negócio |
| Manager | `manager` | opera o dia a dia; **não** vê faturamento consolidado |
| Staff | `junior` | acesso restrito; ações sensíveis exigem PIN de gerente |

**Matriz do financeiro:**

| Ação | Assistente | Gerente | Sócio |
|---|---|---|---|
| Emitir orçamento/fatura | ✅ | ✅ | ✅ |
| Registrar pagamento | ❌ | ✅ | ✅ |
| Duplicar · Cancelar · Apagar | ❌ | ✅ | ✅ |
| Editar fatura | ❌ | ✅ com senha e motivo | ✅ |
| Estornar pagamento | ❌ | ✅ com senha e motivo | ✅ |
| Conceder desconto | ❌ | ✅ | ✅ |
| Relatórios e totais | ❌ | ❌ | ✅ |
| Ver conversas de atendimento | ❌ | ✅ | ✅ |

O cliente só acessa o próprio cadastro. Quem não tem registro em `staff_roles` é tratado como assistente — o nível mais restrito.

---

## 4. Módulos

### 4.1 Clientes e portal

Cadastro de pessoas físicas e jurídicas, com etapa do serviço, documentos, agendamento e mensagens. O cliente entra no portal para enviar documentos, acompanhar o andamento, pagar e — quando é empresa — consultar a contabilidade.

**Portal do cliente:** Home · Documentos · Organizador fiscal · Bancos · **Contabilidade** · Mensagens · Pagamentos.

A aba Contabilidade (só para empresa) reúne **DRE (P&L)**, **Balanço Patrimonial**, **Fornecedores** e **1099**, com seletor de ano e impressão no mesmo padrão da firma.

### 4.2 Bookkeeping

O núcleo operacional. Importa movimentação bancária por **Plaid**, **PDF de extrato** ou **CSV**, classifica automaticamente e produz os relatórios.

**Histórico do QuickBooks.** Para trazer o passado sem redigitar: exporta-se do QuickBooks Online o relatório *Transaction List by Date* (ou *Transaction Detail by Account*) em CSV e importa-se na aba Bookkeeping. Cada conta do relatório vira (ou aponta para) uma conta bancária do cliente; a categoria vem do *Split* e, quando o nome casa com uma categoria do sistema, o lançamento entra já aprovado (a decisão foi de uma pessoa no QuickBooks). *Split* sem correspondência pode ser mapeado na prévia ou fica pendente; "-Split-" (várias categorias) sempre fica pendente. O dedupe é o mesmo do CSV e do PDF, e a origem fica marcada como `quickbooks`.

**Motor de classificação** — três pontos do sistema executam a mesma lógica (importação, aplicação de regras e criação de regra), mantidos sincronizados:

- **Casamento por palavra inteira.** Fragmentos com menos de 3 caracteres são ignorados. Evita que "mobil" capture "Mobilizat" ou "bk" capture "BNF BK:ITAU".
- **Limpeza de metadados.** Remove ruído de wire e ACH (`BNF BK:`, `ORIG:`, `ID:`, `TRN:`, `Conf#`) antes de comparar.
- **Transferência interna** só quando o extrato diz literalmente "transfer to/from" **e** a conta citada é uma conta cadastrada do cliente, **e** o sentido é coerente com o sinal do valor. Conta não cadastrada é dinheiro de fora — receita ou despesa normal.
- **Pagamento de cartão** reconhecido pelo nome do cartão ou pelos 4 dígitos, nas duas pontas (saída do checking e entrada no cartão). A detecção de cartão tem precedência sobre as regras.
- **Non-profit** (igreja, ONG): cada conta bancária é um fundo; as regras valem só para aquela entidade, nunca as gerais.

**Conciliação bancária** no padrão QuickBooks: só fecha com diferença zero. Permite **incluir lançamento manual** durante a conciliação — para cheque não compensado, dinheiro em espécie ou ajuste — restrito a sócio e gerente, com senha e alerta de duplicidade.

**Relatórios:** DRE, Balanço, Fornecedores, Detalhe por conta contábil e 1099. Formato formal preto e branco, timbre com a logo, subtotais em negrito, total em linha dupla, sem parênteses (sinal de menos), Georgia/Times.

### 4.3 Financeiro (faturamento)

Ciclo completo: **orçamento → fatura → cobrança → recebimento**.

**Documentos.** Orçamentos e faturas na mesma estrutura, distinguidos por tipo, com numeração sequencial por ano (`INV-2026-0001`) gerada no banco — à prova de duas pessoas emitindo ao mesmo tempo. Nascem como rascunho; enviar é ato consciente do gerente ou sócio. Itens vêm do **catálogo de preços** (`pricing_items`), e cada item guarda o **preço praticado** — reajuste futuro não altera fatura antiga.

**Formas de pagamento e o que cada uma permite:**

| Forma | Parcela? | Cobrança automática? |
|---|---|---|
| Cartão · ACH | ✅ | ✅ |
| Klarna | cliente parcela com eles | firma recebe integral na hora |
| Dinheiro · Zelle · Venmo · Cheque · Wire | ❌ | ❌ baixa manual |

Pagamento **dividido** é permitido (ex.: $50 em dinheiro + $50 no cartão); o que faltar continua em aberto. O que não se permite é parcelar nas formas manuais.

**Klarna** merece destaque: o cliente parcela com a financeira, a firma recebe o valor cheio imediatamente e **o risco de inadimplência deixa de ser da firma** — resposta direta ao histórico de contestação de cobrança.

**Cobrança pelo Stripe.** Quando a equipe envia a fatura, o cliente recebe e-mail e aviso no portal. Em **Pagamentos**, no portal, ele clica em Pagar e o sistema abre **um link só com as três formas** — cartão, débito em conta (ACH) e Klarna; o cliente escolhe na página do Stripe, e se pedir Klarna a aprovação é feita ali mesmo (recusou, ele escolhe outra forma na mesma tela). A equipe também pode gerar esse link único no Receber, ou um link de forma específica; todo link volta para o portal do cliente e vale 24 horas — no portal ele sempre tem um novo. Quando o cliente paga, o **webhook** descobre a forma usada pelo PaymentIntent (nunca pela lista oferecida), registra o pagamento, o gatilho do banco recalcula o saldo, a fatura vira Paga e o cliente é avisado — sem intervenção humana. Débito em conta leva dias: o pagamento entra como "em processamento" e só vira recebido quando o banco confirma (`async_payment_succeeded`); devolução fica registrada e o cliente é avisado. Recusas ficam registradas com o motivo.

**Fatura parcelada na emissão.** Quando a equipe parcela a fatura, o cliente recebe e-mail e aviso no portal; em Pagamentos ele paga a entrada (se houver) ou cadastra a conta bancária/cartão com o mandato ACH, sem cobrança imediata. A sessão do Stripe é criada na hora em que ele clica (`lib/plan-checkout.ts`, a mesma regra que a equipe usa), porque o link do Checkout expira em 24 horas.

**Estorno.** Sócio faz direto; gerente precisa de senha e motivo. O pagamento vai para `payment_reversals` antes de sair. Se veio do Stripe, o sistema avisa que a devolução do dinheiro precisa ser feita no painel do Stripe — apagar o registro não devolve nada.

**Impressão.** Toda fatura e orçamento gera documento formal com timbre, dados do cliente, itens, parcelas, pagamentos recebidos e saldo.

**Aviso antes do débito.** Todo dia, uma rotina agendada na Vercel (`vercel.json` → `/api/cron/billing-reminders`, protegida por `CRON_SECRET`) encontra os planos ativos cujo débito cai em **três dias** — mensalidade no dia acordado, parcela pelo cronograma — e avisa o cliente: por SMS quando há consentimento, senão por e-mail, e sempre com aviso no portal. Cada aviso fica em `plan_audit` (`reminder_sent`, com canal, data e valor) e tem chave única por plano e data, então rodar duas vezes no dia não duplica. As regras de data são as mesmas do checkout e do cronograma (`lib/plans.ts`).

### 4.4 Planos e contratos

Contratos recorrentes: **bookkeeping mensal** (com transações incluídas e valor por excedente) e **outros serviços mensais** (payroll, sales tax), mais **parcelamento** de serviços avulsos com entrada.

O **dia da cobrança é definido no acordo** (1 a 28), não mais fixo. Um cliente pode ter vários serviços mensais, mas o sistema impede dois planos ativos do mesmo serviço — evita cobrança duplicada.

**Contrato** gerado pelo sistema, em português ou inglês conforme o cliente, com timbre e dez cláusulas: objeto, preço, autorização de débito, obrigações, prazo, atraso, entrega, confidencialidade, **autorização ACH** e assinaturas. Assinado via **DocuSign**, com campos preenchíveis pelo cliente (banco, tipo de conta, routing, account) e rubrica.

**Dados de cartão nunca são coletados no documento** — o cliente cadastra em ambiente seguro do Stripe, e o contrato autoriza a cobrança naquele método. Mantém a firma fora do escopo PCI pesado.

O botão **Ver contrato** abre a prévia sem tocar no DocuSign, para conferência antes do envio.

### 4.5 Comunicação

**SMS** pelo Twilio, número (857) 837-2327. Envio com três travas obrigatórias: cliente autorizou, não pediu STOP, e tem celular válido. A verificação fica dentro da biblioteca de envio — nenhum fluxo novo consegue burlar por esquecimento. Toda mensagem sai identificada e com "Reply STOP to opt out".

**Consentimento** registrado com data, hora, IP, origem (portal, equipe ou palavra-chave) e o texto exato que o cliente viu. O histórico nunca é sobrescrito.

Três caminhos alimentam esse registro: o **próprio cliente, no portal** (a prova mais forte: ele lê o texto versionado em `lib/sms-consent-text.ts`, marca que concorda e ficam IP e navegador); a **equipe, na ficha do cliente** (exige descrever como o cliente autorizou); e a **palavra-chave por SMS** (webhook `/api/sms/webhook`, assinatura da Twilio conferida). STOP e equivalentes gravam o cancelamento e a biblioteca de envio passa a recusar na hora. START só reativa quem já tinha autorizado antes — um START de quem nunca autorizou não cria consentimento. Mensagens de texto comuns entram na fila do Atendimento no canal `sms`, sem passar pelo bot.

**WhatsApp** pela API do Twilio, com atendimento pelo portal: bot responde consultas de status primeiro, escala para humano quando não souber. Mensagens saem como Peace on Tax; a autoria fica visível só para a equipe. Respeita a janela de 24 horas da Meta — fora dela, apenas templates aprovados.

---

## 5. Integrações

| Serviço | Para quê | Situação |
|---|---|---|
| **Supabase** | banco, autenticação, arquivos | ✅ operando |
| **Stripe** | pagamentos, links, Klarna, ACH | ✅ operando em produção |
| **Plaid** | importação bancária automática | ✅ operando |
| **DocuSign** | assinatura de contratos | ⚠️ chave corrigida, falta testar |
| **Resend** | e-mails transacionais | ✅ operando |
| **Twilio SMS** | avisos e cobrança | ⏳ campanha A2P em aprovação |
| **Twilio WhatsApp** | atendimento e bot | ⏳ cadastro na Meta |
| **Anthropic** | apoio à classificação | ✅ operando |

---

## 6. Auditoria

Cada área guarda sua própria trilha, com quem fez, quando, em que nível e por quê:

`invoice_audit` (faturas) · `payment_reversals` (estornos) · `client_audit` (cadastro) · `plan_audit` (contratos) · `quote_audit` (orçamentos) · `bank_account_audit` (contas bancárias) · `sms_consent_log` (consentimento) · `sms_messages` (mensagens).

Além do valor operacional, essa trilha existe por uma razão concreta: **num questionamento de cobrança, o que protege a firma é o registro** — contrato assinado, autorização datada, aviso enviado e histórico de pagamentos.

---

## 7. Verificação

Existe um script de auditoria na raiz do projeto (`npm run auditoria`, arquivo `auditoria.mjs`; `auditoria.ps1` é a versão original em PowerShell) que confere os invariantes do sistema: o motor de regras nos três pontos, transferências, cartões, isolamento non-profit, formato de datas, permissões em todas as rotas do financeiro, assinatura dos webhooks do Stripe e da Twilio, travas do SMS, lista fechada de APIs públicas e integridade dos arquivos (acentos corrompidos, BOM, `.bak` versionado).

Junto dele, `npm run typecheck` e `npm run lint` são a trava de qualidade — a Vercel publica mesmo com erro de tipo, então esses três comandos rodam antes de cada push.

Rodar antes de cada sessão de trabalho mostra em segundos o que está realmente instalado — evita horas investigando sintomas de código antigo.

---

## 8. O que falta

**Em andamento, dependendo de terceiros:**
- Campanha A2P do SMS (suporte do Twilio)
- Cadastro do WhatsApp Sender (Meta)
- Teste do envio de contrato pelo DocuSign

**Construído desde a versão anterior deste documento** (conferido no código em 3 de setembro de 2026):
- Tela de **Atendimento** (fila e conversa) em `app/dashboard/atendimento`, com as rotas de fila, conversa, envio e atribuição
- Webhook de recebimento do WhatsApp e o bot de consultas (`lib/wa-bot.ts`), determinístico, nível `publico` por padrão
- Consentimento de SMS **no portal do cliente** (cartão na página inicial, texto versionado) e webhook de SMS recebido com STOP/START/HELP, dedupe por SID e encaminhamento de texto livre ao Atendimento. Migração: `sql/sms-consentimento-portal-v1.sql`
- **Aviso de cobrança três dias antes do débito**: cron diário na Vercel, SMS com fallback para e-mail e aviso no portal, trilha em `plan_audit`. Exige a variável `CRON_SECRET` no ambiente
- **Importação do histórico do QuickBooks** pelo relatório exportado (`/api/bookkeeping/import-quickbooks`, prévia com contas, tipos e categorias antes de gravar)
- Tela de **novo serviço mensal** nos Planos (payroll, sales tax…), com item do catálogo, valor e **dia da cobrança (1 a 28)** escolhidos no acordo; o formulário de bookkeeping ganhou o mesmo campo. O contrato passou a ler o dia acordado (antes lia uma coluna inexistente e imprimia sempre dia 5) e tem cláusulas próprias para serviço mensal, sem a regra de transações incluídas

**A construir:**
- Nada pendente da lista original. Próximos itens entram aqui quando forem decididos.

**Decisões pendentes:**
- Módulo Plans × tabela `recurring_plans` (duplicação a resolver)
- Orçamentos: módulo Quotes × estimates do financeiro
- `staff_roles` × `team_members` (permissão × CRM)
- Menu repetido em quatro layouts
- Domínio próprio `portal.peaceontax.com`

---

## 9. Onde as coisas ficam

```
app/
  dashboard/          área da equipe (clientes, bookkeeping, financeiro, listas)
  portal/             área do cliente
  api/
    bookkeeping/      importação, regras, relatórios, conciliação
    billing/          faturas, pagamentos, Stripe, impressão
    plans/            contratos e parcelamentos
    signatures/       DocuSign
    stripe/webhook    entrada única dos eventos de pagamento
    clients/ firm/    cadastro e equipe
components/           telas reutilizáveis (BookkeepingTab, PlansTab, ProfileEditor…)
lib/                  motor de regras, permissões, SMS, contrato, integrações
middleware.ts         controle de acesso por rota
```

---

*Documento mantido junto ao projeto. Sempre que uma regra de negócio mudar, esta especificação deve mudar com ela — é o que impede o sistema de virar um conjunto de decisões que ninguém mais lembra por que foram tomadas.*
