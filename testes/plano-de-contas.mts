// testes/plano-de-contas.mts — o que uma edição do plano de contas leva junto
//
// O plano é um só para a carteira inteira, e o lançamento guarda o NOME da
// conta. Renomear, mudar de grupo ou de mãe muda o P&L e o Balanço de todos
// os clientes — inclusive de anos já declarados. E conta que o plano não tem
// vira DESPESA no P&L. É o tipo de regra que se erra lendo.

import {
  planoDaEdicao, planoDaRemocao, recusaDaDesativacao, pedidoDoFormulario, partesDoNome, nomeCompleto,
  chaveDaConta, recusaDoNome, filhasDe, contaDoSistema, CONTAS_DO_SISTEMA,
  GRUPOS_DO_PLANO, ROTULO_DO_GRUPO, type ContaDoPlano,
} from '../lib/plano-de-contas.ts'
import { CONTA_DO_RECEBIMENTO, CONTA_DA_TAXA, CONTA_DO_DEPOSITO } from '../lib/deposito-match.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

const c = (id: string, name: string, kind = 'expense', extra: Partial<ContaDoPlano> = {}): ContaDoPlano =>
  ({ id, name, kind, active: true, form_1099: null, ...extra })

const PLANO: ContaDoPlano[] = [
  c('1', 'Office Expenses'),
  c('2', 'Office Expenses: Supplies'),
  c('3', 'Office Expenses: Software', 'expense', { form_1099: 'NEC' }),
  c('4', 'Rent', 'expense', { form_1099: 'MISC' }),
  c('5', 'Sales', 'income'),
  c('6', 'Equipment', 'asset'),
  c('7', 'Old Stuff', 'expense', { active: false }),
  c('8', 'Transfer', 'non_pnl'),
  c('9', 'Credit Card Payment', 'non_pnl'),
  c('10', CONTA_DA_TAXA, 'expense'),
  c('11', CONTA_DO_RECEBIMENTO, 'income'),
  c('12', 'Meals_Entertainment'),
  c('13', 'MealsXEntertainment: Lunch'),
  c('14', 'Contract Labor', 'cogs', { form_1099: 'NEC' }),
  c('15', 'Legacy', 'equity'),
  c('16', 'Vehicle'),
  c('17', 'Vehicle: Fuel', 'other_expense'),   // dado antigo: grupo diferente da mãe
  c('18', 'Travel'),
]
const conta = (id: string) => PLANO.find(x => x.id === id)!
const USOS: Record<string, number> = {
  'Office Expenses': 3, 'Office Expenses: Supplies': 40, 'Office Expenses: Software': 7,
  'Sales': 120, 'Equipment': 2, 'Rent': 12, 'Vehicle: Fuel': 9,
}
const plano = (id: string, pedido: any, usos = USOS) => planoDaEdicao({ conta: conta(id), pedido, plano: PLANO, usos })

// ── Peças ───────────────────────────────────────────────────────────────
eq('partes de sub-conta', partesDoNome('Office Expenses: Supplies'), { mae: 'Office Expenses', base: 'Supplies' })
eq('partes de conta principal', partesDoNome('Rent'), { mae: null, base: 'Rent' })
eq('nome completo da sub', nomeCompleto('Supplies', 'Office'), 'Office: Supplies')
eq('nome completo da principal', nomeCompleto('Rent', null), 'Rent')
eq('chave ignora maiúscula, acento e espaço', chaveDaConta('  Depósito   de Recebimentos '), chaveDaConta('deposito de recebimentos'))
eq('chave distingue nomes diferentes', chaveDaConta('Rent') === chaveDaConta('Rental'), false)
eq('nome de 1 letra recusa', recusaDoNome('A'), 'Nome: 2 a 60 caracteres.')
eq('nome de 61 recusa', recusaDoNome('x'.repeat(61)), 'Nome: 2 a 60 caracteres.')
eq('nome de 60 passa', recusaDoNome('x'.repeat(60)), null)
eq('dois-pontos recusa', !!recusaDoNome('Office: Supplies'), true)
eq('filhas pelo prefixo exato', filhasDe(conta('1'), PLANO).map(x => x.id), ['2', '3'])
eq('"_" não é curinga (o LIKE antigo casava "MealsX…")', filhasDe(conta('12'), PLANO).length, 0)
eq('conta sem filhas', filhasDe(conta('4'), PLANO).length, 0)

