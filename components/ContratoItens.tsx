'use client'
// components/ContratoItens.tsx — as linhas de um contrato recorrente
//
// O contrato é o MOLDE DE UMA FATURA: itens, desconto, total e prazo. Este
// editor é usado na CRIAÇÃO e na EDIÇÃO, um componente só — duas cópias
// divergiriam, e a conta que elas mostram é dinheiro.
//
// A PRÉVIA SAI DA MESMA FUNÇÃO QUE A ROTA USA (`montarContrato`). Duas telas
// nunca devem calcular o mesmo número de jeitos diferentes, e aqui o número
// é o que o cliente vai pagar todo mês.
//
// O catálogo aparece por linha de propósito: são poucas linhas (duas, três)
// e dezenas de serviços. O caso que derrubou a aba de fornecedores era o
// oposto — milhares de linhas, cada uma com a carteira inteira dentro.

import { montarContrato, vencimentoDaCobranca, PRAZO_MAXIMO } from '@/lib/contrato-recorrente'
import { money } from '@/lib/format'

export interface LinhaDoContrato { description: string; quantity: number; unit_price: number }

const inp: React.CSSProperties = {
  padding: '8px 10px', border: '1.5px solid #E2E8F4', borderRadius: 8,
  fontSize: 14, outline: 'none', fontFamily: 'inherit',
}

export const LINHA_VAZIA: LinhaDoContrato = { description: '', quantity: 1, unit_price: 0 }

export default function ContratoItens({
  itens, setItens, desconto, setDesconto, dueDays, setDueDays, servicos, emissao,
}: {
  itens: LinhaDoContrato[]
  setItens: (l: LinhaDoContrato[]) => void
  desconto: string
  setDesconto: (v: string) => void
  dueDays: string
  setDueDays: (v: string) => void
  servicos: any[]
  emissao?: string | null
}) {
  const mexer = (i: number, campo: keyof LinhaDoContrato, valor: any) =>
    setItens(itens.map((l, k) => k === i ? { ...l, [campo]: valor } : l))

  const conta = montarContrato({ itens, desconto: Number(desconto) || 0 })
  const erro = 'erro' in conta ? conta.erro : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
          <thead><tr>
            {['Serviço', 'Qtd', 'Preço', 'Subtotal', ''].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: '4px 6px', fontSize: 11,
                fontWeight: 800, color: '#6A7A9A', textTransform: 'uppercase' }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {itens.map((l, i) => (
              <tr key={i} style={{ verticalAlign: 'top' }}>
                <td style={{ padding: '4px 6px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <input value={l.description} placeholder="Bookkeeping mensal"
                      onChange={e => mexer(i, 'description', e.target.value)}
                      style={{ ...inp, width: '100%', minWidth: 170 }} />
                    <select value="" onChange={e => {
                        const sv = (servicos || []).find((x: any) => x.id === e.target.value)
                        if (!sv) return
                        setItens(itens.map((x, k) => k === i
                          ? { ...x, description: sv.nome, unit_price: Number(sv.preco) || 0 } : x))
                      }}
                      style={{ ...inp, fontSize: 12, padding: '4px 8px', cursor: 'pointer' }}>
                      <option value="">— pegar do catálogo —</option>
                      {(servicos || []).map((sv: any) => (
                        <option key={sv.id} value={sv.id}>{sv.nome} · {money(sv.preco)}</option>
                      ))}
                    </select>
                  </div>
                </td>
                <td style={{ padding: '4px 6px' }}>
                  <input type="number" min={0} step="0.5" value={l.quantity}
                    onChange={e => mexer(i, 'quantity', Number(e.target.value))}
                    style={{ ...inp, width: 72 }} />
                </td>
                <td style={{ padding: '4px 6px' }}>
                  <input type="number" min={0} step="0.01" value={l.unit_price}
                    onChange={e => mexer(i, 'unit_price', Number(e.target.value))}
                    style={{ ...inp, width: 110 }} />
                </td>
                <td style={{ padding: '10px 6px', fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
                </td>
                <td style={{ padding: '8px 6px' }}>
                  {/* Nunca tira a última: contrato sem linha nenhuma é um
                      acordo vazio, e a rota recusaria de qualquer forma. */}
                  <button type="button" disabled={itens.length <= 1}
                    onClick={() => setItens(itens.filter((_, k) => k !== i))}
                    title={itens.length <= 1 ? 'O contrato precisa de pelo menos um item' : 'Remover esta linha'}
                    style={{ background: 'none', border: 'none', fontSize: 15, fontWeight: 800,
                      color: itens.length <= 1 ? '#CFDAEA' : '#B02020',
                      cursor: itens.length <= 1 ? 'not-allowed' : 'pointer' }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <button type="button" onClick={() => setItens([...itens, { ...LINHA_VAZIA }])}
          style={{ background: 'none', border: 'none', color: '#2D3278', fontSize: 13.5,
            fontWeight: 700, cursor: 'pointer', padding: 0 }}>
          ➕ Acrescentar item
        </button>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>DESCONTO $</span>
          {/* Em DÓLAR, nunca em porcentagem: o campo de entrada do
              parcelamento já custou caro pedindo 25 para dizer $250. */}
          <input type="number" min={0} step="0.01" value={desconto}
            onChange={e => setDesconto(e.target.value)} style={{ ...inp, width: 120 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#6A7A9A' }}>VENCE EM (DIAS)</span>
          <input type="number" min={0} max={PRAZO_MAXIMO} value={dueDays}
            onChange={e => setDueDays(e.target.value)} style={{ ...inp, width: 120 }} />
          <span style={{ fontSize: 11, color: '#9AAAB0' }}>
            0 = no dia da emissão
          </span>
        </label>
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          {!erro && 'total' in conta && (
            <>
              {conta.desconto > 0 && (
                <div style={{ fontSize: 12.5, color: '#6A7A9A' }}>
                  {money(conta.bruto)} − {money(conta.desconto)} de desconto
                </div>
              )}
              <div style={{ fontSize: 22, fontWeight: 800, color: '#1A6B4A' }}>{money(conta.total)}</div>
              {emissao && (
                <div style={{ fontSize: 12, color: '#6A7A9A' }}>
                  emite {emissao.slice(5, 7)}/{emissao.slice(8, 10)} ·
                  {' '}vence {vencimentoDaCobranca(emissao, Number(dueDays) || 0).slice(5).replace('-', '/')}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* A recusa aparece ANTES de gravar, com o mesmo texto que a rota
          devolveria — a trava de verdade continua sendo a do servidor. */}
      {erro && (
        <div style={{ fontSize: 13, fontWeight: 700, color: '#B02020' }}>⚠️ {erro}</div>
      )}
    </div>
  )
}
