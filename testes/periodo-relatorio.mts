// testes/periodo-relatorio.mts — o período dos relatórios
//
// Trimestre, virada de ano e fevereiro são o tipo de data que se erra lendo —
// e o período decide o que entra no P&L e no 1099. Por isso a conta é
// testada, não conferida.

import { periodoDoPreset, periodoDosParametros, dataDeCorteDosParametros, periodoValido, dataValida,
         rotuloDoPeriodo, periodoDeAno, periodoDoMes, ultimoDiaDoMes, anoDe, dataPorExtensoEN } from '../lib/periodo-relatorio.ts'

let passou = 0, falhou = 0
const eq = (n: string, a: any, b: any) => {
  JSON.stringify(a) === JSON.stringify(b) ? passou++
    : (falhou++, console.log('FALHOU:', n, '\n  obtido:', JSON.stringify(a), '\n  esperado:', JSON.stringify(b)))
}

// ── Atalhos ─────────────────────────────────────────────────────────────
eq('este mês', periodoDoPreset('este_mes', '2026-10-13'), { de: '2026-10-01', ate: '2026-10-31' })
eq('este mês: fevereiro bissexto', periodoDoPreset('este_mes', '2028-02-10'), { de: '2028-02-01', ate: '2028-02-29' })
eq('mês passado', periodoDoPreset('mes_passado', '2026-10-13'), { de: '2026-09-01', ate: '2026-09-30' })
eq('mês passado em janeiro é dezembro do ano anterior', periodoDoPreset('mes_passado', '2026-01-05'), { de: '2025-12-01', ate: '2025-12-31' })
eq('este ano', periodoDoPreset('este_ano', '2026-10-13'), { de: '2026-01-01', ate: '2026-12-31' })
eq('ano passado', periodoDoPreset('ano_passado', '2026-10-13'), { de: '2025-01-01', ate: '2025-12-31' })

// Último trimestre é o último COMPLETO.
eq('em outubro, o último trimestre é jul–set', periodoDoPreset('ultimo_trimestre', '2026-10-13'), { de: '2026-07-01', ate: '2026-09-30' })
eq('em dezembro, ainda jul–set', periodoDoPreset('ultimo_trimestre', '2026-12-31'), { de: '2026-07-01', ate: '2026-09-30' })
eq('em janeiro, out–dez do ano anterior', periodoDoPreset('ultimo_trimestre', '2026-01-02'), { de: '2025-10-01', ate: '2025-12-31' })
eq('em março, ainda out–dez do ano anterior', periodoDoPreset('ultimo_trimestre', '2026-03-31'), { de: '2025-10-01', ate: '2025-12-31' })
eq('em abril, jan–mar', periodoDoPreset('ultimo_trimestre', '2026-04-01'), { de: '2026-01-01', ate: '2026-03-31' })
eq('em julho, abr–jun', periodoDoPreset('ultimo_trimestre', '2026-07-15'), { de: '2026-04-01', ate: '2026-06-30' })

// ── Parâmetros da URL (compat com year/month) ───────────────────────────
const get = (o: Record<string, string>) => (k: string) => (k in o ? o[k] : null)
eq('from/to válidos', periodoDosParametros(get({ from: '2026-05-01', to: '2026-07-31' })), { de: '2026-05-01', ate: '2026-07-31' })
eq('from depois de to é nulo (a rota recusa)', periodoDosParametros(get({ from: '2026-07-31', to: '2026-05-01' })), null)
eq('from sem to é nulo', periodoDosParametros(get({ from: '2026-05-01' })), null)
eq('year vira o ano inteiro', periodoDosParametros(get({ year: '2025' })), { de: '2025-01-01', ate: '2025-12-31' })
eq('year + month vira o mês', periodoDosParametros(get({ year: '2025', month: '9' })), { de: '2025-09-01', ate: '2025-09-30' })
eq('month inválido é nulo', periodoDosParametros(get({ year: '2025', month: '13' })), null)
eq('year fora da faixa é nulo', periodoDosParametros(get({ year: '1999' })), null)
eq('nada é nulo', periodoDosParametros(get({})), null)
eq('from/to vencem year', periodoDosParametros(get({ from: '2026-05-01', to: '2026-05-31', year: '2020' })), { de: '2026-05-01', ate: '2026-05-31' })

