// lib/import-clientes.ts — trazer a carteira do QuickBooks para o cadastro.
//
// O arquivo do QuickBooks vem com colunas próprias e alguns hábitos dele:
//   - BOM no começo (o projeto proíbe BOM, e sem tirar o cabeçalho não casa)
//   - telefone com apóstrofo na frente, o truque do Excel para não virar número
//   - "Client type" é PERSON ou ORGANIZATION, não individual/business
//   - Company ID, Client number e as colunas de produto vêm quase todas vazias
//
// Duas coisas que a carteira real ensinou e que a regra precisa respeitar:
//
//   1. O MESMO E-MAIL SERVE A MAIS DE UM CLIENTE. Em 970 cadastros há 56
//      e-mails repetidos, e só UM é duplicata de verdade. Os outros são o dono
//      e a empresa dele — "Bruno Parreira" e "ABM Capital Group Inc" no mesmo
//      gmail. São clientes diferentes, com declarações diferentes. Por isso o
//      que identifica um cadastro aqui é o NOME, não o e-mail.
//
//   2. IMPORTAR NUNCA CONVIDA. Cadastrar cliente pela tela manda o convite do
//      portal; fazer isso com 924 e-mails de uma vez seria um desastre. O
//      importador grava e pronto — o convite sai depois, um a um, quando a
//      equipe quiser.

export interface LinhaImportada {
  name: string
  email: string | null
  phone: string | null
  type: 'individual' | 'business'
}

export interface Descartado {
  name: string
  motivo: string
}

export interface PlanoDeImportacao {
  novos: LinhaImportada[]
  jaExistem: Descartado[]
  repetidosNoArquivo: Descartado[]
  semNome: number
  /** Mesmo e-mail, nomes diferentes: dono e empresa. Entram, mas a equipe precisa saber. */
  emailCompartilhado: { email: string; nomes: string[] }[]
  telefonesDescartados: number
}

/** Nome comparável: sem acento, sem pontuação, sem espaço dobrado, minúsculo. */
export function chaveDoNome(nome: string): string {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.,'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** E.164 como o resto do sistema (lib/sms.ts). Telefone impossível vira null. */
export function telefoneDoQuickBooks(bruto: string | null | undefined): string | null {
  if (!bruto) return null
  const so = String(bruto).replace(/\D/g, '')
  if (so.length === 10) return `+1${so}`
  if (so.length === 11 && so.startsWith('1')) return `+${so}`
  if (so.length > 11) return `+${so}`
  return null                                  // 2 e 4 dígitos são lixo do cadastro antigo
}

/** PERSON/ORGANIZATION do QuickBooks vira o que a tabela usa. */
export function tipoDoQuickBooks(bruto: string | null | undefined): 'individual' | 'business' {
  return String(bruto || '').trim().toUpperCase() === 'ORGANIZATION' ? 'business' : 'individual'
}

/** CSV com aspas, vírgula dentro de campo e BOM. Sem depender de biblioteca. */
export function lerCsv(texto: string): Record<string, string>[] {
  const limpo = texto.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const linhas: string[][] = []
  let campo = '', linha: string[] = [], aspas = false
  for (let i = 0; i < limpo.length; i++) {
    const c = limpo[i]
    if (aspas) {
      if (c === '"') { if (limpo[i + 1] === '"') { campo += '"'; i++ } else aspas = false }
      else campo += c
    } else if (c === '"') aspas = true
    else if (c === ',') { linha.push(campo); campo = '' }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = '' }
    else campo += c
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha) }
  if (!linhas.length) return []
  const cab = linhas[0].map(h => h.trim())
  return linhas.slice(1)
    .filter(l => l.some(v => v.trim()))
    .map(l => Object.fromEntries(cab.map((h, i) => [h, (l[i] ?? '').trim()])))
}

/**
 * Compara o arquivo com quem já está cadastrado e devolve o que fazer.
 * Nada é gravado aqui: a equipe vê o plano antes de confirmar.
 */
export function planejarImportacao(
  registros: Record<string, string>[],
  jaCadastrados: { name: string; business_name?: string | null }[],
): PlanoDeImportacao {
  const existentes = new Set<string>()
  for (const c of jaCadastrados) {
    if (c.name) existentes.add(chaveDoNome(c.name))
    if (c.business_name) existentes.add(chaveDoNome(c.business_name))
  }

  const plano: PlanoDeImportacao = {
    novos: [], jaExistem: [], repetidosNoArquivo: [],
    semNome: 0, emailCompartilhado: [], telefonesDescartados: 0,
  }
  const vistosNoArquivo = new Set<string>()
  const porEmail = new Map<string, string[]>()

  for (const r of registros) {
    const nome = (r['Name'] || '').trim()
    if (!nome) { plano.semNome++; continue }

    const chave = chaveDoNome(nome)
    if (existentes.has(chave)) { plano.jaExistem.push({ name: nome, motivo: 'já cadastrado' }); continue }
    if (vistosNoArquivo.has(chave)) { plano.repetidosNoArquivo.push({ name: nome, motivo: 'repetido no arquivo' }); continue }
    vistosNoArquivo.add(chave)

    const email = (r['Email id'] || '').trim().toLowerCase() || null
    const telBruto = (r['Phone no.'] || '').trim()
    const phone = telefoneDoQuickBooks(telBruto)
    if (telBruto && !phone) plano.telefonesDescartados++

    if (email) porEmail.set(email, [...(porEmail.get(email) || []), nome])
    plano.novos.push({ name: nome, email, phone, type: tipoDoQuickBooks(r['Client type']) })
  }

  for (const [email, nomes] of porEmail) {
    if (nomes.length > 1) plano.emailCompartilhado.push({ email, nomes })
  }
  return plano
}
