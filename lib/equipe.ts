// lib/equipe.ts — a equipe num lugar só: quem é, que nível tem, como entra
//
// POR QUE ISTO EXISTE (decisão do sócio: "juntar tudo como team member e
// acrescentar as regras")
// A firma tinha TRÊS cadastros da mesma gente, cada um com a sua tela, e
// eles discordavam:
//
//   team_members → o nome de responsável no CRM (/team). A coluna "role"
//                  era um rótulo que QUALQUER pessoa da equipe trocava, e a
//                  tela mostrava "Sócio" para quem o sistema tratava como
//                  assistente.
//   auth.users   → o login e o papel da PORTA (Settings → Team Members).
//   staff_roles  → o NÍVEL que decide o poder (Minha Conta), trocado sem
//                  senha, sem motivo e sem rastro.
//
// E um defeito mudo entre elas: editar o telefone em Team Members comparava
// o papel com `user_metadata.role` — que a migração do papel esvaziou —,
// achava que o papel tinha mudado e REESCREVIA o nível pelo papel. Quem tem
// papel de sócio e nível de gerente virava sócio; quem foi promovido em
// Minha Conta voltava a assistente.
//
// Agora a pessoa é UMA linha de team_members: nome, e-mail, login (user_id),
// nível (level) e PIN. A senha continua no Supabase Auth, e o papel em
// app_metadata continua sendo a PORTA (lib/papeis.ts). O PODER é
// team_members.level, e ele só muda por um ato próprio: do sócio, com senha
// e motivo, gravado na trilha antes (team_member_audit).
//
// Este módulo é PURO (sem banco), para as regras terem teste
// (testes/equipe.mts):
//   nivelDoPapel / papelDoNivel   a tradução porta ⇄ poder
//   decidirMudancaDeNivel         quem pode mudar o nível de quem
//   decidirConvite                quem pode ser convidado
//   escolherMembroParaVincular    o aceite do convite COMPLETA a linha que o
//                                 CRM já tinha, em vez de duplicar a pessoa
//   montarListaDaEquipe           a lista única da tela Equipe

import { chaveDoNome } from './import-clientes.ts'

export const NIVEIS = ['owner', 'manager', 'junior'] as const
export type StaffLevel = (typeof NIVEIS)[number]

export const ROTULO_DO_NIVEL: Record<StaffLevel, string> = {
  owner: 'Sócio',
  manager: 'Gerente',
  junior: 'Assistente',
}

/** O texto vale o mesmo que `ehNivel`: nível de verdade ou nada. */
export function nivelValido(v: unknown): StaffLevel | null {
  const s = String(v ?? '').trim().toLowerCase()
  return (NIVEIS as readonly string[]).includes(s) ? (s as StaffLevel) : null
}

/**
 * O papel da PORTA traduzido para o nível que ele dá.
 *
 *   'firm' · 'owner' · 'admin' → owner    (há convites antigos com 'admin')
 *   'manager'                  → manager
 *   qualquer outro             → junior   (o mais restrito)
 *
 * É a reserva de `getStaffLevel` para um login da firma que ainda não tem
 * linha na equipe — por isso o papel acompanha o nível (`papelDoNivel`).
 */
export function nivelDoPapel(papel: string | null | undefined): StaffLevel {
  switch (String(papel || '').trim().toLowerCase()) {
    case 'firm':
    case 'owner':
    case 'admin':    return 'owner'
    case 'manager':  return 'manager'
    default:         return 'junior'
  }
}

/**
 * O papel da porta que acompanha um nível.
 *
 * Mudar o nível sem mexer no papel deixava os dois discordando — e o papel é
 * a reserva do nível: um gerente com papel 'firm' viraria sócio no primeiro
 * tropeço que tirasse a linha dele da equipe. O sócio mantém o papel que já
 * tinha quando ele já é de sócio ('firm', 'owner' ou 'admin'); o resto
 * recebe o papel do nível. Todos continuam abrindo a porta da firma.
 */
export function papelDoNivel(nivel: StaffLevel, papelAtual?: string | null): string {
  if (nivel === 'owner') {
    const atual = String(papelAtual || '').trim().toLowerCase()
    return nivelDoPapel(atual) === 'owner' ? atual : 'firm'
  }
  return nivel === 'manager' ? 'manager' : 'staff'
}

// ── Mudar o nível ────────────────────────────────────────────────────────

export const MOTIVO_MINIMO = 5