// ── Contas do sistema: o código grava o nome delas ──────────────────────
eq('Transfer é do sistema', !!contaDoSistema('Transfer'), true)
eq('Credit Card Payment é do sistema', !!contaDoSistema('Credit Card Payment'), true)
eq('as três do caixa vêm das constantes do caixa',
  [CONTA_DO_RECEBIMENTO, CONTA_DA_TAXA, CONTA_DO_DEPOSITO].every(n => !!contaDoSistema(n)), true)
eq('são cinco', Object.keys(CONTAS_DO_SISTEMA).length, 5)
eq('conta comum não é', contaDoSistema('Rent'), null)
eq('"toString" não vira conta do sistema', contaDoSistema('toString'), null)
{
  const r: any = plano('8', { nome: 'Transferências' })
  eq('renomear Transfer recusa', r.ok, false)
  eq('… com 409', r.status, 409)
  eq('… e diz quem grava', /motor grava/.test(r.erro), true)
}
eq('Transfer não muda de grupo', (plano('8', { kind: 'expense' }) as any).ok, false)
eq('Transfer não vira sub-conta', (plano('8', { mae: 'Office Expenses' }) as any).ok, false)
eq('conta do caixa não muda de nome', (plano('11', { nome: 'Receitas' }) as any).ok, false)
{
  const r: any = plano('10', { form1099: 'NEC' })
  eq('taxa do Stripe (despesa) aceita a marca do 1099', r.ok, true)
  eq('… e só a marca muda', [r.mudouNome, r.mudouGrupo, r.mudou1099], [false, false, true])
}
eq('Transfer (fora do resultado) não vai para o 1099', (plano('8', { form1099: 'NEC' }) as any).erro, 'Só conta de despesa vai para o 1099.')

// ── Renomear ────────────────────────────────────────────────────────────
{
  const r: any = plano('18', { nome: 'Trips' }, {})
  eq('sem uso: renomeia', r.ok && r.nome, 'Trips')
  eq('sem uso: sem motivo nem senha', [r.exigeMotivo, r.exigeSenha], [false, false])
  eq('resumo diz o nome', r.resumo, 'nome: "Travel" → "Trips"')
}
{
  const r: any = plano('4', { nome: 'Rent & Lease' })
  eq('em uso: pede motivo', r.exigeMotivo, true)
  eq('em uso: renomear não pede senha (o número não muda)', r.exigeSenha, false)
  eq('em uso: conta os lançamentos', r.lancamentos, 12)
  eq('a marca do 1099 fica', r.form1099, 'MISC')
  eq('mudou1099 falso', r.mudou1099, false)
}
{
  const r: any = plano('1', { nome: 'Office' })
  eq('mãe renomeada leva as filhas', r.filhas, [
    { id: '2', de: 'Office Expenses: Supplies', para: 'Office: Supplies' },
    { id: '3', de: 'Office Expenses: Software', para: 'Office: Software' },
  ])
  eq('lançamentos da mãe + filhas', r.lancamentos, 50)
  eq('mãe sem uso direto mas filhas em uso: motivo', r.exigeMotivo, true)
}
{
  const r: any = plano('2', { nome: 'Office Supplies' })
  eq('renomear sub-conta mantém a mãe', r.nome, 'Office Expenses: Office Supplies')
  eq('renomear sub não muda a mãe', r.mudouMae, false)
}
eq('espaço em volta não é mudança', (plano('4', { nome: '  Rent ' }) as any).erro, 'Nada para alterar.')
eq('nada pedido: nada para alterar', (plano('4', {}) as any).erro, 'Nada para alterar.')
eq('dois-pontos no nome recusa', (plano('4', { nome: 'Office Expenses: Rent' }) as any).ok, false)

