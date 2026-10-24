// testes/equipe.mts — a equipe num lugar só (lib/equipe.ts)
//
// Não é dinheiro, mas decide quem chega ao dinheiro: o nível é a raiz da
// matriz inteira (quem recebe, quem estorna, quem vê os totais). E as três
// regras aqui já erraram em produção: o nível reescrito por uma edição de
// telefone, o convite antigo que devolvia o nível de antes, e o mesmo
// funcionário duas vezes no seletor do CRM.

import {
  nivelDoPapel, nivelValido, papelDoNivel, decidirMudancaDeNivel, decidirConvite,
  escolherMembroParaVincular, montarListaDaEquipe, NIVEIS,
  type MembroExistente, type MembroDaLista, type LoginDaLista, type ConviteDaLista,
} from '../lib/equipe.ts'
import { ehDaFirma } from '../lib/papeis.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── A tradução porta → nível ──
for (const p of ['firm', 'owner', 'admin']) eq(`papel ${p} da nivel de socio`, nivelDoPapel(p), 'owner')
eq('papel manager da gerente', nivelDoPapel('manager'), 'manager')
for (const p of ['staff', 'client', '', 'socio', 'administrator'])
  eq(`papel "${p}" da o nivel mais restrito`, nivelDoPapel(p), 'junior')
eq('papel nulo e assistente', nivelDoPapel(null), 'junior')
eq('papel indefinido e assistente', nivelDoPapel(undefined), 'junior')
eq('caixa e espaco nao mudam o papel', nivelDoPapel(' Firm '), 'owner')

eq('nivel valido', nivelValido('owner'), 'owner')
eq('nivel com caixa e espaco', nivelValido(' Manager '), 'manager')
eq('"socio" nao e nivel', nivelValido('socio'), null)
eq('nulo nao e nivel', nivelValido(null), null)
eq('numero nao e nivel', nivelValido(1), null)

// ── O papel acompanha o nível ──
eq('socio mantem admin', papelDoNivel('owner', 'admin'), 'admin')
eq('socio mantem firm', papelDoNivel('owner', 'firm'), 'firm')
eq('socio mantem owner', papelDoNivel('owner', 'owner'), 'owner')
eq('gerente promovido a socio ganha firm', papelDoNivel('owner', 'manager'), 'firm')
eq('socio sem papel ganha firm', papelDoNivel('owner', null), 'firm')
eq('socio rebaixado a gerente perde o papel de socio', papelDoNivel('manager', 'firm'), 'manager')
eq('assistente e staff', papelDoNivel('junior', 'firm'), 'staff')
// O defeito que isto fecha: papel e nível discordando. Em toda combinação,
// o papel gravado devolve o MESMO nível e continua abrindo a porta.
for (const n of NIVEIS) for (const p of ['firm', 'owner', 'admin', 'manager', 'staff', null]) {
  eq(`papel de ${n} (antes ${p}) devolve ${n}`, nivelDoPapel(papelDoNivel(n, p)), n)
  eq(`papel de ${n} (antes ${p}) abre a porta`, ehDaFirma(papelDoNivel(n, p)), true)
}

// ── Mudar o nível ──
const socio = { userId: 'u-socio', nivel: 'owner' as const }
const pedido = (x: any = {}) => decidirMudancaDeNivel({
  quemChama: socio, alvo: { userId: 'u-ana', nivel: 'manager' }, novo: 'junior', motivo: 'saiu da gerencia', ...x,
})
eq('gerente nao muda nivel', (pedido({ quemChama: { userId: 'u-g', nivel: 'manager' } }) as any).status, 403)
eq('assistente nao muda nivel', (pedido({ quemChama: { userId: 'u-j', nivel: 'junior' } }) as any).status, 403)
eq('gerente pedindo para si leva o 403 do socio primeiro',
   (pedido({ quemChama: { userId: 'u-ana', nivel: 'manager' }, novo: 'owner' }) as any).erro,
   'Só o sócio muda o nível de alguém da equipe.')
