# Peace on Tax OS — guia para sessões do Claude Code

Este arquivo é lido automaticamente no início de cada sessão. Ele resume o que
qualquer pessoa (ou agente) precisa saber antes de mexer no código. A regra de
negócio completa está em `ESPECIFICACAO.md` — **quando uma regra mudar, a
especificação muda junto, no mesmo commit.**

## O que é

Sistema próprio da Peace on Tax Corp (firma de contabilidade e impostos em
Massachusetts): CRM de clientes, portal do cliente, bookkeeping, faturamento,
contratos, atendimento por WhatsApp/SMS. Next.js 14 (App Router) na Vercel,
Supabase (PostgreSQL + Auth + Storage), Stripe, Plaid, DocuSign, Twilio,
Resend, Anthropic. Publicação automática a cada `git push` na `main`.

Idioma do código, comentários e mensagens ao usuário: **português**. Formatos
voltados ao cliente seguem o padrão dos EUA (datas `MM/DD/YYYY` via `fmtDate`,
moeda em dólar, telefone com DDD americano).

## Comandos

```bash
npm install --legacy-peer-deps   # obrigatório o --legacy-peer-deps (mesmo flag da Vercel)
                                 # o package-lock.json foi gerado com esse flag; `npm ci` puro falha.
                                 # O comando de instalação na Vercel precisa continuar sendo este.
npm run typecheck                # tsc --noEmit — tem de passar limpo
npm run lint                     # ESLint (next/core-web-vitals) — sem erros; avisos são dívida conhecida
npm run auditoria                # 30+ invariantes do sistema; sai com 1 se algum falhar
npm run testes                   # testes de lógica pura (testes/*.mts), sem framework
                                 # só o que decide dinheiro e não dá para conferir lendo
npm run migrar -- sql/x.sql      # aplica migração no Supabase e anota em schema_migrations
                                 # precisa de SUPABASE_DB_URL (psql) ou SUPABASE_ACCESS_TOKEN
                                 # (API, por HTTPS) SÓ no ambiente. --pendentes lista o que falta.
                                 # SUPABASE_PROJECT_REF sozinho NÃO autentica — ele diz em qual
                                 # projeto mexer, não quem está mexendo.
                                 # DE DENTRO DO CLAUDE CODE NA NUVEM NÃO FUNCIONA, e não adianta
                                 # trocar de token: o proxy de lá não repassa o Authorization para
                                 # a api.supabase.com (token válido na máquina do sócio dá 401 ali),
                                 # e psql não passa porque a porta 5432 é inalcançável. De lá, a
                                 # migração vai à mão no SQL Editor.
npm run build                    # next build
npm run dev                      # servidor local (precisa de .env.local, ver .env.example)
```

**Atenção:** `next.config.js` tem `ignoreBuildErrors` e `ignoreDuringBuilds`
ligados. Ou seja, **a Vercel publica mesmo com erro de tipo ou de lint.** Já
houve bug em produção por isso (`new FormanData()` na importação de CSV). Por
esse motivo `typecheck`, `lint` e `auditoria` são a trava real: rode os três
antes de qualquer push.

O `auditoria.ps1` na raiz é a versão PowerShell original do mesmo script;
`auditoria.mjs` é a versão portátil e é a que deve ser mantida.

## Regras que não se negociam

Vêm da seção 2 da especificação. Toda mudança de código precisa respeitá-las:

1. **Quem emite não dá baixa.** Assistente emite fatura; só gerente/sócio
   registra pagamento. A matriz está em `lib/billing-perms.ts`
   (`permissoesFinanceiro`) e **toda rota em `app/api/billing/` passa por ela**.
2. **Nada se apaga sem rastro.** Cancelar preserva; apagar é exceção e é
   bloqueado quando há pagamento. Estorno vai para `payment_reversals` antes.
3. **Ação sensível pede senha e motivo** (editar fatura, estornar, lançamento
   manual, trocar conta bancária). O padrão é `signInWithPassword` com a senha
   do gerente + campo de motivo gravado na tabela de auditoria correspondente.
4. **O cliente é da firma.** Mensagens saem como "Peace on Tax"; autoria só
   por dentro.
5. **Documento que sai leva a marca** (logo, endereço, contato).
6. **Consentimento é prova.** Data, hora, IP, origem e texto exato ficam em
   `sms_consent_log`; o histórico nunca é sobrescrito.
