'use client'
// components/SeletorPeriodo.tsx — o período de um relatório, escolhido do
// mesmo jeito em toda tela: um atalho (este mês, mês passado, último
// trimestre, este ano, ano passado) ou duas datas livres.
//
// A conta de cada atalho é de lib/periodo-relatorio.ts (pura, com teste); o
// "hoje" dos atalhos é o dia do ESCRITÓRIO (`dataDaFirma`), não o do
// navegador — o Financeiro oferecia "este mês" pela data UTC, que às 21h de
// Malden já é o mês seguinte.
//
// O componente não decide o padrão: quem o usa manda o período inicial
// (o Financeiro nasce em "este ano", a contabilidade em "ano passado").

import { PRESETS, periodoDoPreset, periodoValido, type Periodo, type PresetId } from '@/lib/periodo-relatorio'
import { dataDaFirma } from '@/lib/dia-da-firma'

export type TextosDoSeletor = {
  presets?: Partial<Record<PresetId, string>>
  de?: string
  ate?: string
  invalido?: string
}

export default function SeletorPeriodo({ valor, onChange, textos, compacto }: {
  valor: Periodo
  onChange: (p: Periodo) => void
  textos?: TextosDoSeletor
  compacto?: boolean
}) {
  const hoje = dataDaFirma(new Date())
  const ok = periodoValido(valor.de, valor.ate)
  // O atalho aceso é DERIVADO do período, não guardado: o padrão com que a
  // tela nasce já aparece aceso, e mexer numa data apaga o atalho sozinho.
  const ativo: PresetId | null = PRESETS.find(p => {
    const q = periodoDoPreset(p.id, hoje)
    return q.de === valor.de && q.ate === valor.ate
  })?.id ?? null

  const escolher = (id: PresetId) => onChange(periodoDoPreset(id, hoje))
  const mudar = (campo: 'de' | 'ate', v: string) => onChange({ ...valor, [campo]: v })

  const botao = (id: PresetId, rotulo: string) => (
    <button key={id} type="button" onClick={() => escolher(id)} aria-pressed={ativo === id}
      style={{ background: ativo === id ? '#2D3278' : '#fff', color: ativo === id ? '#fff' : '#2D3278',
               border: '1.5px solid #cfdaea', borderRadius: 8, padding: compacto ? '5px 9px' : '6px 10px',
               fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
      {rotulo}
    </button>
  )
  const campo = (v: string, aoMudar: (x: string) => void, rotulo: string) => (
    <input type="date" value={v} onChange={e => aoMudar(e.target.value)} aria-label={rotulo}
      style={{ padding: compacto ? '5px 8px' : '7px 10px', border: `1.5px solid ${ok ? '#cfdaea' : '#b02020'}`,
               borderRadius: 8, fontSize: 13 }} />
  )

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {PRESETS.map(p => botao(p.id, textos?.presets?.[p.id] || p.rotulo))}
      <span style={{ fontSize: 12, color: '#6a7a9a' }}>{textos?.de || 'de'}</span>
      {campo(valor.de, v => mudar('de', v), textos?.de || 'de')}
      <span style={{ fontSize: 12, color: '#6a7a9a' }}>{textos?.ate || 'até'}</span>
      {campo(valor.ate, v => mudar('ate', v), textos?.ate || 'até')}
      {!ok && (
        <span style={{ fontSize: 12, color: '#b02020', fontWeight: 700 }}>
          {textos?.invalido || 'Período inválido: a data inicial tem de vir antes da final.'}
        </span>
      )}
    </div>
  )
}
