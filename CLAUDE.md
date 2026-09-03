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
npm run typecheck                # tsc --noEmit — tem de passar limpo
npm run lint                     # ESLint (next/core-web-vitals) — sem erros; avisos são dívida conhecida
npm run auditoria                # 30+ invariantes do sistema; sai com 1 se algum falhar
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
  (agendamento, convite, webhooks). Dentro da rota, `getAuth` de
  `lib/api-auth.ts` confere o dono: equipe acessa qualquer cliente, cliente só
  o próprio.
- **Nível de acesso vem de `staff_roles`** (`lib/staff-perms.ts`): `owner`,
  `manager`, `junior`. Quem não está na tabela é `junior`. O
  `user_metadata.role` do Supabase só distingue firma × cliente no middleware.
- **Webhooks validam assinatura**: Stripe com `constructEvent`, Twilio com
  `X-Twilio-Signature`. Webhook nunca devolve erro à Twilio (reenvio duplica).
- **SMS só sai pela `lib/sms.ts`**, que confere consentimento, STOP e celular
  válido. Nenhum fluxo chama a Twilio direto.
- **Numeração de fatura é gerada no banco** (`INV-2026-0001`), nunca no código.
- **Preço praticado fica gravado no item da fatura**; reajuste do catálogo
  (`pricing_items`) não altera fatura antiga.

## Convenções de arquivo

- **UTF-8 sem BOM, sempre.** O projeto já sofreu com acentos corrompidos
  (o "ã" virando "A" com til mais "£") por arquivos copiados de ZIP e
  editados no Windows. A
  auditoria falha se encontrar isso. Se um editor no Windows for usado, salve
  como "UTF-8" (não "UTF-8 with BOM").
- Não versionar `.bak`. Os dois que existem (`middleware.ts.bak`,
  `app/dashboard/layout.tsx.bak`) são lixo histórico; a auditoria os lista.
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
app/api/bookkeeping/ importação (Plaid, CSV, PDF), regras, relatórios, conciliação
app/api/billing/     faturas, pagamentos, Stripe, impressão, parcelamento
app/api/plans/       contratos recorrentes
app/api/signatures/  DocuSign (contrato, 8879, diagnóstico)
app/api/stripe/webhook   entrada única dos eventos de pagamento
app/api/whatsapp/    webhook, fila, conversa, bot
components/          BookkeepingTab, PlansTab, QuotesTab, ReconcileTab, SignaturesTab…
lib/                 motor de regras, permissões, SMS, contrato, integrações
sql/ e *.sql         migrações rodadas à mão no SQL Editor do Supabase (idempotentes)
middleware.ts        controle de acesso por rota
```

## Dívida conhecida (decidir antes de "corrigir")

- Menu da firma duplicado em quatro layouts (`app/dashboard`, `app/clients`,
  `app/invitations`, `app/settings`). Mudança de menu precisa ir nos quatro.
- Módulo Plans × tabela `recurring_plans`; Quotes × estimates do financeiro;
  `staff_roles` × `team_members`. Duplicações conhecidas, resolução pendente
  de decisão do sócio.
- Avisos de lint `react-hooks/exhaustive-deps` e `no-img-element`: conhecidos,
  não bloqueiam.

## Como trabalhar aqui

- Leia `ESPECIFICACAO.md` antes de mudar regra de negócio. Se a mudança pedida
  contraria um princípio da seção 2, diga isso antes de implementar.
- Ao concluir: `npm run typecheck && npm run lint && npm run auditoria`, e só
  então commit. Mensagem de commit em português, no imperativo curto, como o
  histórico já faz.
- Migração de banco: arquivo SQL novo em `sql/`, idempotente, com bloco de
  conferência no fim (padrão de `sql/whatsapp-atendimento-v1.sql`). Ela **não**
  roda sozinha — quem faz o deploy precisa rodá-la no Supabase, e isso deve
  constar na entrega.
