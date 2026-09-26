// testes/caixa-firma.mts — o cadastro do caixa da própria firma
//
// A firma é uma LINHA em `clients` marcada com `is_firm`, e a marca é
// fronteira de acesso: quem tem a marca some das listas e só o sócio abre.
// Por isso a marca não pode vir do corpo do pedido — se viesse, marcar um
// cliente faria o cliente sumir da carteira.

import { camposDaFirma, criticarFirma, MARCA_DA_FIRMA, idDaFirma, esquecerFirma }
  from '../lib/caixa-firma.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── A lista de campos é fechada ─────────────────────────────────────────
eq('campo comum passa',
  camposDaFirma({ name: 'Peace on Tax Corp' }), { name: 'Peace on Tax Corp' })
eq('espaço em volta sai',
  camposDaFirma({ name: '  Peace on Tax  ' }), { name: 'Peace on Tax' })
eq('vazio vira nulo -- apagar o campo é um ato',
  camposDaFirma({ name: 'X', city: '' }), { name: 'X', city: null })
eq('campo ausente não entra', camposDaFirma({ name: 'X', city: undefined }), { name: 'X' })

// O que NÃO pode vir de fora, e por quê:
eq('is_firm do corpo é ignorado -- marcaria um cliente como firma',
  camposDaFirma({ name: 'X', is_firm: true }), { name: 'X' })
eq('user_id do corpo é ignorado -- amarraria a firma a um login',
  camposDaFirma({ name: 'X', user_id: 'abc' }), { name: 'X' })
eq('type do corpo é ignorado -- a firma é sempre empresa',
  camposDaFirma({ name: 'X', type: 'individual' }), { name: 'X' })
eq('stage, assignee, balance não entram',
  camposDaFirma({ name: 'X', stage: 'won', assignee: 'y', balance: 999 }), { name: 'X' })
eq('corpo vazio não inventa campo', camposDaFirma({}), {})
eq('corpo nulo não estoura', camposDaFirma(null), {})

// ── A crítica ───────────────────────────────────────────────────────────
eq('sem nome não existe caixa', criticarFirma({}), 'Informe o nome da firma.')
eq('nome em branco também', criticarFirma({ name: null }), 'Informe o nome da firma.')
eq('e-mail inválido recusa', criticarFirma({ name: 'X', email: 'nao-e-email' }), 'E-mail inválido.')
eq('e-mail válido passa', criticarFirma({ name: 'X', email: 'a@b.com' }), null)
eq('sem e-mail passa -- não é obrigatório', criticarFirma({ name: 'X' }), null)

{
  const f: any = { name: 'Peace on Tax Corp' }
  criticarFirma(f)
  eq('sem razão social, o impresso usa o nome', f.business_name, 'Peace on Tax Corp')
}
{
  const f: any = { name: 'Peace on Tax Corp', business_name: 'POT LLC' }
  criticarFirma(f)
  eq('razão social informada não é sobrescrita', f.business_name, 'POT LLC')
}

// ── A marca ─────────────────────────────────────────────────────────────
eq('a marca liga is_firm', MARCA_DA_FIRMA.is_firm, true)
eq('a firma é empresa', MARCA_DA_FIRMA.type, 'business')
eq('e nasce ativa', MARCA_DA_FIRMA.active, true)

// ── idDaFirma: a coluna pode ainda não existir ──────────────────────────
// É a diferença entre "ainda não há caixa" e "o sistema inteiro recusa
// acesso até alguém rodar um SQL": canAccessClient chama esta função.
const bancoQue = (resposta: any) => ({
  chamadas: 0,
  from() { return this },
  select() { return this },
  eq() { return this },
  async limit() { (this as any).chamadas++; return resposta },
})

{
  esquecerFirma()
  const db: any = bancoQue({ data: [], error: { code: '42703', message: 'column clients.is_firm does not exist' } })
  eq('coluna ausente devolve null, não estoura', await idDaFirma(db), null)
}
{
  esquecerFirma()
  const db: any = bancoQue({ data: [], error: null })
  eq('sem caixa criado devolve null', await idDaFirma(db), null)
  await idDaFirma(db)
  eq('o null NÃO fica guardado -- o caixa pode nascer daqui a um minuto', db.chamadas, 2)
}
{
  esquecerFirma()
  const db: any = bancoQue({ data: [{ id: 'firma-1' }], error: null })
  eq('acha a firma', await idDaFirma(db), 'firma-1')
  eq('de novo', await idDaFirma(db), 'firma-1')
  eq('o id fica guardado -- o funil de acesso chama isto a cada rota', db.chamadas, 1)
  esquecerFirma()
  eq('esquecerFirma zera o guardado', db.chamadas, 1)
  await idDaFirma(db)
  eq('e a próxima consulta vai ao banco', db.chamadas, 2)
}
esquecerFirma()

console.log(`caixa-firma: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
