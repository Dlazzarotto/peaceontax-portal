import { lerCsv, chaveDoNome, telefoneDoQuickBooks, tipoDoQuickBooks, planejarImportacao } from '../lib/import-clientes.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// --- CSV com os habitos do QuickBooks: BOM, apostrofo no telefone, virgula no nome ---
const CSV = '﻿Company ID,Name,Email id,Phone no.,Client number,Client type\n'
  + ",2D Quality Logistic LLC,2dqualitylogistic@gmail.com,'+18572373138,,ORGANIZATION\n"
  + ',Abilio de Abreu,abiliodabreu@gmail.com,6174120370,,PERSON\n'
  + ',Mempu Church Boston USA,abiliodabreu@gmail.com,9733360917,,ORGANIZATION\n'
  + ',"United Builders Solutions, INC",ub@ex.com,,,ORGANIZATION\n'
  + ',Sem Telefone Bom,x@ex.com,1234,,PERSON\n'
  + ',Sem Email,,6175550101,,PERSON\n'

const regs = lerCsv(CSV)
eq('BOM nao suja o cabecalho', Object.keys(regs[0])[0], 'Company ID')
eq('leu todas as linhas', regs.length, 6)
eq('virgula dentro de aspas nao parte o campo', regs[3]['Name'], 'United Builders Solutions, INC')
eq('linha em branco no fim nao vira registro', lerCsv(CSV + '\n\n').length, 6)
eq('arquivo vazio', lerCsv(''), [])
eq('so cabecalho', lerCsv('Name,Email id\n'), [])

// --- telefone, no mesmo formato do resto do sistema ---
eq("apostrofo + 11 digitos", telefoneDoQuickBooks("'+18572373138"), '+18572373138')
eq('10 digitos crus', telefoneDoQuickBooks('6174120370'), '+16174120370')
eq('com formatacao', telefoneDoQuickBooks('(617) 412-0370'), '+16174120370')
eq('11 digitos comecando com 1', telefoneDoQuickBooks('16174120370'), '+16174120370')
eq('internacional passa', telefoneDoQuickBooks("'+5511999998888"), '+5511999998888')
eq('4 digitos e lixo', telefoneDoQuickBooks('1234'), null)
eq('2 digitos e lixo', telefoneDoQuickBooks('55'), null)
eq('vazio', telefoneDoQuickBooks(''), null)
eq('nulo', telefoneDoQuickBooks(null), null)

// --- tipo ---
eq('ORGANIZATION vira business', tipoDoQuickBooks('ORGANIZATION'), 'business')
eq('PERSON vira individual', tipoDoQuickBooks('PERSON'), 'individual')
eq('minusculo tambem', tipoDoQuickBooks('organization'), 'business')
eq('vazio cai em individual', tipoDoQuickBooks(''), 'individual')

// --- chave do nome: o que decide se ja existe ---
eq('caixa alta nao muda', chaveDoNome('ABM Capital Group Inc'), chaveDoNome('abm capital group inc'))
eq('acento nao muda', chaveDoNome('Jose Emilio'), chaveDoNome('José Emílio'))
eq('pontuacao nao muda', chaveDoNome('United Builders Solutions, INC'), chaveDoNome('United Builders Solutions INC'))
eq('espaco dobrado nao muda', chaveDoNome('Ana   Maria'), 'ana maria')

// --- o plano, com banco vazio ---
let p = planejarImportacao(regs, [])
eq('todos entram', p.novos.length, 6)
eq('nenhum ja existe', p.jaExistem.length, 0)
eq('telefone ruim descartado, cadastro entra', p.telefonesDescartados, 1)
eq('...e o cliente dele fica sem telefone', p.novos.find(n => n.name === 'Sem Telefone Bom')?.phone, null)
eq('cliente sem e-mail entra', p.novos.find(n => n.name === 'Sem Email')?.email, null)

// O CASO QUE A CARTEIRA REAL ENSINOU: dono e empresa no mesmo e-mail sao
// clientes DIFERENTES e os dois precisam entrar.
eq('dono e empresa entram os dois',
  p.novos.filter(n => n.email === 'abiliodabreu@gmail.com').map(n => n.name).sort(),
  ['Abilio de Abreu', 'Mempu Church Boston USA'])
eq('mas a equipe e avisada', p.emailCompartilhado.length, 1)
eq('...com quem compartilha', p.emailCompartilhado[0].nomes.sort(), ['Abilio de Abreu', 'Mempu Church Boston USA'])

// --- ja cadastrado fica de fora, mesmo escrito diferente ---
p = planejarImportacao(regs, [{ name: '2D QUALITY LOGISTIC LLC' }])
eq('caixa alta reconhece', p.jaExistem.map(x => x.name), ['2D Quality Logistic LLC'])
eq('e nao entra de novo', p.novos.length, 5)

p = planejarImportacao(regs, [{ name: 'qualquer', business_name: 'United Builders Solutions INC' }])
eq('reconhece pela razao social, sem a virgula', p.jaExistem.map(x => x.name), ['United Builders Solutions, INC'])

// --- repetido DENTRO do arquivo entra uma vez so ---
const comRepeticao = lerCsv(CSV + ',2D Quality Logistic LLC,outro@ex.com,6175550000,,ORGANIZATION\n')
p = planejarImportacao(comRepeticao, [])
eq('repetido no arquivo entra uma vez', p.novos.filter(n => n.name === '2D Quality Logistic LLC').length, 1)
eq('...e e relatado', p.repetidosNoArquivo.length, 1)

// --- linha sem nome nao vira cliente fantasma ---
p = planejarImportacao(lerCsv(CSV + ',,fantasma@ex.com,6175550000,,PERSON\n'), [])
eq('linha sem nome e contada', p.semNome, 1)
eq('...e nao entra', p.novos.some(n => n.email === 'fantasma@ex.com'), false)

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
