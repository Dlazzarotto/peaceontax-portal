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
  **E o papel mora em `app_metadata`, não em `user_metadata`.** No Supabase,
  `user_metadata` é do PRÓPRIO usuário: com a sessão dele e a anon key do
  navegador, `auth.updateUser({ data: { role: 'owner' } })` fazia qualquer
  cliente do portal virar firma — e OWNER, porque `getStaffLevel`, sem linha
  em `staff_roles`, caía no mesmo campo. `app_metadata` só a service role
  escreve. Não há reserva lendo `user_metadata`: a reserva seria o buraco de
  volta. Migração: `sql/papel-no-app-metadata-v1.sql`, que **precisa rodar
  antes de o código subir** — ela copia o papel de quem `staff_roles`
  confirma, rebaixa a cliente quem alegava firma sem confirmação (copiar cego
  daria alvará a quem já tivesse forjado `owner`) e lista os rebaixados com a
  linha de SQL pronta para promover quem for de casa. Decide pelo estado de
  DESTINO, não pelo de origem: a primeira versão olhava `user_metadata` e, na
  segunda rodada, rebaixava a firma inteira. A auditoria recusa leitura ou
  escrita do papel em `user_metadata`, e recusa qualquer menção a
  `user_metadata` em `papeis.ts`, `api-auth.ts`, `staff-perms.ts` e
  `middleware.ts`.
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
- **A tela pede a mesma chave que a rota exige — e isso é conferido.** Foi a
  falha de método que custou mais caro aqui. As auditorias olhavam ARQUIVOS:
  quem chama a rota, qual cliente ela alcança, RLS, erro engolido. Nenhuma
  perguntou se o **botão** e a **trava** pedem a mesma coisa — e eles vivem em
  arquivos diferentes, então conferir cada um sozinho nunca acha a
  discrepância. Dois casos reais: o botão **Enviar** pedia `cancelar` e a rota
  exigia `enviar` (a fatura ficava rascunho, não chegava ao cliente e não saía
  e-mail); o botão **Estornar** pedia `estornar` e a rota barrava antes num
  `!perms.receber` que cobria o POST inteiro — quem recebesse `estornar` sem
  `receber` via o botão e levava 403. Agora a auditoria faz duas conferências:
  a **automática**, que casa `perms?.X && … acao(_, 'Y')` da tela com
  `action === 'Y' … !perms.Z` da rota (pelo `perms` IMEDIATAMENTE ANTERIOR, não
  por distância de regex — medir distância já acusou defeito que não existia),
  e uma **tabela declarada** para os botões cujo destino não dá para deduzir
  lendo. Botão novo entra na tabela.
- **Mandar documento ao cliente pede a chave `enviar` — na tela TAMBÉM.** O
  botão **Enviar** da lista olhava `perms.cancelar` enquanto a rota exigia
  `perms.enviar`: quem recebesse a autorização de enviar continuava sem o
  botão, e a fatura ficava **rascunho para sempre** — não chega ao portal do
  cliente (rascunho nunca aparece lá, de propósito) e não sai e-mail. Nada de
  fora avisa; o cliente simplesmente não vê fatura nenhuma. **Reenviar** e
  **Cobrar** tinham o mesmo acoplamento, nos dois lados, e também passaram a
  `enviar`: mandar documento ao cliente é enviar, não cancelar. Por NÍVEL nada
  muda (as duas chaves são de gerente/sócio); o que muda é a autorização por
  pessoa, que é justamente para isso. A auditoria confere os três pontos.
- **A lista de faturas é do dia e é de quem emitiu — e só o SÓCIO é
  ilimitado** (`lib/escopo-faturas.ts`, `/api/billing/consulta`, migração
  `sql/consulta-de-faturas-v1.sql`). O corte do dia vem de
  `lib/dia-da-firma.ts` (`America/New_York`), nunca do servidor: às 20h de
  Malden já é o dia seguinte em UTC e a lista zerava no meio do expediente.
  **O que mudou (decisão do sócio):** `verTodasFaturas` vinha por NÍVEL, e
  com isso o GERENTE abria a tela com o histórico inteiro à mostra. Quem
  passa pela mesa lê quanto cada cliente da firma pagou — e abrir a tela não
  é a mesma coisa que PRECISAR daquele dado. Agora a lista nasce FECHADA no
  próprio dia, das próprias faturas, com busca por período e por situação
  (`todas · em aberto · pagas · canceladas · rascunhos`, lista FECHADA).
  **Sair disso é um ATO**: pede senha e motivo de um gerente ou sócio, a
  liberação vale 30 minutos e fica em `invoice_query_audit` — que é a trilha
  E a janela, porque duas tabelas poderiam discordar e aí "quem viu a
  carteira em setembro" deixa de ter resposta. `via` separa `proprio`
  (o gerente na própria máquina) de `senha` (liberou para outra pessoa),
  pela mesma razão de `aprovadoVia` no recebimento. **Senha certa não
  basta**: o nível de quem autoriza é conferido, como em `podeAprovar`.
  A regra mora em `decidirConsulta`, e a TELA CHAMA A MESMA FUNÇÃO —
  o servidor manda `escopo` pronto e a tela não recalcula nada.
  Três armadilhas que o módulo fecha: **pedido SEM data é amplo**, não "o
  dia de hoje" (é o jeito mais fácil de ver tudo sem parecer que se pediu);
  **emissor ausente é QUALQUER emissor**, não "eu"; e a recusa devolve o
  filtro SEGURO, nunca o aberto. A rota **recusa com 403** em vez de
  devolver calada uma lista curta — lista curta sem explicação é uma
  afirmação falsa ("não há fatura") e quem olha conclui que o sistema
  perdeu o documento; a tela abre o pedido de autorização em cima disso.
  O `?id=` respeita o MESMO escopo: fechar a lista e deixar o id aberto é
  fechar a porta e esquecer a janela. 40 casos em
  `testes/escopo-faturas.mts`; a auditoria confere os quatro elos.
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
- **O caixa da firma é a firma como CLIENTE de si mesma** (`clients.is_firm`,
  `lib/caixa-firma.ts`, tela `/dashboard/caixa`, migração
  `sql/caixa-da-firma-v1.sql`). O bookkeeping inteiro é amarrado a
  `clients.id`; dar livro próprio à firma com tabelas separadas seria a
  QUARTA cópia do motor de classificação. O preço da escolha é que a firma
  aparece por padrão em toda tela que lista cliente — o contrário do padrão
  da casa —, e quem paga esse preço são duas travas, e só elas:
  `canAccessClient` (a linha da firma é **só do sócio**: `verEmpresas` não
  serve, porque o gerente a tem por nível e abriria a folha de pagamento) e
  `clientesOcultos`, que tira a firma das LISTAS — seletor de fatura e de
  contrato, central de bookkeeping, alertas, e `/api/clients` também das
  CONTAGENS. `empresasVedadas` virou `clientesOcultos` porque o nome antigo
  dizia metade, e o erro da consulta agora VIAJA (`{ ocultos, erro }`): um
  conjunto vazio ali não esconde nada e mostraria justamente a carteira de
  empresas que o escopo existe para esconder. A mesma varredura achou
  `/api/bookkeeping/payees?all=1`, que agrega a carteira inteira (o nome de
  cada cliente e com quem ele gasta) e ficara de fora do escopo por não
  receber `clientId`. `is_firm` nunca vem do corpo do pedido — marcar um
  CLIENTE faria o cliente sumir de todas as listas — e o banco só admite uma
  firma (índice único parcial). **A coluna pode ainda não existir**:
  `idDaFirma` trata a ausência como "ainda não há caixa" em vez de derrubar o
  funil de acesso, senão o sistema recusaria tudo entre o deploy e a migração
  feita à mão. O Plaid do caixa é o mesmo do portal: `link-token` e
  `exchange` passaram a aceitar `clientId` da equipe, pelo funil
  `canAccessClient` (era o que `/api/plaid/items` já fazia) — e a URL de
  retorno `/dashboard/caixa` precisa entrar em *Allowed redirect URIs* no
  painel do Plaid, senão banco OAuth não conecta (a rota avisa, em vez de só
  falhar).
