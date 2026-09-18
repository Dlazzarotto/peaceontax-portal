// testes/tipo-do-cliente.mts — empresa ou pessoa fisica
//
// Decide ACESSO: desde que o assistente ficou restrito a pessoa fisica, o
// tipo diz quem na firma ve a ficha. O erro nao e simetrico:
//   pessoa marcada como empresa → ela desaparece do assistente (incomodo)
//   empresa marcada como pessoa → a carteira dela fica visivel a quem nao
//                                 deveria (falha de acesso)
// Por isso "virar_pessoa" so quando NAO HA NENHUM sinal de empresa.

import { sinaisDeEmpresa, propostaParaEmpresa } from '../lib/tipo-do-cliente.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}
const decisao = (c: any) => propostaParaEmpresa(c).decisao

// ── O CASO: pessoa fisica que o QuickBooks marcou como organizacao ──
eq('pessoa com nome e sobrenome', decisao({ name: 'Maria Silva' }), 'virar_pessoa')
eq('nome com tres partes',        decisao({ name: 'Jose Carlos Pereira' }), 'virar_pessoa')
eq('nome com acento',            decisao({ name: 'João Gonçalves' }), 'virar_pessoa')
eq('nome com apostrofo',         decisao({ name: "Sean O'Brien" }), 'virar_pessoa')
eq('nome com hifen',             decisao({ name: 'Ana Lopez-Reyes' }), 'virar_pessoa')
eq('razao social IGUAL ao nome nao prova nada',
   decisao({ name: 'Maria Silva', business_name: 'Maria Silva' }), 'virar_pessoa')
eq('EIN em branco nao conta',     decisao({ name: 'Maria Silva', ein: '' }), 'virar_pessoa')
eq('EIN so com mascara nao conta', decisao({ name: 'Maria Silva', ein: '--' }), 'virar_pessoa')
eq('tipo de entidade vazio nao conta',
   decisao({ name: 'Maria Silva', business_type: '   ' }), 'virar_pessoa')

// ── Sinal FORTE: fica empresa ──
eq('tem EIN',         decisao({ name: 'Maria Silva', ein: '12-3456789' }), 'manter_empresa')
eq('EIN sem mascara', decisao({ name: 'Maria Silva', ein: '123456789' }), 'manter_empresa')
eq('tipo de entidade', decisao({ name: 'Maria Silva', business_type: 'S-Corp' }), 'manter_empresa')
eq('razao social propria',
   decisao({ name: 'Maria Silva', business_name: 'Silva Tax Prep' }), 'manter_empresa')
for (const suf of ['LLC', 'Inc', 'CORP', 'Ltd', 'LLP', 'PLLC', 'Trust', 'Group', 'Holdings'])
  eq(`sufixo ${suf}`, decisao({ name: `Alpha ${suf}` }), 'manter_empresa')
eq('LLC com ponto',   decisao({ name: 'Alpha L.L.C.' }), 'manter_empresa')
eq('sufixo no meio',  decisao({ name: 'Alpha Inc of Boston' }), 'manter_empresa')

// ── Sinal FRACO: ninguem decide por ele ──
for (const ramo of ['Services', 'Construction', 'Cleaning', 'Market', 'Auto', 'Salon'])
  eq(`ramo ${ramo} vai para revisar`, decisao({ name: `Boston ${ramo}` }), 'revisar')
eq('"&" vai para revisar', decisao({ name: 'Silva & Sons' }), 'revisar')
eq('forte vence fraco',
   decisao({ name: 'Boston Cleaning LLC' }), 'manter_empresa')
eq('forte vence fraco tambem por EIN',
   decisao({ name: 'Boston Cleaning', ein: '12-3456789' }), 'manter_empresa')

// ── Sobrenome que parece ramo: e por isso que fraco nao decide ──
// "Market" e sobrenome real; sem revisar humano, viraria empresa para sempre.
eq('sobrenome Market vai para revisar, nao para empresa',
   decisao({ name: 'Daniel Market' }), 'revisar')

// ── Os motivos aparecem, para a equipe conferir ──
{
  const p = propostaParaEmpresa({ name: 'Alpha LLC', ein: '12-3456789' })
  eq('mostra os dois sinais fortes', p.motivos.length >= 2, true)
  eq('diz que tem EIN', p.motivos.some(m => /EIN/.test(m)), true)
}
{
  const p = propostaParaEmpresa({ name: 'Maria Silva' })
  eq('explica por que virou pessoa',
     /nenhum sinal de empresa/.test(p.motivos[0]), true)
}

// ── sinaisDeEmpresa separa forte de fraco ──
{
  const s = sinaisDeEmpresa({ name: 'Boston Cleaning Services LLC', ein: '12-3456789' })
  eq('fortes juntos', s.fortes.length >= 2, true)
  eq('fraco tambem aparece', s.fracos.length >= 1, true)
}
eq('cadastro vazio nao tem sinal',
   sinaisDeEmpresa({}), { fortes: [], fracos: [] })
eq('nulos nao quebram',
   sinaisDeEmpresa({ name: null, business_name: null, ein: null, business_type: null }),
   { fortes: [], fracos: [] })

console.log(`tipo-do-cliente: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