7. **O motor decide sozinho, a IA não.** Transferência interna e pagamento de
   cartão são regra determinística. A IA (Anthropic) só sugere categoria.

## Invariantes de código (o que a auditoria confere)

- **Motor de classificação existe em três lugares e precisa ser idêntico:**
  `lib/apply-rules.ts`, `app/api/bookkeeping/categorize/route.ts` e
  `app/api/bookkeeping/rules/route.ts` (`casaTexto`, `limparRuido`,
  `sentidoTransferencia`, `contasDeFora`, `cartaoCitado`, `ehPagamentoNoCartao`,
  isolamento `nonprofit`). Alterou um, altera os três. Unificar num módulo
  único é dívida aceita, não decisão tomada.
- **Sessão não é identidade.** O `middleware.ts` só garante que existe login
  — a sessão de um cliente bate em qualquer rota. Conferir QUEM está
  chamando é obrigatório DENTRO da rota (`getAuth`, `getUser` + filtro por
  `user_id`, `autorDaRequisicao`, `CRON_SECRET` ou assinatura), e a auditoria
  recusa route.ts sem nenhuma delas. `/api/firm/users/[id]` não conferia nada
  e usava a service role key: qualquer cliente logado virava firma, trocava a
  senha do sócio ou banía qualquer um. Junto com ela, `/api/clients/[id]`,
  `/api/documents[/id]`, `/api/upload`, `/api/process-pdf` e
  `/api/firm/messages`. Daí também: **corpo de requisição nunca vai inteiro
  para o banco** (`clients/[id]` fazia `update({...body})` — dava para gravar
  `user_id`) e **`user_metadata` se mescla, nunca se substitui** (corpo sem
  `role` rebaixava um membro da firma a cliente).
- **Toda rota de API exige sessão** (`middleware.ts`). A lista `API_PUBLIC` é
  fechada: só entra rota que um visitante sem login precisa mesmo chamar
  (agendamento, convite, webhooks, cron da Vercel). Rota de `/api/cron/` só
  aceita `Authorization: Bearer CRON_SECRET` e recusa tudo se a variável não
  existir. Rotinas agendadas ficam em `vercel.json`. Dentro da rota, `getAuth` de
  `lib/api-auth.ts` confere o dono: equipe acessa qualquer cliente, cliente só
  o próprio.
- **Firma × cliente se decide em `lib/papeis.ts`, e só lá.** `ehDaFirma` tem
  uma lista FECHADA (`firm · owner · admin · manager · staff`); papel fora
  dela é cliente. `middleware.ts`, `getRole` de `lib/supabase-server.ts` e
  `isStaff` de `lib/api-auth.ts` perguntam ali. Antes cada um comparava
  `role === 'firm'` por conta própria, e quem era convidado como **staff**
  (o padrão do formulário), manager ou admin virava CLIENTE ao entrar: caía
  no `/portal`, sem linha em `clients`, com 403 em toda rota. A auditoria
  recusa quem voltar a comparar `user_metadata.role` com `'firm'`.
- **Nível de acesso vem de `staff_roles`** (`lib/staff-perms.ts`): `owner`,
  `manager`, `junior`. Quem não está na tabela é `junior`. São duas
  perguntas diferentes: `papeis.ts` é a PORTA, `staff_roles` é o PODER.
- **Em cima do nível há autorização por pessoa** (`lib/permissoes.ts`,
  tabela `staff_grants`). O nível é a base; cada concessão é um sim ou não
  explícito que o vence; o sócio é imune a concessão negativa. Quem monta o
  conjunto é `permissoesDe` — `lib/billing-perms.ts` só busca o que está
  gravado, e as 12 rotas de `billing/` herdam pelo mesmo funil. A tabela é
  APPEND-ONLY: o estado atual é a view `staff_grants_atual`, então estado e
  histórico não podem discordar. Motivo é obrigatório, só o sócio autoriza,
  ninguém mexe no próprio. Autorizar `receber` a quem emite quebra o
  princípio 1 — `conflitoDeSeparacao` diz o quê, a tela avisa antes de
  salvar e o motivo fica gravado. A lista de chaves está no módulo E no
  `CHECK` do SQL; a auditoria falha se divergirem.
  Migrações: `sql/permissoes-por-pessoa-v1.sql` (a tabela) e `-v4.sql`, que
  troca o `CHECK` inteiro e por isso contém a v2 e a v3 — rodar a v1 e a v4
  basta. As quinze chaves.