eq('sem login nao tem nivel', (pedido({ alvo: { userId: null, nivel: null } }) as any).status, 409)
eq('ninguem muda o proprio nivel', (pedido({ alvo: { userId: 'u-socio', nivel: 'owner' }, novo: 'manager' }) as any).status, 403)
eq('nivel desconhecido', (pedido({ novo: 'socio' }) as any).status, 400)
eq('nivel nulo', (pedido({ novo: null }) as any).status, 400)
eq('o mesmo nivel nao enche a trilha', (pedido({ novo: 'manager' }) as any).erro, 'Já é Gerente. Nada a mudar.')
// Login da firma sem linha na equipe: confirmar o MESMO nível cria a linha
// — sem isso a tela mandava "mude o nível para acertar" e a rota recusava.
eq('sem cadastro: o mesmo nivel e aceito (cria a linha)',
   pedido({ alvo: { userId: 'u-ana', nivel: 'manager', semCadastro: true }, novo: 'manager' }).ok, true)
eq('sem cadastro nao dispensa o motivo',
   (pedido({ alvo: { userId: 'u-ana', nivel: 'manager', semCadastro: true }, novo: 'manager', motivo: '' }) as any).status, 400)
eq('sem motivo', (pedido({ motivo: '' }) as any).status, 400)
eq('motivo de espacos', (pedido({ motivo: '     ' }) as any).status, 400)
eq('motivo curto depois do trim', (pedido({ motivo: '  abc  ' }) as any).status, 400)
eq('motivo de 5 letras basta', pedido({ motivo: 'abcde' }).ok, true)
eq('rebaixar a assistente apaga o PIN', pedido(), { ok: true, nivel: 'junior', zerarPin: true, motivo: 'saiu da gerencia' })
eq('promover a socio mantem o PIN',
   pedido({ alvo: { userId: 'u-ana', nivel: 'manager' }, novo: 'owner' }),
   { ok: true, nivel: 'owner', zerarPin: false, motivo: 'saiu da gerencia' })
eq('nivel com caixa e espaco e aceito',
   (pedido({ alvo: { userId: 'u-j', nivel: 'junior' }, novo: ' Manager ' }) as any).nivel, 'manager')
eq('socio rebaixa outro socio (tirar poder de socio e pelo nivel)',
   pedido({ alvo: { userId: 'u-outro', nivel: 'owner' }, novo: 'manager' }).ok, true)

// ── Convidar ──
const logins = [
  { id: 'u-ana', email: 'Ana@PeaceOnTax.com', papel: 'firm' },
  { id: 'u-cli', email: 'cliente@gmail.com', papel: 'client' },
]
const convite = (email: unknown, nivel: unknown) => decidirConvite({ email, nivel, logins, ehDaFirma })
eq('e-mail invalido', (convite('nao-e-email', 'junior') as any).status, 400)
eq('e-mail vazio', (convite('', 'junior') as any).status, 400)
eq('sem nivel', (convite('nova@p.com', '') as any).status, 400)
eq('nivel que nao existe', (convite('nova@p.com', 'socio') as any).status, 400)
eq('quem ja tem login na equipe nao se reconvida (caixa e espaco)',
   (convite('  ana@peaceontax.COM ', 'junior') as any).erro,
   'Esta pessoa já tem login na equipe. Para mudar o acesso use Nível; se ela saiu, Reativar.')
eq('login de cliente nao vira equipe por convite', /CLIENTE/.test((convite('cliente@gmail.com', 'junior') as any).erro), true)
eq('convite de socio', convite(' Nova@P.com', 'owner'), { ok: true, email: 'nova@p.com', nivel: 'owner', papel: 'firm' })
eq('convite de gerente', (convite('g@p.com', 'manager') as any).papel, 'manager')
eq('convite de assistente', (convite('a@p.com', 'junior') as any).papel, 'staff')

// ── O aceite completa a linha que já existia ──
const crm: MembroExistente[] = [
  { id: 'm-ana',    name: 'Ana Gerente',    email: 'ana@p.com',      user_id: 'u-ana', active: true },
  { id: 'm-david',  name: 'David L.',       email: 'David@P.com ',   user_id: null,    active: true },
  { id: 'm-joao',   name: 'João Pereira',   email: null,             user_id: null,    active: true },
  { id: 'm-carla',  name: 'Carla',          email: 'carla@antiga.com', user_id: null,  active: true },
  { id: 'm-bia-v',  name: 'Bia Velha',      email: 'bia@p.com',      user_id: null,    active: false },
  { id: 'm-bia',    name: 'Bia',            email: 'bia@p.com',      user_id: null,    active: true },
]
const vinc = (userId: string, email: string | null, nome: string | null) =>
  escolherMembroParaVincular(crm, { userId, email, nome })