- **Contabilidade fiscal × caixa diário: a receita passa por "Recebimentos a
  depositar".** (`lib/deposito-match.ts`, `lib/caixa-recebimentos.ts`,
  `lib/stripe-repasse.ts`, `/api/caixa/depositos`, migrações
  `sql/caixa-conciliacao-v1.sql` e `-funcao-v1.sql`.) O livro da firma é
  **regime de caixa**: despesa direto do extrato, receita no RECEBIMENTO da
  fatura, numa conta de passagem (o Undeposited Funds do QuickBooks) que o
  depósito esvazia. **A receita não é lida do extrato** porque na mesma conta
  caem o depósito de cheque/Zelle (um a um) e o repasse do Stripe, que junta
  vários pagamentos e chega LÍQUIDO — lendo só o banco, a receita bruta nunca
  fecha, e é a bruta que vai no 1099-K. A conta de passagem **fecha em zero**:
  `+ recebimentos − taxa − transferência = 0`, e é isso que o teste exige.
  **A conciliação é UMA RPC** (`conciliar_deposito`): são cinco escritas que
  valem juntas ou nenhuma, e **o valor é recalculado no banco** — a tela manda
  ids, número vindo do navegador não lança despesa. Testado no PG 16, inclusive
  duas sessões simultâneas (a segunda recebe `ja_conciliado`). Três recusas
  deliberadas: depósito MAIOR que os recebimentos é `falta_recebimento` (não é
  taxa negativa — é fatura paga que ninguém baixou); **reembolso dentro do
  repasse não é taxa** (seria despesa que não existiu, com a receita ainda
  lançada); e recebimento estornado DEPOIS de depositado não some do livro,
  vira aviso. A sincronização dos recebimentos é **idempotente e sem gancho no
  caminho do dinheiro** — `invoice_payments` é gravado em três lugares e
  apagado no estorno; pendurar a criação do lançamento em cada um seriam
  quatro pontos para manter em pé. O índice único em `payment_id` é o que
  garante que rodar duas vezes não dobra a receita do ano — e ele tem de ser
  **SIMPLES, não parcial**: a v1 criou `where payment_id is not null`, e
  `on conflict (payment_id)` **não infere índice parcial** (precisaria repetir
  o predicado, que o PostgREST não tem como mandar). A tela falhou em
  produção com `there is no unique or exclusion constraint matching the ON
  CONFLICT specification` e nenhum recebimento entrava. `sql/caixa-conciliacao-v2.sql`
  troca. Em UNIQUE o Postgres trata cada NULL como distinto, então as dezenas
  de milhares de linhas do extrato (todas com `payment_id` nulo) continuam
  entrando — conferido no PG 16 nos dois sentidos.
  E a rotina **deixou de depender da forma do índice**: usa `insert` puro e
  trata o 23505 linha a linha. Depender do formato de um índice para a
  sincronização funcionar é frágil — já derrubou tudo uma vez, e o conserto
  exigia migração. O índice segue sendo quem garante que a receita não
  dobre; a rotina só não pergunta como ele foi criado.
- **`bank_transactions.source` tem CHECK, e ele nasceu no PAINEL.** A
  sincronização dos recebimentos morreu em produção com
  `violates check constraint "bank_transactions_source_check"`: o caixa da
  firma trouxe três origens novas (`recebimento`, `deposito`, `taxa` — as
  duas últimas usadas pela própria `desconciliar_deposito`, que apaga
  `where source in ('deposito','taxa')`) e a lista fechada não as conhecia.
  Nenhum `.sql` tinha o CHECK: é de novo o **schema que só existe no banco
  vira folclore**. `sql/caixa-origens-v1.sql` traz a regra para o
  repositório e recria o CHECK como a **UNIÃO** do que já está gravado na
  tabela com o que o código grava — montar a lista "que eu acho que é a
  certa" recusaria uma origem antiga e travaria a importação sem aviso
  (conferido: uma origem fora do código sobreviveu). A lista sai pelo `union`,
  ordenada: `||` cru repetia `plaid` e a ordem mudava a cada rodada, o que
  faz comparar o CHECK de dois bancos acusar diferença que não existe.
  **A conferência testa o CHECK de verdade, mas numa tabela TEMPORÁRIA** —
  `pg_get_constraintdef` copia o predicado real para uma tabela de uma coluna
  e o insert de teste vai lá. Ler o texto do CHECK não prova nada; inserir em
  `bank_transactions` também não serve, e foi o que derrubou a migração em
  produção: a primeira versão inseria com quatro colunas e bateu em
  `null value in column "description" violates not-null constraint` —
  **conferência não pode depender de colunas que ela não conhece.** Como o
  SQL Editor roda tudo numa transação, o CHECK novo voltou atrás junto e a
  migração inteira não valeu (reproduzido no PG 16, nos dois sentidos).
  A auditoria casa cada `source: '…'` escrito perto de `bank_transactions`
  com a lista da migração — olhando o ARRAY, não o arquivo (o bloco de
  conferência cita os mesmos nomes, e a primeira versão passava com o valor
  removido) — e **âncora perdida é FALHA, não lista vazia**: sem o
  `unnest(array[` ela não confere nada, e esse é justamente o modo de falhar
  que já passou despercebido aqui.
- **O fluxo de caixa lê o EXTRATO, não o livro inteiro** (`lib/fluxo-de-caixa.ts`,
  `/api/caixa/fluxo`, `components/CaixaFluxo.tsx`). A mesma tabela guarda o
  extrato e a conta de passagem; somar as duas conta o mesmo depósito **duas
  vezes** e antecipa o cheque recebido e ainda não depositado. `ehDoExtrato`
  tira `recebimento · deposito · taxa` (`ORIGENS_DE_PASSAGEM`), e a auditoria
  casa essa lista com quem de fato grava passagem — `lib/caixa-recebimentos.ts`
  e o `source in (…)` de `desconciliar_deposito` —, além de exigir que
  `movimentoDeBanco` FILTRE, não só declare. Transferência entre contas da
  própria firma sai pelo PAR, nunca pela coluna: o crédito do depósito
  conciliado também tem `transfer_match_id`, mas apontando para a passagem, e
  cortar por "tem `transfer_match_id`" apagaria a entrada de dinheiro. O
  fluxo **não espera classificação** — o P&L exige `approved` porque lucro
  depende da conta certa; o débito saiu da conta de qualquer jeito, e a firma
  tem centenas de linhas na fila. A projeção é conservadora de propósito:
  **fatura vencida fica fora** (aparece à parte), **conta a pagar vencida
  fica dentro** e mensalidade não faturada não entra — superestimar entrada
  faz a firma gastar o que não tem. Toda rota de `/api/caixa/` é **só do
  sócio** (a auditoria confere as quatro), porque o a receber é a carteira
  inteira, inclusive as empresas que o escopo por tipo esconde.
- **O saldo da conta vem do BANCO; o do extrato é reserva** (`saldoEmConta`,
  `bank_accounts.current_balance`, migração `sql/caixa-saldo-da-conta-v1.sql`).
  O `/transactions/sync` do Plaid traz a transação, **não o saldo depois
  dela** — então quem conectou o banco (o caminho recomendado) via "saldo
  desconhecido" para sempre e a projeção nascia sem o número de que depende.
  O `/accounts/get`, que a sincronização já chamava, traz `balances.current`;
  só faltava onde guardar. Na falta dele vale o saldo corrido do CSV, e a
  tela diz **de qual fonte** veio e de quando: o do extrato só sabe até a
  última linha importada. Não duplica o balanço — lá a pergunta é "quanto
  tinha em 31/12", que só o corrido responde. Cartão de crédito fica fora da
  soma (ali o saldo é dívida). **Saldo desconhecido não é zero**, e **zero
  informado pelo banco é um saldo** — tratar a conta zerada como desconhecida
  esconderia justamente o aperto. As colunas podem não existir ainda: a
  sincronização e a rota caem para a consulta sem elas (`colunaAusente`), em
  vez de derrubar o extrato inteiro entre o deploy e a migração.
