import { camposDoCliente, criticarCliente, deveConvidar } from '../lib/novo-cliente.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// O QUE MAIS IMPORTA: campo de fora nao entra na tabela.
// Antes o corpo ia direto para o insert, e user_id amarra o cadastro a um login.
const hostil = camposDoCliente({
  name: 'Ana', email: 'ana@ex.com',
  user_id: '00000000-0000-0000-0000-000000000001',
  balance: 999999, id: 'outro-id', created_at: '1999-01-01', active: false,
})
eq('user_id nao passa', 'user_id' in hostil, false)
eq('balance nao passa', 'balance' in hostil, false)
eq('id nao passa', 'id' in hostil, false)
eq('created_at nao passa', 'created_at' in hostil, false)
eq('o que vale passa', hostil, { name: 'Ana', email: 'ana@ex.com' })

// aparar e normalizar
eq('apara espaco', camposDoCliente({ name: '  Ana Maria  ' }), { name: 'Ana Maria' })
eq('vazio vira null, nao string vazia', camposDoCliente({ name: 'Ana', phone: '   ' }), { name: 'Ana', phone: null })
eq('ausente nao entra', camposDoCliente({ name: 'Ana' }), { name: 'Ana' })
eq('corpo vazio nao quebra', camposDoCliente(null), {})

// critica
eq('sem nome recusa', criticarCliente({}), 'Informe o nome do cliente.')
eq('nome so de espaco recusa', criticarCliente(camposDoCliente({ name: '   ' })), 'Informe o nome do cliente.')
eq('com nome passa', criticarCliente({ name: 'Ana' }), null)
eq('email torto recusa', criticarCliente({ name: 'Ana', email: 'ana@@ex' }), 'E-mail inválido.')
eq('email sem ponto recusa', criticarCliente({ name: 'Ana', email: 'ana@ex' }), 'E-mail inválido.')
eq('email bom passa', criticarCliente({ name: 'Ana', email: 'ana@ex.com' }), null)
eq('sem email passa (balcao sem e-mail)', criticarCliente({ name: 'Ana' }), null)
eq('tipo invalido recusa', criticarCliente({ name: 'X', type: 'ong' }), 'Tipo inválido.')

// empresa sem razao social herda o nome: o impresso precisa de um nome
const emp: any = { name: 'Padaria Boa', type: 'business' }
eq('empresa passa', criticarCliente(emp), null)
eq('...e herda a razao social', emp.business_name, 'Padaria Boa')
const emp2: any = { name: 'Ronny', type: 'business', business_name: 'Ronny Maintenance Inc' }
criticarCliente(emp2)
eq('razao social informada nao e sobrescrita', emp2.business_name, 'Ronny Maintenance Inc')

// convite
eq('com email convida por padrao', deveConvidar({}, { name: 'A', email: 'a@ex.com' }), true)
eq('sem email nao convida', deveConvidar({}, { name: 'A' }), false)
eq('dispensando nao convida', deveConvidar({ convidar: false }, { name: 'A', email: 'a@ex.com' }), false)
eq('convidar=true convida', deveConvidar({ convidar: true }, { name: 'A', email: 'a@ex.com' }), true)
eq('sem email nem convidar=true convida', deveConvidar({ convidar: true }, { name: 'A' }), false)

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
