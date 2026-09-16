#!/usr/bin/env node
// testes/rodar.mjs — roda os testes de lógica pura (npm run testes).
//
// Sem framework: cada arquivo .mts em testes/ é um programa que imprime
// "N passaram, M falharam" e sai com 1 se algo falhou. Aqui só se soma.
//
// O que entra aqui é regra que decide DINHEIRO e que não dá para conferir
// lendo: qual parcela o Stripe está cobrando, o que acontece quando uma forma
// de pagamento não está ativada na conta. O resto do sistema é coberto por
// `npm run auditoria`, que confere invariantes de código.

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = dirname(fileURLToPath(import.meta.url))
const arquivos = readdirSync(aqui).filter(f => f.endsWith('.mts')).sort()
let falhou = 0

for (const f of arquivos) {
  console.log(`\n\x1b[36m=== ${f} ===\x1b[0m`)
  const r = spawnSync(process.execPath, ['--experimental-strip-types', join(aqui, f)], {
    stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8',
  })
  // Os avisos de --experimental-strip-types poluem a saida; erro de verdade passa
  const erro = (r.stderr || '').split('\n')
    .filter(l => l.trim() && !/ExperimentalWarning|trace-warnings|Reparsing|eliminate this warning|^\(node:/.test(l))
    .join('\n')
  if (erro) console.error(erro)
  if (r.status !== 0) falhou++
}

console.log(falhou
  ? `\n\x1b[31m${falhou} arquivo(s) de teste falharam.\x1b[0m`
  : `\n\x1b[32mTestes concluidos sem falhas (${arquivos.length} arquivos).\x1b[0m`)
process.exit(falhou ? 1 : 0)
