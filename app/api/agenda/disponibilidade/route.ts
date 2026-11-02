// GET /api/agenda/disponibilidade — os horários de atendimento de quem chama
// PUT /api/agenda/disponibilidade — troca o conjunto inteiro: { rows: [...] }
// Só a equipe, e só as PRÓPRIAS linhas (staff_id = quem chama).
//
// /dashboard/agenda lia e gravava `staff_availability` direto do navegador,
// com a sessão da pessoa. Fechar as tabelas do painel
// (sql/rls-tabelas-expostas-v3.sql) tiraria a agenda da equipe do ar. Agora
// quem trabalha a tabela é o servidor, como no resto do sistema.
//
// E dois defeitos que a tela tinha, de passagem:
//   - a leitura engolia o erro (`avail ?? []`): consulta que falhava virava
//     "nenhum horário", e quem salvasse dali APAGAVA os horários de verdade;
//   - salvar era apagar tudo e inserir de novo, em duas idas: se a segunda
//     falhasse, a pessoa ficava SEM horário nenhum — e os clientes deixavam de
//     achar horário livre em /agendar, sem ninguém saber. Agora a inserção que
//     falha devolve as linhas que estavam lá.

import { NextRequest, NextResponse } from "next/server";
import { getAuth, serviceDb } from "@/lib/api-auth";

const COLUNAS = "id,weekday,start_time,end_time,timezone";
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

type Linha = { weekday: number; start_time: string; end_time: string; timezone: string };

/** O que entra no banco: só linhas inteiras e coerentes. Número de navegador não se grava sem conferir. */
function validar(rows: unknown): { linhas: Linha[] } | { erro: string } {
  if (!Array.isArray(rows)) return { erro: "Envie a lista de horários (rows)." };
  if (rows.length > 50) return { erro: "Horários demais (máximo 50)." };
  const linhas: Linha[] = [];
  for (const r of rows as any[]) {
    const weekday = Number(r?.weekday);
    const ini = String(r?.start_time ?? "").slice(0, 5);
    const fim = String(r?.end_time ?? "").slice(0, 5);
    const timezone = String(r?.timezone ?? "").trim() || "America/New_York";
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { erro: "Dia da semana inválido." };
    if (!HORA.test(ini) || !HORA.test(fim)) return { erro: "Horário inválido (use HH:MM)." };
    if (fim <= ini) return { erro: "O fim tem de ser depois do início." };
    if (timezone.length > 64) return { erro: "Fuso horário inválido." };
    linhas.push({ weekday, start_time: ini, end_time: fim, timezone });
  }
  return { linhas };
}

/** Quem chama, se for da equipe; senão, a recusa pronta. */
async function daEquipe() {
  const auth = await getAuth();
  if (!auth) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  if (!auth.isStaff) return NextResponse.json({ error: "Acesso restrito à equipe" }, { status: 403 });
  return auth;
}

export async function GET() {
  const auth = await daEquipe();
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await serviceDb()
    .from("staff_availability").select(COLUNAS)
    .eq("staff_id", auth.userId).order("weekday");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function PUT(req: NextRequest) {
  const auth = await daEquipe();
  if (auth instanceof NextResponse) return auth;

  const body = await req.json().catch(() => null);
  const v = validar(body?.rows);
  if ("erro" in v) return NextResponse.json({ error: v.erro }, { status: 400 });

  const db = serviceDb();
  // O que está lá ANTES: é o que volta se a inserção falhar.
  const { data: antes, error: errAntes } = await db
    .from("staff_availability").select("weekday,start_time,end_time,timezone")
    .eq("staff_id", auth.userId);
  if (errAntes) return NextResponse.json({ error: `Nada foi mudado: não deu para ler os horários (${errAntes.message}).` }, { status: 500 });

  const { error: errApagar } = await db.from("staff_availability").delete().eq("staff_id", auth.userId);
  if (errApagar) return NextResponse.json({ error: `Nada foi mudado: ${errApagar.message}` }, { status: 500 });

  if (v.linhas.length) {
    const { error: errInserir } = await db.from("staff_availability")
      .insert(v.linhas.map(l => ({ ...l, staff_id: auth.userId })));
    if (errInserir) {
      const { error: errVolta } = (antes || []).length
        ? await db.from("staff_availability").insert((antes || []).map((l: any) => ({ ...l, staff_id: auth.userId })))
        : { error: null };
      return NextResponse.json({
        error: errVolta
          ? `ATENÇÃO: os horários novos não foram gravados (${errInserir.message}) e os antigos não voltaram (${errVolta.message}). Sua agenda está SEM horários — salve de novo.`
          : `Os horários não foram gravados (${errInserir.message}). Os anteriores continuam valendo.`,
      }, { status: 500 });
    }
  }

  const { data, error } = await db.from("staff_availability").select(COLUNAS)
    .eq("staff_id", auth.userId).order("weekday");
  if (error) return NextResponse.json({ error: `Gravado, mas não deu para reler: ${error.message}` }, { status: 500 });
  return NextResponse.json({ ok: true, rows: data ?? [] });
}