export interface PedidoDeNivel {
  /** Quem chama: o login e o nível dele. */
  quemChama: { userId: string; nivel: StaffLevel }
  /**
   * A pessoa: o login (nulo = só existe no CRM) e o nível atual.
   * `semCadastro`: login da firma sem linha na equipe — o nível é o da
   * reserva (o papel), e confirmar o MESMO nível é o que cria a linha.
   */
  alvo: { userId: string | null; nivel: StaffLevel | null; semCadastro?: boolean }
  novo: unknown
  motivo: unknown
}

export type DecisaoDeNivel =
  | { ok: true; nivel: StaffLevel; zerarPin: boolean; motivo: string }
  | { ok: false; status: 400 | 403 | 409; erro: string }

/**
 * Quem pode mudar o nível de quem — a regra inteira, num lugar só.
 *
 * Só o sócio. Ninguém mexe no próprio nível (como nas autorizações): sem
 * isso, um sócio podia se rebaixar por engano e deixar a firma sem quem
 * administre a equipe — e, como só sócio muda nível, sempre sobra pelo
 * menos um, o que pediu. Quem não tem login não tem nível: o nível é do
 * LOGIN, e a linha só do CRM é um nome no seletor de responsável.
 * Passar a assistente apaga o PIN: assistente não aprova nada.
 */
export function decidirMudancaDeNivel(p: PedidoDeNivel): DecisaoDeNivel {
  if (p.quemChama.nivel !== 'owner')
    return { ok: false, status: 403, erro: 'Só o sócio muda o nível de alguém da equipe.' }
  if (!p.alvo.userId)
    return { ok: false, status: 409,
      erro: 'Esta pessoa não tem login: nível só existe para quem entra no sistema. Convide-a primeiro.' }
  if (p.alvo.userId === p.quemChama.userId)
    return { ok: false, status: 403, erro: 'Você não altera o próprio nível. Peça a outro sócio.' }

  const nivel = nivelValido(p.novo)
  if (!nivel)
    return { ok: false, status: 400, erro: 'Nível desconhecido: escolha Sócio, Gerente ou Assistente.' }
  if (nivel === p.alvo.nivel && !p.alvo.semCadastro)
    return { ok: false, status: 400, erro: `Já é ${ROTULO_DO_NIVEL[nivel]}. Nada a mudar.` }

  const motivo = String(p.motivo ?? '').trim()
  if (motivo.length < MOTIVO_MINIMO)
    return { ok: false, status: 400,
      erro: 'Escreva o motivo — ele fica na trilha e é o que explica a mudança depois.' }

  return { ok: true, nivel, zerarPin: nivel === 'junior', motivo }
}

// ── Convidar ─────────────────────────────────────────────────────────────

export interface LoginExistente {
  id: string
  email: string | null
  /** app_metadata.role — a porta. */
  papel: string | null
}

export type DecisaoDeConvite =
  | { ok: true; email: string; nivel: StaffLevel; papel: string }
  | { ok: false; status: 400 | 409; erro: string }

const ehEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
const normEmail = (e: unknown) => String(e ?? '').trim().toLowerCase()

/**
 * Convite é para quem AINDA NÃO TEM login.
 *
 * Quem já é da equipe não se reconvida: o aceite trocava a senha e
 * regravava o nível pelo convite — um convite antigo, aceito depois de a
 * pessoa ter sido rebaixada, devolvia o nível de antes. Nível de quem já
 * está na equipe muda pelo botão Nível; quem saiu volta por Reativar.
 *
 * Login de CLIENTE também é recusado: o aceite transformaria o portal dele
 * em acesso da firma, e o cadastro de cliente ficaria sem portal.
 */
export function decidirConvite(p: {
  email: unknown
  nivel: unknown
  logins: LoginExistente[]
  ehDaFirma: (papel: unknown) => boolean
}): DecisaoDeConvite {
  const email = normEmail(p.email)
  if (!ehEmail(email)) return { ok: false, status: 400, erro: 'Informe um e-mail válido.' }

  const nivel = nivelValido(p.nivel)
  if (!nivel) return { ok: false, status: 400, erro: 'Escolha o nível: Sócio, Gerente ou Assistente.' }

  const login = p.logins.find(l => normEmail(l.email) === email)
  if (login) {
    return p.ehDaFirma(login.papel)
      ? { ok: false, status: 409,
          erro: 'Esta pessoa já tem login na equipe. Para mudar o acesso use Nível; se ela saiu, Reativar.' }
      : { ok: false, status: 409,
          erro: 'Este e-mail é de um CLIENTE no portal. Use outro e-mail para o login da equipe — senão o portal dele vira acesso da firma.' }
  }
  return { ok: true, email, nivel, papel: papelDoNivel(nivel, null) }
}

