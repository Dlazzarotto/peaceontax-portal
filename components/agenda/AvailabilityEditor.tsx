"use client";
// AGENDAMENTO — Configuração de disponibilidade da equipe
// Vai na área staff do portal (e ganha card no hub Ferramentas).
// Cada linha: dia da semana + início + fim, no fuso do profissional.

import { useState } from "react";

export interface AvailabilityRow {
  id?: string;
  weekday: number;
  start_time: string; // "09:00"
  end_time: string;   // "17:00"
  timezone: string;
}

interface Props {
  staffId: string;
  initial: AvailabilityRow[];
  /** Persiste no Supabase (delete-all + insert é aceitável no volume da equipe) */
  onSave: (rows: AvailabilityRow[]) => Promise<void>;
}

const DIAS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const TZS = ["America/New_York", "America/Sao_Paulo", "America/Chicago", "America/Los_Angeles"];

export default function AvailabilityEditor({ staffId, initial, onSave }: Props) {
  const [rows, setRows] = useState<AvailabilityRow[]>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const update = (i: number, patch: Partial<AvailabilityRow>) =>
    setRows(r => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const addRow = () =>
    setRows(r => [...r, { weekday: 1, start_time: "09:00", end_time: "17:00", timezone: "America/New_York" }]);

  async function save() {
    for (const r of rows) {
      if (r.end_time <= r.start_time) {
        setMsg(`Erro: em ${DIAS[r.weekday]}, o fim deve ser depois do início.`);
        return;
      }
    }
    setSaving(true); setMsg("");
    try {
      await onSave(rows);
      setMsg("✓ Disponibilidade salva.");
    } catch (e) {
      setMsg(`Erro ao salvar: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const input = "min-h-[52px] text-[18px] border-2 border-[#2D3278] rounded-xl px-3 bg-white";
  const btn = "min-h-[52px] px-5 rounded-xl text-[18px] font-semibold " +
    "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-[#F47B20]";

  return (
    <div className="space-y-4 text-[18px] text-[#1a1d4d] max-w-2xl">
      <h2 className="text-[22px] font-bold text-[#2D3278]">Meus horários de atendimento</h2>
      <p>Clientes só conseguem agendar dentro destes horários. Reuniões já marcadas e bloqueios são respeitados automaticamente.</p>

      {rows.map((r, i) => (
        <fieldset key={i} className="flex flex-wrap items-end gap-3 border-2 border-[#2D3278]/30 rounded-xl p-3">
          <label className="flex-1 min-w-[140px]">
            <span className="block font-semibold text-[16px]">Dia</span>
            <select className={`${input} w-full`} value={r.weekday}
              onChange={e => update(i, { weekday: Number(e.target.value) })}>
              {DIAS.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
            </select>
          </label>
          <label>
            <span className="block font-semibold text-[16px]">Início</span>
            <input type="time" className={input} value={r.start_time}
              onChange={e => update(i, { start_time: e.target.value })} />
          </label>
          <label>
            <span className="block font-semibold text-[16px]">Fim</span>
            <input type="time" className={input} value={r.end_time}
              onChange={e => update(i, { end_time: e.target.value })} />
          </label>
          <label className="flex-1 min-w-[200px]">
            <span className="block font-semibold text-[16px]">Fuso</span>
            <select className={`${input} w-full`} value={r.timezone}
              onChange={e => update(i, { timezone: e.target.value })}>
              {TZS.map(t => <option key={t}>{t}</option>)}
            </select>
          </label>
          <button aria-label={`Remover horário de ${DIAS[r.weekday]}`}
            className={`${btn} border-2 border-red-700 text-red-700`}
            onClick={() => setRows(rows.filter((_, idx) => idx !== i))}>
            Remover
          </button>
        </fieldset>
      ))}

      <div className="flex flex-wrap gap-3">
        <button className={`${btn} border-2 border-[#2D3278] text-[#2D3278]`} onClick={addRow}>
          + Adicionar horário
        </button>
        <button className={`${btn} bg-[#2D3278] text-white disabled:opacity-40`}
          disabled={saving} onClick={save}>
          {saving ? "Salvando…" : "Salvar disponibilidade"}
        </button>
      </div>

      {msg && <p role="status" className="font-semibold">{msg}</p>}
    </div>
  );
}