- **Contas a pagar são CAIXA DIÁRIO, nunca lançamento** (`lib/contas-a-pagar.ts`,
  `/api/caixa/contas`, migração `sql/contas-a-pagar-v1.sql`). O livro da firma
  é regime de caixa e a despesa vem do extrato: se a conta a pagar virasse
  lançamento, a MESMA despesa entraria duas vezes — emissão e pagamento — e o
  P&L sairia dobrado onde houvesse boleto. **Pagar é LIGAR a conta ao débito
  que já está no banco** (`firm_bills.paid_tx_id`), e o índice único garante
  que um débito feche UMA conta só; a rota traduz o 23505 em vez de devolver o
  erro cru. O candidato tem de bater ao **centavo** — fechar com o débito
  errado é pior que não fechar, porque a conta some do radar; a data é uma
  janela em volta do vencimento, porque boleto se paga adiantado e atrasado.
  `chaveDoFornecedor` só ORDENA sugestão e **não é** o motor de classificação
  (que vive em três arquivos e precisa continuar idêntico) — misturar faria a
  quarta cópia. Cancelar preserva com motivo; paga com atraso não volta a
  aparecer como vencida. Fornecedor é `payees`, não uma segunda lista. 38
  casos em `testes/contas-a-pagar.mts`.
- **Reclassificar o registro pela regra não pode falhar calado**
  (`PATCH /api/bookkeeping/rules`). Mudar uma regra marcando "aplicar aos já
  aprovados" pedia senha e motivo, respondia `ok` e **não mudava o
  relatório** — por quatro caminhos, todos mudos:
  **1.** `.limit(5000)` sem `order`: o PostgREST tem teto próprio (1000 por
  padrão), então num cliente com muitos lançamentos parte do registro nunca
  era visitada — e nem dá para saber QUAIS mil voltaram. Agora lê em páginas
  de 1000 com `order('id')`, até acabar.
  **2.** O erro do `select` era descartado: consulta que falha virava "nenhuma
  casou", com a tela dizendo que deu certo. Agora a leitura lança e a rota
  responde o motivo.
  **3.** `if (!uErr) registerChanged++` **descartava a recusa do banco**; na
  fila era pior, `applied++` era incondicional e contava como aplicada a
  linha que o banco recusou. Agora conta `casou`/`mudou`/`falhou` e devolve o
  texto da primeira recusa.
  **4.** `applyToRegister` sem cliente alvo era PULADO em silêncio — senha
  digitada, motivo escrito, resposta `ok`, nada feito. Agora recusa.
  E a tela escondia o pior caso: `r.registerChanged ? …` **omitia o trecho
  inteiro quando era zero**, então "reclassifiquei e nada mudou" era
  indistinguível de "não pedi reclassificação". **Zero é informação.**
  A condição de casamento virou UMA função (`casaARegra`): a fila e o
  registro comparavam por cópia lado a lado, e cópia diverge.
  **Regra GERAL editada pela tela de um cliente reclassifica só o registro
  DAQUELE cliente** — a regra passa a valer para todos, a reclassificação
  retroativa não. A resposta diz isso (`escopoDoRegistro`), senão a conclusão
  é "não funcionou".
- **Contrato recorrente: editar e encerrar pedem senha, motivo e trilha —
  e a aba parou de prometer o que o sistema não faz**
  (`lib/contrato-recorrente.ts`, `/api/billing/recurring`, migração
  `sql/contrato-recorrente-auditoria-v1.sql`). A aba só tinha
  Pausar/Reativar, e o PATCH que já aceitava valor, dia e cobrança
  automática **não pedia senha, não pedia motivo, não deixava rastro e não
  conferia de qual cliente era o contrato** — `isStaff` diz QUEM chama, não
  QUAL cliente, e bastava mandar o `id` de um contrato de empresa. Editar
  uma FATURA, documento único, exige as três primeiras; o contrato exigia
  zero. A fatura erra uma vez, **o contrato erra todo mês**.
  **Encerrar ≠ pausar.** Pausar é reversível e não mexe no acordo: segue em
  um clique, mas vai para a trilha. Encerrar grava `end_date`, desliga e
  **não volta** — `situacaoDoContrato` olha o `end_date` ANTES do `active`,
  senão um contrato acabado apareceria como "pausado", com botão de
  Reativar, ressuscitando um acordo que as duas partes desfizeram.
  **A trilha vem ANTES da alteração** (`recurring_plan_audit`): se o insert
  falhar, a edição é RECUSADA e a mensagem diz qual migração falta. Mudança
  sem rastro é pior que mudança não feita (princípio 2). O preço é uma linha
  de trilha sobrando se o update seguinte falhar — esse lado é o barato.
  **A próxima cobrança tinha dois defeitos mudos**, agora em módulo puro com
  59 casos: somava **um mês sempre**, qualquer que fosse o intervalo (o
  trimestral tinha data de mensal), e usava o dia do **servidor em UTC**, não
  o do escritório — o mesmo defeito já corrigido na lista de faturas e no
  relatório. A régua é **ancorada no início**, não em hoje: trimestral que
  começou em 10/jan cobra jan · abr · jul · out; recalcular a partir de hoje
  daria outra régua a cada edição e a data andaria sozinha. Mexer em dia,
  início ou intervalo **recalcula `next_run`** — trocar o dia deixava a
  próxima data na antiga, em silêncio.
  Três armadilhas na comparação do que mudou, cada uma marcando "mudou" sem
  nada ter mudado e enchendo a trilha de ruído: `350` × `'350.00'`,
  `auto_charge` nulo × `false`, e `date` devolvido com hora. A quarta é o
  oposto: **campo de data VAZIO é "não mexi nisso", não "data inválida"** —
  contrato sem `start_date` fazia quem só queria trocar o VALOR levar um erro
  falando de data.
  **E a aba mentia.** O texto dizia "Gera fatura sozinho no dia escolhido".
  **Nada no repositório lê `recurring_plans`** além da própria rota: não há
  cron para ela (o único é o aviso de cobrança), não há geração de fatura,
  não há Stripe — e o relatório de receita recorrente lê `payment_plans`,
  outra tabela. Como há pelo menos um gatilho nessa tabela que **só existe no
  banco** (o que recusa auto-cobrança sem cartão), não dá para afirmar daqui
  que não exista um `pg_cron`; então a tela não afirma nada: ela marca
  **⚠ a data passou e nada foi gerado** quando `next_run` ficou para trás com
  o contrato ativo. É auto-evidente — quem gerasse a fatura teria movido o
  `next_run`. Gerar a fatura de verdade é decisão aberta, junto com a
  duplicação Plans × `recurring_plans`.
  O GET passou a filtrar os contratos por `clientesOcultos`: filtrava a lista
  de CLIENTES e não a de contratos, então o nome das empresas (e o caixa da
  firma) aparecia para quem não pode abri-las.
- **O contrato recorrente é o MOLDE DE UMA FATURA: itens, desconto, prazo**
  (`lib/contrato-recorrente.ts`, `components/ContratoItens.tsx`, migrações
  `sql/contrato-recorrente-itens-v1.sql` e `-funcao-v1.sql`). Era uma
  descrição e um valor — não dava para escrever o acordo real
  ("Bookkeeping 350 + Payroll 120, menos 50, vence 15 dias depois").
  **`amount` e `description` passaram a ser DERIVADOS** das linhas, e a
  lista `CAMPOS_EDITAVEIS` **não** os aceita: dois caminhos para o mesmo
  número deixariam o cabeçalho discordar das linhas no primeiro item
  acrescentado — o defeito que a impressão de fatura já teve aqui.
  **Desconto em DÓLAR**, nunca porcentagem: a entrada do parcelamento já
  custou caro pedindo 25 para dizer $250, e desconto quebrado é pior ($37
  em $470 é 7,87%). Desconto ≥ soma é **recusa** — negativo seria a firma
  pagando o cliente todo mês.
  **Prazo em DIAS, não em dia do mês.** "Emite no 1 e vence no 10" desmonta
  quando a emissão é no 25: o vencimento cairia ANTES da emissão. "Vence em
  N dias" atravessa a virada do mês sozinho e é como o mundo contábil já
  escreve (Net 15, Net 30). `vencimentoDaCobranca` soma ao MEIO-DIA UTC —
  somar dias em cima da meia-noite escorrega um dia nas viradas de horário
  de verão.
  **Trocar as linhas é UMA operação, no banco** (`salvar_itens_do_contrato`):
  apagar e inserir em duas idas deixaria o contrato SEM NENHUMA LINHA se a
  segunda falhasse — o acordo apagado por uma falha de rede. **E o total é
  recalculado lá dentro**: a tela manda as linhas, número vindo do navegador
  não define quanto o cliente paga (mesma regra de `conciliar_deposito`).
  Testado no PG 16: a recusa por desconto volta atrás e as linhas antigas
  ficam. A migração **copia** cada contrato antigo para uma linha — sem
  isso, o modelo novo apagaria o acordo antigo em silêncio —, e a
  conferência **falha** se sobrar contrato sem linha.
  A prévia da tela chama `montarContrato`, a MESMA função da rota. 85 casos
  em `testes/contrato-recorrente.mts`.
