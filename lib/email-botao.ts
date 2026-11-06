// lib/email-botao.ts — o botão de e-mail que se lê em QUALQUER leitor.
//
// O link de cadastro ia ao cliente num botão de texto BRANCO sobre um fundo
// em gradiente (`background: linear-gradient(...)`). Leitor de e-mail não é
// navegador: o Gmail e o Outlook descartam o gradiente, o fundo some e sobra
// texto branco sobre o cartão branco — o cliente via um espaço em branco e
// não achava onde clicar. O cabeçalho da marca tinha o mesmo gradiente, com o
// mesmo título branco. E o aviso padrão (`emailComMarca`) usava cor sólida,
// mas no próprio <a>: o Outlook do Windows (motor do Word) ignora fundo e
// recuo em link, e lá o defeito era o mesmo.
//
// O formato que funciona em todos é o "botão à prova de bala": a COR vai na
// CÉLULA da tabela, como atributo `bgcolor` (o Outlook lê) e como
// `background-color` (o resto lê), com o link dentro, também com a cor. O
// recuo fica no link (assim o botão inteiro é clicável) e, para o Outlook,
// que ignora recuo em link, também na célula por `mso-padding-alt` — que só
// ele lê.
// Embaixo vai o endereço por extenso, escuro sobre branco: se o botão ainda
// assim não aparecer, o link aparece.
//
// Puro: sem rede, sem banco. testes/email-botao.mts.

import { escaparHtml } from './relatorio-barra.ts'

/** O azul da marca: fundo do botão e do cabeçalho. Branco sobre ele dá 11:1. */
export const COR_DO_BOTAO = '#2D3278'

const COPIE: Record<string, string> = {
  pt: 'Se o botão não abrir, copie e cole este endereço no navegador:',
  es: 'Si el botón no abre, copie y pegue esta dirección en el navegador:',
  en: 'If the button does not open, copy and paste this address into your browser:',
}

export function botaoDeEmail(p: {
  url: string
  texto: string
  lang?: string | null
  /** O aviso padrão é alinhado à esquerda; os convites, ao centro. */
  alinhar?: 'center' | 'left'
}): string {
  const url = escaparHtml(p.url)
  const texto = escaparHtml(p.texto)
  const lang = String(p.lang || 'en').toLowerCase().slice(0, 2)
  const copie = COPIE[lang] || COPIE.en
  const alinhar = p.alinhar === 'left' ? 'left' : 'center'
  const margem = alinhar === 'center' ? '24px auto' : '22px 0'
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="${alinhar}" style="margin:${margem};border-collapse:separate">
  <tr><td align="center" bgcolor="${COR_DO_BOTAO}" style="background-color:${COR_DO_BOTAO};border-radius:10px;mso-padding-alt:14px 32px">
    <a href="${url}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:10px;background-color:${COR_DO_BOTAO};border:1px solid ${COR_DO_BOTAO}"><span style="color:#ffffff">${texto}</span></a>
  </td></tr>
</table>
<p style="clear:both;margin:0 0 4px;font-size:12px;line-height:1.5;color:#4a5a6a;text-align:${alinhar}">${copie}</p>
<p style="margin:0 0 16px;font-size:12px;line-height:1.5;text-align:${alinhar};word-break:break-all"><a href="${url}" target="_blank" style="color:${COR_DO_BOTAO};text-decoration:underline">${url}</a></p>`
}

/** Cabeçalho da marca em cor SÓLIDA na célula (o gradiente sumia junto com o título branco). */
export function celulaDoCabecalho(): string {
  return `bgcolor="${COR_DO_BOTAO}" style="background-color:${COR_DO_BOTAO};border-radius:16px 16px 0 0;padding:28px;text-align:center;"`
}
