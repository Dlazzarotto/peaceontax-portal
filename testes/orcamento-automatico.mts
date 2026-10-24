// testes/orcamento-automatico.mts — o orçamento da declaração pelos documentos
//
// É preço de serviço: errar para cima cobra do cliente um anexo que ele não
// tem; errar para baixo a firma trabalha de graça. A versão antiga contava
// TODO 1099 como Schedule C e pulava serviço com `active` nulo.

import {
  perfilDosDocumentos, itensDaDeclaracao, tipoDo1099, ehW2, eh1099,
  type ItemDoCatalogo, type DocumentoDoCliente,
} from '../lib/orcamento-automatico.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const doc = (file_name: string, extra: Partial<DocumentoDoCliente> = {}): DocumentoDoCliente => ({ file_name, ...extra })

// ── O tipo do 1099 ──
eq('1099-NEC', tipoDo1099(doc('1099-NEC 2025.pdf')), 'nec')
eq('1099 nec com espaco', tipoDo1099(doc('1099 nec acme.pdf')), 'nec')
eq('1099misc colado', tipoDo1099(doc('1099misc.pdf')), 'misc')
eq('1099-K', tipoDo1099(doc('1099-K paypal.pdf')), 'k')
eq('1099-INT', tipoDo1099(doc('1099-INT chase.pdf')), 'int')
eq('1099_DIV', tipoDo1099(doc('1099_DIV.pdf')), 'div')
eq('1099-B', tipoDo1099(doc('1099-B fidelity.pdf')), 'b')
eq('1099-R', tipoDo1099(doc('1099-R pension.pdf')), 'r')
eq('1099-G', tipoDo1099(doc('1099-G.pdf')), 'g')
eq('SSA-1099 nao e o 1099 comum', tipoDo1099(doc('SSA-1099.pdf')), 'ssa')
eq('pela categoria (interest)', tipoDo1099(doc('scan.pdf', { category: 'Income / Interest' })), 'int')
eq('pela subcategoria (brokerage)', tipoDo1099(doc('x.pdf', { subcategory: 'Brokerage statement' })), 'b')
eq('1099-BB nao e 1099-B', tipoDo1099(doc('1099-BB.pdf')), 'nao_identificado')
eq('1099 sem tipo', tipoDo1099(doc('1099 2025.pdf')), 'nao_identificado')

// ── W-2 e 1099 pelo tipo gravado e pelo nome ──
eq('w2 pelo doc_type', ehW2({ doc_type: 'w2', file_name: 'scan.pdf' }), true)
eq('doc_type de outro tipo vence o nome', ehW2({ doc_type: 'other', file_name: 'W2.pdf' }), false)
eq('W2_2025.pdf (o _ nao e fronteira)', ehW2(doc('W2_2025.pdf')), true)
eq('w-2 com hifen', ehW2(doc('w-2 empresa.pdf')), true)
eq('W22 nao e W-2', ehW2(doc('W22.pdf')), false)
eq('1099 pelo doc_type', eh1099({ doc_type: '1099', file_name: 'scan.pdf' }), true)
eq('1099 pela categoria', eh1099(doc('x.pdf', { category: 'Income / 1099' })), true)

// ── O perfil ──
const docs: DocumentoDoCliente[] = [
  doc('W2 empresa A.pdf'), doc('W2 empresa B.pdf'), doc('w-2 empresa C.pdf'),
  doc('1099-NEC uber.pdf'), doc('1099-INT banco.pdf'), doc('1099-DIV corretora.pdf'),
  doc('1099-B fidelity.pdf'), doc('1099 2025.pdf'),
  doc('1098 mortgage.pdf'), doc('1098-T faculdade.pdf'),
  doc('1095-C empregador.pdf'),
  doc('aluguel.pdf', { category: 'Rental income' }),
]
const p = perfilDosDocumentos(docs, 'Single')
eq('tres W-2', p.w2, 3)
eq('Schedule C: NEC e o nao identificado, nao o INT, DIV ou B', p.scheduleC, 2)
eq('contagem por tipo para a equipe revisar', p.por1099, { nec: 1, int: 1, div: 1, b: 1, nao_identificado: 1 })
eq('INT e DIV levam ao Schedule B', p.scheduleB, true)
eq('1099-B', p.tem1099B, true)
eq('1098 de hipoteca', p.tem1098, true)
eq('1095-C nao pede o Form 8962', p.tem1095A, false)
eq('um aluguel', p.scheduleE, 1)
eq('documentos', p.documentos, 12)
eq('solteiro', p.casado, false)
eq('casado', perfilDosDocumentos([], 'Married Filing Jointly').casado, true)
eq('1098-T sozinho nao e hipoteca', perfilDosDocumentos([doc('1098-T.pdf')], 'Single').tem1098, false)
eq('1098-E sozinho nao e hipoteca', perfilDosDocumentos([doc('1098E loan.pdf')], 'Single').tem1098, false)
eq('1095-A pede o 8962', perfilDosDocumentos([doc('1095-A marketplace.pdf')], 'Single').tem1095A, true)
eq('lista nula', perfilDosDocumentos(null as any, null).documentos, 0)