- **Documento nasce rascunho; enviar é outra decisão, com chave própria.**
  `enviar` estava pendurado em `perms.cancelar`: com autorização individual,
  soltar cancelar soltaria o envio junto. Quem pode enviar tem o botão
  **Criar e enviar** (`enviarAgora` no POST, conferido no servidor); quem não
  pode vê só **Salvar rascunho**, e o rascunho não se perde.
- **A lista de faturas é do dia e é de quem emitiu.** Sem `verTodasFaturas`,
  `GET /api/billing/invoices` filtra por `created_by` + `created_at >=`
  início do dia; o `?id=` respeita o mesmo escopo. O corte vem de
  `lib/dia-da-firma.ts` (`America/New_York`), nunca do servidor: às 20h de
  Malden já é o dia seguinte em UTC e a lista zerava no meio do expediente.
  O módulo trata os dois domingos de horário de verão — 15 casos em
  `testes/dia-da-firma.mts`.
- **Dado de cliente tem uma porta só: `/api/clients/profile`**, com
  `editarCliente` + senha da própria pessoa + motivo, gravando
  `previous_state`/`new_state` em `client_audit`. `/api/clients/[id]` PATCH
  move apenas o FLUXO (`stage`, `assignee`, `notes`) e recusa campo de
  cadastro apontando o caminho certo — aceitava nome, e-mail e telefone sem
  nada disso, e trocar o e-mail troca o acesso do cliente ao portal. Aqui
  era PIN e virou senha (princípio 3); o PIN segue em uso nos orçamentos.
- **Recebimento: cartão e Zelle sozinho, o resto com senha de gerente/sócio**
  (`lib/recebimento-aprovacao.ts`). `FORMAS_LIVRES` é uma lista de LIVRES,
  não de bloqueadas — forma nova nasce pedindo aprovação. Espécie é o caso
  que originou: não existe até alguém digitar, e o sócio agora pode
  autorizar `receber` a quem também emite. Senha certa não basta, `podeAprovar`
  confere o nível do aprovador; quem aprovou vai para `invoice_audit`
  (`reason` e `next.aprovadoPor`). A trava é da ROTA — a tela só antecipa.
- **A autorização é um CÓDIGO, um por cobrança** (`lib/codigo-autorizacao.ts`,
  tabela `approval_codes`, migração `sql/codigo-de-autorizacao-v1.sql`). O
  gerente abre **Financeiro → Autorização** no PRÓPRIO login, aparece um
  número e ele dita; vale 10 minutos e **uma** cobrança. Substituiu pedir a
  senha do gerente na máquina do balcão, que tinha três defeitos: senha de
  terceiro em máquina alheia, o limite de tentativas de login do Supabase por
  IP (40 atendimentos/dia do mesmo escritório na temporada) e uma senha
  liberando infinitas cobranças. A senha fica como **reserva** para quando
  quem aprova é quem opera, e a trilha grava `aprovadoVia: 'codigo' | 'senha'`
  — sem isso "aprovado por X" não diz se X estava presente.
  **O consumo é atômico**: um `UPDATE ... where usado_em is null and
  expira_em > now() RETURNING` na função `consumir_codigo_de_autorizacao`.
  Conferir antes e gravar depois deixaria dois atendentes liberarem duas
  cobranças com o mesmo número — testado com duas sessões simultâneas.
  Gerar um código novo encerra o anterior não usado (um gerente, um código
  vivo). O alfabeto não tem `O·0·I·1·L·S·5·Z·2`: o número é DITADO. O nível
  de quem emitiu é conferido **no uso**, não só na emissão.