// ── Nome repetido: sem maiúscula nem acento ─────────────────────────────
{
  const r: any = plano('18', { nome: 'rent' })
  eq('nome igual a outra conta (outra caixa) recusa', [r.ok, r.status], [false, 409])
  eq('… e aponta o caminho de juntar', /apague esta e mova/.test(r.erro), true)
}
eq('acento não disfarça repetido', (plano('18', { nome: 'Taxas de Processamento' }) as any).ok, false)
eq('corrigir a caixa do próprio nome passa', (plano('4', { nome: 'RENT' }) as any).ok, true)
{
  const P = [...PLANO, c('20', 'Office: Supplies')]
  const r: any = planoDaEdicao({ conta: conta('1'), pedido: { nome: 'Office' }, plano: P, usos: USOS })
  eq('filha que viraria nome existente recusa', [r.ok, r.status], [false, 409])
  eq('… e diz qual', /Supplies/.test(r.erro), true)
}

// ── Grupo ───────────────────────────────────────────────────────────────
{
  const r: any = plano('6', { kind: 'expense' })
  eq('grupo de conta em uso: senha E motivo', [r.exigeSenha, r.exigeMotivo], [true, true])
  eq('… com aviso de relatório passado', /inclusive de períodos já fechados/.test(r.avisos.join(' ')), true)
  eq('… resumo', r.resumo, 'grupo: Ativo → Despesas')
}
eq('grupo de conta sem uso: sem senha', (plano('18', { kind: 'cogs' }, {}) as any).exigeSenha, false)
{
  const r: any = plano('1', { kind: 'cogs' })
  eq('mãe muda de grupo: as filhas vão junto', r.filhas.map((f: any) => f.para), ['Office Expenses: Supplies', 'Office Expenses: Software'])
  eq('… cogs é despesa: a marca da filha fica', r.filhasSaemDo1099, 0)
  eq('… senha (filhas em uso)', r.exigeSenha, true)
}
{
  const r: any = plano('1', { kind: 'asset' })
  eq('mãe vira ativo: a filha marcada sai do 1099', r.filhasSaemDo1099, 1)
  eq('… e o aviso diz', /saem do 1099/.test(r.avisos.join(' ')), true)
}
{
  const r: any = plano('4', { kind: 'liability' })
  eq('conta marcada vira passivo: sai do 1099', r.form1099, null)
  eq('… mudou1099', r.mudou1099, true)
  eq('… avisa', /sai do 1099/.test(r.avisos.join(' ')), true)
}
eq('grupo inválido recusa', (plano('4', { kind: 'equity' }) as any).erro, 'Grupo inválido.')
eq('conta em grupo desconhecido: renomear pede o grupo', /grupo desconhecido/.test((plano('15', { nome: 'Legacy Equity' }) as any).erro), true)
eq('… e escolhendo o grupo passa', (plano('15', { nome: 'Legacy Equity', kind: 'non_pnl' }) as any).ok, true)

