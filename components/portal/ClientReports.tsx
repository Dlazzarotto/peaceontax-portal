'use client'
// Contabilidade no portal: o cliente empresarial abre P&L, Balanço,
// Fornecedores e a lista de 1099 do período que escolher.
//
// O relatório é gerado pela rota da API (HTML pronto para imprimir) e abre em
// aba nova. Aqui não há conta nenhuma — a tela só escolhe o período e o
// documento, pelo mesmo seletor da equipe (components/SeletorPeriodo.tsx).
// O texto acompanha o idioma do cadastro do cliente, como no resto do portal.
//
// O 1099 é por ano-calendário (lei), então ele usa o ANO do fim do período
// escolhido e a tela diz isso. O Balanço é "em tal data": usa o fim.

import { useState } from 'react'
import SeletorPeriodo from '@/components/SeletorPeriodo'
import { periodoDoPreset, periodoValido, anoDe, type Periodo } from '@/lib/periodo-relatorio'
import { dataDaFirma } from '@/lib/dia-da-firma'

const T: Record<string, any> = {
  en: {
    title: 'Accounting', period: 'Period',
    intro: 'documents prepared by our team from the entries already reviewed. They open in a new tab, ready to print or save as PDF.',
    pnl: 'Profit & Loss (P&L)', pnlDesc: 'Income, cost of goods and expenses in the period',
    bs: 'Balance Sheet', bsDesc: 'What the business owns, what it owes and the equity at the end of the period',
    vendors: 'Vendors and customers', vendorsDesc: 'How much was paid to each vendor and received from each customer in the period',
    f1099: '1099 — contractors', f1099Desc: 'Who was paid $600 or more for services in the calendar year',
    note: 'These reports are for reference and reflect what has already been checked and posted to the books — recent activity still under review may not appear. Found something that needs fixing? Send us a message and our team will correct it.',
    nota1099: (ano: number) => `1099 is by calendar year: ${ano}`,
    seletor: { presets: { este_mes: 'This month', mes_passado: 'Last month', ultimo_trimestre: 'Last quarter', este_ano: 'This year', ano_passado: 'Last year' }, de: 'from', ate: 'to', invalido: 'Invalid period: the start date must come before the end date.' },
  },
  pt: {
    title: 'Contabilidade', period: 'Período',
    intro: 'documentos gerados pela nossa equipe a partir dos lançamentos já revisados. Abrem em uma nova aba, prontos para imprimir ou salvar em PDF.',
    pnl: 'Demonstrativo de Resultado (P&L)', pnlDesc: 'Receitas, custos e despesas do período',
    bs: 'Balanço Patrimonial (Balance Sheet)', bsDesc: 'O que a empresa tem, o que deve e o patrimônio no fim do período',
    vendors: 'Fornecedores e clientes', vendorsDesc: 'Quanto foi pago a cada fornecedor e recebido de cada cliente no período',
    f1099: '1099 — prestadores de serviço', f1099Desc: 'Quem recebeu US$ 600 ou mais em serviços no ano-calendário',
    note: 'Os relatórios são somente para consulta e refletem o que já foi conferido e lançado nos livros — movimentações recentes em revisão podem não aparecer. Encontrou algo que precisa de ajuste? Fale com a gente pelo chat que nossa equipe corrige.',
    nota1099: (ano: number) => `O 1099 é por ano-calendário: ${ano}`,
    seletor: { presets: { este_mes: 'Este mês', mes_passado: 'Mês passado', ultimo_trimestre: 'Último trimestre', este_ano: 'Este ano', ano_passado: 'Ano passado' }, de: 'de', ate: 'até', invalido: 'Período inválido: a data inicial tem de vir antes da final.' },
  },
  es: {
    title: 'Contabilidad', period: 'Período',
    intro: 'documentos preparados por nuestro equipo a partir de los asientos ya revisados. Se abren en una pestaña nueva, listos para imprimir o guardar en PDF.',
    pnl: 'Estado de Resultados (P&L)', pnlDesc: 'Ingresos, costos y gastos del período',
    bs: 'Balance General', bsDesc: 'Lo que la empresa tiene, lo que debe y el patrimonio al cierre del período',
    vendors: 'Proveedores y clientes', vendorsDesc: 'Cuánto se pagó a cada proveedor y se recibió de cada cliente en el período',
    f1099: '1099 — contratistas', f1099Desc: 'Quién recibió US$ 600 o más por servicios en el año calendario',
    note: 'Los reportes son solo para consulta y reflejan lo que ya fue verificado y registrado en los libros — los movimientos recientes en revisión pueden no aparecer. ¿Encontró algo que necesita ajuste? Escríbanos por el chat y nuestro equipo lo corrige.',
    nota1099: (ano: number) => `El 1099 es por año calendario: ${ano}`,
    seletor: { presets: { este_mes: 'Este mes', mes_passado: 'Mes pasado', ultimo_trimestre: 'Último trimestre', este_ano: 'Este año', ano_passado: 'Año pasado' }, de: 'desde', ate: 'hasta', invalido: 'Período inválido: la fecha inicial debe ser anterior a la final.' },
  },
  zh: {
    title: '会计报表', period: '期间',
    intro: '由我们团队根据已复核的账目生成的文件。在新标签页中打开，可直接打印或保存为 PDF。',
    pnl: '损益表 (P&L)', pnlDesc: '所选期间的收入、成本与费用',
    bs: '资产负债表', bsDesc: '期末的资产、负债与权益',
    vendors: '供应商与客户', vendorsDesc: '所选期间向每个供应商支付以及从每个客户收取的金额',
    f1099: '1099 — 承包商', f1099Desc: '日历年度内服务报酬达到 600 美元及以上的收款人',
    note: '报表仅供参考，反映的是已核对并入账的内容 — 仍在复核中的近期交易可能尚未显示。发现需要调整的地方？请通过聊天告诉我们，我们的团队会更正。',
    nota1099: (ano: number) => `1099 按日历年度：${ano}`,
    seletor: { presets: { este_mes: '本月', mes_passado: '上月', ultimo_trimestre: '上季度', este_ano: '今年', ano_passado: '去年' }, de: '从', ate: '至', invalido: '期间无效：开始日期必须早于结束日期。' },
  },
  fr: {
    title: 'Comptabilité', period: 'Période',
    intro: 'documents préparés par notre équipe à partir des écritures déjà révisées. Ils s’ouvrent dans un nouvel onglet, prêts à imprimer ou à enregistrer en PDF.',
    pnl: 'Compte de résultat (P&L)', pnlDesc: 'Produits, coûts et charges de la période',
    bs: 'Bilan', bsDesc: 'Ce que l’entreprise possède, ce qu’elle doit et les capitaux propres en fin de période',
    vendors: 'Fournisseurs et clients', vendorsDesc: 'Montant payé à chaque fournisseur et reçu de chaque client sur la période',
    f1099: '1099 — prestataires', f1099Desc: 'Qui a reçu 600 $ ou plus pour des services dans l’année civile',
    note: 'Ces rapports sont fournis à titre de consultation et reflètent ce qui a déjà été vérifié et comptabilisé — les mouvements récents en cours de révision peuvent ne pas apparaître. Un ajustement est nécessaire ? Écrivez-nous par le chat et notre équipe corrigera.',
    nota1099: (ano: number) => `Le 1099 est par année civile : ${ano}`,
    seletor: { presets: { este_mes: 'Ce mois', mes_passado: 'Mois dernier', ultimo_trimestre: 'Dernier trimestre', este_ano: 'Cette année', ano_passado: 'Année dernière' }, de: 'du', ate: 'au', invalido: 'Période invalide : la date de début doit précéder la date de fin.' },
  },
}

