// POST   /api/agenda/bookings   → cria agendamento (revalida o slot antes)
// DELETE /api/agenda/bookings?id=...&token=...  → cancelamento via link do e-mail
// A constraint EXCLUDE no banco garante que dois cliques simultâneos
// no mesmo horário nunca gerem duas reuniões.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildICS } from "@/lib/scheduling";

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { meetingTypeId, staffId, startUTC, guestName, guestEmail, guestPhone, guestTimezone, notes, clientId } = body;

  if (!meetingTypeId || !staffId || !startUTC || !guestName || !guestEmail) {
    return NextResponse.json({ error: "Campos obrigatórios faltando" }, { status: 400 });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guestEmail)) {
    return NextResponse.json({ error: "E-mail inválido" }, { status: 400 });
  }

  const supabase = db();
  const { data: mt } = await supabase
    .from("meeting_types")
    .select("name,duration_min,mode,active")
    .eq("id", meetingTypeId).single();
  if (!mt?.active) return NextResponse.json({ error: "Tipo de reunião indisponível" }, { status: 404 });

  const starts = new Date(startUTC);
  const ends = new Date(starts.getTime() + mt.duration_min * 60_000);

  const { data: booking, error } = await supabase
    .from("bookings")
    .insert({
      client_id: clientId ?? null,
      guest_name: guestName.trim(),
      guest_email: guestEmail.trim().toLowerCase(),
      guest_phone: guestPhone ?? null,
      meeting_type_id: meetingTypeId,
      staff_id: staffId,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      guest_timezone: guestTimezone ?? "America/New_York",
      notes: notes ?? null,
      booked_via: "portal",
    })
    .select("id,cancel_token")
    .single();

  if (error) {
    // 23P01 = violação da EXCLUDE constraint → alguém pegou o horário antes
    const msg = error.code === "23P01"
      ? "Esse horário acabou de ser reservado por outra pessoa. Escolha outro."
      : error.message;
    return NextResponse.json({ error: msg }, { status: 409 });
  }

  const location = mt.mode === "in_person"
    ? "Peace on Tax Corp — 75 Pleasant St Suite 119, Malden, MA 02148"
    : mt.mode === "phone" ? "Ligação: (833) 732-2327" : "Videoconferência (link será enviado)";

  const ics = buildICS({
    title: `${mt.name} — Peace on Tax`,
    description: `Agendado por ${guestName}. Dúvidas: (833) 732-2327 · info@peaceontax.com`,
    location,
    startUTC: starts.toISOString(),
    endUTC: ends.toISOString(),
    uid: booking.id,
  });

  // AUDITAR: integrar aqui o envio de e-mail já usado no portal
  // (Resend/SendGrid) com o .ics em anexo e o link de cancelamento:
  // https://SEU_DOMINIO/api/agenda/bookings?id=...&token=...
  // Fase 3 acrescenta confirmação e lembrete por WhatsApp/SMS.

  return NextResponse.json({
    ok: true,
    bookingId: booking.id,
    cancelToken: booking.cancel_token,
    ics,        // o front oferece download "Adicionar ao calendário"
    location,
  });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  const token = req.nextUrl.searchParams.get("token");
  if (!id || !token) return NextResponse.json({ error: "id e token obrigatórios" }, { status: 400 });

  const { data, error } = await db()
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", id).eq("cancel_token", token).eq("status", "booked")
    .select("id").single();

  if (error || !data) {
    return NextResponse.json({ error: "Agendamento não encontrado ou já cancelado" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
