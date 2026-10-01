'use client'
// Fluxo de caixa da firma — o realizado e o projetado.
//
// REALIZADO é o extrato e só ele. O livro guarda também a conta de passagem
// ("Recebimentos a depositar"), que existe para a receita fechar pelo bruto;
// somar as duas contaria o mesmo depósito duas vezes. A separação está em
// `lib/fluxo-de-caixa.ts`, com teste.
//
// PROJETADO é conservador de propósito: fatura vencida fica FORA (aparece à
// parte) e conta a pagar vencida fica DENTRO. Superestimar entrada faz a
// firma gastar o que não tem.
//
// Saldo desconhecido não vira zero: a tela diz que não sabe.

import { useState, useEffect, useCallback } from 'react'
import { money } from '@/lib/format'

const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const rotuloMes = (ym: string) => `${MES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`
const fmtData = (d: string) => {
  const s = String(d || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}` : s
}
const sinal = (v: number) => (v < 0 ? '#b02020' : '#1a6b4a')

const CAIXA = { background: '#fff', borderRadius: 14, border: '1.5px solid #d6e0f0' } as const
const TH: React.CSSProperties = {
  textAlign: 'right', padding: '6px 8px', fontSize: 11.5, fontWeight: 800,
  color: '#6a7a9a', borderBottom: '1.5px solid #e2e8f4', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = { textAlign: 'right', padding: '6px 8px', fontSize: 13, whiteSpace: 'nowrap' }

export default function CaixaFluxo() {
  const [d, setD] = useState<any>(null)
  const [erro, setErro] = useState('')
  const [meses, setMeses] = useState(12)

  const carregar = useCallback(async () => {
    try {
      const r = await fetch(`/api/caixa/fluxo?meses=${meses}`)
      const j = await r.json()
      if (!r.ok) { setErro(j.error || 'Não foi possível abrir o fluxo de caixa.'); setD(null); return }
      setErro(''); setD(j)
    } catch (e) { setErro((e as Error).message) }
  }, [meses])
  useEffect(() => { carregar() }, [carregar])

  const titulo = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
      <div style={{ fontWeight: 800, color: '#0f2340', fontSize: 15 }}>📈 Fluxo de caixa</div>
      <select value={meses} onChange={e => setMeses(Number(e.target.value))}
        style={{ padding: '4px 8px', borderRadius: 8, border: '1.5px solid #cfdaea', fontSize: 12.5 }}>
        {[3, 6, 12, 24].map(n => <option key={n} value={n}>últimos {n} meses</option>)}
      </select>
    </div>
  )

  if (erro) return (
    <div style={{ ...CAIXA, padding: '16px 18px', marginBottom: 20, maxWidth: 900 }}>
      {titulo}
      <div style={{ background: '#fee2e2', border: '1.5px solid #b02020', borderRadius: 10,
                    padding: '10px 13px', color: '#7a1a1a', fontSize: 13 }}>{erro}</div>
    </div>
  )
  if (!d) return (
    <div style={{ ...CAIXA, padding: '16px 18px', marginBottom: 20, maxWidth: 900 }}>
      {titulo}<p style={{ color: '#6a7a9a', fontSize: 13, margin: 0 }}>Carregando…</p>
    </div>
  )

  const { saldo, realizado, projecao } = d
  const maior = Math.max(1, ...realizado.meses.map((m: any) => Math.max(m.entradas, m.saidas)))

  return (
    <div style={{ ...CAIXA, padding: '16px 18px', marginBottom: 20, maxWidth: 900 }}>
      {titulo}
      <p style={{ fontSize: 12.5, color: '#6a7a9a', margin: '0 0 14px' }}>
        O realizado vem do extrato; os recebimentos ainda não depositados ficam de fora
        (eles estão na conta de passagem, não no banco). A projeção conta o que vence
        dos dois lados — fatura já vencida fica fora dela, de propósito.
      </p>

      {/* ── Saldo hoje ───────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ ...CAIXA, padding: '12px 16px', minWidth: 180, background: '#f6f9ff' }}>
          <div style={{ fontSize: 11.5, color: '#6a7a9a', fontWeight: 800 }}>SALDO EM CONTA HOJE</div>
          {saldo.total == null ? (
            <div style={{ fontSize: 14, fontWeight: 700, color: '#c06010', marginTop: 4 }}>
              desconhecido
            </div>
          ) : (
            <div style={{ fontSize: 24, fontWeight: 800, color: sinal(saldo.total) }}>
              {money(saldo.total)}
            </div>
          )}
          {saldo.contas.map((c: any) => (
            <div key={c.id} style={{ fontSize: 11.5, color: '#6a7a9a', marginTop: 2 }}>
              {c.nome}: {c.saldo == null ? 'saldo desconhecido' : money(c.saldo)}
              {/* De ONDE veio o número muda o quanto se confia nele: o banco
                  responde por hoje; o extrato importado, só até a última
                  linha que entrou. */}
              {c.saldo != null && (
                <span style={{ color: c.fonte === 'banco' ? '#1a6b4a' : '#c06010' }}>
                  {' · '}{c.fonte === 'banco' ? 'pelo banco' : 'pelo extrato importado'}
                  {c.em ? ` em ${fmtData(c.em)}` : ''}
                </span>
              )}
            </div>
          ))}
        </div>
        <div style={{ ...CAIXA, padding: '12px 16px', minWidth: 150 }}>
          <div style={{ fontSize: 11.5, color: '#6a7a9a', fontWeight: 800 }}>MÉDIA MENSAL</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: sinal(realizado.mediaLiquida) }}>
            {money(realizado.mediaLiquida)}
          </div>
          <div style={{ fontSize: 11.5, color: '#6a7a9a' }}>
            {realizado.meses.length} {realizado.meses.length === 1 ? 'mês' : 'meses'} com movimento
          </div>
        </div>
        <div style={{ ...CAIXA, padding: '12px 16px', minWidth: 150 }}>
          <div style={{ fontSize: 11.5, color: '#6a7a9a', fontWeight: 800 }}>SALDO PROJETADO</div>
          <div style={{ fontSize: 24, fontWeight: 800,
                        color: projecao.saldoFinal == null ? '#9aa5b8' : sinal(projecao.saldoFinal) }}>
            {projecao.saldoFinal == null ? '—' : money(projecao.saldoFinal)}
          </div>
          <div style={{ fontSize: 11.5, color: '#6a7a9a' }}>depois do que está comprometido</div>
        </div>
      </div>

      {saldo.semSaldo.length > 0 && (
        <div style={{ background: '#fff7e6', border: '1.5px solid #c06010', borderRadius: 10,
                      padding: '9px 13px', color: '#7a4a10', fontSize: 12.5, marginBottom: 14 }}>
          Sem saldo conhecido: {saldo.semSaldo.join(', ')}. O saldo vem do banco, na
          sincronização — clique em <strong>Buscar lançamentos</strong>. Se a conta entrou
          por CSV, ele só existe quando o arquivo traz a coluna de saldo corrido.
        </div>
      )}

      {projecao.alerta && (
        <div style={{ background: '#fee2e2', border: '1.5px solid #b02020', borderRadius: 10,
                      padding: '10px 13px', color: '#7a1a1a', fontSize: 13, marginBottom: 14,
                      fontWeight: 600 }}>
          ⚠ {projecao.alerta}
        </div>
      )}

      {/* ── Realizado ────────────────────────────────────────────────── */}
      <div style={{ fontWeight: 800, color: '#0f2340', fontSize: 13.5, margin: '6px 0 6px' }}>
        Realizado — o que o banco movimentou
      </div>
      {realizado.meses.length === 0 ? (
        <p style={{ fontSize: 13, color: '#6a7a9a', margin: '0 0 14px' }}>
          Nenhum lançamento do extrato no período. Conecte o banco ou busque lançamentos.
        </p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: 16 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
            <thead><tr>
              <th style={{ ...TH, textAlign: 'left' }}>Mês</th>
              <th style={TH}>Entradas</th><th style={TH}>Saídas</th><th style={TH}>Líquido</th>
              <th style={{ ...TH, width: '38%' }}></th>
            </tr></thead>
            <tbody>
              {realizado.meses.map((m: any) => (
                <tr key={m.mes} style={{ borderBottom: '1px solid #eef2f8' }}>
                  <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>{rotuloMes(m.mes)}</td>
                  <td style={{ ...TD, color: '#1a6b4a' }}>{money(m.entradas)}</td>
                  <td style={{ ...TD, color: '#b02020' }}>{money(m.saidas)}</td>
                  <td style={{ ...TD, fontWeight: 800, color: sinal(m.liquido) }}>{money(m.liquido)}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {/* Barra em duas metades: entrada à direita, saída à esquerda */}
                    <div style={{ display: 'flex', alignItems: 'center', height: 12 }}>
                      <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                        <div style={{ width: `${(m.saidas / maior) * 100}%`, height: 10,
                                      background: '#e4a0a0', borderRadius: '3px 0 0 3px' }} />
                      </div>
                      <div style={{ width: 1, height: 12, background: '#cfdaea' }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ width: `${(m.entradas / maior) * 100}%`, height: 10,
                                      background: '#8fc4a8', borderRadius: '0 3px 3px 0' }} />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
              <tr>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 800 }}>Total</td>
                <td style={{ ...TD, fontWeight: 800, color: '#1a6b4a' }}>{money(realizado.entradas)}</td>
                <td style={{ ...TD, fontWeight: 800, color: '#b02020' }}>{money(realizado.saidas)}</td>
                <td style={{ ...TD, fontWeight: 800, color: sinal(realizado.liquido) }}>{money(realizado.liquido)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── Projetado ────────────────────────────────────────────────── */}
      <div style={{ fontWeight: 800, color: '#0f2340', fontSize: 13.5, margin: '6px 0 6px' }}>
        Projetado — o que está comprometido
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 520 }}>
          <thead><tr>
            <th style={{ ...TH, textAlign: 'left' }}>Prazo</th>
            <th style={TH}>A receber</th><th style={TH}>A pagar</th>
            <th style={TH}>Líquido</th><th style={TH}>Saldo projetado</th>
          </tr></thead>
          <tbody>
            {projecao.linhas.map((l: any) => (
              <tr key={l.faixa} style={{ borderBottom: '1px solid #eef2f8' }}>
                <td style={{ ...TD, textAlign: 'left', fontWeight: 700,
                             color: l.faixa === 'vencido' ? '#b02020' : '#0f2340' }}>{l.rotulo}</td>
                <td style={{ ...TD, color: l.receber ? '#1a6b4a' : '#9aa5b8' }}>{money(l.receber)}</td>
                <td style={{ ...TD, color: l.pagar ? '#b02020' : '#9aa5b8' }}>{money(l.pagar)}</td>
                <td style={{ ...TD, color: sinal(l.liquido) }}>{money(l.liquido)}</td>
                <td style={{ ...TD, fontWeight: 800,
                             color: l.saldo == null ? '#9aa5b8' : sinal(l.saldo) }}>
                  {l.saldo == null ? '—' : money(l.saldo)}
                </td>
              </tr>
            ))}
            <tr>
              <td style={{ ...TD, textAlign: 'left', fontWeight: 800 }}>Total</td>
              <td style={{ ...TD, fontWeight: 800, color: '#1a6b4a' }}>{money(projecao.receber)}</td>
              <td style={{ ...TD, fontWeight: 800, color: '#b02020' }}>{money(projecao.pagar)}</td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>

      {projecao.receberVencido > 0 && (
        <div style={{ background: '#fff7e6', border: '1.5px solid #c06010', borderRadius: 10,
                      padding: '10px 13px', color: '#7a4a10', fontSize: 12.5, marginTop: 12 }}>
          <strong>{money(projecao.receberVencido)} vencidos a receber, fora da projeção.</strong>{' '}
          Dinheiro que já era para ter entrado não é previsão, é cobrança — contar com ele
          justamente quando o caixa aperta é como se gasta o que não se tem. Está em
          Financeiro → Relatórios → Contas a receber.
        </div>
      )}

      <p style={{ fontSize: 11.5, color: '#9aa5b8', margin: '12px 0 0' }}>
        Mensalidade ainda não faturada não entra: contrato recorrente é expectativa, não
        compromisso com data. A projeção só conta fatura emitida e conta a pagar lançada.
      </p>
    </div>
  )
}
