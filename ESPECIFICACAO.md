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

**Dentro da firma, todo mundo vê todos os clientes.** `canAccessClient` faz
`if (auth.isStaff) return true`. A coluna `clients.assignee` é rótulo de
CRM — aparece na lista, na ficha e no e-mail de convite —, **não** é
controle de acesso. A tela de equipe chegou a prometer "Staff: view and
edit assigned clients only", o que nunca foi verdade; o texto foi
corrigido para descrever o que o sistema faz. Restringir assistente aos
clientes atribuídos é **decisão do sócio pendente**, não defeito: numa
temporada com 40 atendimentos por dia, travar o balcão tem custo próprio.

### 3.1 Autorizações por pessoa, em cima do nível

O nível é um degrau inteiro. Para autorizar a assistente a **receber no
balcão** era preciso promovê-la a gerente — e gerente traz junto cancelar,
apagar e estornar. Agora o sócio autoriza a **chave exata**, e retira quando
quiser, sem mexer no nível.

O conjunto final é montado por `permissoesDe` (`lib/permissoes.ts`, lógica
pura e testada):

1. o **nível** dá a base;
2. cada **autorização** é um sim ou um não explícito, que vence o nível;
3. o **sócio é imune** — concessão negativa não o alcança. Tirar poder de
   sócio se faz mudando o nível, à vista, não por uma chave solta.

As dez chaves: `criar · receber · editar · duplicar · cancelar ·
darDesconto · estornar · apagar · verRelatorios · verTotais`. A mesma lista
está no `CHECK` da migração, e a auditoria falha se as duas divergirem.

**A trilha é a tabela.** `staff_grants` é *append-only*: cada decisão grava
uma linha com quem autorizou, quando, o motivo (obrigatório) e o conflito
de separação de funções, se houve. O estado atual é a última linha de cada
chave, pela view `staff_grants_atual`. Estado e histórico não podem
discordar porque são a mesma coisa — princípio 2.

**Separação de funções, princípio 1.** Todos emitem fatura. Autorizar
`receber` a quem emite quebra "quem emite não dá baixa" — é o vetor de
fraude clássico (emitir por $500, receber em dinheiro, registrar $300).
Não é proibido: é decisão do sócio, e existem casos legítimos. Mas
`conflitoDeSeparacao` devolve em uma frase o que está sendo quebrado, a
tela mostra **antes** de salvar, e o motivo fica gravado. Autorização assim
é decisão registrada, não clique. O mesmo vale para `estornar` concedido a
quem recebe — aí a pessoa desfaria o próprio recebimento.

Quem autoriza é **só o sócio**, e ninguém mexe nas próprias permissões.
Editar fatura continua pedindo senha e motivo para todo mundo que não seja
sócio, inclusive quem recebeu a autorização: ela diz que a pessoa **pode**,
não que pode sem deixar rastro.

**Cartão e Zelle sozinho; o resto pede senha de gerente ou sócio.**
Quem tem `receber` registra **cartão** e **Zelle** por conta própria — os
dois deixam rastro fora do sistema (cobrança no Stripe, crédito no extrato
da firma). **Dinheiro em espécie, cheque, wire, Venmo, débito em conta,
financiamento e "outro"** só entram com o e-mail e a senha de um gerente ou
sócio, e quem aprovou fica na trilha da fatura (`invoice_audit`).

A lista em `lib/recebimento-aprovacao.ts` é de **livres**, não de
bloqueadas: forma de pagamento nova nasce pedindo aprovação até alguém
decidir o contrário. Errar para o lado da trava custa uma senha; errar para
o outro custa dinheiro que ninguém reconstitui.

Senha certa não basta — o sistema confere que quem aprovou é mesmo gerente
ou sócio. E a trava é da **rota**, não da tela: esconder o botão não é
controle de acesso.

### 3.2 Duas perguntas diferentes: a porta e o poder

São decisões separadas e não podem ser confundidas:

1. **A porta — firma ou cliente?** Vem de `lib/papeis.ts`, e só de lá.
   `user_metadata.role` do login é comparado com uma **lista fechada**:
   `firm · owner · admin · manager · staff`. Papel fora da lista é **cliente**.
   Errar para o lado restritivo tranca um funcionário, que o sócio libera em
   um minuto; errar para o outro abre a carteira inteira.
2. **O poder dentro da firma — owner, manager ou junior?** Vem de
   `staff_roles`, por `lib/staff-perms.ts`, como na tabela acima.

**Por que isto está escrito aqui.** O sistema tinha duas linguagens para a
mesma coisa: o convite gravava `firm | admin | manager | staff`, e a porta
lia `role === 'firm' ? 'firm' : 'client'`, escrito em três arquivos
diferentes. Quem era convidado como **Staff** — o padrão do formulário —,
Manager ou Admin virava **cliente** ao entrar: caía no `/portal`, via um
portal vazio (não há linha em `clients` para ele) e levava 403 em toda rota
de API. Só quem era convidado como Owner funcionava. A auditoria agora
recusa qualquer arquivo que volte a comparar `user_metadata.role` com
`'firm'` por conta própria.

### 3.3 Toda rota de API confere quem está chamando

O `middleware.ts` exige **sessão**, não identidade — a sessão de um cliente
serve para bater em qualquer rota. A conferência de *quem* é obrigatória
**dentro** da rota, e a auditoria recusa route.ts que não faça nenhuma:

- `getAuth()` de `lib/api-auth.ts` — equipe × cliente, mais `canAccessClient`
- `getUser()` + filtro por `user_id` — rotas do portal
- `autorDaRequisicao` de `lib/wa-auth.ts` — atendimento (nível da equipe)
- `CRON_SECRET`, assinatura do Stripe, assinatura da Twilio — máquinas

Isto não é teoria. `/api/firm/users/[id]` não conferia nada e usava a
service role key: **qualquer pessoa logada, inclusive um cliente**, podia
`PATCH {"role":"firm"}` e virar firma, trocar a senha do sócio e assumir a
conta, ou banir qualquer usuário. Junto com ela estavam sem guarda
`/api/clients/[id]` (ler, editar e inativar qualquer cliente),
`/api/documents/[id]` (link assinado de qualquer declaração), `/api/documents`,
`/api/upload`, `/api/process-pdf` e `/api/firm/messages` (escrever em nome da
firma na conversa de qualquer cliente).

Duas regras que saíram daí:

- **Corpo de requisição nunca vai inteiro para o banco.** `/api/clients/[id]`
  fazia `update({...body})`: dava para gravar `user_id` e apontar a ficha de
  um cliente para o login de outro. Só a lista de campos de `lib/novo-cliente.ts`.
- **`user_metadata` se mescla, nunca se substitui.** A tela de equipe
  reescrevia o metadata inteiro: corpo sem `role` rebaixava um membro da
  firma a cliente e apagava `must_change_password`.

Gerenciar a equipe é do **sócio**, e ninguém altera o próprio acesso —
a mudança de papel ali também atualiza `staff_roles`, senão a tela diz
"Manager" e o sistema continua tratando como assistente.

**O nível só é reescrito quando o papel muda.** Papel e nível podem
discordar de propósito: existe hoje quem tem papel `firm` e nível `manager`,
afinado à mão em `/api/account/team`. Sincronizar em toda gravação faria uma
edição de telefone promover essa pessoa a sócia — e ela passaria a ver o
faturamento consolidado, sem ninguém pedir. Quem manda no que a pessoa PODE
é sempre o `staff_roles`.

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

**Débito em conta é confirmado, não presumido.** O ACH leva dias: tanto a fatura quanto a entrada de parcelamento entram como "em processamento" quando o cliente conclui, e só viram recebidas quando o banco confirma. Devolução fica na trilha e avisa o cliente. A primeira cobrança de uma mensalidade respeita a folga de 48 horas que o Stripe exige: se o dia acordado estiver perto demais, a cobrança vai para a ocorrência seguinte, no mesmo dia do mês.

**Cobrança pelo Stripe.** Quando a equipe envia a fatura, o cliente recebe e-mail e aviso no portal. Em **Pagamentos**, no portal, ele clica em Pagar e o sistema abre **um link só com as três formas** — cartão, débito em conta (ACH) e Klarna; o cliente escolhe na página do Stripe, e se pedir Klarna a aprovação é feita ali mesmo (recusou, ele escolhe outra forma na mesma tela). A equipe também pode gerar esse link único no Receber, ou um link de forma específica; todo link volta para o portal do cliente e vale 24 horas — no portal ele sempre tem um novo. Quando o cliente paga, o **webhook** descobre a forma usada pelo PaymentIntent (nunca pela lista oferecida), registra o pagamento, o gatilho do banco recalcula o saldo, a fatura vira Paga e o cliente é avisado — sem intervenção humana. Débito em conta leva dias: o pagamento entra como "em processamento" e só vira recebido quando o banco confirma (`async_payment_succeeded`); devolução fica registrada e o cliente é avisado. Recusas ficam registradas com o motivo.

**Fatura parcelada na emissão.** Quando a equipe parcela a fatura, o cliente recebe e-mail e aviso no portal; em Pagamentos ele paga a entrada (se houver) ou cadastra a conta bancária/cartão com o mandato ACH, sem cobrança imediata. A sessão do Stripe é criada na hora em que ele clica (`lib/plan-checkout.ts`, a mesma regra que a equipe usa), porque o link do Checkout expira em 24 horas.

**Estorno.** Sócio faz direto; gerente precisa de senha e motivo. O pagamento vai para `payment_reversals` antes de sair. Se veio do Stripe, o sistema avisa que a devolução do dinheiro precisa ser feita no painel do Stripe — apagar o registro não devolve nada.

**Dinheiro que volta sem passar pela equipe.** Reembolso feito no painel do Stripe, contestação (chargeback) perdida e débito ACH devolvido depois de confirmado tiram o dinheiro do caixa sem que ninguém aqui peça — e a receita continuava registrada como recebida. O webhook passou a desfazer o recebimento nesses três casos, pela mesma rotina do estorno manual (`lib/estorno-stripe.ts`): `payment_reversals` primeiro, recebimento depois, fatura reaberta, trilha em `invoice_audit` e alerta à equipe. A autoria fica como do Stripe, não de uma pessoa. Se o rastro não puder ser gravado, **o recebimento não é apagado** — nada se apaga sem rastro, e aqui não há humano conferindo. Duas exceções deliberadas: **reembolso parcial** não desfaz nada (o valor não bate; vira alerta para a equipe acertar à mão) e **contestação aberta** também não (o dinheiro está retido e pode voltar) — ela só alerta, porque há prazo para enviar comprovação. Contestação **perdida** desfaz sozinha: é fato consumado, não decisão da equipe. Débito devolvido avisa também o cliente, que precisa saber que a fatura reabriu.

