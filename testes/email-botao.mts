// testes/email-botao.mts — o botão do e-mail tem de aparecer em qualquer leitor
//
// O convite de cadastro chegava com o botão em BRANCO: texto branco sobre um
// gradiente que o Gmail e o Outlook descartam. Errar aqui é o cliente sem o
// link para se cadastrar, para cadastrar o cartão ou para assinar.

import { botaoDeEmail, celulaDoCabecalho, COR_DO_BOTAO } from '../lib/email-botao.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// Contraste pela fórmula da WCAG 2.x (luminância relativa).
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contraste = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const url = 'https://peaceontax-portal.vercel.app/invite/abc123'
const h = botaoDeEmail({ url, texto: 'Create My Account →' })

// ── A cor na CÉLULA, nos dois jeitos que os leitores leem ────────────────
eq('o fundo vai como atributo bgcolor (o Outlook lê)', h.includes(`bgcolor="${COR_DO_BOTAO}"`), true)
eq('…e como background-color na célula (o resto lê)', h.includes(`<td align="center" bgcolor="${COR_DO_BOTAO}" style="background-color:${COR_DO_BOTAO}`), true)
eq('o link também carrega a cor (leitor que ignora a célula)', /<a href="[^"]+" target="_blank" style="[^"]*background-color:#2D3278/.test(h), true)
eq('sem gradiente: o Gmail e o Outlook o descartam', /gradient/i.test(h), false)
eq('sem cor com transparência (rgba): o Outlook não lê', /rgba\(/i.test(h), false)
eq('o texto do botão é branco', h.includes('color:#ffffff'), true)
eq('o botão é uma tabela de apresentação', h.startsWith('<table role="presentation"'), true)

// ── O endereço por extenso, escuro sobre branco ──────────────────────────
eq('o endereço aparece como texto, além do botão', h.includes(`>${url}</a>`), true)
eq('…com o link duas vezes (botão e texto)', h.split(`href="${url}"`).length - 1, 2)
eq('…e quebra em telefone em vez de vazar da tela', h.includes('word-break:break-all'), true)

// ── Escape: endereço e texto não viram HTML ──────────────────────────────
{
  const e = botaoDeEmail({ url: 'https://x.com/a?b=1&c="2"', texto: '<b>Pagar</b> & assinar' })
  eq('& do endereço vira &amp; no href', e.includes('href="https://x.com/a?b=1&amp;c=&quot;2&quot;"'), true)
  eq('aspas do endereço não fecham o atributo', /href="[^"]*"2"/.test(e), false)
  eq('o texto é escapado', e.includes('&lt;b&gt;Pagar&lt;/b&gt; &amp; assinar'), true)
}

// ── Idioma da frase de reserva ───────────────────────────────────────────
eq('pt', botaoDeEmail({ url, texto: 'x', lang: 'pt' }).includes('Se o botão não abrir, copie e cole este endereço no navegador:'), true)
eq('es', botaoDeEmail({ url, texto: 'x', lang: 'es' }).includes('Si el botón no abre, copie y pegue esta dirección en el navegador:'), true)
eq('en é o padrão', h.includes('If the button does not open, copy and paste this address into your browser:'), true)
eq('idioma que não atendemos cai no inglês', botaoDeEmail({ url, texto: 'x', lang: 'zh' }).includes('If the button does not open'), true)
eq('pt-BR conta como pt', botaoDeEmail({ url, texto: 'x', lang: 'pt-BR' }).includes('Se o botão não abrir'), true)

// ── Alinhamento ──────────────────────────────────────────────────────────
eq('convite: centralizado', h.includes('align="center" style="margin:24px auto'), true)
eq('aviso padrão: à esquerda', botaoDeEmail({ url, texto: 'x', alinhar: 'left' }).includes('align="left" style="margin:22px 0'), true)

// ── Contraste (WCAG): o que motivou tudo isto é texto que não se lê ──────
eq('branco sobre o azul do botão passa o AAA (≥ 7:1)', contraste('#ffffff', COR_DO_BOTAO) >= 7, true)
eq('o link de reserva, azul sobre branco, passa o AAA', contraste(COR_DO_BOTAO, '#ffffff') >= 7, true)
eq('a frase de reserva (#4a5a6a) sobre branco passa o AA (≥ 4,5:1)', contraste('#4a5a6a', '#ffffff') >= 4.5, true)
eq('o subtítulo do cabeçalho (#c9cdea) sobre o azul passa o AA', contraste('#c9cdea', COR_DO_BOTAO) >= 4.5, true)
eq('…e o defeito de antes: branco sobre branco é 1:1', contraste('#ffffff', '#ffffff'), 1)

// ── Cabeçalho ────────────────────────────────────────────────────────────
eq('cabeçalho com bgcolor e cor sólida', celulaDoCabecalho().startsWith(`bgcolor="${COR_DO_BOTAO}" style="background-color:${COR_DO_BOTAO};`), true)
eq('cabeçalho sem gradiente', /gradient/i.test(celulaDoCabecalho()), false)

console.log(`email-botao: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