- **O assistente fica em PESSOA FÍSICA, e não baixa arquivo.**
  `canAccessClient` (o funil de ~40 rotas) era `if (auth.isStaff) return true`
  — toda a equipe via os quase mil cadastros. Agora ele lê o **tipo** do
  cliente: Empresa exige `verEmpresas` (gerente e sócio têm por nível).
  Empresa é a carteira do ano todo (bookkeeping, payroll, EIN); pessoa física
  é a temporada e o balcão. `baixarArquivo` separa **ver da lista** de **tirar
  cópia**: o arquivo é o que sai do prédio. `clients.assignee` continua sendo
  rótulo de CRM, não controle de acesso — o escopo é por TIPO, e por isso
  trocar o tipo na ficha pede senha e motivo.
  `/api/clients` filtra a lista E as contagens do `?resumo=1` (contar empresas
  para quem não pode abri-las vaza o tamanho da carteira), e pedir
  `?type=business` sem autorização **recusa** em vez de devolver pessoa física
  em silêncio. A tela obedece `tipos` do servidor: o cartão Empresas não
  existe porque o dado não chega, não porque a tela esconde.
  `serviceDb` mudou para `lib/service-db.ts`: `canAccessClient` passou a
  precisar do nível, e `api-auth → staff-perms → api-auth` é ciclo. Em ESM
  às vezes funciona — "às vezes funciona" não sustenta controle de acesso.
  `api-auth` reexporta `serviceDb` para as ~40 rotas que já o importam de lá.
  Migração: `sql/permissoes-por-pessoa-v4.sql` (substitui o `CHECK` da v3).
  O texto de cada nível em `app/settings/users/page.tsx` descreve o que o
  sistema FAZ (matriz da seção 3): mudou a matriz, muda o texto.
- **Webhooks validam assinatura**: Stripe com `constructEvent`, Twilio com
  `X-Twilio-Signature` (WhatsApp em `app/api/whatsapp/webhook`, SMS em
  `app/api/sms/webhook`). Webhook nunca devolve erro à Twilio (reenvio duplica).
- **SMS só sai pela `lib/sms.ts`**, que confere consentimento, STOP e celular
  válido. Nenhum fluxo chama a Twilio direto. Consentimento só entra por
  `registrarConsentimento` (portal, ficha do cliente ou palavra-chave); o texto
  que o cliente lê é o de `lib/sms-consent-text.ts`, versionado. START por SMS
  só reativa quem já tinha opt-in.
- **O cliente age pelo portal, a equipe libera.** Rascunho nunca aparece ao
  cliente; fatura enviada, plano em `awaiting_*` e contrato enviado aparecem em
  Pagamentos. Sessão do Stripe de plano só nasce em `lib/plan-checkout.ts`, na
  hora do clique (o link expira em 24h). Contrato assinado no portal libera o
  débito (`contract_signed_by_client` em `plan_audit`, conferido pela API do
  DocuSign). O webhook do Stripe lê a forma real no PaymentIntent e trata o
  ACH assíncrono. Contrato do fluxo antigo (convite por e-mail, sem
  `clientUserId`) também assina no portal: a rota promove o destinatário a
  embutido no clique — o que invalida o link do e-mail dele, então só se faz
  a pedido do cliente e nunca depois de assinado.
- **Plano mensal ≠ parcelamento. Primeiro emite, depois cobra.** A fatura
  do mês nasce em aberto no `invoice.finalized` do Stripe e guarda
  `stripe_invoice`; o `invoice.paid` só dá baixa.
- **O payload do webhook do Stripe é pobre — confira antes de ler um campo.**
  O endpoint está em `2026-06-24.dahlia`: a invoice do evento NÃO traz
  `subscription`, `payment_intent`, `charge`, `paid_out_of_band` nem
  `payments` (expansível). O SDK 17.7.0 ainda declara esses campos nos tipos,
  então `typecheck` passa e o campo vem vazio em produção — foi assim que as
  mensalidades sumiram. `lib/stripe-invoice.ts` lê só o que o payload garante;
  método de pagamento e motivo de recusa exigem buscar a invoice com `expand`.
  Competência sai de `lines[0].period.start` (o serviço), nunca de
  `invoice.period_start`. Débito que falha deixa a fatura em aberto com o
  motivo; `billing/recharge` cobra de novo; baixa manual marca a invoice do
  Stripe como paga fora dele (sai da linha de cobrança). Parcelamento é
  sempre de uma fatura; além da quitação antecipada e da parcela que falhou
  recebida por fora (`billing/payments`), **agora se cancela em andamento**
  (`PATCH /api/billing/installment-plan`, motivo `plano_cancelado`): para o
  débito, anula as invoices de parcela abertas e DEIXA A FATURA EM ABERTO com
  o saldo. O que já foi pago fica pago — cancelar nunca desfaz recebimento,
  isso é estorno. Pede `cancelar` + senha + motivo, e o cliente é avisado:
  ele tinha um acordo e um débito automático. **Proposta × cobrança são
  casos diferentes**: plano em `awaiting_*` sem parcela paga e sem assinatura
  no Stripe nunca saiu do lugar — nada a parar, nada cobrado. O aviso ao
  cliente é outro (o link deixou de valer), senão ele procura uma cobrança
  que nunca existiu. E a recusa do POST devolve `planoExistente`, para a tela
  abrir o cancelamento ali mesmo em vez de mandar procurar em outra aba.