**Impressão.** Toda fatura e orçamento gera documento formal com timbre, dados do cliente, itens, parcelas, pagamentos recebidos e saldo.

**Relatórios do sócio.** Botão Relatórios no Financeiro, visível e servido **só ao sócio** (`verRelatorios`; gerente e assistente recebem recusa na rota). Seis relatórios impressos, no mesmo padrão dos contábeis, com período escolhido: **Faturamento por mês** (emitido, recebido e em aberto), **Recebimentos** (por forma e por cliente, com Klarna como financiado), **Contas a receber** (por cliente, com atraso em faixas), **Contratos e parcelamentos** (receita recorrente mensal dos contratos ativos e parcelas a receber), **Faturamento por serviço** (por item do catálogo) e **Estornos e cancelamentos**. Orçamentos, rascunhos e faturas canceladas ficam fora do faturamento. As contas ficam em `lib/relatorios-financeiro.ts`, sem banco, testadas com casos fixos.

**Aviso antes do débito.** Todo dia, uma rotina agendada na Vercel (`vercel.json` → `/api/cron/billing-reminders`, protegida por `CRON_SECRET`) encontra os planos ativos cujo débito cai em **três dias** — mensalidade no dia acordado, parcela pelo cronograma — e avisa o cliente: por SMS quando há consentimento, senão por e-mail, e sempre com aviso no portal. Cada aviso fica em `plan_audit` (`reminder_sent`, com canal, data e valor) e tem chave única por plano e data, então rodar duas vezes no dia não duplica. As regras de data são as mesmas do checkout e do cronograma (`lib/plans.ts`).

### 4.4 Planos e contratos

Contratos recorrentes: **bookkeeping mensal** (com transações incluídas e valor por excedente) e **outros serviços mensais** (payroll, sales tax), mais **parcelamento** de serviços avulsos com entrada.

O **dia da cobrança é definido no acordo** (1 a 28), não mais fixo. Um cliente pode ter vários serviços mensais, mas o sistema impede dois planos ativos do mesmo serviço — evita cobrança duplicada.

**Contrato** gerado pelo sistema, em português ou inglês conforme o cliente, com timbre e dez cláusulas: objeto, preço, autorização de débito, obrigações, prazo, atraso, entrega, confidencialidade, **autorização ACH** e assinaturas. Assinado via **DocuSign**, com campos preenchíveis pelo cliente (banco, tipo de conta, routing, account) e rubrica.

**Dados de cartão nunca são coletados no documento** — o cliente cadastra em ambiente seguro do Stripe, e o contrato autoriza a cobrança naquele método. Mantém a firma fora do escopo PCI pesado.

O botão **Ver contrato** abre a prévia sem tocar no DocuSign, para conferência antes do envio.

**Assinatura no portal.** Enviar o contrato libera o plano e avisa o cliente (e-mail da firma e aviso no portal). Em Pagamentos, ele clica em **Assinar contrato**: a tela do DocuSign abre embutida (assinante com `clientUserId`), ele assina o contrato — que já contém a **autorização de débito automático** — e, ao terminar, o sistema confere a assinatura pela API do DocuSign (nunca pelo parâmetro de retorno), registra `contract_signed_by_client` em `plan_audit` e o leva **direto ao Stripe** para cadastrar a conta bancária (ACH) ou o cartão. Enquanto o contrato não está assinado, o plano não aceita cadastro de débito. A firma assina depois, pelo e-mail do DocuSign; quando o envelope completa, a equipe atualiza o status e o PDF assinado é arquivado. O envio por e-mail do DocuSign (fluxo antigo) continua disponível com `viaEmail`.

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

- **Fornecedores e clientes (Listas)** passou a permitir mudar o escopo do cadastro (geral × de um cliente), o tipo e a conta contábil — antes só renomeava, e o cadastro geral nem editava. Trocar a conta ajusta também a regra que classifica o nome, senão a conta voltaria na importação seguinte. Escopo geral é de gerente ou sócio. Migração: `sql/payees-escopo-v1.sql`
- **Painel da equipe refeito** (`/dashboard`): sócio vê resultado do mês com comparação contra o mesmo período do mês anterior, recebido no ano, recorrente contratado, contas a receber com aging e 12 meses de recebimentos; gerente e assistente veem carteira, operação e agenda. A fila do bookkeeping deixou de ser um número só: **sem classificação** (`pending`) e **aguardando aprovação** (`auto`) são contas separadas, por cliente — juntas, o número não se mexia quando a equipe classificava. O contador de "documentos com classificação incerta" saiu: não existe estado de conferido em `documents`, então ele só crescia. Contas em `lib/painel.ts`; migração: `sql/painel-v1.sql`

