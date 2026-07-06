// GET /api/agenda/my-bookings
// Retorna as próximas reuniões do staff logado usando service role.
// Protegida pelo middleware (exige sessão) + verificação interna de isStaff.

import { NextResponse } from "next/server";
import { getAuth, serviceDb } from "@/lib/api-auth";

export async function GET() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!auth.isStaff) return NextResponse.json({ error: "Acesso restrito à equipe" }, { status: 403 });

  const { data, error } = await serviceDb()
    .from("bookings")
    .select(`
      id, guest_name, guest_email, guest_phone,
      starts_at, ends_at, status, notes, booked_via,
      meeting_types ( name, mode )
    `)
    .eq("staff_id", auth.userId)
    .eq("status", "booked")
    .gte("starts_at", new Date().toISOString())
    .order("starts_at")
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ bookings: data ?? [] });
}