// ── Conta-mãe ───────────────────────────────────────────────────────────
{
  const r: any = plano('18', { mae: 'Office Expenses' }, {})
  eq('principal vira sub', r.nome, 'Office Expenses: Travel')
  eq('… mudouMae', r.mudouMae, true)
  eq('… grupo é o da mãe', r.kind, 'expense')
}
{
  const r: any = plano('6', { mae: 'Office Expenses' })
  eq('vira sub de mãe de outro grupo: grupo muda junto', [r.kind, r.mudouGrupo], ['expense', true])
  eq('… e conta em uso pede senha', r.exigeSenha, true)
}
eq('sub com grupo diferente do da mãe recusa', /grupo da conta-mãe/.test((plano('18', { mae: 'Office Expenses', kind: 'asset' }) as any).erro), true)
eq('sub mantendo o grupo da mãe passa', (plano('18', { mae: 'Office Expenses', kind: 'expense' }, {}) as any).ok, true)
{
  const r: any = plano('2', { mae: null })
  eq('sub vira principal', r.nome, 'Supplies')
  eq('… mudouMae', r.mudouMae, true)
  eq('… o grupo fica', r.kind, 'expense')
}
eq('mãe vazia também é principal', (plano('2', { mae: '' }) as any).nome, 'Supplies')
eq('mudar de mãe', (plano('2', { mae: 'Rent' }) as any).nome, 'Rent: Supplies')
eq('mãe inexistente recusa', /não encontrada/.test((plano('18', { mae: 'Nada' }) as any).erro), true)
eq('mãe inativa recusa', /inativa/.test((plano('18', { mae: 'Old Stuff' }) as any).erro), true)
eq('mãe que é sub recusa (um nível só)', /um nível/.test((plano('18', { mae: 'Office Expenses: Supplies' }) as any).erro), true)
eq('a própria conta como mãe recusa', /dela mesma/.test((plano('18', { mae: 'Travel' }) as any).erro), true)
{
  const r: any = plano('1', { mae: 'Rent' })
  eq('conta com filhas não vira sub', [r.ok, r.status], [false, 409])
}
{
  const r: any = plano('17', { nome: 'Gas' })
  eq('dado antigo: sub fora do grupo da mãe volta para o grupo dela', [r.kind, r.mudouGrupo], ['expense', true])
  eq('… dito no aviso', /passa para o grupo da mãe/.test(r.avisos.join(' ')), true)
  eq('… em uso: senha', r.exigeSenha, true)
}

// ── 1099 pela edição ────────────────────────────────────────────────────
eq('marca NEC em despesa', (plano('18', { form1099: 'NEC' }) as any).form1099, 'NEC')
eq('marca em receita recusa', (plano('5', { form1099: 'NEC' }) as any).erro, 'Só conta de despesa vai para o 1099.')
eq('formulário estranho recusa', /inválido/.test((plano('18', { form1099: 'K' }) as any).erro), true)
eq('tirar do 1099', (plano('4', { form1099: null }) as any).form1099, null)
eq('só o 1099: sem motivo nem senha, mesmo em uso', ((r: any) => [r.exigeMotivo, r.exigeSenha])(plano('4', { form1099: 'NEC' })), [false, false])
eq('mesma marca: nada para alterar', (plano('4', { form1099: 'MISC' }) as any).erro, 'Nada para alterar.')
eq('vira despesa e marca junto', (plano('6', { kind: 'expense', form1099: 'NEC' }) as any).form1099, 'NEC')

// ── Apagar ──────────────────────────────────────────────────────────────
const rem = (id: string, lancamentos: number, regras: number, destino?: string | null) =>
  planoDaRemocao({ conta: conta(id), plano: PLANO, lancamentos, regras, destino }) as any
eq('conta do sistema não sai', [rem('9', 0, 0).ok, rem('9', 0, 0).status], [false, 409])
eq('conta com filhas não sai', /sub-conta/.test(rem('1', 0, 0).erro), true)
{
  const r = rem('4', 12, 0)
  eq('em uso sem destino recusa', [r.ok, r.status, r.emUso], [false, 409, 12])
}
eq('só regras também pede destino', /1 regra/.test(rem('18', 0, 1).erro), true)
eq('sem uso: sai sem destino e sem motivo', rem('18', 0, 0), { ok: true, destino: null, exigeMotivo: false })
eq('em uso com destino do mesmo grupo: motivo', rem('4', 12, 2, 'Office Expenses'), { ok: true, destino: 'Office Expenses', exigeMotivo: true })
eq('destino de outro grupo recusa', /outro grupo/.test(rem('4', 12, 0, 'Sales').erro), true)
eq('destino inativo recusa', /inativa/.test(rem('4', 12, 0, 'Old Stuff').erro), true)
eq('destino inexistente recusa', /não encontrada/.test(rem('4', 12, 0, 'Nada').erro), true)
eq('destino = a própria conta recusa', /própria/.test(rem('4', 12, 0, 'Rent').erro), true)
eq('destino só com espaço é sem destino', rem('4', 12, 0, '   ').ok, false)

