// testes/recebimento-aprovacao.mts — que forma de recebimento pede aprovação
//
// Decide dinheiro: é a trava que impede quem emite a fatura de também
// receber em espécie sem ninguém ver. A lista é de LIVRES — forma nova
// nasce pedindo aprovação.

import {
  exigeAprovacao, podeAprovar, nomeDaForma, notaDaAprovacao,
  FORMAS_LIVRES, NIVEIS_APROVADORES, AVISO,
} from '../lib/recebimento-aprovacao.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── As duas livres, e só elas ──
eq('a lista de livres e exatamente esta', [...FORMAS_LIVRES], ['card', 'zelle'])
eq('cartao passa sozinho',  exigeAprovacao('card'), false)
eq('zelle passa sozinho',   exigeAprovacao('zelle'), false)

// ── O caso que originou a regra ──
eq('DINHEIRO pede aprovacao', exigeAprovacao('cash'), true)

// ── Tudo o mais fica travado ate o socio decidir soltar ──
for (const f of ['check', 'wire', 'venmo', 'ach', 'external', 'other'])
  eq(`${f} pede aprovacao`, exigeAprovacao(f), true)

// ── Falha para o lado da trava ──
eq('forma vazia trava',      exigeAprovacao(''), true)
eq('forma nula trava',       exigeAprovacao(null), true)
eq('forma indefinida trava', exigeAprovacao(undefined), true)
eq('forma nova trava',       exigeAprovacao('pix'), true)
eq('forma desconhecida trava', exigeAprovacao('bitcoin'), true)

// ── Tolerancia ao que a mao digita, sem afrouxar a lista ──
eq('CARD maiusculo passa',   exigeAprovacao('CARD'), false)
eq('espaco em volta passa',  exigeAprovacao(' zelle '), false)
eq('cashh nao e cash',       exigeAprovacao('cashh'), true)
eq('card com sufixo trava',  exigeAprovacao('card_manual'), true)

// ── Quem aprova ──
eq('niveis aprovadores', [...NIVEIS_APROVADORES], ['owner', 'manager'])
eq('socio aprova',       podeAprovar('owner'), true)
eq('gerente aprova',     podeAprovar('manager'), true)
eq('assistente NAO aprova', podeAprovar('junior'), false)
eq('nivel vazio NAO aprova', podeAprovar(''), false)
eq('nivel nulo NAO aprova',  podeAprovar(null), false)
eq('nivel inventado NAO aprova', podeAprovar('supervisor'), false)

// ── Textos ──
eq('nome do dinheiro', nomeDaForma('cash'), 'Dinheiro em espécie')
eq('nome desconhecido nao quebra', nomeDaForma('pix'), 'pix')
eq('sem forma tem texto', nomeDaForma(''), 'Esta forma')
eq('o aviso nomeia a forma', AVISO.falta('cash').includes('Dinheiro em espécie'), true)
eq('o aviso diz o que passa sozinho',
   AVISO.falta('cash').includes('Cartão e Zelle'), true)
eq('a nota da trilha tem forma, valor e quem aprovou',
   notaDaAprovacao('gerente@peaceontax.com', 250, 'cash'),
   'Dinheiro em espécie: $250.00 aprovado por gerente@peaceontax.com.')
eq('a nota arredonda em centavos',
   notaDaAprovacao('x@y.com', 99.5, 'check'),
   'Cheque: $99.50 aprovado por x@y.com.')

console.log(`recebimento-aprovacao: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