- **Mexer em contrato é por NÍVEL (sócio ou gerente), não por chave de
  `perms`** — decisão do sócio. `receber` também se concede a uma pessoa
  (`staff_grants`), e com a concessão um assistente passava a definir quanto
  a carteira paga todo mês. Nível é a base; aqui a base é o PISO.
  A conferência disso **não** é o par de textos "a tela pede X, a rota exige
  X", porque a regra é uma expressão: é mais forte — **a tela não decide**.
  O GET manda `podeContrato` calculado pela MESMA função que trava o POST e
  o PATCH, e a auditoria exige os quatro elos (a função por nível, as duas
  guardas de escrita, o GET mandando pronto, a tela obedecendo). Sabotada
  nos quatro. A primeira versão era larga demais e acusou a aba de
  Autorização, que lê o nível por motivo próprio: ela olha a ATRIBUIÇÃO de
  `podeContrato`, não qualquer menção a nível na tela — invariante que
  reprova código certo ensina a cadastrar exceção.
- **Cobrar no balcão é um QR, não um leitor** (`lib/cobranca-balcao.ts`,
  `/api/billing/cobranca-balcao`, quadro em `app/dashboard/billing`). O leitor
  comprado foi o **Stripe Reader M2**, que é **Bluetooth**: só funciona com um
  app móvel feito sobre o SDK do Terminal, e o app do Dashboard do Stripe
  **não** o aciona (conferido no suporte do Stripe). Sistema web não fala
  Bluetooth — então, sem leitor de internet, o balcão mostra um QR, o cliente
  aponta o próprio telefone e paga.
  **Não há integração nova com o Stripe:** é o MESMO Checkout do portal, com o
  MESMO `metadata.invoice_id`, passando pelo mesmo `sessaoComFormasDisponiveis`.
  O webhook que já existe (`payment_intent.succeeded` / `checkout.session.completed`,
  com a idempotência das duas chaves) dá a baixa; o recebimento entra na conta
  de passagem do caixa da firma e concilia no repasse. **A tela nunca registra
  pagamento** — ela só PERGUNTA de 3 em 3 segundos se já caiu, senão haveria
  dois caminhos para o mesmo dinheiro.
  A chave é `enviar`, a mesma de Enviar/Reenviar/Cobrar: pôr a cobrança diante
  do cliente é enviar, não receber. Duas regras puras, com teste (20 casos):
  o valor é o **SALDO**, nunca o total (cobrar o total de fatura com entrada
  paga cobra a entrada duas vezes), e **rascunho não é cobrável** — nunca
  chegou ao cliente, e receber por ele deixaria a fatura rascunho depois de
  paga. `PAGAVEL` é lista FECHADA: status novo nasce não cobrável.
  **Para leitor de verdade, o caminho é um de INTERNET** (WisePOS E $249,
  S700 $299), com a integração *server-driven* — sem SDK no navegador, e
  testável com leitor simulado (`simulated-wpe`). App móvel com o M2 é a opção
  cara: conta de desenvolvedor, loja, pareamento, e **não dá para conferir
  deste container**.
- **Conferir QUEM chama não é conferir QUAL cliente.** `isStaff` diz que a
  pessoa é da firma; o escopo por TIPO é `canAccessClient`. Nove rotas
  ficavam só no `isStaff` e recebiam um `clientId` de fora — entre elas
  `/api/clients/profile` (a porta do cadastro) e `/api/clients/access` (o
  acesso ao portal): bastava passar o id de uma empresa. Também
  `bookkeeping/rules` (que diz o plano de contas e os fornecedores da
  empresa), `billing/invoices`, `billing/recurring`, `firm/messages`,
  `send-invite` e `fase1/apply-template`. Resumo que AGREGA a carteira não
  pergunta por um cliente: `bookkeeping/overview` e `bookkeeping/alerts` usam
  `empresasVedadas` (`lib/api-auth.ts`), senão o nome e o volume das empresas
  apareciam no painel de quem não pode abri-las — o mesmo vazamento já
  corrigido em `/api/clients?resumo=1`. A auditoria recusa rota de equipe com
  `clientId` sem um dos dois, e procura a CHAMADA, não o import.
- **Tabela nova nasce FECHADA para o navegador.** No Supabase, tabela criada
  no schema `public` já vem com privilégio para `anon` e `authenticated` — a
  RLS é que segura. Toda migração que cria tabela faz
  `alter table … enable row level security` e
  `revoke all … from anon, authenticated`, **sem policy**: quem trabalha nelas
  é o servidor, com a service role key, que passa por cima da RLS. A view
  também leva `revoke` próprio — view roda com o dono, não com quem chama,
  então RLS na tabela não protege quem lê pela view. Das 18 tabelas, 16 já
  nasciam assim; as duas que faltavam eram `staff_grants` e `approval_codes`,
  e em `staff_grants` isso não era vazamento e sim **escalada**: a tabela é
  append-only e o estado é a última linha, então uma linha inserida de fora
  (`concedido = true`, chave `receber`) valia em `permissoesDe` sem sócio, sem
  senha e sem motivo. Migração: `sql/rls-tabelas-expostas-v1.sql`, que fecha
  também `staff_roles` (que não está em nenhum `.sql` — nasceu no painel) e a
  view `wa_relatorio_atendimento`, que não tinha `revoke`: as tabelas de
  baixo estavam fechadas, a view não, e ela entregava o histórico de
  atendimento (telefone, canal, contagens) a quem tivesse a anon key. A
  auditoria falha se alguma tabela **ou view** criada em `.sql` ficar aberta.
  A migração termina listando o que ainda responde ao navegador — as tabelas
  de faturamento nasceram no painel e não dá para conferi-las pelo
  repositório.
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
- **Acertar Empresa × Pessoa física em LOTE** (`lib/tipo-do-cliente.ts`,
  `/api/clients/reclassify`). A importação lê `Client type` do QuickBooks
  (`ORGANIZATION` → empresa) e na carteira real muita PESSOA está assim —
  desde que o tipo virou fronteira de acesso, esses cadastros desapareceram
  de quem atende o balcão, e ficha por ficha não se faz com centenas.
  **O erro não é simétrico, e é isso que desenha o critério:** pessoa marcada
  como empresa some do assistente (incômodo); empresa marcada como pessoa
  abre a carteira dela a quem não deveria ver (falha de acesso). Então
  `propostaParaEmpresa` só propõe pessoa física quando **não há NENHUM**
  sinal de empresa (EIN de 9 dígitos, tipo de entidade, razão social
  diferente do nome, sufixo jurídico no nome). Sinal fraco — palavra de ramo,
  `&` — vai para **revisar**, desmarcado: "Market" e "Auto" também são
  sobrenome. O ponto é REMOVIDO e não trocado por espaço, senão `L.L.C.` se
  desfaz em três letras. O GET mostra o plano e não grava; o POST grava só os
  ids marcados, com senha e motivo, em blocos com recuo por linha, trilha
  `type_changed` POR CLIENTE e sincronização do `client_type` no login. A
  resposta diz quantos já não eram empresa e quantos falharam. 41 casos em
  `testes/tipo-do-cliente.mts`.
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
- **Serviço novo nasce ATIVO, e "ativo" tem uma definição só**
  (`lib/catalogo-precos.ts`). O catálogo (`pricing_items`) era lido de três
  jeitos: `/api/pricing` (tela Preços, orçamentos) mostrava TUDO, a fatura e o
  contrato mensal exigiam `active = true` — e o POST que cria o item **não
  gravava `active`**. Com a coluna sem `default`, o item nascia nulo:
  aparecia em Preços e sumia justamente onde seria usado, e para quem
  cadastrou "a lista de serviços da fatura não atualiza". Agora o POST grava
  `active: true`, quem lê usa `FILTRO_ATIVO` (nulo conta como ativo —
  **desativar é um ATO**, e ele grava `false`), e
  `sql/pricing-items-ativo-v1.sql` acerta as linhas nulas e põe o `default` na
  coluna. 11 casos em `testes/catalogo-precos.mts`.