// ── Os itens, pelo catálogo ──
const C = (id: string, code: string, amount: number, active: boolean | null = true): ItemDoCatalogo =>
  ({ id, code, label: code, amount, active })
const catalogo = [
  C('i-bs', 'base_single', 250), C('i-bm', 'base_married', 350),
  C('i-w2', 'extra_w2', 25), C('i-c', 'schedule_c', 150),
  C('i-1098', 'mortgage_1098', 40), C('i-e', 'schedule_e', 120),
  C('i-b', 'schedule_b', 30), C('i-1099b', 'brokerage_1099b', 60),
  C('i-1095', 'health_1095a', 35),
]
const r = itensDaDeclaracao(p, catalogo) as any
eq('itens do perfil', r.itens.map((i: any) => [i.serviceId, i.qty]), [
  ['i-bs', 1], ['i-w2', 1], ['i-c', 2], ['i-1098', 1], ['i-e', 1], ['i-b', 1], ['i-1099b', 1],
])
eq('total', r.total, 250 + 25 + 300 + 40 + 120 + 30 + 60)
eq('o item leva o id do catalogo e o preco praticado', r.itens[0], { serviceId: 'i-bs', description: 'base_single', qty: 1, unitPrice: 250 })
eq('casado usa a base de casado e inclui 4 W-2',
   (itensDaDeclaracao({ ...p, casado: true, w2: 4 }, catalogo) as any).itens.map((i: any) => i.serviceId).slice(0, 2),
   ['i-bm', 'i-c'])
eq('W-2 dentro do incluso nao cobra extra',
   (itensDaDeclaracao({ ...p, w2: 2 }, catalogo) as any).itens.some((i: any) => i.serviceId === 'i-w2'), false)

// O defeito da versão antiga: active nulo era tratado como inativo.
const comNulo = catalogo.map(c => c.code === 'schedule_c' ? { ...c, active: null } : c)
eq('active nulo conta como ativo',
   (itensDaDeclaracao(p, comNulo) as any).itens.some((i: any) => i.serviceId === 'i-c'), true)
const semC = catalogo.map(c => c.code === 'schedule_c' ? { ...c, active: false } : c)
eq('desativado (false) fica fora',
   (itensDaDeclaracao(p, semC) as any).itens.some((i: any) => i.serviceId === 'i-c'), false)
eq('sem a base nao ha calculo (e a recusa diz qual)',
   itensDaDeclaracao(p, catalogo.filter(c => c.code !== 'base_single')),
   { ok: false, motivo: 'A declaração base (base_single) está desativada ou não existe na tabela de Preços — sem ela não há como calcular.' })
eq('base desativada', itensDaDeclaracao(p, catalogo.map(c => c.code === 'base_single' ? { ...c, active: false } : c)).ok, false)
eq('sem nenhum documento: so a base',
   (itensDaDeclaracao(perfilDosDocumentos([], 'Single'), catalogo) as any).itens.map((i: any) => i.serviceId), ['i-bs'])
eq('total em centavos (0,10 + 0,20)',
   (itensDaDeclaracao({ ...p, w2: 3, scheduleC: 0, tem1098: false, scheduleE: 0, scheduleB: false, tem1099B: false },
     [C('b', 'base_single', 0.1), C('w', 'extra_w2', 0.2)]) as any).total, 0.3)
eq('preco em texto do banco vira numero',
   (itensDaDeclaracao(perfilDosDocumentos([], 'Single'), [{ id: 'b', code: 'base_single', label: 'Base', amount: '275.50', active: true }]) as any).itens[0].unitPrice,
   275.5)

console.log(`orcamento-automatico: ${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
