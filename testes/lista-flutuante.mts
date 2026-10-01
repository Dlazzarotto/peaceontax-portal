// testes/lista-flutuante.mts — onde a lista flutuante é desenhada
//
// O caso que originou: na ÚLTIMA LINHA da tabela do bookkeeping o
// autocomplete do payee nascia abaixo do campo, fora da janela — e por ser
// `position: fixed` rolar não traz de volta. Quem lança o cheque via a
// sugestão pela metade, sem alcance.

import { posicionarLista, FOLGA, MARGEM, ALTURA_MINIMA } from '../lib/lista-flutuante.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const ok = (n: string, c: boolean) => eq(n, c, true)

const JANELA = { largura: 1440, altura: 900 }
const campo = (o: Partial<{ top: number; bottom: number; left: number; width: number }> = {}) =>
  ({ top: 300, bottom: 324, left: 700, width: 120, ...o })

// ── Padrão: abaixo ──────────────────────────────────────────────────────
{
  const p = posicionarLista(campo(), JANELA)
  eq('abre abaixo', p.acima, false)
  eq('logo abaixo do campo', p.top, 324 + FOLGA)
  eq('com a altura pedida', p.maxHeight, 260)
  eq('alinhada ao campo', p.left, 700)
  eq('largura mínima, não a do campo', p.width, 230)
}

// ── O caso real: última linha ───────────────────────────────────────────
// Campo a 24px do fim da janela. Abaixo não cabe nada; acima cabe muito.
{
  const p = posicionarLista(campo({ top: 852, bottom: 876 }), JANELA)
  ok('vira para CIMA', p.acima)
  eq('o fundo da lista encosta no campo', p.top + p.maxHeight, 852 - FOLGA)
  ok('o topo fica dentro da janela', p.top >= 0)
  ok('o fundo fica dentro da janela', p.top + p.maxHeight <= JANELA.altura)
}
// E o que acontecia antes: abaixo, o fundo passava da janela.
{
  const antes = 876 + FOLGA + 260
  ok('a versão antiga passava da janela', antes > JANELA.altura)
}

// ── Não troca de lado por qualquer sobra ────────────────────────────────
// Cabe inteira embaixo: fica embaixo, mesmo havendo mais espaço acima.
{
  const p = posicionarLista(campo({ top: 560, bottom: 584 }), JANELA)
  eq('cabe embaixo → fica embaixo', p.acima, false)
  eq('e com a altura cheia', p.maxHeight, 260)
}

// ── Os dois lados apertados: escolhe o maior e limita a altura ──────────
{
  // Campo no meio de uma janela baixa: 200 acima, 160 abaixo.
  const p = posicionarLista(campo({ top: 212, bottom: 236 }), { largura: 1440, altura: 408 })
  ok('vai para o lado maior (acima)', p.acima)
  eq('altura limitada ao espaço real', p.maxHeight, 212 - FOLGA - MARGEM)
  ok('não ultrapassa a janela', p.top >= 0)
}
{
  // Espelho: mais espaço abaixo. 272 cabe, então vale o TETO (260), não o
  // espaço — a lista não cresce além do pedido só porque sobra lugar.
  const p = posicionarLista(campo({ top: 100, bottom: 124 }), { largura: 1440, altura: 408 })
  eq('fica abaixo', p.acima, false)
  eq('o teto vence a sobra', p.maxHeight, 260)
}

// ── Janela baixa: a altura segue o espaço, sem forçar o piso ────────────
{
  const p = posicionarLista(campo({ top: 120, bottom: 144 }), { largura: 400, altura: 200 })
  eq('usa o espaço que há', p.maxHeight, 120 - FOLGA - MARGEM)
  ok('e virou para cima', p.acima)
}
// ── Janela minúscula: o PISO vale, e a lista rola dentro ────────────────
// Aqui nenhum dos lados comporta ALTURA_MINIMA. Preferir uma fresta de 70px
// onde nada se lê seria pior que deixar a lista passar e rolar por dentro —
// é uma troca deliberada, e por isso está testada.
{
  const p = posicionarLista(campo({ top: 90, bottom: 114 }), { largura: 400, altura: 200 })
  eq('o piso segura a altura', p.maxHeight, ALTURA_MINIMA)
  ok('nenhum lado comportava o piso', (200 - 114 - FOLGA - MARGEM) < ALTURA_MINIMA
    && (90 - FOLGA - MARGEM) < ALTURA_MINIMA)
}

// ── Borda direita: não corta na horizontal ──────────────────────────────
{
  const p = posicionarLista(campo({ left: 1380 }), JANELA)
  ok('recuada para caber', p.left < 1380)
  eq('encostada na margem direita', p.left + p.width, JANELA.largura - MARGEM)
}
{
  const p = posicionarLista(campo({ left: -40 }), JANELA)
  eq('borda esquerda respeitada', p.left, MARGEM)
}
// Janela mais estreita que a largura mínima: a lista não encolhe a ponto de
// não caber um nome, mas o recuo vai para a margem.
{
  const p = posicionarLista(campo({ left: 10 }), { largura: 200, altura: 900 })
  eq('largura não desce da mínima', p.width, 230)
  eq('e cola na margem', p.left, MARGEM)
}

// ── Campo largo manda na largura ────────────────────────────────────────
{
  const p = posicionarLista(campo({ width: 420 }), JANELA)
  eq('largura acompanha o campo', p.width, 420)
}

// ── A lista NUNCA sai da janela, em qualquer posição do campo ───────────
// Varredura: é a garantia que importa, e vale mais que qualquer caso solto.
{
  let fora = 0
  for (let y = 0; y <= 900; y += 10) {
    const p = posicionarLista(campo({ top: y, bottom: y + 24 }), JANELA)
    // Tolera o caso degenerado em que nem ALTURA_MINIMA cabe de um lado só.
    if (p.top < 0 || p.top + p.maxHeight > JANELA.altura) {
      if (p.maxHeight > ALTURA_MINIMA) fora++
    }
  }
  eq('nenhuma posição joga a lista para fora', fora, 0)
}

console.log(`lista-flutuante: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
