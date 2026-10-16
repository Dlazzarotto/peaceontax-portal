'use client'
// components/OcultarValores.tsx — o botão de "não mostrar os valores" do caixa.
//
// Quem passa pela mesa do sócio lê o caixa da firma inteiro — o mesmo motivo
// que fechou a lista de faturas por escopo (lib/escopo-faturas.ts). Aqui a
// tela continua a mesma; só os VALORES em dólar viram •••••• até o botão ser
// clicado de novo. Contagens (quantas faturas, quantos pagamentos) ficam: não
// dizem quanto.
//
// A escolha fica no navegador (localStorage) — é conforto de quem olha, não
// regra do sistema — e falha em silêncio onde o storage não existe (aba
// privada): a tela abre MOSTRANDO, que é o padrão.
//
// `useDinheiro()` é o `money()` de lib/format que respeita o botão. Todo
// componente do caixa formata dinheiro por ele, nunca por `money` direto —
// senão um valor escapa da máscara e o botão vira meia verdade.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { money } from '@/lib/format'

const CHAVE = 'caixa_ocultar_valores'
export const MASCARA = '••••••'

type Estado = { ocultar: boolean; alternar: () => void }
const Ctx = createContext<Estado>({ ocultar: false, alternar: () => {} })

export function OcultarValoresProvider({ children }: { children: ReactNode }) {
  // Nasce MOSTRANDO e só depois lê a escolha salva: o servidor renderiza a
  // página sem storage, e começar escondido para depois mostrar piscaria.
  const [ocultar, setOcultar] = useState(false)
  useEffect(() => {
    try { if (localStorage.getItem(CHAVE) === '1') setOcultar(true) } catch {}
  }, [])
  const alternar = () => setOcultar(atual => {
    const novo = !atual
    try { localStorage.setItem(CHAVE, novo ? '1' : '0') } catch {}
    return novo
  })
  return <Ctx.Provider value={{ ocultar, alternar }}>{children}</Ctx.Provider>
}

export const useOcultarValores = () => useContext(Ctx)

/** `money()` que vira •••••• quando o sócio pediu para não mostrar. */
export function useDinheiro(): (v: unknown) => string {
  const { ocultar } = useOcultarValores()
  return v => (ocultar ? MASCARA : money(v))
}

export function BotaoOcultarValores() {
  const { ocultar, alternar } = useOcultarValores()
  return (
    <button type="button" onClick={alternar} aria-pressed={ocultar}
      title={ocultar ? 'Mostrar os valores de novo' : 'Não mostrar os valores'}
      style={{ padding: '7px 12px', borderRadius: 9, border: '1.5px solid #cfdaea', background: '#fff',
               color: '#334', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {ocultar ? '👁 Mostrar valores' : '🙈 Ocultar valores'}
    </button>
  )
}
