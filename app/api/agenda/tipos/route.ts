// GET /api/agenda/tipos — os tipos de reunião ATIVOS, para a página pública
// /agendar. Aberta de propósito (API_PUBLIC): quem agenda ainda não tem login.
//
// A página lia `meeting_types` direto do navegador, com a anon key, apoiada
// numa policy pública da tabela. Isso amarrava a tabela ao navegador: fechar
// as tabelas do painel (sql/rls-tabelas-expostas-v3.sql) tiraria da página
// pública a lista de reuniões, e o cliente não conseguiria agendar. Agora quem
// lê é o servidor, com a service role, e só os campos que a página mostra.

import { NextResponse } from "next/server";
import { serviceDb } from "@/lib/api-auth";

export async function GET() {
  const { data, error } = await serviceDb()
    .from("meeting_types")
    .select("id,name,description,duration_min,mode")
    .eq("active", true)
    .order("name");
  // Consulta que falha não é "não há reunião para agendar".
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ types: data ?? [] });
}
