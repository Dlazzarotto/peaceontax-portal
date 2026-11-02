import { filtroDeRecebimento, lancarRecebimentoStripe } from '../lib/recebimento-stripe.ts'

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

// --- lancarRecebimentoStripe: a MESMA regra para o webhook e para a equipe ---
// Banco falso: guarda as linhas e entende o filtro .or() de duas colunas.
function livro(linhas: any[] = [], erroNaConsulta = false, erroNoInsert = false) {
  const gravadas: any[] = []
  const db: any = {
    gravadas,
    from: () => {
      const q: any = {}
      q.select = () => q
      q.or = (filtro: string) => { q.filtro = filtro; return q }
      q.limit = () => {
        if (erroNaConsulta) return Promise.resolve({ data: null, error: { message: 'timeout' } })
        const chaves = q.filtro.split(',').map((c: string) => c.split('.eq.'))
        const achou = [...linhas, ...gravadas].filter(l => chaves.some(([col, v]: string[]) => l[col] === v))
        return Promise.resolve({ data: achou.slice(0, 1), error: null })
      }
      q.insert = (linha: any) => {
        if (erroNoInsert) return Promise.resolve({ error: { message: 'Recebimento acima do saldo' } })
        gravadas.push(linha); return Promise.resolve({ error: null })
      }
      return q
    },
  }
  return db
}
const entrada = (x: any = {}) => ({ invoiceId: 'inv_1', clientId: 'c1', valor: 250, metodo: 'card',
  referencia: 'pi_entrada', objetoStripe: 'cs_entrada', ...x })
{
  const db = livro()
  const quando = new Date('2026-09-20T15:30:00Z')
  const r = await lancarRecebimentoStripe(db, entrada({ recebidoEm: quando }))
  eq('lanca a entrada', r, { ok: true, lancado: true })
  eq('com a data em que o dinheiro ENTROU, nao a de hoje', db.gravadas[0].received_at, '2026-09-20T15:30:00.000Z')
  eq('as duas chaves gravadas', [db.gravadas[0].stripe_object, db.gravadas[0].reference], ['cs_entrada', 'pi_entrada'])
  eq('reenvio nao lanca de novo', await lancarRecebimentoStripe(db, entrada()), { ok: true, lancado: false })
  eq('uma linha so', db.gravadas.length, 1)
}
{
  // Lançada antes pelo INTENT (outro caminho): a sessão procura pelas duas chaves e acha
  const db = livro([{ stripe_object: 'pi_entrada', reference: null }])
  eq('acha pelo intent em stripe_object', await lancarRecebimentoStripe(db, entrada()), { ok: true, lancado: false })
  eq('e nao grava', db.gravadas.length, 0)
}
{
  const db = livro([], true)
  const r = await lancarRecebimentoStripe(db, entrada()) as any
  eq('consulta que falha NAO grava no escuro', [r.ok, db.gravadas.length], [false, 0])
  eq('e diz por que', /conferir/.test(r.motivo), true)
}
{
  const r = await lancarRecebimentoStripe(livro([], false, true), entrada()) as any
  eq('recusa do banco volta com o texto dele', [r.ok, r.motivo], [false, 'Recebimento acima do saldo'])
}
eq('sem fatura nao lanca', await lancarRecebimentoStripe(livro(), entrada({ invoiceId: null })), { ok: true, lancado: false })
eq('valor zero nao lanca', await lancarRecebimentoStripe(livro(), entrada({ valor: 0 })), { ok: true, lancado: false })
eq('sem chave do Stripe recusa', (await lancarRecebimentoStripe(livro(), entrada({ objetoStripe: '', referencia: null })) as any).ok, false)

console.log(`\n${passou} passaram, ${falhou} falharam`)
process.exit(falhou ? 1 : 0)
