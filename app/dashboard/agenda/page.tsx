"use client";
// /dashboard/agenda — versão corrigida
// Reuniões: busca via /api/agenda/my-bookings (service role, sem problema de RLS)
// Disponibilidade: /api/agenda/disponibilidade (servidor, só as próprias
// linhas). Lia e gravava direto na tabela com a sessão — fechar as tabelas
// do painel ao navegador tiraria esta tela do ar. E a leitura que falhava
// virava "nenhum horário": salvar dali apagava os horários de verdade.

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import AvailabilityEditor, { type AvailabilityRow } from "@/components/agenda/AvailabilityEditor";

interface Booking {
  id: string;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string | null;
  booked_via: string;
  meeting_types: { name: string; mode: string } | null;
}

const MODE_LABEL: Record<string, string> = {
  video: "📹 Vídeo",
  phone: "📞 Telefone",
  in_person: "🏢 Presencial",
};

/** As linhas como o editor espera: hora em HH:MM (o banco devolve HH:MM:SS). */
function paraEditor(rows: any[]): AvailabilityRow[] {
  return rows.map(a => ({ ...a, start_time: String(a.start_time).slice(0, 5), end_time: String(a.end_time).slice(0, 5) }));
}

export default function AgendaStaffPage() {
  const sb = useMemo(
    () =>
      createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      ),
    []
  );

  const [userId, setUserId] = useState<string | null>(null);
  const [availability, setAvailability] = useState<AvailabilityRow[] | null>(null);
  const [erroDisponibilidade, setErroDisponibilidade] = useState("");
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [loadingBookings, setLoadingBookings] = useState(true);

  const tz = "America/New_York";

  useEffect(() => {
    (async () => {
      // Sessão
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      setUserId(user.id);

      // Disponibilidade: pelo servidor. Consulta que falha NÃO vira lista vazia:
      // o editor nem abre, porque salvar a partir do vazio apagaria os horários.
      const resAv = await fetch("/api/agenda/disponibilidade");
      const jsonAv = await resAv.json().catch(() => ({}));
      if (!resAv.ok) {
        setErroDisponibilidade(jsonAv.error || `Erro ${resAv.status}`);
      } else {
        setAvailability(paraEditor(jsonAv.rows ?? []));
      }

      // Reuniões: via API com service role (evita problema de RLS com is_staff)
      const res = await fetch("/api/agenda/my-bookings");
      const json = await res.json();
      setBookings(json.bookings ?? []);
      setLoadingBookings(false);
    })();
  }, [sb]);

  async function saveAvailability(rows: AvailabilityRow[]) {
    if (!userId) throw new Error("Sessão expirada — recarregue a página");
    // Troca o conjunto inteiro no servidor; se a gravação falhar no meio, ele
    // devolve os horários que estavam lá (a tela apagava tudo e depois inseria).
    const res = await fetch("/api/agenda/disponibilidade", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: rows.map(r => ({ weekday: r.weekday, start_time: r.start_time, end_time: r.end_time, timezone: r.timezone })),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Erro ${res.status}`);
    setAvailability(paraEditor(json.rows ?? []));
  }

  const fmtBooking = (iso: string) =>
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz,
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));

  const card = "border-2 border-[#2D3278] rounded-2xl p-4 bg-white";

  return (
    <main className="max-w-3xl mx-auto px-5 py-8 space-y-10 text-[18px] text-[#1a1d4d]">

      {/* ---- Próximas reuniões ---- */}
      <section>
        <h1 className="text-[26px] font-bold text-[#2D3278] mb-1">Minha agenda</h1>
        <p className="mb-4">
          Próximas reuniões confirmadas · horários no seu fuso: <strong>{tz}</strong>
        </p>

        {loadingBookings && <p role="status">Carregando reuniões…</p>}

        {!loadingBookings && bookings?.length === 0 && (
          <div className={`${card} text-center py-8`}>
            <p>Nenhuma reunião futura agendada.</p>
            <p className="text-[16px] mt-1 text-[#2D3278]">
              Compartilhe o link{" "}
              <strong>/agendar</strong> com os clientes para que eles possam marcar.
            </p>
          </div>
        )}

        <ul className="space-y-3">
          {bookings?.map(b => (
            <li key={b.id} className={card}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-[#2D3278] text-[19px]">
                    {b.meeting_types?.name ?? "Reunião"}
                    {" · "}
                    {MODE_LABEL[b.meeting_types?.mode ?? "video"]}
                  </p>
                  <p className="font-semibold mt-1">{fmtBooking(b.starts_at)}</p>
                </div>
                <span className="text-[14px] font-semibold bg-green-100 text-green-800 px-3 py-1 rounded-full">
                  {b.booked_via === "ai" ? "🤖 IA" : "🌐 Portal"}
                </span>
              </div>
              <div className="mt-2 text-[17px] space-y-1">
                <p>👤 {b.guest_name}</p>
                <p>✉️ {b.guest_email}{b.guest_phone ? ` · 📱 ${b.guest_phone}` : ""}</p>
                {b.notes && <p>💬 {b.notes}</p>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ---- Disponibilidade ---- */}
      <section>
        {erroDisponibilidade && (
          <p role="alert" className="text-[#B02020]">
            Não deu para carregar seus horários: {erroDisponibilidade}. Recarregue a página — nada foi alterado.
          </p>
        )}
        {availability === null && !erroDisponibilidade && <p role="status">Carregando disponibilidade…</p>}
        {availability !== null && userId && (
          <AvailabilityEditor
            staffId={userId}
            initial={availability}
            onSave={saveAvailability}
          />
        )}
      </section>
    </main>
  );
}

