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
- **Toda rota de API exige sessão** (`middleware.ts`). A lista `API_PUBLIC` é
  fechada: só entra rota que um visitante sem login precisa mesmo chamar
  (agendamento, convite, webhooks, cron da Vercel). Rota de `/api/cron/` só
  aceita `Authorization: Bearer CRON_SECRET` e recusa tudo se a variável não
  existir. Rotinas agendadas ficam em `vercel.json`. Dentro da rota, `getAuth` de
  `lib/api-auth.ts` confere o dono: equipe acessa qualquer cliente, cliente só
  o próprio.
- **Nível de acesso vem de `staff_roles`** (`lib/staff-perms.ts`): `owner`,
  `manager`, `junior`. Quem não está na tabela é `junior`. O
  `user_metadata.role` do Supabase só distingue firma × cliente no middleware.
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
  sempre de uma fatura, não se cancela em andamento — só quitação antecipada
  ou parcela que falhou recebida por fora (`billing/payments`).
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
- **Cliente repetido é NOME igual, não e-mail igual.** Na carteira real, 56
  e-mails servem a mais de um cadastro e só um é duplicata: o resto é o dono e
  a empresa dele no mesmo endereço. Recusar por e-mail barrava 55 cadastros
  legítimos. A chave é `chaveDoNome` (`lib/import-clientes.ts`), que ignora
  maiúscula, acento e pontuação e olha também a razão social; e-mail
  compartilhado passa com aviso, porque o portal atende um cadastro só.
- **Importar a carteira (`/api/clients/import`) mostra o plano antes de
  gravar e NUNCA envia convite** — quase mil e-mails de uma vez. Gerente ou
  sócio.
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
  A entrega sempre diz qual migração precisa rodar.
