#!/usr/bin/env node
// scripts/acerto-recebimento-setembro.mjs
//
// Acerta o que sobrou das duas faturas de setembro recuperadas por reenvio de
// evento (INV-2026-0011 e INV-2026-0012).
//
// O arquivo sql/acerto-faturas-recuperadas-v1.sql prometia dois acertos no
// cabeçalho mas só fazia um: corrigiu `issue_date` na fatura e deixou o
// recebimento intacto. Ficaram de fora:
//
//   reference    nulo  -> o PaymentIntent que quitou a cobrança
//   received_at  14/09 -> a data em que o Stripe realmente recebeu
//
// Por que script e não migração: os dois valores certos não existem no nosso
// banco -- `stripe_object` guarda o id da INVOICE do Stripe (in_...), não o do
// PaymentIntent (pi_...). SQL nenhum consegue derivá-los. Este script busca os
// valores reais na API do Stripe e grava o que voltou. Nada é adivinhado: se o
// Stripe não devolver o PaymentIntent, a fatura é pulada e reportada.
//
//   node scripts/acerto-recebimento-setembro.mjs            só mostra (padrão)
//   node scripts/acerto-recebimento-setembro.mjs --aplicar  grava
//
// Precisa no ambiente: STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL e
// SUPABASE_SERVICE_KEY (ou SUPABASE_SERVICE_ROLE_KEY).
//
// Idempotente: o que já está certo é pulado. Cada alteração fica em
// invoice_audit, com o estado anterior e o motivo.

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const FATURAS = ['INV-2026-0011', 'INV-2026-0012']
const MOTIVO  = 'Acerto das faturas recuperadas por reenvio de evento em 14/09: '
              + 'reference e received_at haviam saído da data do processamento, '
              + 'não da data do fato. Valores buscados na API do Stripe.'

const aplicar = process.argv.includes('--aplicar')

const precisa = (nome, ...alt) => {
  for (const n of [nome, ...alt]) if (process.env[n]) return process.env[n]
  console.error(`Falta a variável de ambiente ${nome}.`)
  process.exit(2)
}

const stripe = new Stripe(precisa('STRIPE_SECRET_KEY'), { apiVersion: '2026-06-24.dahlia' })
const db = createClient(
  precisa('NEXT_PUBLIC_SUPABASE_URL'),
  precisa('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
)

const id = (v) => (typeof v === 'string' ? v : v?.id) || null

// Mesma regra de lib/stripe-invoice.ts: o intent vem direto ou por dentro de
// `payments`, e só numa invoice buscada com expand.
const intentDaInvoice = (inv) => {
  const direto = id(inv?.payment_intent)
  if (direto) return direto
  for (const p of (inv?.payments?.data || [])) {
    const pi = id(p?.payment?.payment_intent)
    if (pi) return pi
  }
  return null
}

// O Stripe aceita no MÁXIMO 4 níveis de expand -- pedir cinco derruba a
// chamada inteira, e foi exatamente o que fez o reference sumir na primeira
// vez. Quatro níveis trazem o intent.
async function invoiceComPagamentos(invId) {
  for (const expand of [['payments.data.payment.payment_intent'], ['payments']]) {
    try {
      return await stripe.invoices.retrieve(invId, { expand })
    } catch (e) {
      console.error(`    expand ${expand[0]} falhou: ${e.message}`)
    }
  }
  return null
}

async function main() {
  console.log(aplicar ? 'MODO: gravando\n' : 'MODO: só conferindo (use --aplicar para gravar)\n')

  for (const numero of FATURAS) {
    console.log(`── ${numero}`)

    const { data: fatura } = await db.from('invoices').select('id, number').eq('number', numero).maybeSingle()
    if (!fatura) { console.log('    fatura não encontrada — pulada'); continue }

    const { data: pagamentos } = await db.from('invoice_payments')
      .select('id, amount, method, reference, received_at, stripe_object')
      .eq('invoice_id', fatura.id)

    if (!pagamentos?.length) { console.log('    sem recebimento lançado — pulada'); continue }

    for (const pag of pagamentos) {
      if (!pag.stripe_object?.startsWith('in_')) {
        console.log(`    recebimento ${pag.id}: stripe_object não é invoice do Stripe — pulado`)
        continue
      }

      const inv = await invoiceComPagamentos(pag.stripe_object)
      if (!inv) { console.log('    Stripe não devolveu a invoice — pulado'); continue }

      const intent = intentDaInvoice(inv)
      // Quando o Stripe marcou a invoice como paga: é a data do fato.
      const pagoEm = inv?.status_transitions?.paid_at
        ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
        : null

      const patch = {}
      if (!pag.reference && intent) patch.reference = intent
      if (pagoEm && pag.received_at !== pagoEm) patch.received_at = pagoEm

      if (!intent) console.log('    Stripe não trouxe o PaymentIntent — reference fica como está')
      if (!pagoEm) console.log('    Stripe não trouxe status_transitions.paid_at — received_at fica como está')

      if (Object.keys(patch).length === 0) { console.log('    já está certo — nada a fazer'); continue }

      console.log(`    reference   ${pag.reference ?? 'nulo'} -> ${patch.reference ?? '(mantém)'}`)
      console.log(`    received_at ${String(pag.received_at).slice(0,10)} -> ${patch.received_at ? patch.received_at.slice(0,10) : '(mantém)'}`)

      if (!aplicar) continue

      const { error } = await db.from('invoice_payments').update(patch).eq('id', pag.id)
      if (error) { console.error(`    FALHOU: ${error.message}`); process.exitCode = 1; continue }

      await db.from('invoice_audit').insert({
        invoice_id: fatura.id,
        action:     'recebimento_acertado',
        reason:     MOTIVO,
        previous:   { reference: pag.reference, received_at: pag.received_at },
        next:       { ...patch },
      })
      console.log('    gravado e anotado em invoice_audit')
    }
  }
  console.log('\nConcluído.')
}

main().catch(e => { console.error(e.message || e); process.exit(1) })