// ── O aceite do convite ──────────────────────────────────────────────────

export interface MembroExistente {
  id: string
  name: string
  email: string | null
  user_id: string | null
  active: boolean | null
}

export type Vinculo =
  | { tipo: 'ja-vinculado'; id: string }
  | { tipo: 'vincular'; id: string; por: 'email' | 'nome' }
  | { tipo: 'inserir'; nome: string }

/**
 * Qual linha da equipe é desta pessoa — a MESMA regra de
 * sql/equipe-unica-v1.sql, que fez isso uma vez para quem já tinha login.
 *
 *   1. a linha que já tem este login               → já vinculado
 *   2. a linha SEM login com o mesmo e-mail         → vincular
 *   3. a linha SEM login e SEM e-mail, mesmo nome   → vincular
 *   4. nenhuma                                      → inserir
 *
 * A mesma lição do cadastro de cliente: aceitar convite COMPLETA o que
 * existe. Inserir sempre punha a pessoa duas vezes no seletor do CRM — a
 * linha antiga, com os clientes que ela já atendia, e a nova, vazia.
 *
 * Linha sem login com o mesmo nome e OUTRO e-mail não é a mesma pessoa. Na
 * inserção, nome que já existe na equipe leva o e-mail entre parênteses: o
 * CRM guarda o responsável pelo NOME, e dois "Maria" no seletor são uma
 * escolha no escuro.
 */
export function escolherMembroParaVincular(
  membros: MembroExistente[],
  pessoa: { userId: string; email: string | null; nome: string | null },
): Vinculo {
  const ja = membros.find(m => m.user_id === pessoa.userId)
  if (ja) return { tipo: 'ja-vinculado', id: ja.id }

  const livres = membros.filter(m => !m.user_id)
  // Ativa primeiro: a linha inativa é a de quem saiu e volta — vale, mas a
  // ativa é a que o CRM está usando.
  const ordenar = (a: MembroExistente, b: MembroExistente) =>
    Number(!!b.active) - Number(!!a.active)

  const email = normEmail(pessoa.email)
  if (email) {
    const porEmail = livres.filter(m => normEmail(m.email) === email).sort(ordenar)
    if (porEmail.length) return { tipo: 'vincular', id: porEmail[0].id, por: 'email' }
  }

  const nome = String(pessoa.nome || '').trim() || (email ? email.split('@')[0] : '') || pessoa.userId
  const chave = chaveDoNome(nome)
  const porNome = livres.filter(m => !normEmail(m.email) && chaveDoNome(m.name) === chave).sort(ordenar)
  if (porNome.length) return { tipo: 'vincular', id: porNome[0].id, por: 'nome' }

  const repetido = membros.some(m => chaveDoNome(m.name) === chave)
  return { tipo: 'inserir', nome: repetido ? `${nome} (${email || pessoa.userId})` : nome }
}

// ── A lista da tela ──────────────────────────────────────────────────────

export interface LoginDaLista extends LoginExistente {
  nome: string | null
  title: string | null
  phone: string | null
  banido: boolean
  ultimoAcesso: string | null
}

export interface ConviteDaLista {
  id: string
  email: string
  name: string
  role: string | null
  status: string | null
  expires_at: string
  title?: string | null
  phone?: string | null
}

export interface MembroDaLista extends MembroExistente {
  level: string | null
  temPin: boolean
}

/**
 *  ativo        tem login e entra
 *  inativo      saiu: login bloqueado ou fora do seletor do CRM
 *  convidado    convite enviado, ainda não aceito
 *  sem-login    só existe no CRM, como nome de responsável
 *  sem-cadastro login da firma sem linha na equipe — não devia existir
 *               depois da migração; o nível é o da reserva (o papel)
 */
export type Situacao = 'ativo' | 'inativo' | 'convidado' | 'sem-login' | 'sem-cadastro'

export interface PessoaDaEquipe {
  /** Chave estável para a tela: m:<id da linha> · u:<login> · c:<convite>. */
  chave: string
  memberId: string | null
  userId: string | null
  nome: string
  email: string | null
  /** Nulo para quem não tem login: nível é do login. */
  nivel: StaffLevel | null
  temPin: boolean
  situacao: Situacao
  conviteExpira: string | null
  /** O nível que o convite pendente dá — o que "Reenviar" tem de repetir. */
  conviteNivel: StaffLevel | null
  papel: string | null
  title: string | null
  phone: string | null
  ultimoAcesso: string | null
}

