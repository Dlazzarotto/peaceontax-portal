import { situacaoDaEtapa, resumirEtapas, buscaLiteral, ETAPAS, ZERADO } from '../lib/clientes-grupos.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// Cada etapa cai numa situacao, e TODAS as seis estao mapeadas
eq('Onboarding espera o cliente', situacaoDaEtapa('Onboarding'), 'pendente')
eq('Gathering Docs espera o cliente', situacaoDaEtapa('Gathering Docs'), 'pendente')
eq('In Preparation e com a equipe', situacaoDaEtapa('In Preparation'), 'trabalhando')
eq('Under Review e com a equipe', situacaoDaEtapa('Under Review'), 'trabalhando')
eq('Filed esta concluido', situacaoDaEtapa('Filed'), 'concluido')
eq('Complete esta concluido', situacaoDaEtapa('Complete'), 'concluido')
eq('nenhuma etapa ficou de fora', ETAPAS.every(e => situacaoDaEtapa(e) !== undefined), true)

// Etapa desconhecida nao pode SUMIR da conta: aparece como pendente
eq('etapa estranha vira pendente', situacaoDaEtapa('Etapa Que Nao Existe'), 'pendente')
eq('vazio vira pendente', situacaoDaEtapa(''), 'pendente')
eq('nulo vira pendente', situacaoDaEtapa(null), 'pendente')
eq('espaco em volta nao atrapalha', situacaoDaEtapa('  Filed  '), 'concluido')

// Resumo
eq('sem linhas fica zerado', resumirEtapas([]), ZERADO)
eq('soma por situacao', resumirEtapas([
  { stage: 'Onboarding', quantidade: 5 },
  { stage: 'Gathering Docs', quantidade: 3 },
  { stage: 'In Preparation', quantidade: 2 },
  { stage: 'Under Review', quantidade: 1 },
  { stage: 'Filed', quantidade: 4 },
  { stage: 'Complete', quantidade: 6 },
]), { total: 21, pendente: 8, trabalhando: 3, concluido: 10 })
eq('o total bate com a soma das partes', (() => {
  const r = resumirEtapas([{ stage:'Onboarding', quantidade:7 }, { stage:'Filed', quantidade:9 }, { stage:'Under Review', quantidade:2 }])
  return r.total === r.pendente + r.trabalhando + r.concluido
})(), true)
eq('zero nao conta', resumirEtapas([{ stage: 'Filed', quantidade: 0 }]), ZERADO)
eq('negativo nao subtrai', resumirEtapas([{ stage: 'Filed', quantidade: -5 }]), ZERADO)
eq('quantidade como texto ainda soma', resumirEtapas([{ stage: 'Filed', quantidade: '3' as any }]).concluido, 3)
eq('etapa nula entra como pendente', resumirEtapas([{ stage: null, quantidade: 4 }]), { total:4, pendente:4, trabalhando:0, concluido:0 })

// Busca: o curinga do LIKE precisa ser escapado
eq('porcento escapado', buscaLiteral('100%'), '100\\%')
eq('sublinhado escapado', buscaLiteral('a_b'), 'a\\_b')
eq('barra escapada', buscaLiteral('a\\b'), 'a\\\\b')
eq('texto normal intacto', buscaLiteral('Ronny Maintenance'), 'Ronny Maintenance')
eq('vazio', buscaLiteral(''), '')

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