// ── Desativar ───────────────────────────────────────────────────────────
eq('desativar conta do sistema recusa', /sistema/.test(recusaDaDesativacao(conta('8'), 0, 0) || ''), true)
eq('desativar em uso recusa', /12 lançamento/.test(recusaDaDesativacao(conta('4'), 12, 0) || ''), true)
eq('desativar com regra recusa (a importação seguiria lançando)', /2 regra/.test(recusaDaDesativacao(conta('18'), 0, 2) || ''), true)
eq('desativar sem uso passa', recusaDaDesativacao(conta('18'), 0, 0), null)

// ── O formulário da tela: manda só o que mudou ──────────────────────────
{
  const form = (id: string, f: Partial<{ nome: string; mae: string; kind: string; form1099: string }> = {}) => {
    const x = conta(id); const p = partesDoNome(x.name)
    return pedidoDoFormulario(x, { nome: p.base, mae: p.mae || '', kind: x.kind, form1099: x.form_1099 || '', ...f }, PLANO, true)
  }
  eq('formulário intocado não pede nada', form('4'), {})
  eq('só o nome', form('4', { nome: 'Rent & Lease' }), { nome: 'Rent & Lease' })
  eq('nome com espaço em volta igual ao atual não é mudança', form('4', { nome: ' Rent ' }), {})
  eq('escolher a mãe não manda grupo (é o dela)', form('18', { mae: 'Office Expenses', kind: 'asset' }), { mae: 'Office Expenses' })
  eq('sub-conta vira principal', form('2', { mae: '' }), { mae: null })
  eq('sub-conta vira principal e muda de grupo', form('2', { mae: '', kind: 'cogs' }), { mae: null, kind: 'cogs' })
  eq('mudar só o 1099', form('4', { form1099: 'NEC' }), { form1099: 'NEC' })
  eq('tirar do 1099', form('4', { form1099: '' }), { form1099: null })
  eq('grupo que não é de despesa: a marca não vai', form('4', { kind: 'asset', form1099: 'MISC' }), { kind: 'asset' })
  eq('… e a regra tira a marca sozinha',
    ((r: any) => [r.ok, r.form1099])(planoDaEdicao({ conta: conta('4'), pedido: form('4', { kind: 'asset', form1099: 'MISC' }), plano: PLANO, usos: USOS })),
    [true, null])
  eq('sem a migração do 1099, nunca manda a marca',
    pedidoDoFormulario(conta('18'), { nome: 'Travel', mae: '', kind: 'expense', form1099: 'NEC' }, PLANO, false), {})
  eq('grupo desconhecido sem escolha não manda grupo', form('15', { kind: '' }), {})
  eq('… e escolhendo, manda', form('15', { kind: 'non_pnl' }), { kind: 'non_pnl' })
  eq('mãe de despesa e marca nova', form('6', { mae: 'Office Expenses', form1099: 'NEC' }), { mae: 'Office Expenses', form1099: 'NEC' })
}

// ── Os grupos ───────────────────────────────────────────────────────────
eq('oito grupos', GRUPOS_DO_PLANO.length, 8)
eq('todo grupo tem rótulo', GRUPOS_DO_PLANO.every(g => !!ROTULO_DO_GRUPO[g]), true)

console.log(`plano-de-contas: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