- **Consulta lado a lado não pode ter erro engolido.** Num `Promise.all`,
  conferir o erro de UMA consulta e ignorar o das outras faz a que falhou
  virar lista vazia — e lista vazia, na tela, é uma afirmação: "não há serviço
  cadastrado", "não há pagamento". Era assim em cinco lugares. O pior era
  `billing/print`: itens ou pagamentos que falhassem mandavam embora uma
  fatura **sem itens mas com o total**, ou sem os pagamentos já feitos,
  entregue a um cliente que pagou — agora ela recusa imprimir e diz o quê
  falhou, porque sair incompleto é pior. Ignorar de propósito continua
  legítimo: capture o erro e não o use, para a decisão aparecer no código. É
  a **quinta** vez que esse padrão custa tempo; agora a auditoria o recusa.
  A primeira versão da invariante só acusava quando **algum irmão** conferia o
  erro — e deixou passar `/api/portal/billing`, onde nenhum dos quatro
  conferia. Era o pior caso: o portal do CLIENTE mostrando zero, que na tela é
  uma afirmação ("você não tem nada para pagar") — o cliente acredita e a
  firma não recebe. Reforçada, ela achou mais nove, entre eles a importação de
  CSV (a consulta que falha vira "nada importado" e o extrato entra **em
  dobro**), a agenda (oferece horário já marcado), o balanço (demonstrativo
  errado, não incompleto) e a edição de fatura (abre sem itens, e salvar dali
  apaga o que estava).
- **A lista de clientes da fatura e do contrato obedece ao escopo por tipo.**
  `GET /api/billing/invoices` e `GET /api/billing/recurring` filtram por
  `empresasVedadas`. O POST já recusava empresa para quem não tem
  `verEmpresas`; mostrar o nome no seletor e recusar no salvar seria oferecer
  o que não se pode fazer — e a lista de empresas é o que o escopo esconde.
- **E-mail que não sai diz POR QUE, e o resultado nunca se descarta.**
  `enviarEmail` (`lib/avisos.ts`) devolve `{ ok, motivo }`, e o motivo aponta
  onde está o conserto: **sem chave** → o sócio, no Vercel; **cadastro sem
  e-mail** ou endereço inválido → a equipe, na ficha; **recusa do Resend** →
  o painel do Resend, com o texto dele (domínio não verificado é o caso
  comum). A regra de "nem tenta" mora em `lib/email-motivo.ts`, módulo puro
  sem import — `avisos.ts` depende de `contract-html` e o teste não
  conseguiria importar de lá. 12 casos em `testes/email-motivo.mts`.
  Três dos cinco pontos de envio faziam `await enviarEmail(...)` e seguiam em
  frente: contrato, parcelamento criado e parcelamento cancelado. Contrato
  que o cliente nunca recebe é assinatura que não acontece, e ninguém sabe
  por quê. Agora o resultado vai para a trilha (`invoice_audit.next.email`) e
  para a resposta da tela. A auditoria recusa quem descartar.
  **`/api/billing/diag-envio?numero=INV-2026-0007`** (equipe, respeitando o
  escopo por tipo) responde "por que ESTE cliente não recebeu", em nove
  passos, só leitura. Existe porque o caso já foi diagnosticado errado três
  vezes — as causas são parecidas por fora e completamente diferentes por
  dentro: fatura ainda em rascunho · cadastro sem e-mail · Resend não
  configurado · e a que **ninguém adivinha**, porque não há erro em lugar
  nenhum: **a fatura está num cadastro e o LOGIN do cliente está em OUTRO**
  (duplicata da importação, de antes de o aceite passar a completar o cadastro
  existente). O portal procura pelo `user_id`, então aquele cliente nunca vê
  aquela fatura, e nenhum log acusa nada. O diagnóstico procura irmãos por
  `chaveDoNome` e por e-mail, e diz qual é o primeiro conserto.
  **O aviso no portal também deixou de falhar em silêncio**: `avisarNoPortal`
  devolve `{ ok, motivo }`. Quando o e-mail não sai, o portal é o único canal
  que resta — engolir a falha ali deixava o cliente sem aviso nenhum e ninguém
  sabendo.
  **`/api/avisos/diag`** (só o sócio) responde "por que o cliente não
  recebeu": diz se a chave existe, qual é o remetente e, com
  `?teste=email@dominio`, manda um e-mail de verdade e devolve a resposta
  literal do Resend. É o irmão de `/api/signatures/diag`, e existe pelo mesmo
  motivo. **O aviso no portal sai mesmo sem e-mail** — o cliente vê a fatura
  em Pagamentos ao entrar; o e-mail é o empurrão, não o único caminho.
- **Conferir-e-gravar em dois passos não vale sob concorrência — e isso é
  dinheiro.** Auditoria financeira, três travas que estavam no código e
  viraram regra do banco (`sql/recebimento-seguro-v1.sql`, roda **depois** de
  `status-da-fatura-v2`):
  **1. Estorno.** A rota gravava `payment_reversals` com o erro DESCARTADO
  (`.then(() => null, () => null)`) e só então apagava o recebimento: rastro
  que falha = dinheiro apagado sem registro, o oposto do princípio 2 — e o
  oposto do que `lib/estorno-stripe.ts`, o irmão dele, já fazia certo. E eram
  dois passos: dois estornos simultâneos do mesmo recebimento gravavam DOIS
  rastros. Agora é `estornar_recebimento`: o `delete … returning` trava a
  linha (o segundo recebe `ja_estornado`) e, se o rastro falhar, a transação
  volta atrás e **o recebimento fica**. Conferido no PG 16, inclusive o caso
  do rastro recusado.
  **2. Recebimento acima do saldo.** A rota confere `valor > saldo` antes de
  gravar. O Zelle digitado no balcão e o webhook do Stripe chegando juntos
  leem o mesmo saldo e os dois passam. O gatilho passa a recusar — só em
  INSERT/UPDATE, nunca em DELETE, senão uma fatura que já esteja com sobra não
  poderia nem ser estornada. A migração lista as faturas que já estejam assim.
  **3. Parcela sem piso.** O parcelamento aceitava de 2 a 36 parcelas sem
  olhar quanto dá cada uma: **$15 em 36× = $0,41**, e o Stripe recusa abaixo
  de US$ 0,50 — o plano nasceria e toda cobrança falharia para sempre; com
  saldo pequeno o `floor` chega a produzir parcela de **$0,00**. O cronograma
  saiu da rota para `lib/cronograma-parcelas.ts` (puro, com teste — a conta é
  dinheiro com arredondamento e não tinha nenhum) e a recusa diz o **número
  máximo de parcelas** para aquele saldo. 41 casos.
- **O relatório corta o período no dia do ESCRITÓRIO** (`janelaDaFirma` de
  `lib/dia-da-firma.ts`). Comparava `received_at` com `${to}T23:59:59Z` — UTC:
  o recebimento das 20h do último dia do mês caía no mês **seguinte**, e é o
  número em que o sócio decide. O fim é EXCLUSIVO (`.lt`), então nenhum
  instante fica de fora nem conta duas vezes na emenda de um mês com o outro.
  Os dois domingos de horário de verão estão nos testes (dia de 23 e de 25
  horas).
- **Excedente de transações: franquia MENSAL, apuração ANUAL, e o
  bookkeeping só CONTA** (`lib/excedente-transacoes.ts`, 30 casos em
  `testes/excedente-transacoes.mts`). `included_transactions` é POR MÊS
  (formulário e contrato dizem isso), e a rota de excedente e a central
  comparavam com a contagem do ANO: 100/mês contra 590 no ano dava "$612,50
  a cobrar" — e o botão **Cobrar excedente** lançava isso na assinatura do
  Stripe. O conserto existia desde setembro num ramo que nunca entrou
  (`af814e1`). Franquia = mensal × meses de vigência, da PRIMEIRA COBRANÇA
  (`ancoraDeCobranca`); a contagem se recorta pela vigência; no ano corrente
  vai até o mês corrente e sai marcada `parcial`. O POST e o botão saíram:
  cobrança é faturamento (princípio 1). A auditoria recusa o POST, o Stripe
  na rota, o botão na tela e a central voltar a usar o número mensal, e
  exige o módulo nas duas rotas.
