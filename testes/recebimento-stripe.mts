import { filtroDeRecebimento } from '../lib/recebimento-stripe.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// O filtro cobre as duas colunas onde a chave pode ter sido gravada
eq('uma chave, duas colunas', filtroDeRecebimento('pi_1'),
  'stripe_object.eq.pi_1,reference.eq.pi_1')
eq('sessao e intent juntos', filtroDeRecebimento('cs_1', 'pi_1'),
  'stripe_object.eq.cs_1,reference.eq.cs_1,stripe_object.eq.pi_1,reference.eq.pi_1')

// sem chave nao se procura (e quem chama nao grava)
eq('nenhuma chave', filtroDeRecebimento(), null)
eq('so nulos', filtroDeRecebimento(null, undefined, ''), null)
eq('id invalido e descartado', filtroDeRecebimento('pi bom, ruim'), null)
eq('valido sobrevive ao invalido', filtroDeRecebimento('pi_ok', 'x,y'),
  'stripe_object.eq.pi_ok,reference.eq.pi_ok')
eq('repetido nao duplica', filtroDeRecebimento('pi_1', 'pi_1'),
  'stripe_object.eq.pi_1,reference.eq.pi_1')

// --- o que importa de verdade: NENHUMA ordem de chegada lanca duas vezes ---
// Simula a tabela e os dois caminhos do webhook.
function banco() {
  const linhas: any[] = []
  return {
    linhas,
    // devolve true quando o caminho GRAVOU (ou seja, nao achou nada antes)
    tentar(filtro: string | null, linha: any) {
      if (!filtro) return false
      const chaves = filtro.split(',').map(c => c.split('.eq.')[1])
      const achou = linhas.some(l => chaves.includes(l.stripe_object) || chaves.includes(l.reference))
      if (achou) return false
      linhas.push(linha)
      return true
    },
  }
}
const CS = 'cs_abc', PI = 'pi_abc'
const porSessao = (b: any) => b.tentar(filtroDeRecebimento(CS, PI), { stripe_object: CS, reference: PI })
const porIntent = (b: any) => b.tentar(filtroDeRecebimento(PI), { stripe_object: PI, reference: PI })

let b = banco()
eq('sessao primeiro: grava', porSessao(b), true)
eq('...e o intent depois nao grava', porIntent(b), false)
eq('uma linha so', b.linhas.length, 1)

b = banco()
eq('intent primeiro: grava', porIntent(b), true)
eq('...e a sessao depois nao grava', porSessao(b), false)
eq('uma linha so (ordem inversa)', b.linhas.length, 1)

// reentrega do MESMO evento tambem nao duplica
b = banco()
porSessao(b); porSessao(b); porSessao(b)
eq('reenvio do mesmo evento nao duplica', b.linhas.length, 1)

b = banco()
porIntent(b); porSessao(b); porIntent(b); porSessao(b)
eq('alternando os dois eventos nao duplica', b.linhas.length, 1)

// pagamento DIFERENTE na mesma fatura continua entrando (nao pode travar tudo)
b = banco()
porIntent(b)
eq('outro pagamento entra normalmente',
  b.tentar(filtroDeRecebimento('pi_outro'), { stripe_object: 'pi_outro', reference: 'pi_outro' }), true)
eq('duas linhas', b.linhas.length, 2)

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