- **Qual parcela o Stripe está cobrando vem da invoice, nunca de contador.**
  `lib/parcela-stripe.ts`: a parcela é a amarrada a `stripe_invoice` (gravada
  no `invoice.finalized`) e, na falta, a primeira em aberto do cronograma.
  `paid_installments` é **recontado** do cronograma, não incrementado.
  `paid_installments + 1` errava sempre que o Stripe entregava evento fora de
  ordem, uma parcela falhava e a seguinte passava, ou houve baixa manual.
- **Encerrar parcelamento é `lib/parcelamento.ts`, em todos os caminhos.**
  Quitação, fatura quitada pelo Stripe e cancelamento da fatura chamam a
  mesma rotina. Ela também FECHA as invoices de parcela já abertas no
  Stripe: cancelar a assinatura não fecha invoice finalizada, e a parcela
  em NSF voltava a cobrar depois da fatura quitada.
- **Dinheiro que volta é `lib/estorno-stripe.ts`.** Reembolso integral no
  painel do Stripe, contestação PERDIDA e ACH devolvido depois de confirmado
  desfazem o recebimento: `payment_reversals` antes, recebimento depois,
  fatura reaberta, trilha e alerta. Se o rastro falhar, **não apaga** o
  recebimento. Reembolso parcial e contestação ainda ABERTA só alertam —
  no primeiro o valor não bate, no segundo o dinheiro ainda pode voltar.
- **Forma de pagamento é a conta do Stripe que decide.** Pedir uma forma não
  ativada (Settings → Payment methods) faz o Stripe recusar a SESSÃO INTEIRA,
  não só a opção. Toda sessão de Checkout passa por
  `sessaoComFormasDisponiveis` de `lib/stripe-formas.ts`, que tira a forma
  recusada e refaz com o que sobrou; cartão é o piso. O que caiu vira alerta
  à equipe, e sessão que não nasce grava o motivo real (`plan_alerts`,
  `invoice_audit.checkout_failed`) — nunca só um "tente de novo".
- **Idioma do cliente é conforto, não requisito.** Plaid e Stripe recebem só
  idioma que atendem (`idiomaDoPlaid` em `app/api/plaid/link-token`,
  `localeStripe` em `lib/avisos.ts`); recusado, cai para inglês em vez de
  bloquear o cliente.
- **ACH a caminho é estado, em `lib/ach-transito.ts`.** Entre o
  `checkout.session.completed` e a confirmação do banco a fatura guarda
  `ach_desde`/`ach_sessao`/`ach_valor`. Com isso: a tela mostra, o lembrete
  de cobrança é recusado e a baixa manual pede confirmação — senão o Zelle
  registrado no meio vira recebimento em dobro. quem tira do limbo é a
  rotina diária, que alerta acima de sete dias — `checkout.session.expired`
  é só rede de segurança (o Stripe expira sessão ABERTA, e a de ACH costuma
  ser concluída; o que demora é o dinheiro). Dinheiro só entra
  no `async_payment_succeeded`.
- **Um pagamento, dois eventos, um lançamento.** O Checkout gera
  `checkout.session.completed` E `payment_intent.succeeded`, sem ordem
  garantida. Os dois caminhos procuram pelo MESMO conjunto de chaves
  (`filtroDeRecebimento` de `lib/recebimento-stripe.ts`: sessão e intent, nas
  colunas `stripe_object` e `reference`) — olhar só a própria chave lançava o
  recebimento duas vezes. O que vem depois da baixa é `depoisDoRecebimento`,
  uma rotina só. `payment_intent.succeeded` só age com `metadata.invoice_id`
  nosso: mensalidade e parcelamento têm caminho próprio.
- **Um plano, uma assinatura.** `checkout.session.completed` cancela a
  assinatura duplicada quando o plano já tem outra registrada — dois
  cadastros concluídos criavam duas assinaturas e a primeira cobrava para
  sempre, invisível. Cobrar de novo (`billing/recharge`) leva
  `idempotencyKey`: `invoices.pay` não é idempotente sozinho.
- **Cadastro de cliente é `lib/novo-cliente.ts`.** O corpo do pedido nunca vai
  direto para o insert — só os campos da lista (antes `user_id` entrava, e ele
  amarra o cadastro a um login). Cliente com e-mail recebe o **convite do
  portal ao ser criado**; dispensar é explícito. Cadastrar cabe dentro da
  emissão da fatura (botão no Financeiro), e e-mail repetido é recusado
  apontando o cadastro existente.
