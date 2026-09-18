// testes/codigo-autorizacao.mts — o codigo que libera UMA cobranca
//
// Decide dinheiro: e o que autoriza receber em especie. Um codigo, uma
// cobranca. O alfabeto sem caractere ambiguo importa porque o numero e
// DITADO — confundir O com 0 gasta a paciencia de quem tem cliente na frente.

import {
  ALFABETO, TAMANHO, MINUTOS_DE_VIDA, gerarCodigo, formatar, normalizar,
  formatoValido, segundosRestantes, relogio, RECUSA,
} from '../lib/codigo-autorizacao.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── O alfabeto nao pode ter caractere que se confunde ao ditar ──
for (const ambiguo of ['O', '0', 'I', '1', 'L', 'S', '5', 'Z', '2', 'B', '8'])
  eq(`alfabeto sem "${ambiguo}"`, ALFABETO.includes(ambiguo), false)
eq('alfabeto sem repetidos', new Set(ALFABETO).size, ALFABETO.length)
eq('alfabeto grande o suficiente', ALFABETO.length >= 20, true)
eq('oito caracteres', TAMANHO, 8)
eq('dez minutos de vida', MINUTOS_DE_VIDA, 10)

// ── Gerar ──
{
  const c = gerarCodigo()
  eq('o codigo tem o tamanho certo', c.length, TAMANHO)
  eq('todo caractere vem do alfabeto', [...c].every(x => ALFABETO.includes(x)), true)
  eq('o codigo gerado passa na validacao', formatoValido(c), true)
}
// Determinismo com aleatorio controlado: sempre o primeiro caractere
eq('aleatorio zerado da o primeiro caractere',
   gerarCodigo(() => 0), ALFABETO[0].repeat(TAMANHO))
// Mil codigos sem repetir (o espaco e grande; repetir aqui seria bug)
{
  const vistos = new Set<string>()
  for (let i = 0; i < 1000; i++) vistos.add(gerarCodigo())
  eq('mil codigos, mil diferentes', vistos.size, 1000)
}

// ── Normalizar o que a mao digita ──
eq('minuscula',          normalizar('acde3467'), 'ACDE3467')
eq('com hifen',          normalizar('ACDE-3467'), 'ACDE3467')
eq('com espacos',        normalizar(' ACDE 3467 '), 'ACDE3467')
eq('com pontuacao',      normalizar('ACDE.3467'), 'ACDE3467')
eq('misturado',          normalizar('acde - 3467'), 'ACDE3467')
eq('nulo vira vazio',    normalizar(null), '')
eq('indefinido vira vazio', normalizar(undefined), '')
eq('numero vira texto',  normalizar(34673467), '34673467')

// ── Formato ──
eq('codigo valido',        formatoValido('ACDE-3467'), true)
eq('curto recusa',         formatoValido('ACDE346'), false)
eq('longo recusa',         formatoValido('ACDE34677'), false)
eq('fora do alfabeto recusa', formatoValido('ACDE3468'), false)  // 8 nao existe
eq('com O recusa',         formatoValido('ACDEO467'), false)
eq('vazio recusa',         formatoValido(''), false)
eq('nulo recusa',          formatoValido(null), false)

// ── Exibicao ──
eq('formata com hifen',    formatar('ACDE3467'), 'ACDE-3467')
eq('formata o que ja tem hifen', formatar('ACDE-3467'), 'ACDE-3467')
eq('tamanho errado sai cru', formatar('ACDE'), 'ACDE')

// ── Contagem ──
{
  const agora = new Date('2026-09-18T12:00:00Z')
  eq('dez minutos a frente', segundosRestantes('2026-09-18T12:10:00Z', agora), 600)
  eq('um minuto a frente',   segundosRestantes('2026-09-18T12:01:00Z', agora), 60)
  eq('ja venceu da zero',    segundosRestantes('2026-09-18T11:59:00Z', agora), 0)
  eq('exatamente agora da zero', segundosRestantes('2026-09-18T12:00:00Z', agora), 0)
  eq('sem data da zero',     segundosRestantes(null, agora), 0)
  eq('data invalida da zero', segundosRestantes('nao e data', agora), 0)
}
eq('relogio de 600s',  relogio(600), '10:00')
eq('relogio de 187s',  relogio(187), '3:07')
eq('relogio de 7s',    relogio(7), '0:07')
eq('relogio de 0s',    relogio(0), '0:00')
eq('relogio negativo', relogio(-5), '0:00')

// ── As frases dizem o que fazer ──
eq('ja usado explica a regra',  /uma cobrança só/.test(RECUSA.ja_usado), true)
eq('expirado diz os minutos',   RECUSA.expirado.includes(String(MINUTOS_DE_VIDA)), true)
eq('nao encontrado diz o caminho', /aba Autorização/.test(RECUSA.nao_encontrado), true)
eq('formato mostra um exemplo', /ACDE-3467/.test(RECUSA.formato), true)

console.log(`codigo-autorizacao: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