eq('a linha que ja tem o login', vinc('u-ana', 'outra@p.com', 'Outra'), { tipo: 'ja-vinculado', id: 'm-ana' })
eq('mesmo e-mail (caixa e espaco)', vinc('u-david', 'david@p.com', 'David Lazzarotto'), { tipo: 'vincular', id: 'm-david', por: 'email' })
eq('dois livres com o e-mail: a linha ATIVA', vinc('u-bia', 'bia@p.com', 'Bia'), { tipo: 'vincular', id: 'm-bia', por: 'email' })
eq('linha ja vinculada a outro login nao e livre',
   vinc('u-x', 'ana@p.com', 'Ana Gerente'), { tipo: 'inserir', nome: 'Ana Gerente (ana@p.com)' })
eq('mesmo nome sem acento, caixa ou ponto', vinc('u-joao', 'joao@p.com', 'joao pereira.'), { tipo: 'vincular', id: 'm-joao', por: 'nome' })
eq('mesmo nome e OUTRO e-mail nao e a mesma pessoa',
   vinc('u-carla', 'carla.nova@p.com', 'Carla'), { tipo: 'inserir', nome: 'Carla (carla.nova@p.com)' })
eq('ninguem parecido', vinc('u-novo', 'novo@p.com', 'Novo Funcionario'), { tipo: 'inserir', nome: 'Novo Funcionario' })
eq('sem nome usa o comeco do e-mail', vinc('u-z', 'zeca@p.com', '  '), { tipo: 'inserir', nome: 'zeca' })
eq('sem nome e sem e-mail usa o login', vinc('u-z', null, null), { tipo: 'inserir', nome: 'u-z' })
eq('so a lista vazia', escolherMembroParaVincular([], { userId: 'u', email: 'a@b.com', nome: 'A' }), { tipo: 'inserir', nome: 'A' })

// ── A lista da tela ──
const agora = new Date('2026-10-16T12:00:00Z')
const membros: MembroDaLista[] = [
  { id: 'm1', name: 'David L.',  email: 'david@p.com', user_id: 'u1', active: true,  level: 'owner',   temPin: true },
  { id: 'm2', name: 'Ana',       email: 'ana@p.com',   user_id: 'u2', active: true,  level: 'manager', temPin: false },
  { id: 'm3', name: 'Ex',        email: 'ex@p.com',    user_id: 'u3', active: true,  level: 'junior',  temPin: false },
  { id: 'm4', name: 'Saiu',      email: 'saiu@p.com',  user_id: 'u4', active: false, level: 'junior',  temPin: false },
  { id: 'm5', name: 'Estranho',  email: 'e@p.com',     user_id: 'u5', active: true,  level: 'admin',   temPin: false },
  { id: 'm6', name: 'Carlos',    email: 'carlos@x.com', user_id: null, active: true, level: 'junior',  temPin: false },
  { id: 'm7', name: 'Antigo',    email: null,          user_id: null, active: false, level: 'junior',  temPin: false },
  { id: 'm8', name: 'Zuleica',   email: 'zu@x.com',    user_id: null, active: true,  level: 'junior',  temPin: false },
]
const L = (id: string, email: string, papel: string, banido = false): LoginDaLista =>
  ({ id, email, papel, nome: null, title: null, phone: null, banido, ultimoAcesso: null })
const listaLogins: LoginDaLista[] = [
  L('u1', 'david@p.com', 'firm'), L('u2', 'ana@p.com', 'firm'), L('u3', 'ex@p.com', 'staff', true),
  L('u4', 'saiu@p.com', 'staff'), L('u5', 'e@p.com', 'staff'),
  { ...L('u9', 'semlinha@p.com', 'manager'), nome: 'Sem Linha' },
  L('u10', 'banido-sem-linha@p.com', 'staff', true),
  L('u11', 'cliente@gmail.com', 'client'),
]
const C = (id: string, email: string, role: string, expires_at: string, status = 'pending'): ConviteDaLista =>
  ({ id, email, name: `Convite ${id}`, role, status, expires_at })
