'use client'
// AcertarTipoModal — acertar em lote quem é Empresa e quem é Pessoa física
//
// A importação do QuickBooks trouxe muita PESSOA marcada como organização, e
// desde que o tipo virou fronteira de acesso esses cadastros desapareceram de
// quem atende o balcão. Ficha por ficha não se faz com centenas.
//
// A tela segue o desenho da importação, pela mesma razão: MOSTRA O PLANO
// ANTES DE GRAVAR. O que muda quem vê o quê não se aplica em silêncio.
//
// Três grupos, e a diferença entre eles é o ponto:
//   Sem sinal de empresa  → marcados por padrão. É o caso do QuickBooks.
//   Precisam de olho      → DESMARCADOS. Palavra de ramo não decide nada:
//                           "Market" e "Auto" também são sobrenome.
//   Têm sinal de empresa  → não aparecem. Já estão certos.

import { useEffect, useState } from 'react'

interface Linha {
  id: string
  name: string
  business_name?: string | null
  ein?: string | null
  business_type?: string | null
  motivos: string[]
}

export default function AcertarTipoModal(
  { onPronto, onClose }: { onPronto: () => void; onClose: () => void },
) {
  const [plano, setPlano]   = useState<any>(null)
  const [erro, setErro]     = useState('')
  const [carregando, setCarregando] = useState(true)
  const [marcados, setMarcados] = useState<Set<string>>(new Set())
  const [motivo, setMotivo] = useState('')
  const [senha, setSenha]   = useState('')
  const [salvando, setSalvando] = useState(false)
  const [feito, setFeito]   = useState<any>(null)

  useEffect(() => {
    fetch('/api/clients/reclassify')
      .then(r => r.json())
      .then(d => {
        if (d.error) { setErro(d.error); setCarregando(false); return }
        setPlano(d)
        // Sem sinal de empresa já vem marcado; "revisar" não.
        setMarcados(new Set((d.virarPessoa || []).map((l: Linha) => l.id)))
        setCarregando(false)
      })
      .catch(e => { setErro(String(e)); setCarregando(false) })
  }, [])

  const alternar = (id: string) => setMarcados(s => {
    const n = new Set(s)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  const aplicar = async () => {
    setSalvando(true); setErro('')
    const r = await fetch('/api/clients/reclassify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [...marcados], motivo, password: senha }),
    })
    const d = await r.json().catch(() => ({ error: 'Resposta inválida do servidor.' }))
    setSalvando(false); setSenha('')
    if (d.error) { setErro(d.error); return }
    setFeito(d)
  }

  const cx: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(15,35,64,0.6)', display: 'flex',
    alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
  }
  const inp: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: '1.5px solid #e2e8f4',
    borderRadius: 8, fontSize: 13, boxSizing: 'border-box', outline: 'none',
  }

  const grupo = (titulo: string, sub: string, linhas: Linha[], cor: string) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12.5, fontWeight: 800, color: cor, marginBottom: 2 }}>
        {titulo} ({linhas.length})
      </div>
      <p style={{ fontSize: 11.5, color: '#6a7a9a', margin: '0 0 8px', lineHeight: 1.5 }}>{sub}</p>
      {linhas.length === 0 ? (
        <p style={{ fontSize: 13, color: '#9aaab0', margin: 0 }}>Nenhum.</p>
      ) : (
        <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #e2e8f4', borderRadius: 9 }}>
          {linhas.map(l => (
            <label key={l.id} style={{ display: 'flex', gap: 9, alignItems: 'flex-start',
              padding: '8px 11px', borderBottom: '1px solid #f0f4fa', cursor: 'pointer' }}>
              <input type="checkbox" checked={marcados.has(l.id)} onChange={() => alternar(l.id)}
                style={{ marginTop: 3, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0f2340' }}>{l.name}</div>
                <div style={{ fontSize: 11, color: '#6a7a9a', lineHeight: 1.45 }}>
                  {l.motivos.join(' · ')}
                </div>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div style={cx} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 620,
          maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>

        <div style={{ background: 'linear-gradient(135deg,#2D3278,#1a1f5e)', padding: '17px 22px',
          borderRadius: '16px 16px 0 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontFamily: 'Georgia,serif', fontSize: 17, color: '#fff', margin: 0, fontWeight: 400 }}>
            Acertar Empresa × Pessoa física
          </h3>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.15)', border: 'none',
            color: '#fff', width: 28, height: 28, borderRadius: 7, cursor: 'pointer', fontSize: 15 }}>✕</button>
        </div>

        <div style={{ padding: '18px 22px', overflowY: 'auto' }}>
          {carregando ? (
            <p style={{ fontSize: 14, color: '#6a7a9a', margin: 0 }}>Conferindo os cadastros…</p>
          ) : feito ? (
            <>
              <div style={{ background: '#f0fbf4', border: '1px solid #b8e0c8', borderRadius: 11,
                padding: '14px 16px', fontSize: 14, color: '#0f2340', lineHeight: 1.6 }}>
                ✓ {feito.message}
              </div>
              {feito.falhas?.length > 0 && (
                <div style={{ background: '#fdf0f0', border: '1px solid #f0c0c0', borderRadius: 11,
                  padding: '12px 14px', marginTop: 10, fontSize: 12.5, color: '#b02020', lineHeight: 1.55 }}>
                  <strong>Não gravaram:</strong>{' '}
                  {feito.falhas.map((f: any) => `${f.name} (${f.erro})`).join('; ')}
                </div>
              )}
            </>
          ) : (
            <>
              <p style={{ fontSize: 13.5, color: '#4a5a70', margin: '0 0 16px', lineHeight: 1.6 }}>
                A importação do QuickBooks marcou como <strong>Empresa</strong> todo cadastro
                que lá estava como organização — e muita pessoa física está assim.
                Desde que o assistente passou a atender só pessoa física, esses
                cadastros <strong>desapareceram de quem atende o balcão</strong>.
                Dos <strong>{plano?.total ?? 0}</strong> cadastros hoje como Empresa,
                {' '}{plano?.resumo?.manterEmpresa ?? 0} têm sinal de empresa e não aparecem aqui.
              </p>

              {erro && (
                <div style={{ background: '#fdf0f0', color: '#b02020', padding: '9px 13px',
                  borderRadius: 8, fontSize: 13, marginBottom: 14 }}>{erro}</div>
              )}

              {grupo('Sem nenhum sinal de empresa',
                'Sem EIN, sem tipo de entidade, sem razão social própria e sem sufixo jurídico no nome. É o caso típico do QuickBooks.',
                plano?.virarPessoa || [], '#1a6b4a')}

              {grupo('Precisam de olho',
                'Só sinal fraco: palavra de ramo ou "&" no nome. Vêm desmarcados de propósito — "Market" e "Auto" também são sobrenome.',
                plano?.revisar || [], '#c06010')}

              <div style={{ background: '#fff8e8', border: '1.5px solid #f0d8a0', borderRadius: 11,
                padding: '13px 15px', marginTop: 6 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: '#7a5a10', marginBottom: 6 }}>
                  🔐 {marcados.size} cadastro(s) marcados · pede motivo e senha
                </div>
                <p style={{ fontSize: 11.5, color: '#7a5a10', margin: '0 0 10px', lineHeight: 1.5 }}>
                  O motivo fica na ficha de cada cliente. Mudar o tipo muda o portal que
                  ele vê e quem na firma tem acesso à ficha.
                </p>
                <input value={motivo} onChange={e => setMotivo(e.target.value)}
                  placeholder="Motivo (ex.: acerto da importação do QuickBooks)"
                  style={{ ...inp, borderColor: '#e0c880', marginBottom: 8 }} />
                <input type="password" value={senha} onChange={e => setSenha(e.target.value)}
                  placeholder="Sua senha" autoComplete="new-password"
                  style={{ ...inp, borderColor: '#e0c880' }} />
              </div>
            </>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid #e2e8f4',
          display: 'flex', gap: 9, justifyContent: 'flex-end' }}>
          {feito ? (
            <button onClick={() => { onPronto(); onClose() }}
              style={{ background: 'linear-gradient(135deg,#2D3278,#1a1f5e)', color: '#fff',
                border: 'none', padding: '10px 22px', borderRadius: 9, fontSize: 14,
                fontFamily: 'Georgia,serif', fontWeight: 700, cursor: 'pointer' }}>
              Concluir
            </button>
          ) : (
            <>
              <button onClick={onClose}
                style={{ background: '#f8faff', color: '#6a7a9a', border: '1.5px solid #e2e8f4',
                  padding: '10px 16px', borderRadius: 9, fontSize: 13.5, cursor: 'pointer' }}>
                Cancelar
              </button>
              {(() => {
                const travado = salvando || carregando || marcados.size === 0
                  || motivo.trim().length < 5 || !senha
                return (
                  <button onClick={aplicar} disabled={travado}
                    style={{ background: travado ? '#e2e8f4' : 'linear-gradient(135deg,#1A6B4A,#14543a)',
                      color: travado ? '#9aaab0' : '#fff', border: 'none', padding: '10px 22px',
                      borderRadius: 9, fontSize: 14, fontFamily: 'Georgia,serif', fontWeight: 700,
                      cursor: travado ? 'not-allowed' : 'pointer' }}>
                    {salvando ? 'Gravando…'
                      : marcados.size === 0 ? 'Marque ao menos um'
                      : `Passar ${marcados.size} para Pessoa física`}
                  </button>
                )
              })()}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