- **Clientes entram por TIPO, não num quadro só.** `/clients` mostra dois
  cartões (Empresas · Pessoa física) e o quadro abre em `?tipo=…`. As seis
  etapas viram três situações em `lib/clientes-grupos.ts` (esperando o
  cliente · com a equipe · concluído), e etapa desconhecida conta como
  pendente. A contagem dos cartões é feita no banco (`?resumo=1`): com quase
  mil cadastros, contar no navegador transfere a carteira inteira.
- **Aceitar convite COMPLETA o cadastro existente.** `client_invitations.client_id`
  diz de quem é o convite; o aceite atualiza aquele cliente e só insere quando
  não há nenhum. Antes inseria sempre — convidar quem veio da importação
  criava a mesma pessoa duas vezes, uma com login e outra sem.
- **E-mail é contato; identidade é o `user_id`.** `clients.email` aceita nulo
  (46 clientes reais não têm) e aceita repetir (dono e empresa dele dividem
  um). O que é único é `user_id` — dois cadastros no mesmo login quebram o
  portal. Acesso ao portal é só por e-mail e senha: SMS como único fator não
  é multifator, e o FTC Safeguards Rule exige multifator aqui.
- **Cliente repetido é NOME igual, não e-mail igual.** Na carteira real, 56
  e-mails servem a mais de um cadastro e só um é duplicata: o resto é o dono e
  a empresa dele no mesmo endereço. Recusar por e-mail barrava 55 cadastros
  legítimos. A chave é `chaveDoNome` (`lib/import-clientes.ts`), que ignora
  maiúscula, acento e pontuação e olha também a razão social; e-mail
  compartilhado passa com aviso, porque o portal atende um cadastro só.
- **Importar a carteira (`/api/clients/import`) mostra o plano antes de
  gravar e NUNCA envia convite** — quase mil e-mails de uma vez. Gerente ou
  sócio.
- **A entrada do parcelamento é em DÓLAR, não em porcentagem**
  (`lib/entrada-parcelamento.ts`). O campo pedia `ENTRADA %` de 0 a 90: para
  uma entrada de $250 em $1.000 era preciso digitar 25, e digitar 250 era
  recusado com "a entrada vai de 0% a 90%" — ninguém liga uma coisa à outra.
  Entrada quebrada é pior ($237 é 23,7%). A porcentagem passou a ser
  DERIVADA, porque o banco guarda as duas colunas e o impresso a mostra. A
  rota E a prévia da tela chamam `entradaDoPedido` — a mesma conta num lugar
  só. A recusa diz o valor máximo em dólar, não a regra abstrata. 26 casos
  em `testes/entrada-parcelamento.mts`.
- **Consulta que falha não pode virar lista vazia.** `[]` é verdadeiro em
  JavaScript, então `if (d?.plans)` engolia o erro e a aba de Parcelamentos
  dizia "nenhuma fatura parcelada" quando a consulta havia falhado. O erro
  vem PRIMEIRO, na rota (`error: errPlanos`) e na tela. É a terceira vez que
  esse padrão custa tempo — antes foi a importação que gravou zero e pintou
  de verde. Corolário: **coluna nova num `select` que a tela depende é
  risco**; o detalhe cosmético (`nuncaComecou`) foi para uma consulta
  separada e tolerante, decidido no servidor, e a tela não recebe mais os
  ids do Stripe.
- **Pagamento PARCIAL é aceito em qualquer forma.** O gatilho
  `atualiza_saldo_da_fatura` (agora versionado em
  `sql/gatilho-saldo-da-fatura-v1.sql`) não valida valor: recalcula
  `paid_total` pela soma de `invoice_payments` e marca a fatura como
  `partial`. Uma entrada de $250 em $1.000 entra e deixa saldo de $750 — que
  é o que o parcelamento usa. Havia um comentário na rota de pagamentos
  atribuindo ao banco uma recusa de valor parcial que ele nunca fez, e essa
  frase passou a valer como regra. **Schema que só existe no banco vira
  folclore**: gatilho ou constraint aplicado à mão vai para `sql/`, mesmo que
  só como `create or replace` do que já está lá. A regra de "à vista" que
  EXISTE é outra: parcelamento exige cartão ou ACH como forma esperada,
  porque o Stripe não debita dinheiro automaticamente.
