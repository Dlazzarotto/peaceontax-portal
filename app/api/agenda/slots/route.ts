// GET /api/agenda/slots?meetingTypeId=...&date=2026-07-10&tz=America/Sao_Paulo&staffId=(opcional)
// Retorna horários livres do dia. Sem staffId, agrega os slots de todos
// os profissionais com disponibilidade para o tipo (modo "primeiro disponível").

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { computeSlots } from "@/lib/scheduling";

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const meetingTypeId = q.get("meetingTypeId");
  const date = q.get("date");                       // YYYY-MM-DD
  const tz = q.get("tz") ?? "America/New_York";
  const staffFilter = q.get("staffId");

  if (!meetingTypeId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "meetingTypeId e date (YYYY-MM-DD) obrigatórios" }, { status: 400 });
  }

  const supabase = db();

  const { data: mt } = await supabase
    .from("meeting_types")
    .select("duration_min,buffer_min,active")
    .eq("id", meetingTypeId).single();
  if (!mt?.active) return NextResponse.json({ error: "Tipo de reunião indisponível" }, { status: 404 });

  let availQuery = supabase.from("staff_availability").select("staff_id,weekday,start_time,end_time,timezone");
  if (staffFilter) availQuery = availQuery.eq("staff_id", staffFilter);
  const { data: availability } = await availQuery;
  if (!availability?.length) return NextResponse.json({ slots: [] });

  // Janela de busca ampla (dia ±1 em UTC) para cobrir diferenças de fuso
  const from = `${date}T00:00:00Z`;
  const dayAfter = new Date(`${date}T00:00:00Z`); dayAfter.setUTCDate(dayAfter.getUTCDate() + 2);
  const to = dayAfter.toISOString();

  const staffIds = [...new Set(availability.map(a => a.staff_id))];

  const [{ data: bookings }, { data: blocks }] = await Promise.all([
    supabase.from("bookings")
      .select("staff_id,starts_at,ends_at")
      .in("staff_id", staffIds).eq("status", "booked")
      .gte("starts_at", from).lt("starts_at", to),
    supabase.from("staff_time_blocks")
      .select("staff_id,starts_at,ends_at")
      .in("staff_id", staffIds)
      .gte("ends_at", from).lt("starts_at", to),
  ]);

  // Calcula por staff e agrega, guardando quem atende cada slot
  const slotMap = new Map<string, { startUTC: string; endUTC: string; staffId: string }>();

  for (const staffId of staffIds) {
    const busy = [
      ...(bookings ?? []).filter(b => b.staff_id === staffId),
      ...(blocks ?? []).filter(b => b.staff_id === staffId),
    ].map(b => ({ starts_at: b.starts_at, ends_at: b.ends_at }));

    const slots = computeSlots({
      dateISO: date,
      guestTimezone: tz,
      durationMin: mt.duration_min,
      bufferMin: mt.buffer_min,
      availability: availability.filter(a => a.staff_id === staffId),
      busy,
    });

    for (const s of slots) {
      if (!slotMap.has(s.startUTC)) slotMap.set(s.startUTC, { ...s, staffId });
    }
  }

  const result = [...slotMap.values()].sort((a, b) => a.startUTC.localeCompare(b.startUTC));
  return NextResponse.json({ slots: result });
}
