// lib/wa-bot.ts — o bot que atende primeiro
//
// DECISÃO DE SEGURANÇA (leia antes de mudar):
// número de telefone NÃO é senha. Quem manda a mensagem pode ser
// o cliente, o filho dele, um chip clonado ou alguém que trocou de
// número. Por isso o bot, no nível padrão, responde só o que é
// público — e manda quem quer dado de conta para o portal, que tem
// login. É a mesma lógica que impede o assistente de ver esta tela.
//
// WA_BOT_NIVEL = 'publico' (padrão)  → só informação pública
// WA_BOT_NIVEL = 'status'            → se o telefone bater com UM
//   cliente, o bot confirma a etapa do processo. Nunca valores,
//   nunca documentos, nunca dados pessoais.

import type { SupabaseClient } from '@supabase/supabase-js'

export type RespostaBot = { texto: string | null; escalar: boolean; motivo: string }

const NIVEL = (process.env.WA_BOT_NIVEL || 'publico').toLowerCase()
const PORTAL = process.env.NEXT_PUBLIC_APP_URL || 'https://peaceontax.com'

const ASSINATURA = '' // o cliente já vê "Peace on Tax" no perfil; não assinamos por dentro

function limpar(t: string) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

function contem(t: string, palavras: string[]) {
  return palavras.some((p) => new RegExp(`(^|[^a-z0-9])${p}([^a-z0-9]|$)`, 'i').test(t))
}

const FAQ: { chave: string; gatilhos: string[]; resposta: string }[] = [
  {
    chave: 'saudacao',
    gatilhos: ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'hello', 'hi', 'hola'],
    resposta:
      'Olá! Aqui é a Peace on Tax. Posso ajudar com horário de atendimento, envio de documentos e acesso ao portal. ' +
      'Para falar com alguém da equipe, escreva *atendente*.',
  },
  {
    chave: 'horario',
    gatilhos: ['horario', 'horários', 'que horas', 'aberto', 'funciona', 'hours', 'open'],
    resposta:
      'Atendemos de segunda a sexta, das 9h às 18h. Fora desse horário você pode deixar a mensagem aqui — respondemos no próximo dia útil.',
  },
  {
    chave: 'endereco',
    gatilhos: ['endereco', 'onde fica', 'localizacao', 'address', 'where'],
    resposta:
      'Ficamos em Malden, MA. Telefone: 833-732-2327 · E-mail: info@peaceontax.com · Site: peaceontax.com',
  },
  {
    chave: 'documentos',
    gatilhos: ['documento', 'documentos', 'enviar', 'mandar', 'upload', 'w2', 'w-2', '1099', 'papelada'],
    resposta:
      `Os documentos entram pelo portal, na aba Documentos: ${PORTAL}. ` +
      'Lá eles ficam guardados por ano e a equipe é avisada na hora. Se preferir, mande por aqui que a equipe recebe.',
  },
  {
    chave: 'portal',
    gatilhos: ['portal', 'senha', 'login', 'acesso', 'entrar', 'password'],
    resposta:
      `O portal fica em ${PORTAL}. Se esqueceu a senha, use "Esqueci minha senha" — chega um código de 6 dígitos no seu e-mail.`,
  },
  {
    chave: 'agendar',
    gatilhos: ['agendar', 'marcar', 'reuniao', 'consulta', 'appointment', 'schedule'],
    resposta:
      'Posso pedir para a equipe entrar em contato para marcar. Me diga o melhor dia e período que eu encaminho.',
  },
]

const PEDE_HUMANO = [
  'atendente', 'humano', 'pessoa', 'falar com', 'alguem', 'alguém',
  'gerente', 'david', 'cristiane', 'reclamacao', 'urgente', 'human', 'agent',
]

const ASSUNTO_SENSIVEL = [
  'valor', 'quanto', 'preco', 'preço', 'pagar', 'pagamento', 'fatura', 'boleto',
  'restituicao', 'restituição', 'refund', 'irs', 'multa', 'divida', 'dívida',
  'ssn', 'itin', 'ein', 'auditoria', 'notificacao', 'notificação', 'carta',
  'prazo', 'imposto', 'declaracao', 'declaração',
]

export async function responderBot(args: {
  texto: string
  clientId: string | null
  db: SupabaseClient
}): Promise<RespostaBot> {
  const t = limpar(args.texto)

  if (!t) return { texto: null, escalar: true, motivo: 'mensagem sem texto (mídia)' }

  if (contem(t, PEDE_HUMANO)) {
    return {
      texto: 'Certo — já estou passando para a equipe. Alguém responde por aqui em instantes.',
      escalar: true,
      motivo: 'cliente pediu atendente',
    }
  }

  // Assunto que envolve dinheiro, prazo ou orientação fiscal vai
  // direto para gente. Errar aí custa caro.
  if (contem(t, ASSUNTO_SENSIVEL)) {
    if (NIVEL === 'status' && args.clientId) {
      const etapa = await etapaDoCliente(args.db, args.clientId)
      if (etapa) {
        return {
          texto:
            `Seu processo está em: *${etapa}*. Para ver os detalhes com segurança, entre no portal: ${PORTAL}. ` +
            'Já avisei a equipe para confirmar com você.',
          escalar: true,
          motivo: 'assunto sensível — status informado e escalado',
        }
      }
    }
    return {
      texto:
        `Essa é uma pergunta que a equipe precisa responder com o seu caso na tela. Já estou encaminhando. ` +
        `Enquanto isso, o seu histórico completo está no portal: ${PORTAL}`,
      escalar: true,
      motivo: 'assunto sensível',
    }
  }

  for (const item of FAQ) {
    if (contem(t, item.gatilhos)) {
      return { texto: item.resposta + ASSINATURA, escalar: false, motivo: `faq:${item.chave}` }
    }
  }

  return {
    texto:
      'Recebi sua mensagem e já encaminhei para a equipe. Alguém responde por aqui em breve. ' +
      'Se for urgente, ligue para 833-732-2327.',
    escalar: true,
    motivo: 'não reconhecido',
  }
}

/** Etapa do funil, tolerante ao nome da coluna. Nunca devolve valores. */
async function etapaDoCliente(db: SupabaseClient, clientId: string): Promise<string | null> {
  const { data } = await db.from('clients').select('*').eq('id', clientId).maybeSingle()
  if (!data) return null
  const c = data as any
  const bruto = c.stage ?? c.etapa ?? c.pipeline_stage ?? c.status ?? null
  return bruto ? String(bruto) : null
}