- **Cada VERBO confere quem chama, não só o arquivo.** A auditoria olhava
  se o `route.ts` tinha `getAuth` em algum lugar: o POST de
  `/api/send-invite` tinha, o GET não — e o GET entregava a lista de
  convites, com o TOKEN que cria a conta, a qualquer cliente logado no
  portal. Agora cada `GET/POST/PUT/PATCH/DELETE` exportado precisa conferir
  no próprio corpo ou chamar uma função do mesmo arquivo que confere
  (seguida em cadeia), com os comentários retirados antes. A lista de
  convites também obedece ao escopo por tipo (`podeVerEmpresas`, para
  convite sem cadastro ligado).
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
- **Escolher o payee SUGERE a conta, não grava** (`lib/payee-contas.ts`,
  `/api/bookkeeping/payee-category`). Ao se escolher o payee numa linha sem
  conta, o sistema pegava a conta do último lançamento dele e aplicava
  sozinho. Funciona para o fornecedor que sempre cai na mesma conta e **erra
  sempre** para o que não cai — há cliente com o mesmo payee em contas
  diferentes (material numa, serviço noutra, combustível noutra). Pior: a
  última, sozinha, **esconde** que existem outras, e quem lança não tem como
  saber que precisa pensar. Agora a rota devolve TODAS as contas já usadas,
  ordenadas da mais recente para a mais antiga, com quantas vezes cada uma —
  e `variado` avisa quando é mais de uma. A tela mostra e não grava; um
  clique aceita e vai para `auto` (🔵 Reconhecidas, aguardando aprovação),
  nunca direto ao registro. É o caminho MANUAL, o do cheque, em que só vêm
  número e valor: **o automático (regra e IA na importação) não passa por
  aqui e não muda.** A rota e a tela chamam `historicoDoPayee`, a mesma
  contagem. O `ilike` do payee escapa o curinga (um payee "100%" casaria com
  tudo que começa em 100) e a consulta que falha vira erro, não "payee sem
  histórico" — dizer que não há sugestão quando há faz escolher no escuro.
  30 casos em `testes/payee-contas.mts`.
  A sugestão é uma **faixa** abaixo do campo, nunca um painel: o quadro de
  250×260 da primeira versão levava a linha de 40 a 330px e o `<select>`,
  centralizado nessa altura, subia para junto da linha DE CIMA — quem lança
  perdia de vista onde se escolhe a conta. Daí a regra: **célula que pode
  crescer pede `verticalAlign: 'top'` na linha inteira**, senão o campo foge
  do lugar. A faixa tem ✕ para fechar, e o campo da conta continua sendo o
  `<select>`, que tem todas as contas e o "➕ Criar nova categoria…".
- **Lista flutuante se posiciona por conta, não na mão** (`lib/lista-flutuante.ts`,
  `posicionarLista`). O autocomplete do payee punha a lista SEMPRE abaixo do
  campo (`top: r.bottom + 4`), com `position: fixed` e `maxHeight` fixo. Na
  **última linha** da tabela ela nascia fora da janela — e `fixed` fica preso
  à JANELA, então **rolar não traz de volta**: quem lança o cheque vê a
  sugestão pela metade, sem alcance. `fixed` é necessário (a célula tem
  `overflow` e recortaria filho posicionado), e o preço é que não sair da
  janela passa a ser conta nossa. Agora: ABAIXO é o padrão — é onde o olho
  procura —, e só vira para CIMA quando embaixo não cabe a altura pedida **e**
  em cima cabe mais (trocar de lado por qualquer sobra faria a lista pular
  enquanto se digita); a altura é limitada ao espaço real do lado escolhido,
  com piso para não virar fresta ilegível; o recuo é limitado nas duas bordas,
  senão é o mesmo defeito na horizontal. E ela se **reposiciona na rolagem**
  (`scroll` com `capture`, para pegar container interno) — sem isso ela fica
  parada enquanto a tabela rola por baixo. 28 casos em
  `testes/lista-flutuante.mts`, incluindo uma varredura do campo por toda a
  altura da janela. A auditoria recusa `\w+.bottom + N` em arquivo que use
  `getBoundingClientRect` sem passar por `posicionarLista`.
- **Linha de tabela não carrega lista grande — o custo é o PRODUTO.** A tela
  Listas → Fornecedores e clientes derrubava a aba do navegador
  (`RESULT_CODE_HUNG`, o Chrome matando o renderizador): cada linha montava um
  `<select>` com TODOS os clientes da firma. Medido em Chromium: **22,7 ms por
  mil `<option>`**, linear. São quase mil clientes e o cadastro de
  fornecedores passa dos milhares — 500 linhas já são 532 mil `<option>` e
  **~12 s** de thread principal travada; 2.000 linhas, ~48 s. O Chrome mata a
  aba muito antes. Filtrar não salvava: quem abre a tela vê tudo ANTES de
  filtrar. Duas travas, e as duas precisam existir, senão o defeito volta pelo
  outro caminho: **o seletor pesado só nasce na linha em edição** (trocar
  escopo é raro e já pede confirmação — manter mil opções em cada linha para
  um clique por mês foi o que custou a aba) e **a tabela desenha `POR_PAGINA`
  linhas por vez**, com o teto no DESENHO, nunca na busca nem na contagem.
  Depois: 161 ms. Fechar o editor no `blur` tem de ESPERAR (200 ms, o mesmo do
  autocomplete do payee): em celular o `change` às vezes chega depois do blur,
  e desmontar antes perde a escolha em silêncio.
  **Não há invariante de auditoria para isto, e é decisão, não esquecimento:**
  a forma do código corrigido — o `.map` de `<option>` dentro do `.map` da
  linha, agora sob `editandoEscopo === p.id` — é a MESMA do defeito. Uma
  conferência estrutural acusaria o conserto, e invariante que reprova código
  certo ensina a cadastrar exceção. A regra fica escrita; a conta é
  `linhas × opções`, e acima de ~50 mil `<option>` num render a aba congela.
  **Dívida medida e aberta**: `components/BookkeepingTab.tsx` tem a mesma
  forma na linha do lançamento (conta contábil + contas bancárias, ~60-80
  `<option>` por linha, até 8.000 linhas = ~560 mil, ~12 s). Não foi mexida
  junto porque é a mesa de trabalho diária e paginar ali mexe no "selecionar
  tudo" e nas ações em lote — é decisão do sócio, não conserto de passagem.
