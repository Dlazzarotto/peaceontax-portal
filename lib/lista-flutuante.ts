// Onde desenhar uma lista que flutua ancorada num campo (o autocomplete do
// payee, na tabela do bookkeeping).
//
// O DEFEITO QUE ISTO CONSERTA
// A lista era sempre posta ABAIXO do campo (`top: rect.bottom + 4`), com
// `position: fixed` e `maxHeight: 260`. Na ÚLTIMA LINHA da tabela o campo já
// está perto do fim da janela, então a lista nascia fora da tela — e, por ser
// `fixed`, **rolar a página não a traz de volta**: ela fica presa à janela, no
// mesmo lugar. Quem lança o cheque via a sugestão pela metade e não tinha como
// alcançá-la.
//
// Por que `fixed` e não `absolute`: a célula da tabela tem `overflow` e
// recorta filho posicionado. `fixed` escapa do recorte, mas em troca passa a
// ser responsabilidade nossa não sair da janela — é o que esta conta faz.
//
// Puro e com teste porque é aritmética de tela: erra em silêncio, só aparece
// na linha de baixo, e ninguém olha a última linha ao conferir uma mudança.

export interface RetanguloDoCampo {
  top: number       // distância do topo da JANELA (getBoundingClientRect)
  bottom: number
  left: number
  width: number
}

export interface Janela { largura: number; altura: number }

export interface PosicaoDaLista {
  top: number
  left: number
  width: number
  maxHeight: number
  acima: boolean    // abriu para cima (a tela diz, para o teste e para o CSS)
}

/** Respiro entre o campo e a lista. */
export const FOLGA = 4
/** Distância mínima da borda da janela. Zero grudaria no limite. */
export const MARGEM = 8
/** Abaixo disto a lista não serve para nada; melhor rolar dentro dela. */
export const ALTURA_MINIMA = 96

const entre = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

/**
 * Decide lado, altura e recuo da lista.
 *
 * ABAIXO é o padrão — é onde o olho procura. Só vai para CIMA quando embaixo
 * não cabe a altura pedida E em cima cabe mais. Trocar de lado por qualquer
 * sobra faria a lista pular de lado enquanto se digita.
 *
 * A altura é SEMPRE limitada ao espaço real do lado escolhido, então a lista
 * nunca ultrapassa a janela: o que não couber rola dentro dela.
 */
export function posicionarLista(
  campo: RetanguloDoCampo,
  janela: Janela,
  opcoes: { alturaIdeal?: number; larguraMinima?: number } = {}
): PosicaoDaLista {
  const alturaIdeal = opcoes.alturaIdeal ?? 260
  const larguraMinima = opcoes.larguraMinima ?? 230

  const espacoAbaixo = janela.altura - campo.bottom - FOLGA - MARGEM
  const espacoAcima = campo.top - FOLGA - MARGEM

  const acima = espacoAbaixo < alturaIdeal && espacoAcima > espacoAbaixo

  const espaco = acima ? espacoAcima : espacoAbaixo
  // O piso vem DEPOIS do teto: numa janela minúscula é melhor a lista passar
  // um pouco e rolar do que virar uma fresta de 10px onde nada se lê.
  const maxHeight = Math.max(ALTURA_MINIMA, Math.min(alturaIdeal, espaco))

  const width = Math.min(
    Math.max(campo.width, larguraMinima),
    Math.max(larguraMinima, janela.largura - 2 * MARGEM)
  )

  const top = acima
    ? campo.top - FOLGA - maxHeight
    : campo.bottom + FOLGA

  return {
    top,
    // Encostar no canto direito cortaria a lista na horizontal — o mesmo
    // defeito, no outro eixo.
    left: entre(campo.left, MARGEM, Math.max(MARGEM, janela.largura - width - MARGEM)),
    width,
    maxHeight,
    acima,
  }
}