- **O status da fatura tem UMA definição, no banco**
  (`recalcular_status_da_fatura`, em `sql/status-da-fatura-v2.sql`). O gatilho
  chama; `lib/estorno-stripe.ts` chama por RPC. Antes o estorno escrevia
  `'partial'`/`'sent'` na mão, sem olhar o vencimento — segunda definição, com
  o mesmo defeito. Duas corrigidas ali: **vencimento vence a entrada** (a
  ordem punha `partial` antes de `overdue`, e quem pagou $10 de $1.000 três
  meses atrasado saía da lista de vencidas — justamente o parcelamento que
  desanda), e o dia é o do **escritório** (`data_da_firma()`), não
  `current_date` em UTC, que fazia a fatura vencer às 20h de Malden. Quem lê
  status sempre lê `sent`/`partial`/`overdue` juntos como "em aberto", então
  nenhuma tela mudou; o aging já calculava pelo `due_date`. A migração acerta
  o histórico.
- **Empresa × pessoa física se edita na ficha** (`type` em `EDITABLE` de
  `/api/clients/profile`). Não é campo comum: valida a lista, faz empresa sem
  razão social herdar o nome, **sincroniza a cópia em
  `user_metadata.client_type`** do login (gravada no convite e na senha
  provisória — divergir é questão de tempo) e grava a trilha como
  `type_changed`. O tipo muda o portal que o cliente vê, o que o contrato
  exige e — com o assistente restrito a pessoa física — quem na firma vê a
  ficha.
- **DocuSign em sandbox não assina de verdade.** `DOCUSIGN_BASE_PATH` e
  `DOCUSIGN_OAUTH_BASE` têm padrão de SANDBOX no código
  (`demo.docusign.net` / `account-d.docusign.com`). Sem as variáveis de
  produção no Vercel, todo contrato e todo Form 8879 sai com a tarja
  "This email is for demonstration purposes only" e **não tem validade
  legal** — inclusive a autorização de e-file perante o IRS. Aconteceu de
  verdade: as variáveis não estavam no `.env.example`, então ninguém sabia
  que existiam. Agora `exigirProducao()` **recusa o envio** em sandbox
  (`DOCUSIGN_PERMITIR_DEMO=1` libera para teste, de propósito) — coletar
  assinatura sem valor é pior que não coletar, porque parece que a
  autorização existe. `app/api/signatures/diag` diz em qual ambiente está.
  O contrato vai como **HTML** (`fileExtension: 'html'`) e o DocuSign
  converte; a 8879 vai como PDF. O nome `.html` aparece ao cliente e o
  conversor não garante o CSS — trocar o contrato por PDF é dívida aberta.
- **Numeração de fatura é gerada no banco** (`INV-2026-0001`), nunca no código.
- **Preço praticado fica gravado no item da fatura**; reajuste do catálogo
  (`pricing_items`) não altera fatura antiga.

## Convenções de arquivo

- **Relatório em HTML não interpola dado dentro de `<script>`.** O que vem da
  URL ou do banco vai em atributo escapado (`escaparHtml` de
  `lib/relatorio-barra.ts`) e o script é fixo. `JSON.stringify` dentro de
  script **não** protege: ele não escapa `</script>`.
- **Menu da firma é `components/FirmNav.tsx`, um só.** Os quatro layouts
  (`app/dashboard`, `app/clients`, `app/invitations`, `app/settings`) o
  usam — item novo entra lá, uma vez. É client component de propósito: com
  `<details>` nativo a sanfona do celular ficava ABERTA depois de escolher,
  porque a navegação do App Router não recarrega a página.
- **Todo impresso leva `META_RELATORIO` e `barraDoRelatorio`** (de
  `lib/relatorio-barra.ts`). Sem o viewport o celular desenha a página a
  ~980px e a barra sai do alcance. A barra tem Voltar (contextual), um
  destino FIXO (Dashboard, ou Meu portal no relatório do cliente) e
  Imprimir — o Voltar sozinho depende do histórico e de o navegador deixar
  fechar a aba.
- **Formato voltado ao cliente vem de `lib/format.ts`** (`fmtUS`, `money`), e
  aviso ao cliente sai por `lib/avisos.ts` (e-mail com a marca, portal).
