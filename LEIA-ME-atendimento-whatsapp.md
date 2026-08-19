# Atendimento (WhatsApp) — v1

Tela de atendimento, webhook de recebimento e bot. Sócio e gerente apenas.

## O que vem no pacote

```
sql/whatsapp-atendimento-v1.sql          complementa o banco que já existe
lib/wa.ts                                telefone, janela de 24h, assinatura, envio Twilio
lib/wa-auth.ts                           quem pode entrar (sócio/gerente), conferido no servidor
lib/wa-bot.ts                            o bot que atende primeiro
lib/wa-browser.ts                        cliente Supabase do navegador (instância única)
app/api/whatsapp/webhook/route.ts        recebe as mensagens do cliente
app/api/whatsapp/status/route.ts         recibos de entrega
app/api/whatsapp/conversations/route.ts  a fila
app/api/whatsapp/messages/route.ts       a conversa + contexto do cliente
app/api/whatsapp/send/route.ts           a equipe responde
app/api/whatsapp/assign/route.ts         assumir, resolver, devolver ao bot, vincular cliente
app/dashboard/atendimento/page.tsx       a tela
components/AtendimentoResumo.tsx         bloco do painel da equipe
```

Nenhum arquivo existente é sobrescrito — o ZIP só acrescenta.

---

## 1. Ordem de instalação

**1º — SQL.** Rode `sql/whatsapp-atendimento-v1.sql` no Supabase.
Ele é idempotente: pode rodar de novo sem quebrar. No fim aparece uma
conferência — os cinco itens têm de vir com contagem ≥ 1.

**2º — Arquivos.** Descompacte o ZIP por cima do projeto:

```powershell
Expand-Archive -LiteralPath "$HOME\Downloads\whatsapp-atendimento-v1.zip" -DestinationPath "C:\Users\PeaceonTax\OneDrive - Peace on Tax\Confidencial-David\Peace on Tax\Portal\Documents Github\peaceontax\peaceontax-portal" -Force
```

**3º — Variáveis no Vercel** (Production e Preview):

| Variável | Valor |
|---|---|
| `TWILIO_ACCOUNT_SID` | `AC096e…` (já existe) |
| `TWILIO_AUTH_TOKEN` | já existe |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+14155238886` no teste · `whatsapp:+16178999461` depois da migração |
| `TWILIO_WEBHOOK_BASE_URL` | `https://peaceontax-portal.vercel.app` |
| `WA_BOT_NIVEL` | `publico` (padrão) ou `status` — veja o item 4 |

`TWILIO_WEBHOOK_BASE_URL` não é enfeite: a assinatura da Twilio é
calculada sobre a URL exata que ela chamou. Sem essa variável, o
proxy do Vercel pode fazer o cálculo bater em `localhost` e **todo
webhook cai em 403**.

**4º — Twilio.** No Messaging Service (ou no Sandbox), aponte:
- *When a message comes in* → `https://…/api/whatsapp/webhook` (POST)
- *Status callback* → `https://…/api/whatsapp/status` (POST)

**5º — Commit.**

```powershell
git add .
git commit -m "Atendimento WhatsApp v1: webhook, bot, tela e travas"
git push
```

---

## 2. Teste HOJE, sem migrar o 617

Este é o ponto que garante a ordem que você definiu. A migração do
617 é irreversível no curto prazo — testar antes não é zelo, é a
única forma de saber que a tela funciona.

1. No console Twilio: **Messaging → Try it out → WhatsApp Sandbox**
2. Do seu celular, mande a palavra de ativação para o número do sandbox
3. Escreva "oi" — o bot responde e a conversa aparece na tela
4. Escreva "quanto ficou minha declaração" — o bot **não responde o valor**, escala para a fila
5. Responda pela tela e confira que no seu celular chega **sem o seu nome**

Só depois disso a migração do 617 faz sentido.

**Na migração, um detalhe que não está no código:** o nome que o
cliente vê é o **perfil comercial do WhatsApp**. Ele precisa estar
gravado como *Peace on Tax* no Twilio (Senders → WhatsApp → Business
Profile). Se ficar em branco, o cliente vê só o número.

---

## 3. Menu

O item precisa entrar nos **quatro layouts** que duplicam o menu hoje
(a auditoria já apontou essa duplicação). Cole junto dos outros itens:

```tsx
{/* só sócio e gerente — a rota recusa os demais de qualquer forma */}
<Link href="/dashboard/atendimento">💬 Atendimento</Link>
```

E no painel da equipe:

```tsx
import AtendimentoResumo from '@/components/AtendimentoResumo'
// dentro da grade de blocos:
<AtendimentoResumo />
```

Se você me mandar os quatro arquivos de layout, eu devolvo os quatro
já editados — assim o menu não fica certo em três lugares e errado no
quarto.

---