export default function ClientReports({ clientId, displayName, lang }: {
  clientId: string
  displayName: string
  lang?: string
}) {
  const t = T[lang || 'pt'] || T.pt
  // Nasce em "ano passado": é o exercício que se fecha e se declara.
  const [periodo, setPeriodo] = useState<Periodo>(() => periodoDoPreset('ano_passado', dataDaFirma(new Date())))
  const ok = periodoValido(periodo.de, periodo.ate)
  const ano1099 = anoDe(periodo.ate)

  const open = (path: string, params: Record<string, string>) => {
    if (!ok) return
    const qs = new URLSearchParams({ clientId, ...params })
    window.open(`/api/bookkeeping/${path}?${qs}`, '_blank')
  }

  const card = (accent: string): React.CSSProperties => ({
    display:'flex', alignItems:'center', gap:14, width:'100%', textAlign:'left' as const,
    padding:'18px 18px', background:'#fff', border:'1.5px solid #e2e8f4', borderLeft:`5px solid ${accent}`,
    borderRadius:12, fontSize:15.5, fontWeight:700, color:'#0f2340', cursor: ok ? 'pointer' : 'not-allowed',
    opacity: ok ? 1 : 0.55, marginBottom:10,
  })

  const botao = (accent: string, icone: string, titulo: string, desc: string, acao: () => void) => (
    <button onClick={acao} disabled={!ok} style={card(accent)}>
      <span style={{ fontSize:22 }}>{icone}</span>
      <span style={{ flex:1 }}>
        {titulo}
        <div style={{ fontSize:12, fontWeight:400, color:'#6a7a9a', marginTop:2 }}>{desc}</div>
      </span>
      <span style={{ color:'#9aaab0' }}>→</span>
    </button>
  )

  return (
    <div style={{ maxWidth:760 }}>
      <h1 style={{ fontFamily:'Georgia,serif', fontSize:22, color:'#0f2340', margin:'0 0 4px' }}>
        📊 {t.title}
      </h1>
      <p style={{ fontSize:13.5, color:'#6a7a9a', margin:'0 0 20px', lineHeight:1.55 }}>
        {displayName ? `${displayName} · ` : ''}{t.intro}
      </p>

      <div style={{ background:'#fff', borderRadius:14, padding:'14px 18px', border:'1px solid #e2e8f4', marginBottom:16 }}>
        <div style={{ fontSize:13.5, fontWeight:700, color:'#4a5a70', marginBottom:8 }}>{t.period}</div>
        <SeletorPeriodo valor={periodo} onChange={setPeriodo} textos={t.seletor} />
      </div>

      {botao('#2D3278', '📈', t.pnl,     t.pnlDesc,     () => open('pnl', { from: periodo.de, to: periodo.ate }))}
      {botao('#1a6b4a', '⚖️', t.bs,      t.bsDesc,      () => open('balance-sheet', { asOf: periodo.ate }))}
      {botao('#5a1a8a', '🏪', t.vendors, t.vendorsDesc, () => open('vendors', { from: periodo.de, to: periodo.ate, report: 'vendors' }))}
      {botao('#8a4a0a', '📋', `${t.f1099} · ${ano1099}`, `${t.f1099Desc} — ${t.nota1099(ano1099)}`,
        () => open('vendors', { year: String(ano1099), report: '1099' }))}

      <p style={{ fontSize:12, color:'#9aaab0', lineHeight:1.6, marginTop:18 }}>
        {t.note}
      </p>
    </div>
  )
}