// ── Data de corte do Balanço ("em tal data") ────────────────────────────
eq('asOf vale', dataDeCorteDosParametros(get({ asOf: '2026-09-30' })), '2026-09-30')
eq('to também serve de corte', dataDeCorteDosParametros(get({ to: '2026-09-30' })), '2026-09-30')
eq('asOf vence to e year', dataDeCorteDosParametros(get({ asOf: '2026-06-30', to: '2026-09-30', year: '2020' })), '2026-06-30')
eq('asOf que não existe é nulo, não 31/12', dataDeCorteDosParametros(get({ asOf: '2026-02-30', year: '2026' })), null)
eq('year vira 31 de dezembro', dataDeCorteDosParametros(get({ year: '2025' })), '2025-12-31')
eq('asOf vazio cai para year', dataDeCorteDosParametros(get({ asOf: '', year: '2025' })), '2025-12-31')
eq('year fora da faixa é nulo', dataDeCorteDosParametros(get({ year: '1999' })), null)
eq('sem nada é nulo', dataDeCorteDosParametros(get({})), null)

// ── Validação ───────────────────────────────────────────────────────────
eq('30 de fevereiro não existe', dataValida('2026-02-30'), false)
eq('29 de fevereiro em bissexto existe', dataValida('2028-02-29'), true)
eq('29 de fevereiro fora de bissexto não', dataValida('2026-02-29'), false)
eq('formato errado', dataValida('10/13/2026'), false)
eq('de > ate inválido', periodoValido('2026-10-13', '2026-10-01'), false)
eq('mesmo dia válido', periodoValido('2026-10-13', '2026-10-13'), true)
eq('último dia de abril', ultimoDiaDoMes(2026, 4), 30)
eq('anoDe', anoDe('2025-12-31'), 2025)
eq('periodoDeAno / periodoDoMes', [periodoDeAno(2024), periodoDoMes(2024, 2)],
  [{ de: '2024-01-01', ate: '2024-12-31' }, { de: '2024-02-01', ate: '2024-02-29' }])

// ── Rótulos ─────────────────────────────────────────────────────────────
eq('ano inteiro', rotuloDoPeriodo('2025-01-01', '2025-12-31'), '2025')
eq('mês inteiro EN', rotuloDoPeriodo('2026-10-01', '2026-10-31'), 'October 2026')
eq('mês inteiro PT', rotuloDoPeriodo('2026-10-01', '2026-10-31', 'pt'), 'Outubro de 2026')
eq('trimestre EN', rotuloDoPeriodo('2026-07-01', '2026-09-30'), 'Q3 2026')
eq('trimestre PT', rotuloDoPeriodo('2025-10-01', '2025-12-31', 'pt'), '4º trimestre de 2025')
eq('dois meses não é trimestre', rotuloDoPeriodo('2026-07-01', '2026-08-31'), 'Jul 1 – Aug 31, 2026')
eq('livre no mesmo ano EN', rotuloDoPeriodo('2026-05-10', '2026-07-20'), 'May 10 – Jul 20, 2026')
eq('livre atravessando o ano EN', rotuloDoPeriodo('2025-11-01', '2026-02-28'), 'Nov 1, 2025 – Feb 28, 2026')
eq('livre PT em MM/DD/YYYY', rotuloDoPeriodo('2026-05-10', '2026-07-20', 'pt'), '05/10/2026 – 07/20/2026')
eq('data por extenso EN', dataPorExtensoEN('2026-10-13'), 'October 13, 2026')

console.log(`periodo-relatorio: ${passou} passaram, ${falhou} falharam`)
if (falhou) process.exit(1)