const ORDEM: Record<Situacao, number> = { ativo: 0, 'sem-cadastro': 0, convidado: 1, 'sem-login': 2, inativo: 3 }

/**
 * A lista única: as linhas da equipe, os logins da firma que ainda não têm
 * linha e os convites pendentes. Convite para o e-mail de uma linha do CRM
 * aparece NA linha — é a mesma pessoa a caminho de ter login.
 */
export function montarListaDaEquipe(p: {
  membros: MembroDaLista[]
  logins: LoginDaLista[]
  convites: ConviteDaLista[]
  ehDaFirma: (papel: unknown) => boolean
  agora: Date
}): PessoaDaEquipe[] {
  const loginPorId = new Map(p.logins.map(l => [l.id, l]))
  const vinculados = new Set(p.membros.map(m => m.user_id).filter(Boolean) as string[])

  // O convite pendente mais recente de cada e-mail; vencido não conta.
  const convitePorEmail = new Map<string, ConviteDaLista>()
  for (const c of p.convites) {
    if (String(c.status || 'pending') !== 'pending') continue
    if (!(new Date(c.expires_at).getTime() > p.agora.getTime())) continue
    const e = normEmail(c.email)
    const atual = convitePorEmail.get(e)
    if (!atual || new Date(c.expires_at) > new Date(atual.expires_at)) convitePorEmail.set(e, c)
  }

  const lista: PessoaDaEquipe[] = []
  const emailsCobertos = new Set<string>()

  for (const m of p.membros) {
    const login = m.user_id ? loginPorId.get(m.user_id) : undefined
    const e = normEmail(login?.email ?? m.email)
    if (e) emailsCobertos.add(e)
    if (m.user_id) {
      const ativo = !!m.active && !login?.banido
      lista.push({
        chave: `m:${m.id}`, memberId: m.id, userId: m.user_id,
        nome: m.name, email: login?.email ?? m.email,
        nivel: nivelValido(m.level) ?? 'junior', temPin: m.temPin,
        situacao: ativo ? 'ativo' : 'inativo', conviteExpira: null, conviteNivel: null,
        papel: login?.papel ?? null, title: login?.title ?? null, phone: login?.phone ?? null,
        ultimoAcesso: login?.ultimoAcesso ?? null,
      })
      continue
    }
    const convite = e ? convitePorEmail.get(e) : undefined
    lista.push({
      chave: `m:${m.id}`, memberId: m.id, userId: null,
      nome: m.name, email: m.email, nivel: null, temPin: false,
      situacao: !m.active ? 'inativo' : convite ? 'convidado' : 'sem-login',
      conviteExpira: m.active && convite ? convite.expires_at : null,
      conviteNivel: m.active && convite ? nivelDoPapel(convite.role) : null,
      papel: null, title: null, phone: null, ultimoAcesso: null,
    })
  }

  for (const l of p.logins) {
    if (vinculados.has(l.id) || !p.ehDaFirma(l.papel)) continue
    const e = normEmail(l.email)
    if (e) emailsCobertos.add(e)
    lista.push({
      chave: `u:${l.id}`, memberId: null, userId: l.id,
      nome: String(l.nome || '').trim() || (e ? e.split('@')[0] : l.id),
      email: l.email, nivel: nivelDoPapel(l.papel), temPin: false,
      situacao: l.banido ? 'inativo' : 'sem-cadastro', conviteExpira: null, conviteNivel: null,
      papel: l.papel, title: l.title, phone: l.phone, ultimoAcesso: l.ultimoAcesso,
    })
  }

  for (const [e, c] of Array.from(convitePorEmail.entries())) {
    if (emailsCobertos.has(e)) continue
    lista.push({
      chave: `c:${c.id}`, memberId: null, userId: null,
      nome: c.name, email: c.email, nivel: null, temPin: false,
      situacao: 'convidado', conviteExpira: c.expires_at, conviteNivel: nivelDoPapel(c.role),
      papel: c.role, title: c.title ?? null, phone: c.phone ?? null, ultimoAcesso: null,
    })
  }

  return lista.sort((a, b) =>
    ORDEM[a.situacao] - ORDEM[b.situacao] || a.nome.localeCompare(b.nome, 'pt-BR'))
}
