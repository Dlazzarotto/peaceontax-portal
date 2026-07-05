"use client";
// Página pública de agendamento — peaceontax-portal.vercel.app/agendar
// Liberada no middleware (lista PUBLIC). Prospects agendam sem conta;
// os tipos de reunião vêm direto do Supabase (política de leitura pública).

import { useEffect, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import BookingWidget from "@/components/agenda/BookingWidget";

interface MeetingType {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  mode: string;
}

export default function AgendarPage() {
  const [types, setTypes] = useState<MeetingType[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    sb.from("meeting_types")
      .select("id,name,description,duration_min,mode")
      .eq("active", true)
      .order("name")
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setTypes(data ?? []);
      });
  }, []);

  return (
    <main className="min-h-screen bg-white">
      <header className="bg-[#2D3278] text-white px-5 py-6">
        <div className="max-w-xl mx-auto">
          <p className="text-[16px] font-semibold tracking-wide text-[#F47B20]">
            PEACE ON TAX CORP
          </p>
          <h1 className="text-[26px] font-bold leading-tight mt-1">
            Agende sua reunião
          </h1>
          <p className="text-[18px] mt-2 opacity-90">
            Escolha o melhor horário para você. Atendemos em português,
            inglês e espanhol.
          </p>
        </div>
      </header>

      <section className="max-w-xl mx-auto px-5 py-8">
        {error && (
          <p role="alert" className="text-[18px] font-semibold text-red-700">
            Não foi possível carregar os horários agora. Ligue para (833) 732-2327
            ou escreva para info@peaceontax.com.
          </p>
        )}
        {!types && !error && (
          <p role="status" className="text-[18px] text-[#1a1d4d]">Carregando…</p>
        )}
        {types && <BookingWidget meetingTypes={types} />}
      </section>

      <footer className="max-w-xl mx-auto px-5 pb-10 text-[16px] text-[#1a1d4d]">
        <p>
          Peace on Tax Corp · 75 Pleasant St Suite 119, Malden, MA 02148 ·
          (833) 732-2327 · info@peaceontax.com
        </p>
      </footer>
    </main>
  );
}
