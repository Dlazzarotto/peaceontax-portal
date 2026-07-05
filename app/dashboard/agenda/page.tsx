"use client";
// /dashboard/agenda — área da equipe (protegida pelo middleware, FIRM_ONLY)
// Disponibilidade semanal + próximas reuniões. Usa o client do navegador
// com RLS: staff enxerga tudo pela função is_staff() criada na migração.

import { useEffect, useMemo, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import AvailabilityEditor, { type AvailabilityRow } from "@/components/agenda/AvailabilityEditor";

interface Booking {
  id: string;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  starts_at: string;
  status: string;
  notes: string | null;
  meeting_types: { name: string; mode: string } | null;
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
  const [bookings, setBookings] = useState<Booking[] | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      setUserId(user.id);

      const { data: avail } = await sb
        .from("staff_availability")
        .select("id,weekday,start_time,end_time,timezone")
        .eq("staff_id", user.id)
        .order("weekday");
      setAvailability(
        (avail ?? []).map(a => ({
          ...a,
          start_time: a.start_time.slice(0, 5),
          end_time: a.end_time.slice(0, 5),
        }))
      );

      const { data: bks } = await sb
        .from("bookings")
        .select("id,guest_name,guest_email,guest_phone,starts_at,status,notes,meeting_types(name,mode)")
        .eq("status", "booked")
        .gte("starts_at", new Date().toISOString())
        .order("starts_at")
        .limit(30);
      setBookings((bks as unknown as Booking[]) ?? []);
    })();
  }, [sb]);

  async function saveAvailability(rows: AvailabilityRow[]) {
    if (!userId) throw new Error("Sessão expirada — recarregue a página");
    const { error: delError } = await sb
      .from("staff_availability")
      .delete()
      .eq("staff_id", userId);
    if (delError) throw new Error(delError.message);

    if (rows.length) {
      const { error: insError } = await sb.from("staff_availability").insert(
        rows.map(r => ({
          staff_id: userId,
          weekday: r.weekday,
          start_time: r.start_time,
          end_time: r.end_time,
          timezone: r.timezone,
        }))
      );
      if (insError) throw new Error(insError.message);
    }
  }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fmtBooking = (iso: string) =>
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(iso));

  return (
    <main className="max-w-3xl mx-auto px-5 py-8 space-y-10 text-[18px] text-[#1a1d4d]">
      <section>
        <h1 className="text-[26px] font-bold text-[#2D3278] mb-1">Minha agenda</h1>
        <p className="mb-6">Reuniões confirmadas (horários no seu fuso: {tz}).</p>

        {!bookings && <p role="status">Carregando…</p>}
        {bookings && bookings.length === 0 && (
          <p>Nenhuma reunião futura. Assim que um cliente agendar, aparece aqui.</p>
        )}
        <ul className="space-y-3">
          {bookings?.map(b => (
            <li key={b.id} className="border-2 border-[#2D3278] rounded-2xl p-4">
              <p className="font-bold text-[#2D3278]">
                {fmtBooking(b.starts_at)} — {b.meeting_types?.name ?? "Reunião"}
              </p>
              <p>{b.guest_name} · {b.guest_email}{b.guest_phone ? ` · ${b.guest_phone}` : ""}</p>
              {b.notes && <p className="text-[16px] mt-1">Assunto: {b.notes}</p>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        {availability === null && <p role="status">Carregando disponibilidade…</p>}
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