## 4. Decisão que está esperando você: o que o bot pode contar

Número de telefone **não é senha**. Quem escreve pode ser o cliente,
o filho dele, alguém com o chip antigo ou um número reciclado. É a
mesma razão pela qual o assistente não vê esta tela.

Por isso o bot saiu no nível **`publico`**:

| Pergunta | Resposta do bot |
|---|---|
| horário, endereço, como mandar documento, portal | responde |
| valor, prazo, restituição, IRS, carta, imposto | **não responde** — manda para o portal e escala |
| "quero falar com atendente" | escala na hora |
| não reconheceu | escala |

Se você quiser que ele confirme a **etapa** do processo (só a etapa —
nunca valor, nunca documento) para telefones que batem com um
cadastro, mude `WA_BOT_NIVEL` para `status`. É uma variável, sem
mexer em código.

Minha recomendação é começar em `publico` na primeira semana e olhar
o que os clientes realmente perguntam. Aí a gente amplia com dado, não
com palpite.

---

## 5. O que mudei na base que já estava no banco (e por quê)

| Mudança | Motivo |
|---|---|
| Coluna `canal` em conversations e messages; índice único virou `(phone, canal)` | O 617 vai para WhatsApp e o 857 fica com SMS. Sem o canal, o mesmo cliente falando pelos dois vira **uma conversa só**, com histórico embaralhado — e a janela de 24h do WhatsApp seria aplicada a SMS, que não tem essa regra |
| Bucket privado `whatsapp-media` | O link de mídia da Twilio exige autenticação e expira. Guardando só ele, a foto do W-2 some da tela. Agora o arquivo é baixado e aberto por link assinado de 1 hora |
| `assumida_em` / `resolvida_em` + view `wa_relatorio_atendimento` | Base do relatório que você pediu: conversas por atendente, tempo de resposta, quantas o bot resolveu |
| Tabela `wa_templates` | Fora da janela de 24h, texto livre é recusado pela Meta. Enquanto a tabela estiver vazia, a tela **bloqueia** o envio em vez de fingir que enviou |
| RLS ligada e **sem policy**, com `revoke` para anon/authenticated | Nenhum navegador lê essas tabelas direto. Todo acesso passa pelas rotas, que conferem sócio/gerente. Efeito colateral aceito: Realtime não funciona, então a tela atualiza a cada 8 segundos |
| Validação de `X-Twilio-Signature` no webhook | Sem ela, qualquer pessoa na internet insere mensagem falsa na conversa de um cliente — e faz o bot responder a ela |
| Dedupe por `twilio_sid` antes de processar | A Twilio reenvia quando não recebe 200. Sem isso, o cliente recebe a resposta do bot duas vezes |
| O webhook **nunca** devolve erro para a Twilio | Erro faz a Twilio reenviar, o que duplicaria a mensagem. Falha vai para o log do Vercel |

---

## 6. O que **não** está pronto

- **Relatório de atendimento** (a view existe, a tela não) — próximo passo natural
- **Templates**: precisam ser aprovados na Meta antes de existir linha em `wa_templates`
- **Bot com IA**: v1 é determinístico de propósito. IA solta escrevendo para cliente sobre imposto é risco que não compensa nesta etapa
- **Encerramento automático** de conversa parada (hoje só sinaliza)

---

## 7. Premissas que usei — corrija se alguma estiver errada

1. `staff_roles` guarda o nível e dá para achar a pessoa por `user_id` **ou** por e-mail (a leitura é tolerante a ambos)
2. A tabela `clients` tem `id` e alguma coluna de telefone entre `phone`, `telefone`, `phone_number`, `celular`, `mobile`, `whatsapp` — o SQL avisa no console qual encontrou
3. A ficha do cliente abre em `/dashboard/clients/[id]` — se o caminho for outro, é uma linha na tela
4. A tela não importa `AppShell`: ela é autônoma, com botão de voltar. Foi opção deliberada — importar um componente cuja assinatura eu não vejo quebraria o build no Vercel, e você descobriria pelo celular

---

## 8. Antes de migrar o 617 — lista de conferência

- [ ] SQL rodou e a conferência voltou tudo ≥ 1
- [ ] Tela abre para você e para a Cristiane
- [ ] Tela recusa (403) para um login de assistente
- [ ] Sandbox: mensagem chega na fila em menos de 10 segundos
- [ ] Resposta pela tela chega no celular **sem nome de pessoa**
- [ ] Foto enviada pelo cliente abre pelo botão "Abrir anexo"
- [ ] Perfil comercial no Twilio gravado como *Peace on Tax*
- [ ] Pelo menos um template aprovado na Meta e cadastrado em `wa_templates`

O último item é o que mais dói se ficar para depois: sem template, um
cliente que escreveu ontem e não voltou hoje fica **inalcançável** até
ele mesmo mandar uma nova mensagem.