- **A escolha da regra do payee é uma só, o caminho até ela é que mudou.**
  `regraDoPayee` era chamada DENTRO do laço dos fornecedores e varria a lista
  inteira de regras a cada volta: com o teto de 5.000 dos dois lados são 25
  milhões de comparações, cada uma com `trim`/`toLowerCase`, só para abrir
  Listas → Fornecedores. `indexarRegras` monta o índice uma vez e
  `regraNoIndice` faz a MESMA escolha (a regra do próprio cliente ganha da
  geral) numa consulta. `regraDoPayee` continua existindo e delega — duas
  telas nunca devem decidir a mesma coisa de jeitos diferentes.
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
- **Consulta de faturas além do dia** (`lib/escopo-faturas.ts`,
  `/api/billing/consulta`), três pontos para o sócio decidir:
  **(a)** o assistente digita **e-mail e senha do gerente** na máquina dele —
  o mesmo modelo que o recebimento ABANDONOU pelo código ditado
  (`lib/codigo-autorizacao.ts`): senha de terceiro em máquina alheia e o
  limite de login do Supabase por IP na temporada. **(b)** uma liberação
  abre a carteira INTEIRA por 30 minutos — qualquer período, qualquer
  emissor —; o `pedido` é gravado, mas não restringe nada. **(c)** o rastro
  é da LIBERAÇÃO, não da consulta: não fica registrado o que foi visto, e
  quem tem `verTodasFaturas` não deixa linha nenhuma. Também: pelo `?id=`
  a pessoa abre fatura PRÓPRIA de qualquer dia, sem autorização — a lista
  e o id não aplicam o mesmo corte de data.

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
  **Do celular (ou de qualquer lugar), a migração roda pelo GitHub:**
  Actions → *Migrações do banco* → Run workflow, com `acao = listar` (só
  mostra) ou `acao = aplicar`. Nunca roda sozinho no push: migração é ato
  consciente, como enviar documento ao cliente.
  **São DOIS caminhos de credencial, e basta um** (`escolherExecutor` em
  `migrar.mjs`). O recomendado é o **token**: `SUPABASE_ACCESS_TOKEN` +
  `SUPABASE_PROJECT_REF`, que vai pela API de gestão por HTTPS e não tem
  cadeia para digitar errado, senha para escapar nem IPv6 para dar
  `network unreachable` — os três defeitos que já custaram tempo aqui. O
  token tem de ser **escopado** (começa com `sbp_fc`), com a permissão
  **Database** em **Read-write** (é ela que libera o endpoint *Run a query*,
  que é o que `viaApi` chama) e **escopado a ESTE projeto**; token clássico
  carrega a conta inteira, toda organização e todo projeto, inclusive os
  criados depois. **Token expira**: no dia da data o job para, sem aviso
  antes. O outro caminho é `SUPABASE_DB_URL` com a cadeia do **Session
  pooler** — o runner do GitHub só tem IPv4 e a conexão direta de muitos
  projetos hoje é só IPv6.
  **Com os dois definidos o psql VENCE e o token nem é tentado** — quem
  acabou de criar um token e vê o job falhar na cadeia antiga não tem como
  adivinhar isso, então `--credencial` diz em voz alta qual vai ser usado.
  Para ir pela API, apague o secret `SUPABASE_DB_URL`.
  **Passo que roda `migrar.mjs` leva as QUATRO variáveis.** Esquecer uma não
  quebra: o passo troca de caminho no meio do job, ou fica sem credencial —
  `--pendentes` diria uma coisa e `aplicar` outra, aplicando migração em
  produção. A auditoria confere os quatro passos, e **âncora perdida é
  FALHA** (nenhum passo encontrado = não está conferindo nada). Ela tira os
  COMENTÁRIOS antes de casar: o cabeçalho do workflow explica o `migrar.mjs`,
  a explicação cai dentro do passo seguinte, e a primeira versão acusou dois
  "passos" que eram só comentário.
  **Por que NÃO é um botão dentro do sistema:** a ideia era uma tela em
  Settings chamando `aplicar_sql(text)` no banco. Isso é execução de SQL
  arbitrário exposta por HTTP — mesmo travada no `service_role` e mesmo
  recebendo só nome de arquivo, a FUNÇÃO é genérica e passa a existir para
  sempre. Num sistema com dado de imposto de quase mil pessoas, não vale o
  atalho. No GitHub a credencial fica em Secrets, é usada só pelo job e o
  sistema publicado não ganha porta nenhuma.
  **`SUPABASE_DB_URL` que não é URI faz o psql procurar um Postgres LOCAL.**
  A primeira execução do workflow falhou com
  `connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed`
  **com o secret gravado**: o psql aceita, no primeiro argumento, ou uma URI
  ou um NOME DE BANCO — e qualquer texto sem `postgresql://` ele entende como
  nome de banco. O erro fala de socket, o defeito é o formato do texto, e
  ninguém liga uma coisa à outra. E o texto errado é fácil de colar: o botão
  do Supabase copia a LINHA DE COMANDO inteira (`psql "postgresql://…"`).
  `scripts/credencial-postgres.mjs` limpa o que dá (o `psql` na frente,
  aspas, aspas curvas do teclado, espaços) e RECUSA o resto explicando;
  `--credencial` roda isso no passo da credencial do workflow, para o defeito
  aparecer onde se procura por ele. A mensagem **nunca imprime a cadeia, nem
  em pedaço**: isso vai para log de CI, `usuario:senha@host` põe a senha nos
  primeiros caracteres, e o GitHub só mascara o secret INTEIRO — um trecho
  passa limpo.
  **Senha com `@` (ou `#`, `?`, `/`, `%`) dentro da URI não funciona.**
  Conferido no PostgreSQL 16, com psql de verdade: o libpq corta no
  **PRIMEIRO** `@`, então `ab@cd` faz o servidor virar `cd@host` e o erro sai
  como `could not translate host name` — que não fala de senha nenhuma. E o
  `new URL` do Node corta no ÚLTIMO, ou seja, os dois discordam: não dá para
  usar o parser do Node como juiz. Duas saídas, as duas atendidas: codificar
  (`@`→`%40`, `:`→`%3A`, `/`→`%2F`, `?`→`%3F`, `#`→`%23`, `%`→`%25`) ou —
  melhor — o secret **`SUPABASE_DB_PASSWORD`** com a senha CRUA e a URI sem
  senha, que vai por `PGPASSWORD` e não passa por parser nenhum.
  **Exemplo que parece colável é colado.** A instrução trazia
  `postgresql://postgres.SEUREF:SENHA@…` como modelo e o modelo foi colado: o
  pooler respondeu `FATAL: (ENOTFOUND) tenant/user postgres.SEUREF not
  found` — exato e inútil para quem não vive nisso, e só depois de uma
  viagem ao servidor. Agora texto de exemplo (`SEUREF`, `SENHA`, `<…>`,
  `[…]`) é recusado ANTES de conectar, e `pistaDoErroDoPsql` traduz as
  recusas do servidor (usuário, senha, IPv6, host, banco) para o que se faz
  a respeito. A trava do exemplo fica **antes** do atalho da senha separada:
  a primeira versão ficou depois e não rodava justamente no caminho
  recomendado — a auditoria confere a ORDEM, não a presença.
  **Cadeia de OUTRO projeto Supabase é recusada.** Apareceram duas na mesma
  semana (dois projetos do mesmo dono); a errada só não passou porque o
  usuário ainda era texto de exemplo. Migração no banco errado **não tem
  desfazer**: cria as tabelas num projeto que ninguém olha e deixa o certo
  sem elas. `conferirProjeto` compara o ref da cadeia (`postgres.<ref>` no
  pooler, `db.<ref>.supabase.co` na direta) com o de
  `NEXT_PUBLIC_SUPABASE_URL` em **`.env.example`** — que está versionado e
  não é segredo, só diz QUAL projeto é o desta aplicação. Sem base de
  comparação não se inventa recusa, e `MIGRAR_OUTRO_PROJETO=1` libera de
  propósito (cópia de teste). **A trava vale nos DOIS caminhos**: a primeira
  versão só cobria o psql, e pela API de gestão um `SUPABASE_PROJECT_REF` de
  outro projeto passava direto — meia trava é pior que nenhuma, porque quem
  confia nela para de conferir. 64 casos em `testes/credencial-postgres.mts`.
  **`new URL(...).pathname` não vira caminho de arquivo no Windows.** Ele
  devolve `/C:/Users/…` — com a barra na frente — e o `join` monta
  `C:\C:\Users\…`; o erro real foi
  `ENOENT: scandir 'C:\C:\…\sql'`. Nunca apareceu antes porque o script só
  tinha rodado em Linux (este container e o runner do GitHub). O conversor
  correto é `fileURLToPath`, e a auditoria recusa o padrão antigo —
  procurando a EXPRESSÃO no código, não a palavra no arquivo: a primeira
  versão dispensava quem mencionasse `fileURLToPath` em qualquer lugar, e o
  próprio comentário que explica o defeito menciona.
  **`process.exit` com conexão HTTP aberta aborta o Node no Windows**
  (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`):
  o diagnóstico aparece e o usuário leva um crash em cima. Onde já houve
  rede, marca-se `process.exitCode` e deixa-se o Node fechar o que abriu — o
  código de saída continua 1, que é o que o workflow lê.
  **Uma armadilha de regex que já custou três invariantes nesta sessão:**
  `[^)]*` NÃO atravessa o parêntese de um argumento como `(e.message || e)`
  ou `(l: any)`, então o padrão nunca casa e a invariante passa sempre. Use
  `[\s\S]{0,N}?`. Invariante nova só vale depois de falhar com o defeito
  reintroduzido.
  **A ordem de aplicação é DECLARADA, não alfabética**
  (`scripts/ordem-das-migracoes.mjs`, `DEPENDE_DE`). `readdirSync().sort()`
  parecia inofensivo e está **invertido em dois casos reais**:
  `codigo-de-autorizacao-funcao-v1` vinha antes de `codigo-de-autorizacao-v1`
  (`'f' < 'v'` — a FUNÇÃO antes da TABELA que ela consome) e
  `recebimento-seguro-v1` antes de `status-da-fatura-v2` (`'r' < 's'`, e o
  cabeçalho do próprio arquivo diz que roda depois). Enquanto as duas
  estavam aplicadas ninguém viu; voltaram a aparecer juntas como PENDENTE e
  `aplicar` rodaria na ordem errada. A ordenação é **estável** (quem não
  depende de ninguém não embaralha) e **recusa** quando a dependência não
  está aplicada nem na lista — ela pode estar em "MUDOU DEPOIS DE APLICADO",
  que fica fora do automático de propósito, e aplicar a dependente torcendo
  é o erro que isto existe para impedir. Ciclo na declaração **acusa** em vez
  de travar. Dependência é declarada, nunca adivinhada lendo o SQL: errar
  para o lado de "achei que não dependia" é o defeito original. 24 casos em
  `testes/ordem-das-migracoes.mts`; a auditoria recusa declaração que aponte
  para arquivo inexistente (some em silêncio num rename e a ordem volta à
  alfabética) e recusa o mapa vazio.
  **O livro tem três jeitos de estar torto, e os três faziam migração
  APLICADA parecer NUNCA APLICADA** — o lado que leva a rodar de novo em
  produção (`scripts/livro-de-migracoes.mjs`, puro e com teste). O leitor
  exigia `[0-9a-f]{64}`, então **linha com sha em branco sumia do mapa** e
  era anunciada como PENDENTE (`sql/permissoes-por-pessoa-v3.sql`, no banco
  real). E **nome curto ficava invisível**: a chave é o CAMINHO, quatro
  linhas foram gravadas como `x.sql`, ninguém consulta por essa chave, e as
  quatro apareciam como PENDENTE. Agora são estados próprios —
  `REGISTRO SEM SHA` e `REGISTRADA COM NOME CURTO` —, ficam **fora do
  automático** (o arquivo muito provavelmente já está no banco; reaplicar é
  o risco, esperar não é) e o relato imprime **o `update` que arruma cada
  linha**. O conserto do nome curto **renomeia e só**: a primeira versão
  gravava o sha atual junto, e isso APAGA um sinal verdadeiro —
  `permissoes-por-pessoa-v1` está no livro com `90a85f0af77f` e no disco com
  `0bfe8dd357b4`, porque o arquivo foi editado **seis dias depois** de
  aplicado; sobrescrever viraria um "ok" falso. Mantendo o sha gravado, o
  próximo `--pendentes` diz a verdade e quem decide é gente. No sha vazio não
  há o que preservar, então preencher é uma **afirmação** ("o que está no
  repositório é o que rodou") — confira a data do arquivo contra a de
  aplicação antes de colar. É a regra da casa outra vez: linha malformada não pode virar
  "não existe", como consulta que falha não pode virar lista vazia.
  `--pendentes --so-nomes` devolve só os caminhos, para o workflow consumir;
  ele lista apenas **PENDENTE**.
  **E sai NUA: diagnóstico vai para o stderr.** O workflow faz
  `PENDENTES=$(… --so-nomes)` e passa CADA LINHA adiante como nome de
  arquivo — `Conexão: psql` ia por `console.log` e viraria duas "migrações"
  inexistentes. Nunca apareceu porque o `aplicar` automático nunca tinha
  chegado ao fim; o defeito esperava o primeiro clique no botão. A auditoria
  recusa a linha por `console.log`, e **âncora perdida é FALHA**.
  Corolário do mesmo caso: **relato antes de recusa**. A recusa por
  dependência sai com `exit(3)`, e na primeira versão ela engolia justamente
  o `update` que a pessoa precisava para decidir. "MUDOU DEPOIS DE APLICADO" (arquivo editado
  depois de rodar — aconteceu com a conferência da `permissoes-por-pessoa-v1`)
  aparece no relato e fica FORA do automático: pode ser inofensivo, pode não
  ser, e quem decide é gente.
  **Sem psql e sem token, sobra o SQL Editor — e aí vai UM arquivo só.**
  `scripts/juntar-para-colar.mjs` gera
  `colar-no-sql-editor/caixa-completo.sql`: as migrações na ORDEM, a RLS do
  livro ligada pelo próprio arquivo (senão o detector do SQL Editor
  reescreve) e, no fim, o `insert` em `schema_migrations` com o **mesmo
  sha256** que `migrar.mjs` calcula — sem isso a migração aplicada à mão fica
  PENDENTE para sempre e alguém roda de novo. O arquivo fica **fora de
  `sql/`**, senão viraria mais uma migração pendente. É uma CÓPIA, e cópia
  que envelhece em silêncio é pior que cópia nenhuma: a auditoria regera em
  memória e compara — **todo** arquivo de `colar-no-sql-editor/` que traga
  a marca do gerador, a partir da linha `-- Origem:` dele (antes só o do
  caixa, com a lista escrita à mão; o segundo pacote chegou a ser commitado
  com a mensagem dizendo que a auditoria o conferia, e ela não conferia), e
  confere também a ORDEM dentro dele contra `DEPENDE_DE`. Sem nenhum pacote
  gerado, ou pacote sem `-- Origem:`, é FALHA: âncora perdida.
  **Pacote de migrações não mora em `sql/`.** `pendentes-parte-2.sql`
  embalava SEIS migrações (`status-da-fatura-v2`, `permissoes-por-pessoa-v4`,
  `pricing-items-ativo-v1`, `codigo-de-autorizacao-funcao-v1`,
  `recebimento-seguro-v1`, `rls-tabelas-expostas-v1`) para colar de uma vez.
  Dentro de `sql/` isso vira mais uma PENDENTE no livro **e** faz o `aplicar`
  rodar o pacote E as seis individuais. Mesma razão pela qual
  `colar-no-sql-editor/` fica fora de `sql/`; foi para lá. A auditoria conta
  **cabeçalho embutido**, não menção: quantas outras migrações têm a primeira
  linha delas (`-- sql/x.sql`) dentro deste arquivo. A primeira versão contava
  menções e deu falso positivo — `rls-tabelas-expostas-v1` cita três irmãs em
  comentário e é legítima. Pelo cabeçalho: o pacote marca 7, a maior legítima
  marca 1. Sem cabeçalho padronizado, **falha** em vez de passar.
  **O SQL Editor do Supabase reescreve o script — e a causa não é a que
  parecia.** Ele tem um detector de "tabela criada sem RLS" e, quando acha
  uma, reescreve o script para acrescentar `enable row level security`. Esse
  detector é de SQL puro: **uma consulta que atribui a uma variável de
  plpgsql (`select … into <var>`) é lida como o `SELECT … INTO <tabela>`**, e
  ele conclui que a migração criou uma tabela com o nome da VARIÁVEL. Ao
  reescrever, corta um bloco no meio e o erro que sai é `unterminated
  dollar-quoted string` numa linha sem defeito nenhum. Ele mostra o que
  inventou: `ALTER TABLE achado`, `ALTER TABLE t`, `ALTER TABLE i`… — os
  nomes das variáveis. Por isso, **arquivo que cria tabela: (a) liga a RLS
  ele mesmo, para o detector não ter o que acrescentar; (b) não atribui
  variável por consulta — subconsulta dentro do `if` resolve; (c) não define
  função, que vai para arquivo próprio.** É o caso de
  `sql/codigo-de-autorizacao-v1.sql` (a tabela) e
  `sql/codigo-de-autorizacao-funcao-v1.sql` (o consumo), nessa ordem. A
  auditoria recusa as três coisas.
  A teoria anterior — de que o problema era a tag nomeada (`$function$`) —
  **estava errada**: o arquivo quebrou de novo usando só `$$`. E fica um
  ponto sem explicação: `sql/permissoes-por-pessoa-v1.sql` e
  `sql/whatsapp-atendimento-v1.sql` têm as duas coisas e rodaram. O mais
  provável é que o aviso de RLS daquelas vezes não tenha sido aceito — a
  reescrita depende de um clique. Como o clique não está na nossa mão, é o
  arquivo que não pode dar margem: a conferência da `permissoes-v1` foi
  reescrita sem atribuição (a migração já aplicada não mudou o que FAZ), e a
  `whatsapp-v1` é exceção nomeada na auditoria porque ali a variável é
  necessária — ela monta SQL dinâmico.
