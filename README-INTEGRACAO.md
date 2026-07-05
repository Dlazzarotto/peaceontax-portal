# PACOTE DE INTEGRAÇÃO — Fase 1 no ar
Corrige a segurança das APIs + entrega as telas. Estrutura já espelha a raiz
do portal (sem src/) — os comandos abaixo copiam direto no lugar certo.

## O que este pacote faz

1. **CORREÇÃO DE SEGURANÇA (crítica):** o middleware liberava toda /api/ sem
   login. Agora: só /api/invite, /api/agenda/slots e /api/agenda/bookings são
   públicas (prospects precisam agendar); todo o resto exige sessão. Além
   disso, as rotas da Fase 1 verificam DONO: staff acessa qualquer cliente,
   cliente só acessa o próprio (via clients.user_id).
2. Página pública **/agendar** — o link para anúncios e assinatura de e-mail
3. Página da equipe **/dashboard/agenda** — próximas reuniões + editor de
   disponibilidade (sem disponibilidade cadastrada, NENHUM horário aparece
   para os clientes — cadastrar é o primeiro passo após o deploy)
4. **/api/fase1/backfill** — carga única que cria as pastas para os clientes
   que você JÁ tem cadastrados (novos ganharão no fluxo normal)

## Conteúdo

```
middleware.ts                       ← SUBSTITUI o existente (backup antes!)
lib/api-auth.ts                     novo
app/api/fase1/apply-template/route.ts   ← substitui (agora com auth)
app/api/fase1/folders/route.ts          ← substitui (agora com auth)
app/api/fase1/classify/route.ts         ← substitui (agora com auth)
app/api/fase1/backfill/route.ts     novo
app/agendar/page.tsx                novo
app/dashboard/agenda/page.tsx       novo
```

## Instalação (PowerShell, na pasta do portal)

Backup do middleware atual (obrigatório):
```powershell
Copy-Item ".\middleware.ts" ".\middleware.ts.bak"
```

Copiar o pacote (ajuste o caminho se extraiu em outro lugar):
```powershell
Copy-Item "$env:USERPROFILE\Downloads\integracao-fase1\integracao\middleware.ts" -Destination ".\" -Force
Copy-Item "$env:USERPROFILE\Downloads\integracao-fase1\integracao\lib\*" -Destination ".\lib\" -Force
Copy-Item "$env:USERPROFILE\Downloads\integracao-fase1\integracao\app\*" -Destination ".\app\" -Recurse -Force
```

Subir:
```powershell
git add .
git commit -m "Integracao Fase 1: seguranca das APIs + telas de agenda"
git push
```

## Pós-deploy (nesta ordem)

1. **Testar a segurança:** abra uma janela anônima do navegador (sem login) e
   acesse `https://peaceontax-portal.vercel.app/api/fase1/folders?clientId=x`
   → deve responder `{"error":"Não autenticado"}`. Se responder isso, a
   correção está ativa.
2. **Cadastrar sua disponibilidade:** logado como equipe →
   /dashboard/agenda → adicionar seus horários → Salvar.
3. **Testar o agendamento como cliente:** janela anônima →
   /agendar → escolher tipo → dia → deve listar horários → concluir um
   agendamento de teste → conferir se apareceu em /dashboard/agenda.
   (Cancele o teste direto no Supabase: tabela bookings → status 'cancelled'.)
4. **Backfill das pastas:** logado como equipe, aperte F12 (console do
   navegador) e rode:
   `fetch('/api/fase1/backfill',{method:'POST'}).then(r=>r.json()).then(console.log)`
   → o retorno lista cliente por cliente o que foi criado.
5. **Regressão rápida do portal:** faça login como equipe e como um cliente
   de teste e navegue nas telas principais (dashboard, clients, portal,
   documents, messages). O middleware novo preserva o comportamento antigo,
   mas rotas de API internas que o portal chama por fetch continuam
   funcionando porque agora exigem a MESMA sessão que a página já tem.
   Se alguma tela der erro 401 inesperado, me mande o nome da tela.

## Tela de documentos (FolderTree + DocumentUpload)

Ficou de fora deste pacote de propósito: é a única integração que altera uma
página EXISTENTE do portal, e eu não vou sobrescrever às cegas uma tela que
não vi. Me envie o arquivo da página de documentos atual (provavelmente
app/documents/page.tsx ou similar — procure a pasta no Explorer) e eu devolvo
a versão integrada, mantendo tudo que já funciona.

## Observações

- O e-mail de confirmação de agendamento ainda não dispara (o ponto AUDITAR
  na rota de bookings). Como o portal já usa Resend, essa ligação entra no
  próximo pacote — por enquanto o cliente vê a confirmação na tela e pode
  baixar o .ics.
- Lembrete registrado: atualizar Node 20 → 24 no Vercel antes de 01/10/2026
  (portal e tools).