const convites: ConviteDaLista[] = [
  C('c1', 'carlos@x.com', 'staff', '2026-10-20T00:00:00Z'),          // para a linha do CRM
  C('c2', 'nova@p.com', 'manager', '2026-10-18T00:00:00Z'),
  C('c3', 'nova@p.com', 'staff', '2026-10-21T00:00:00Z'),            // o mais recente vale
  C('c4', 'vencido@p.com', 'staff', '2026-10-15T00:00:00Z'),
  C('c5', 'aceito@p.com', 'staff', '2026-10-21T00:00:00Z', 'accepted'),
  C('c6', 'ana@p.com', 'staff', '2026-10-21T00:00:00Z'),             // reenvio antigo de quem ja entrou
]
const lista = montarListaDaEquipe({ membros, logins: listaLogins, convites, ehDaFirma, agora })
const por = (chave: string) => lista.find(x => x.chave === chave)
eq('socio com PIN', [por('m:m1')?.situacao, por('m:m1')?.nivel, por('m:m1')?.temPin], ['ativo', 'owner', true])
eq('gerente', por('m:m2')?.nivel, 'manager')
eq('login bloqueado e inativo, mesmo ativo no CRM', por('m:m3')?.situacao, 'inativo')
eq('fora do CRM e inativo', por('m:m4')?.situacao, 'inativo')
eq('nivel estranho na tabela mostra o mais restrito', por('m:m5')?.nivel, 'junior')
eq('so CRM com convite pendente aparece convidado na propria linha',
   [por('m:m6')?.situacao, por('m:m6')?.conviteExpira, por('m:m6')?.nivel], ['convidado', '2026-10-20T00:00:00Z', null])
// O "Reenviar" repete o nível do CONVITE: sem isto, a linha do CRM
// convidada como gerente era reconvidada como assistente.
eq('o nivel do convite viaja na linha do CRM', por('m:m6')?.conviteNivel, 'junior')
eq('o convite da linha do CRM nao aparece de novo', !!por('c:c1'), false)
eq('so CRM inativo', [por('m:m7')?.situacao, por('m:m7')?.nivel], ['inativo', null])
eq('so CRM sem convite', por('m:m8')?.situacao, 'sem-login')
eq('login da firma sem linha aparece, com o nivel da reserva',
   [por('u:u9')?.situacao, por('u:u9')?.nivel, por('u:u9')?.nome], ['sem-cadastro', 'manager', 'Sem Linha'])
eq('login bloqueado sem linha e inativo', por('u:u10')?.situacao, 'inativo')
eq('login de cliente nao entra na lista', lista.some(x => x.userId === 'u11'), false)
eq('dois convites para o mesmo e-mail: um so, o mais recente',
   [lista.filter(x => x.email === 'nova@p.com').length, por('c:c3')?.conviteNivel, por('c:c3')?.situacao], [1, 'junior', 'convidado'])
eq('convite sem login nao tem nivel de login', por('c:c3')?.nivel, null)
eq('quem tem login nao carrega nivel de convite', por('m:m1')?.conviteNivel, null)
eq('convite vencido some', lista.some(x => x.email === 'vencido@p.com'), false)
eq('convite aceito some', lista.some(x => x.email === 'aceito@p.com'), false)
eq('convite velho de quem ja tem login some', !!por('c:c6'), false)
eq('ordem: ativos, convidados, so CRM, inativos',
   lista.map(x => x.situacao),
   ['ativo', 'ativo', 'ativo', 'sem-cadastro', 'convidado', 'convidado', 'sem-login', 'inativo', 'inativo', 'inativo', 'inativo'])
eq('dentro do grupo, por nome', lista.filter(x => x.situacao === 'ativo').map(x => x.nome), ['Ana', 'David L.', 'Estranho'])

console.log(`equipe: ${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
