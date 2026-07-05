"use client";
// AGENDAMENTO — Widget do cliente
// Fluxo: tipo de reunião → dia → horário → dados → confirmação
// Acessibilidade: texto ≥18px, alvos ≥52px, alto contraste navy/laranja,
// horários sempre exibidos no fuso do próprio cliente.

import { useEffect, useState } from "react";

interface MeetingType { id: string; name: string; description: string | null; duration_min: number; mode: string }
interface Slot { startUTC: string; endUTC: string; staffId: string }

interface Props {
  meetingTypes: MeetingType[];
  clientId?: string;
  defaultName?: string;
  defaultEmail?: string;
}

const MODE_LABEL: Record<string, string> = {
  video: "📹 Vídeo", phone: "📞 Telefone", in_person: "🏢 Presencial em Malden",
};

export default function BookingWidget({ meetingTypes, clientId, defaultName = "", defaultEmail = "" }: Props) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [type, setType] = useState<MeetingType | null>(null);
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [name, setName] = useState(defaultName);
  const [email, setEmail] = useState(defaultEmail);
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ ics: string; location: string } | null>(null);

  useEffect(() => {
    if (!type || !date) return;
    setLoadingSlots(true);
    setSlots([]);
    fetch(`/api/agenda/slots?meetingTypeId=${type.id}&date=${date}&tz=${encodeURIComponent(tz)}`)
      .then(r => r.json())
      .then(d => setSlots(d.slots ?? []))
      .finally(() => setLoadingSlots(false));
  }, [type, date, tz]);

  const fmtTime = (iso: string) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

  async function confirm() {
    if (!type || !slot) return;
    setSaving(true); setError("");
    try {
      const res = await fetch("/api/agenda/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          meetingTypeId: type.id, staffId: slot.staffId, startUTC: slot.startUTC,
          guestName: name, guestEmail: email, guestPhone: phone,
          guestTimezone: tz, notes, clientId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDone({ ics: data.ics, location: data.location });
      setStep(4);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function downloadICS() {
    if (!done) return;
    const blob = new Blob([done.ics], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "reuniao-peace-on-tax.ics";
    a.click();
  }

  const card = "border-2 border-[#2D3278] rounded-2xl bg-white";
  const btnBase = "min-h-[52px] rounded-xl text-[18px] font-semibold px-5 " +
    "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#F47B20]";
  const input = "w-full min-h-[52px] text-[18px] border-2 border-[#2D3278] rounded-xl px-4 bg-white";

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5 text-[18px] text-[#1a1d4d] max-w-xl">
      <p className="text-[16px]">Horários exibidos no seu fuso: <strong>{tz}</strong></p>

      {step === 1 && (
        <div className="space-y-3">
          <h2 className="text-[22px] font-bold text-[#2D3278]">1 · Escolha o tipo de reunião</h2>
          {meetingTypes.map(mt => (
            <button key={mt.id}
              className={`${card} ${btnBase} w-full text-left p-4 hover:bg-[#2D3278]/5`}
              onClick={() => { setType(mt); setStep(2); }}>
              <span className="block font-bold">{mt.name}</span>
              <span className="block text-[16px] font-normal">
                {mt.duration_min} min · {MODE_LABEL[mt.mode]}
                {mt.description ? ` — ${mt.description}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {step === 2 && type && (
        <div className="space-y-4">
          <h2 className="text-[22px] font-bold text-[#2D3278]">2 · Escolha dia e horário</h2>
          <label className="block">
            <span className="font-semibold">Dia</span>
            <input type="date" min={today} value={date}
              onChange={e => { setDate(e.target.value); setSlot(null); }}
              className={input} />
          </label>

          {loadingSlots && <p role="status">🔎 Buscando horários…</p>}
          {!loadingSlots && date && slots.length === 0 && (
            <p>Nenhum horário livre neste dia. Tente outra data.</p>
          )}

          <div className="grid grid-cols-3 gap-3" role="listbox" aria-label="Horários disponíveis">
            {slots.map(s => (
              <button key={s.startUTC} role="option" aria-selected={slot?.startUTC === s.startUTC}
                className={`${btnBase} border-2 ${
                  slot?.startUTC === s.startUTC
                    ? "bg-[#2D3278] text-white border-[#2D3278]"
                    : "border-[#2D3278] text-[#2D3278] hover:bg-[#2D3278]/10"}`}
                onClick={() => setSlot(s)}>
                {fmtTime(s.startUTC)}
              </button>
            ))}
          </div>

          <div className="flex gap-3">
            <button className={`${btnBase} border-2 border-[#2D3278] text-[#2D3278]`}
              onClick={() => setStep(1)}>← Voltar</button>
            <button className={`${btnBase} bg-[#F47B20] text-white disabled:opacity-40`}
              disabled={!slot} onClick={() => setStep(3)}>Continuar →</button>
          </div>
        </div>
      )}

      {step === 3 && type && slot && (
        <div className="space-y-4">
          <h2 className="text-[22px] font-bold text-[#2D3278]">3 · Seus dados</h2>
          <p className={`${card} p-4`}>
            <strong>{type.name}</strong><br />
            {new Intl.DateTimeFormat("pt-BR", { timeZone: tz, dateStyle: "full" }).format(new Date(slot.startUTC))}
            {" às "}{fmtTime(slot.startUTC)} · {MODE_LABEL[type.mode]}
          </p>
          <label className="block"><span className="font-semibold">Nome completo *</span>
            <input className={input} value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>
          <label className="block"><span className="font-semibold">E-mail *</span>
            <input className={input} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="block"><span className="font-semibold">Telefone / WhatsApp</span>
            <input className={input} type="tel" value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" /></label>
          <label className="block"><span className="font-semibold">Sobre o que quer falar? (opcional)</span>
            <textarea className={`${input} min-h-[96px] py-3`} value={notes} onChange={e => setNotes(e.target.value)} /></label>

          {error && <p role="alert" className="font-semibold text-red-700">{error}</p>}

          <div className="flex gap-3">
            <button className={`${btnBase} border-2 border-[#2D3278] text-[#2D3278]`}
              onClick={() => setStep(2)}>← Voltar</button>
            <button className={`${btnBase} bg-[#2D3278] text-white disabled:opacity-40`}
              disabled={!name.trim() || !email.trim() || saving} onClick={confirm}>
              {saving ? "Confirmando…" : "✓ Confirmar agendamento"}
            </button>
          </div>
        </div>
      )}

      {step === 4 && done && (
        <div className={`${card} p-6 space-y-4`} role="status">
          <h2 className="text-[22px] font-bold text-green-700">✓ Reunião confirmada!</h2>
          <p>Enviamos a confirmação para <strong>{email}</strong>.</p>
          <p><strong>Local:</strong> {done.location}</p>
          <button className={`${btnBase} bg-[#F47B20] text-white`} onClick={downloadICS}>
            📅 Adicionar ao calendário
          </button>
        </div>
      )}
    </div>
  );
}