- **Número que a tela mostra tem definição num módulo puro**, não na página:
  o painel (`/dashboard`) conta em `lib/painel.ts` e reaproveita o aging e a
  receita recorrente de `lib/relatorios-financeiro.ts`. Duas telas nunca
  devem calcular o mesmo indicador de jeitos diferentes.
- **Fila do bookkeeping são dois números, não um**: `pending` (sem
  classificação) e `auto` (classificado, aguardando aprovação). Somados,
  o painel não se mexe quando a equipe classifica — foi o que aconteceu.
- **UTF-8 sem BOM, sempre.** O projeto já sofreu com acentos corrompidos
  (o "ã" virando "A" com til mais "£") por arquivos copiados de ZIP e
  editados no Windows. A
  auditoria falha se encontrar isso. Se um editor no Windows for usado, salve
  como "UTF-8" (não "UTF-8 with BOM").
- Não versionar `.bak` (o `.gitignore` já barra). Os dois que existiam eram
  lixo histórico e foram removidos.
- Rotas de API: `app/api/<módulo>/<recurso>/route.ts`, com comentário de
  cabeçalho listando os verbos e quem pode chamar.
- Chaves e segredos só em variáveis de ambiente (ver `.env.example`); nunca no
  código nem em SQL.
- Stripe: `apiVersion: '2026-06-24.dahlia' as Stripe.LatestApiVersion` em
  todas as instâncias.
- Anthropic: SDK `@anthropic-ai/sdk` 0.27.3; modelo definido por rota.
  Uso da IA é apoio à classificação e ao chat do portal — nunca decide
  transferência, cartão ou valores.

## Onde as coisas ficam

```
app/dashboard/       área da equipe (clientes, bookkeeping, financeiro, agenda, atendimento)
app/portal/          área do cliente
app/api/bookkeeping/ importação (Plaid, CSV, PDF, QuickBooks), regras, relatórios, conciliação
app/api/billing/     faturas, pagamentos, Stripe, impressão, parcelamento, relatórios (só owner)
app/api/plans/       contratos recorrentes
app/api/signatures/  DocuSign (contrato, 8879, diagnóstico)
app/api/portal/      rotas do cliente: billing (pagar), plan-checkout (débito), contract-sign/return (assinar)
app/api/stripe/webhook   entrada única dos eventos de pagamento
app/api/whatsapp/    webhook, fila, conversa, bot
app/api/sms/webhook  STOP/START e SMS recebidos (Twilio)
app/api/cron/        rotinas da Vercel (aviso de cobrança 3 dias antes)
components/          BookkeepingTab, PlansTab, QuotesTab, ReconcileTab, SignaturesTab…
lib/                 motor de regras, permissões, SMS, contrato, integrações
sql/ e *.sql         migrações rodadas à mão no SQL Editor do Supabase (idempotentes)
middleware.ts        controle de acesso por rota
```

## Dívida conhecida (decidir antes de "corrigir")

- Módulo Plans × tabela `recurring_plans`; Quotes × estimates do financeiro;
  `staff_roles` × `team_members`. Duplicações conhecidas, resolução pendente
  de decisão do sócio.
- Avisos de lint `react-hooks/exhaustive-deps` e `no-img-element`: conhecidos,
  não bloqueiam.

## Como trabalhar aqui

- Leia `ESPECIFICACAO.md` antes de mudar regra de negócio. Se a mudança pedida
  contraria um princípio da seção 2, diga isso antes de implementar.
- Ao concluir: `npm run typecheck && npm run lint && npm run auditoria &&
  npm run testes`, e só então commit. Mensagem de commit em português, no imperativo curto, como o
  histórico já faz.
- Migração de banco: arquivo SQL novo em `sql/`, idempotente, com bloco de
  conferência no fim (padrão de `sql/whatsapp-atendimento-v1.sql`). Ela **não**
  roda no deploy: aplica-se com `npm run migrar -- sql/<arquivo>.sql` (que
  anota em `public.schema_migrations`) ou à mão no SQL Editor — e nesse caso
  `npm run migrar -- --registrar sql/<arquivo>.sql` anota que foi feito.
  **A chave do livro é o CAMINHO, não o nome**: `sql/painel-v1.sql`, nunca
  `painel-v1.sql` (`migrar.mjs` monta `sql/${f}` para consultar). Registro
  feito com o nome curto vira uma linha que ninguém encontra, e `--pendentes`
  segue dizendo PENDENTE — alguém roda a migração de novo.
  A entrega sempre diz qual migração precisa rodar.