- **Texto de regra não pode ser jargão do banco.** A sugestão do modal era as três primeiras palavras do extrato — em banco que começa com "PURCHASE AUTHORIZED ON", a regra nascia com esse texto e casava com todo lançamento (foi assim que Payroll Fees engoliu BJ's e Facebook). Agora a sugestão tira o jargão (`lib/regra-texto.ts`), a rota recusa texto genérico ao criar ou editar, a lista de regras marca as que já existem assim, e o "Aplicar regras" avisa quando uma regra sozinha leva um quarto dos lançamentos. O motor de casamento não mudou.

- **Plano mensal e parcelamento são coisas diferentes (regra do sócio).** *Plano* (bookkeeping, payroll, sales tax) é mensal: cada débito pago vira uma fatura própria do mês, quitada, com item, recebimento e trilha (`invoice_audit.recurring_invoiced`), e o plano pode ser cancelado. *Parcelamento* é sempre de uma fatura de serviço realizado: nasce no Financeiro (fatura → Parcelar), cada parcela dá baixa na fatura de origem, e **não se cancela — só se quita antecipadamente**: o recebimento manual do saldo na fatura encerra o débito no Stripe, liquida as parcelas restantes e conclui o plano (`plan_audit.paid_off_early`). Antes do débito começar, desistir devolve a fatura à cobrança à vista. A tela de Planos não cria mais parcelamento solto.
- **Primeiro emite, depois cobra.** A fatura da mensalidade nasce em aberto quando o Stripe finaliza a invoice (`invoice.finalized`, antes do débito) e guarda `invoices.stripe_invoice`; o `invoice.paid` só dá baixa. Se o débito falhar (NSF, cartão recusado), a fatura **fica em aberto** com o motivo em `invoice_audit.charge_failed` (parcela fica `failed` com `last_error`); a equipe pode **cobrar novamente** (`/api/billing/recharge`, botão no Receber) ou receber por fora (Zelle, dinheiro): a baixa manual marca a invoice do Stripe como paga fora dele e a fatura **sai da linha de cobrança**. Recebimento manual em fatura com cobrança automática só em três formas: saldo inteiro da mensalidade; valor exato de uma parcela que falhou; ou saldo inteiro do parcelamento (quitação antecipada). Migração: `sql/cobranca-por-fatura-v1.sql`. O endpoint do Stripe assina nove eventos.
- **A competência da fatura mensal é o período do SERVIÇO** (`lines[0].period.start`), não `invoice.period_start` — conferido em dois eventos reais: numa cobrança de 05/09 cobrindo 05/09→05/10, o `period_start` da invoice apontava para 27/08 num cliente e 20/08 no outro. Lendo dali, toda fatura nascia com a competência do mês anterior.
- **Forma de pagamento, PaymentIntent e motivo de recusa não vêm no evento**: `invoice.payments` é campo expansível e o webhook nunca o traz. Quem precisa desses dados busca a invoice na API com `expand` (uma chamada, reaproveitada). Sem isso, todo recebimento era gravado como cartão, mesmo os de ACH.
- **Reprocessar cobrança já registrada é barrado por ESTADO** (fatura quitada, ou parcela paga com aquela invoice), não por sinal do Stripe: `paid_out_of_band` também sumiu do payload. Reenviar o mesmo evento dez vezes grava uma vez só. O webhook passou a ler a assinatura e o pagamento nos dois formatos da API do Stripe (`lib/stripe-invoice.ts`): a partir da versão Basil o `invoice.subscription` sumiu do objeto e as mensalidades pagas eram ignoradas em silêncio.

- **Reenviar e cobrar são botões diferentes na fatura.** *Reenviar* repete o aviso da emissão ("aqui está sua fatura, com o link de pagamento") — serve a quem perdeu o e-mail e à fatura de mensalidade, que nasce enviada pelo Stripe e nunca passou por rascunho, então nunca teve botão. *Lembrete* (que vira **Cobrar** quando a fatura está vencida) manda texto de cobrança, e sabe dizer se venceu ou está por vencer; em fatura parcelada, fala do débito automático em vez de pedir pagamento. Nenhum dos dois mexe em valor ou situação. Ambos ficam na trilha (`invoice_audit.resent` / `reminded`) com o número do aviso, e a resposta diz à equipe quantas vezes aquele cliente já foi avisado daquela fatura. Permissão de gerente ou sócio, a mesma de enviar.

- **A situação da assinatura no Stripe manda no plano.** A conta está configurada com *Manage failed payments → mark the subscription as unpaid*: quando as tentativas de cobrança se esgotam, o Stripe avisa por `customer.subscription.updated` com status `unpaid` — não por `payment_failed` nem por `paused`. Nesse caso ele **parou de cobrar**, o plano vai para `paused` e a equipe recebe alerta dizendo que a fatura ficou em aberto e nada será debitado até resolver. `past_due` (ele ainda tenta) leva a `payment_failed`; a volta a `active` restaura o plano e avisa. O evento é emitido a cada alteração da assinatura, então só se age quando `previous_attributes.status` mostra que a situação mudou de fato. O endpoint assina dez eventos.

- **Fatura e parcelamento terminam juntos.** Encerrar um parcelamento é sempre a mesma rotina (`lib/parcelamento.ts`), venha de onde vier: quitação antecipada pela tela, fatura quitada de uma vez pelo Stripe, ou cancelamento da fatura antes de qualquer cobrança. Ela para o débito, **fecha as invoices de parcela que ficaram abertas no Stripe** (cancelar a assinatura não fecha invoice já finalizada — uma parcela em NSF continuava lá cobrando), acerta o cronograma e conclui o plano, com trilha. Cancelar a fatura com parcelamento vivo e nenhuma parcela paga cancela os dois; com parcela paga, é recusado. Cobrar a fatura parcelada pelo link da equipe passa a pedir confirmação e é tratado como quitação antecipada — antes fechava a fatura e deixava o débito correndo.

- **Dinheiro que volta ao cliente passou a ser tratado.** O endpoint assina mais quatro eventos: `charge.refunded`, `charge.failed`, `charge.dispute.created` e `charge.dispute.closed` (catorze no total). Reembolso integral no painel, contestação perdida e ACH devolvido depois de dado como recebido desfazem o recebimento com rastro em `payment_reversals` e reabrem a fatura; `payment_intent.payment_failed` passou a conferir se já havia recebimento daquele intent. Reembolso parcial e contestação ainda aberta só alertam. Sem migração.

- **A aba Contabilidade do portal existia no menu, mas a página nunca foi criada.** O item "Contabilidade/Accounting" aparecia no menu e na home do cliente empresarial desde que foi anunciado, e levava a `/portal/reports` — uma rota que não existia: o cliente recebia 404 e nunca conseguiu abrir P&L, Balanço, Fornecedores nem 1099. As rotas da API já aceitavam o próprio cliente `business` e o componente da tela já estava pronto e órfão; faltava a página que os une. Criada, e o texto passou a seguir o idioma do cadastro (en, pt, es, zh, fr) como o resto do portal. O botão Voltar do relatório de Fornecedores/1099 mandava o cliente para `/dashboard/bookkeeping` (área da firma, que o middleware devolve) — agora volta para o portal, como o P&L e o Balanço já faziam. Sem migração.

- **Forma de pagamento desativada no Stripe não derruba mais o pagamento inteiro.** Cartão, débito em conta (ACH) e Klarna só funcionam se estiverem ativados na conta (Settings → Payment methods). Quando o código pedia uma forma que a conta não tinha, o Stripe recusava a **sessão inteira** — o link nem nascia. No cadastro do débito de um parcelamento, que sempre pedia cartão + ACH, isso deixava o cliente sem pagar a entrada e sem autorizar as parcelas, com a rota respondendo "tente de novo" sem dizer o motivo. Agora `lib/stripe-formas.ts` tira a forma recusada e refaz a sessão com o que sobrou (cartão é o piso), em todos os caminhos: pagamento à vista do portal, entrada do parcelamento, cadastro sem entrada e mensalidade. O que a conta recusou vai para `plan_audit`/log e para um alerta à equipe; se a sessão não nascer de jeito nenhum, o motivo real vai para `plan_alerts` e `invoice_audit.checkout_failed` em vez de morrer no log. O link do Financeiro passou a nomear a forma que o Stripe citou (antes dizia "todas não está habilitado"). Sem migração.
- **O idioma do cliente não bloqueia mais o Plaid.** `/api/plaid/link-token` mandava o idioma do cadastro sem conferir se o Plaid o atende; recusado o idioma, a chamada morria e o cliente não conseguia conectar o banco. Agora o idioma é filtrado pela lista que o Plaid aceita (`zh` cai para inglês, `fr` passou a ser respeitado em vez de virar inglês) e, se ainda assim for recusado, a tela abre **em inglês** em vez de não abrir. O motivo real fica no log.
- **A lista "Formas de pagamento" do portal era confundida com botões.** Ficava no fim da página, em inglês para todos, e era o que o cliente tentava clicar quando a fatura não oferecia ação. Agora diz que é informativa e acompanha o idioma. O contrato mandado pelo fluxo antigo (e-mail do DocuSign), que só exibia "assine pelo e-mail" e travava a fatura, passou a dizer onde procurar e o que fazer se não achar.

- **Menu da firma num componente só, e que recolhe ao escolher.** A sanfona do celular era um `<details>` nativo dentro de um Server Component: como a navegação do App Router não recarrega a página, ela continuava **aberta** depois da escolha e só fechava clicando no ☰ de novo. Agora é `components/FirmNav.tsx`, client component, que fecha na escolha e na troca de rota, marca o item ativo e fecha o "Listas" ao clicar fora. De quebra, os outros três layouts da firma (`/clients`, `/invitations`, `/settings`) traziam um menu pela metade, com três itens — quem entrava lá perdia o caminho para Bookkeeping, Financeiro e Atendimento. Os quatro passaram a usar o mesmo menu, encerrando a duplicação que estava na lista de dívidas.
- **Todo impresso tem volta garantida e abre legível no celular.** A barra dos relatórios ganhou um **destino fixo** (🏠 Dashboard, ou Meu portal no relatório do cliente) ao lado do Voltar: o Voltar depende do histórico e de o navegador permitir fechar a aba, então quem abria o relatório por um link ficava sem caminho de volta. E **nenhum dos oito impressos declarava o viewport** — no celular o navegador desenhava a página a ~980px e reduzia tudo, deixando o texto ilegível e a barra fora do alcance do dedo. `META_RELATORIO` entrou nos oito. A prévia do contrato e o documento do orçamento, que só tinham um botão solto de imprimir, passaram a usar a mesma barra. Sem migração.

- **Contrato enviado pelo fluxo antigo do DocuSign também assina no portal.** Quem recebeu o convite por e-mail (sem assinante embutido) não tinha botão em Pagamentos: via só "assine pelo e-mail que você recebeu" — e a fatura parcelada ficava travada junto, porque o débito automático só libera depois da assinatura. Se o e-mail se perdeu, não havia saída nenhuma. Agora o botão aparece sempre: ao clicar, a rota promove o destinatário a embutido no DocuSign (`tornarAssinanteEmbutido`, `resend_envelope=false`) e abre a tela de assinatura. O efeito colateral é conhecido e deliberado — o link do e-mail antigo deixa de valer —, por isso a promoção só acontece quando o próprio cliente pede, nunca sozinha, e nunca depois de ele ter assinado. Fica em `plan_audit.contract_signer_embedded`. A tela de assinatura usa o e-mail e o nome do **destinatário do envelope**, não os do cadastro: cliente que trocou de e-mail depois do envio tinha a view recusada pelo DocuSign. Sem migração.

- **O número da parcela passou a vir da invoice do Stripe, não de um contador.** `paid_installments + 1` parecia certo e não é: o Stripe não garante a ordem de entrega dos eventos, uma parcela pode falhar e a seguinte ser paga antes, e a baixa manual por fora mexe no cronograma sem passar pelo webhook. Em qualquer desses casos a baixa — ou a marca de falha — ia para a parcela **errada**. Agora `lib/parcela-stripe.ts` identifica a parcela pela invoice amarrada no `invoice.finalized` e, na falta, pela primeira em aberto; e `paid_installments` é **recontado** do cronograma em vez de incrementado, então o número que decide se o parcelamento terminou passa a bater com o que foi de fato recebido. Vale nos três pontos: emissão, pagamento e falha. Testado com o caso real que errava (2ª falha, 3ª paga antes). Sem migração.
- **O projeto ganhou `npm run testes`.** Sem framework: cada arquivo em `testes/` é um programa que conta acertos e sai com 1 se algo falhar. Entra ali só regra que decide dinheiro e que não dá para conferir lendo — hoje, a identificação da parcela e o degradê das formas de pagamento do Stripe (21 casos).

- **Cobrança anulada no painel do Stripe agora repercute aqui.** Anular a invoice lá não mexia em nada: a fatura continuava em aberto no financeiro, entrava no contas a receber e o cliente recebia lembrete de uma cobrança que não existe mais. O webhook passou a assinar `invoice.voided` — cancela a fatura, devolve a parcela ao cronograma (soltando a amarra para poder recobrar) e avisa. Se houver dinheiro recebido na fatura, **não mexe em nada** e manda a equipe conferir à mão: anular cobrança de fatura paga ninguém decide sozinho.
- **Um plano, uma assinatura.** O cliente que abria o cadastro do débito duas vezes e concluía as duas criava **duas assinaturas** no Stripe. O plano guardava só a última, e a primeira seguia cobrando todo mês, para sempre, sem nenhum registro aqui. Agora a segunda é cancelada na hora, a primeira permanece, e a equipe recebe alerta para conferir se houve cobrança em dobro — e, se o cancelamento falhar, o alerta diz para cancelar à mão.
- **Cobrar novamente virou idempotente.** `invoices.pay` não é idempotente por conta própria: dois cliques (ou duas pessoas) cobravam **duas vezes** do cliente. A chamada passou a levar chave de idempotência formada pela invoice do Stripe mais quantas recobranças já foram registradas — cliques simultâneos leem o mesmo número e o Stripe trata o segundo como repetição, enquanto uma nova tentativa deliberada, depois, passa normalmente. A rota também deixou de dizer "recusada" quando o motivo é a invoice já estar paga (webhook atrasado), e passou a achar a parcela cobrável mesmo quando a mais antiga ficou sem invoice.
- **Plano parado avisa a equipe.** Plano em `awaiting_entry`/`awaiting_setup` depende do cliente pagar a entrada ou cadastrar o débito. Quem nunca fazia deixava o plano ali para sempre: nada era cobrado, o contrato não andava e ninguém percebia — não existe tela que liste "parados". A rotina diária passou a alertar depois de sete dias, um alerta por plano por dia, dizendo o que falta. **Nada é cancelado sozinho** (parcelamento não se cancela em andamento, e desistir é decisão da firma). `lib/planos-parados.ts`, com 20 casos de teste.

- **Débito em conta a caminho virou um estado, não um silêncio.** O ACH leva dias: o Stripe avisa que o cliente concluiu (`checkout.session.completed`) muito antes de o dinheiro chegar. Nesse intervalo a fatura ficava **idêntica a uma fatura não paga** — entrava no contas a receber, aceitava lembrete de cobrança e aceitava baixa manual. Quem registrasse o Zelle no meio do caminho criava **recebimento em dobro** quando o ACH caísse. Agora a fatura guarda quando o débito começou, de qual sessão e de quanto (`ach_desde`, `ach_sessao`, `ach_valor`): o Financeiro mostra "🏦 $X a caminho" na linha, o botão de **Cobrar/Lembrete é recusado** (Reenviar o documento continua liberado) e o **recebimento manual pede confirmação explícita**, dizendo o valor e há quantos dias. Confirmar assume que aquele débito não vai entrar e encerra o trânsito, com trilha. Nada de dinheiro entra por esse caminho — o recebimento continua nascendo só quando o banco confirma. Quem tira a fatura do limbo quando o dinheiro nunca chega é a **rotina diária**, que alerta acima de sete dias sem confirmação (o ACH normal leva até quatro dias úteis). O endpoint também assina `checkout.session.expired`, mas como rede de segurança, não como proteção principal: o Stripe expira sessão que ficou **aberta**, e a sessão de ACH costuma ser concluída pelo cliente — o que demora é o dinheiro. Migração: `sql/ach-em-transito-v1.sql`. O endpoint assina dezesseis eventos.

- **O `npm run migrar` nunca conseguiu aplicar nada sozinho — e o motivo estava errado no próprio script.** Estava escrito ali que, no Claude Code na nuvem, bastaria `SUPABASE_PROJECT_REF` porque o proxy anexaria o token na saída, mantendo-o fora da sessão. **Não anexa**: aquele proxy é só de TLS e roteamento. O pedido saía sem cabeçalho de autorização e a Supabase respondia `401 Unauthorized` — a mesma resposta que ela dá para token revogado, o que fez parecer problema de token. O modo foi removido, e a mensagem de erro passou a dizer o que falta e o que fazer sem isso. `SUPABASE_PROJECT_REF` diz em qual projeto mexer, não quem está mexendo.

- **Fechado o diagnóstico do `npm run migrar`: é o ambiente, não o token.** Prova cruzada — o mesmo token responde a lista de projetos da máquina do sócio e `401` de dentro do Claude Code na nuvem. O proxy de saída de lá mexe no cabeçalho `Authorization`: para a API do GitHub ele o substitui pela credencial dele (pedido sem cabeçalho e pedido com token errado voltam os dois autenticados), e para a `api.supabase.com` ele não chega. `psql` também não serve: a porta 5432 é inalcançável, o proxy só faz HTTP CONNECT. **Trocar de token não resolve** — de lá, migração é sempre pelo SQL Editor. O sintoma engana porque a Supabase responde o mesmo `401 Unauthorized` para token ausente, inválido e revogado.
- **Fatura quitada sai com carimbo PAID.** O impresso mostrava só a linha "Recebido" e o saldo zerado — quem paga no balcão saía sem nada que atestasse a quitação. Agora fatura paga (nunca orçamento, nunca fatura cancelada) leva um carimbo inclinado com **PAID**, a data do **último recebimento** e as formas usadas. A data é a do recebimento, não a de hoje: reimprimir o documento meses depois não pode mudar o que ele atesta. O carimbo fica **ao lado dos totais**, no fluxo — a primeira versão era posicionada por cima e cobria Total, Recebido e Quitada, e ainda dependia de quantos itens a fatura tinha.
- **Pagamento fora do Checkout passou a dar baixa.** Até aqui **todo** recebimento chegava por `checkout.session.completed` ou `invoice.paid` — os dois únicos caminhos existentes. Uma cobrança feita por PaymentIntent solto (é o caso do leitor de cartão no balcão) seria aprovada no Stripe e **a fatura nunca quitaria**. O endpoint passou a assinar `payment_intent.succeeded`, que dá baixa na fatura indicada em `metadata.invoice_id` — e só nela: mensalidade e parcelamento têm caminho próprio e mexer neles ali daria baixa em dobro. O endpoint assina dezessete eventos.
- **Um pagamento, dois eventos, um lançamento.** O mesmo pagamento do Checkout gera `checkout.session.completed` **e** `payment_intent.succeeded`, sem ordem garantida (no ACH entra ainda um terceiro). Cada caminho procurava só pela própria chave: o do intent gravava pelo intent, o da sessão não achava nada procurando pela sessão, e lançava de novo — o cliente apareceria pagando o dobro. A regra virou uma só, em `lib/recebimento-stripe.ts`: procura-se por **todas** as chaves conhecidas, nas duas colunas. Testado nas duas ordens de chegada e com reentrega repetida. O que acontece **depois** de um recebimento (sair da linha de cobrança, encerrar parcelamento quitado, avisar o cliente) também virou rotina única, senão só valeria para quem entrasse pelo Checkout.

- **Cadastrar cliente e dar acesso viraram um ato só, e cabe dentro da emissão da fatura.** Eram duas telas desligadas: cadastrava-se em Clientes e convidava-se em Convites — resultado, cliente no sistema sem nunca ter recebido o login. Agora criar cliente com e-mail **manda o convite do portal** (dá para dispensar na hora, com um campo). O convite falhar não desfaz o cadastro, mas a resposta diz que não saiu. E o Financeiro ganhou **+ Novo cliente** ao lado do seletor: emitir fatura para quem ainda não existe não obriga mais a sair da tela, cadastrar noutro lugar e recomeçar o documento — o cliente novo já vem selecionado. E-mail repetido é recusado com o cadastro que já existe apontado, que a tela seleciona em vez de mandar procurar.
- **Duas brechas de acesso no caminho do cadastro.** `POST /api/clients` mandava **o corpo do pedido direto para o insert**: qualquer campo enviado entrava na tabela, inclusive `user_id`, que amarra um cadastro a um login. Agora só passa o que está na lista (`lib/novo-cliente.ts`). E `POST /api/send-invite` só era protegido pelo middleware, que confere sessão e não o nível: **um cliente logado no portal podia convidar quem quisesse em nome da firma.** Passou a exigir equipe. Sem migração.

- **A carteira do QuickBooks entra por importação, com prévia.** Em Clientes, **Importar do QuickBooks** recebe o CSV exportado de lá (Clients → Export) e mostra **o plano antes de gravar**: quantos entram, quantos já estão cadastrados, quantos estão repetidos no próprio arquivo, quantos são empresa e quantos pessoa física. Só depois de conferir é que grava, em blocos. O arquivo do QuickBooks traz BOM, telefone com apóstrofo do Excel e `PERSON`/`ORGANIZATION` — tudo tratado em `lib/import-clientes.ts`, que também normaliza o telefone no mesmo E.164 do resto do sistema e descarta os impossíveis sem perder o cadastro. Importar é de gerente ou sócio. Migração: nenhuma.
- **Quem já está cadastrado é reconhecido pelo NOME, não pelo e-mail** — e isso vale também no cadastro manual. A carteira real ensinou: em 970 registros há **56 e-mails em mais de um cadastro e só um é duplicata de verdade**; os outros 55 são o dono e a empresa dele no mesmo endereço ("Bruno Parreira" e "ABM Capital Group Inc"). São clientes diferentes, com declarações diferentes. A regra de e-mail único, criada horas antes, teria barrado os 55 — passou a recusar só quando **nome e e-mail** batem, e a avisar quando o e-mail é compartilhado, porque o acesso ao portal atende um cadastro só. A comparação de nome ignora maiúscula, acento e pontuação, e olha também a razão social.
- **Importar nunca envia convite.** Cadastrar cliente pela tela manda o convite do portal; fazer isso com 924 e-mails de uma vez seria um desastre. O importador grava e pronto — o acesso sai depois, um a um, quando a equipe quiser.

- **A tela de Clientes deixou de ser um quadro só com todo mundo dentro.** A entrada agora são **dois cartões** — 🏢 Empresas e 👤 Pessoa física — e o quadro de etapas abre já separado por tipo (`/clients?tipo=business`). O motivo é de negócio: empresa se atende o ano todo, pessoa física aparece na temporada; num quadro único de seis colunas a fila da temporada escondia quem estava parado há meses, e com quase mil cadastros não dava para ler. O cartão de **Empresas** mostra o total e a divisão em **esperando o cliente · com a equipe · concluído** (as seis etapas agrupadas em `lib/clientes-grupos.ts`); o de **Pessoa física** mostra só o total, porque fora da temporada não há trabalho em aberto e os mesmos números não diriam nada. Etapa desconhecida conta como pendente — some da fila é pior do que aparecer. A contagem é feita **no banco**: trazer mil cadastros para contar no navegador transferia a carteira inteira a cada abertura.
- **Convite do portal, um a um, na lista de clientes.** É o par da importação, que traz a carteira sem convidar ninguém. Cada linha mostra o estado do acesso — *tem acesso*, *convite enviado* (com reenviar) ou *sem e-mail* — e o botão manda o convite daquele cliente. Sem isso, os 968 importados não tinham caminho nenhum para receber o login.
- **Aceitar um convite passou a COMPLETAR o cadastro que já existe, em vez de criar outro.** O aceite inseria um cliente novo sempre. Para quem nunca esteve na carteira está certo; mas convidar alguém que já está — como todo mundo que veio do QuickBooks — criava um **segundo cadastro da mesma pessoa**, um sem login e outro com, com documentos e faturas divididos entre os dois. Agora o convite guarda de quem ele é (`client_invitations.client_id`) e o aceite atualiza aquele cadastro; na falta, procura pelo e-mail; só insere quando não existe mesmo ninguém. O que o cliente deixa em branco não apaga o que a equipe já tinha preenchido. Migração: `sql/convite-liga-ao-cliente-v1.sql`.
- **A busca de clientes escapava sem curinga.** `ilike` com o termo cru fazia "100%" casar com "1000" e "100X" — o mesmo defeito já corrigido em Fornecedores. E a listagem ganhou limite: sem ele, `select('*')` sobre a carteira inteira voltava a cada tecla digitada.

- **E-mail é contato, não identidade — quem identifica o login é o `user_id`.** A tabela `clients` exigia e-mail e o exigia único, e a carteira real desmente as duas coisas: **46 dos 970 clientes não têm e-mail** (cliente de balcão muitas vezes não tem, e isso não o impede de ser cliente) e **55 e-mails servem a mais de um cadastro** (o dono e a empresa dele no mesmo endereço). Juntas, as duas regras barravam a importação inteira: com 46 sem e-mail espalhados em 970 linhas e blocos de 200, todo bloco tinha pelo menos um — nenhum cliente entrava, e nada dizia por quê. Agora o e-mail aceita nulo e aceita repetir (vira índice de busca), e a **unicidade foi para o `user_id`**, que é onde faz falta: dois cadastros no mesmo login quebram o portal, porque as rotas do cliente buscam por `user_id` esperando um só. Migração: `sql/cliente-email-nao-e-identidade-v1.sql`.
- **Cliente sem e-mail entra por escolha, não por regra.** Na importação ele sai separado, com um campo para incluir — desmarcado por padrão. Não é descarte: ele existe, é atendido no balcão e recebe fatura; só nunca vai receber acesso ao portal, porque o convite precisa de e-mail. Quem importa decide se quer o cadastro agora ou depois.
- **Acesso ao portal continua só por e-mail e senha — decisão registrada.** Login por SMS foi avaliado e recusado: o portal guarda `ssn_last4` e é onde o cliente paga e assina, e o **FTC Safeguards Rule** exige multifator para sistema com informação de cliente. SMS como *único* fator não é multifator e é vulnerável a troca de chip. Além disso, dois métodos de login criam duas identidades no Auth para a mesma pessoa — exatamente a duplicação que a unicidade do `user_id` acabou de fechar. SMS como **segundo** fator continua em aberto e seria bem-vindo.

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
