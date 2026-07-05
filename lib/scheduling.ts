// AGENDAMENTO — Cálculo de horários disponíveis
// Gera slots livres cruzando: disponibilidade semanal do staff (na timezone dele)
// × reuniões já marcadas × bloqueios × duração + buffer do tipo de reunião.
// Tudo calculado em UTC; conversão de exibição fica no front.

export interface AvailabilityWindow {
  weekday: number;        // 0=domingo … 6=sábado (no fuso do staff)
  start_time: string;     // "09:00:00"
  end_time: string;       // "17:00:00"
  timezone: string;       // ex.: "America/New_York"
}

export interface BusyInterval { starts_at: string; ends_at: string } // ISO UTC

export interface SlotParams {
  dateISO: string;              // dia consultado "2026-07-10" (no fuso do convidado)
  guestTimezone: string;        // ex.: "America/Sao_Paulo"
  durationMin: number;
  bufferMin: number;
  availability: AvailabilityWindow[];
  busy: BusyInterval[];         // bookings status=booked + time_blocks do staff
  minNoticeHours?: number;      // antecedência mínima (padrão 4h)
  stepMin?: number;             // granularidade dos slots (padrão 15)
}

/** Converte "HH:MM" de um dia em uma timezone para Date UTC. */
function zonedTimeToUtc(dateISO: string, time: string, timeZone: string): Date {
  // Estratégia sem dependências: encontra o offset real da timezone naquele dia
  const [h, m] = time.split(":").map(Number);
  const naive = new Date(`${dateISO}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(naive).map(p => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  const offset = asIfUtc - naive.getTime();
  return new Date(naive.getTime() - offset);
}

function weekdayInTz(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(wd);
}

export interface Slot { startUTC: string; endUTC: string }

export function computeSlots(p: SlotParams): Slot[] {
  const step = (p.stepMin ?? 15) * 60_000;
  const duration = p.durationMin * 60_000;
  const buffer = p.bufferMin * 60_000;
  const minStart = Date.now() + (p.minNoticeHours ?? 4) * 3_600_000;

  const busy = p.busy.map(b => ({
    start: new Date(b.starts_at).getTime() - buffer,
    end: new Date(b.ends_at).getTime() + buffer,
  }));

  const slots: Slot[] = [];

  // O "dia" do convidado pode cruzar dois dias no fuso do staff — testa o dia
  // consultado e o adjacente em cada janela de disponibilidade.
  const candidateDates = [p.dateISO, shiftISO(p.dateISO, -1), shiftISO(p.dateISO, 1)];

  for (const win of p.availability) {
    for (const d of candidateDates) {
      const winStart = zonedTimeToUtc(d, win.start_time.slice(0, 5), win.timezone);
      if (weekdayInTz(winStart, win.timezone) !== win.weekday) continue;
      const winEnd = zonedTimeToUtc(d, win.end_time.slice(0, 5), win.timezone);

      for (let t = winStart.getTime(); t + duration <= winEnd.getTime(); t += step) {
        if (t < minStart) continue;

        // Slot precisa cair no dia consultado NO FUSO DO CONVIDADO
        const guestDay = new Intl.DateTimeFormat("en-CA", {
          timeZone: p.guestTimezone, year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date(t));
        if (guestDay !== p.dateISO) continue;

        const conflict = busy.some(b => t < b.end && t + duration > b.start);
        if (!conflict) {
          slots.push({
            startUTC: new Date(t).toISOString(),
            endUTC: new Date(t + duration).toISOString(),
          });
        }
      }
    }
  }

  return slots
    .filter((s, i, arr) => arr.findIndex(x => x.startUTC === s.startUTC) === i)
    .sort((a, b) => a.startUTC.localeCompare(b.startUTC));
}

function shiftISO(dateISO: string, days: number): string {
  const d = new Date(`${dateISO}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Gera arquivo .ics para anexar no e-mail de confirmação. */
export function buildICS(b: {
  title: string; description: string; location: string;
  startUTC: string; endUTC: string; uid: string;
}): string {
  const fmt = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Peace on Tax//Agenda//PT",
    "BEGIN:VEVENT",
    `UID:${b.uid}@peaceontax.com`,
    `DTSTAMP:${fmt(new Date().toISOString())}`,
    `DTSTART:${fmt(b.startUTC)}`,
    `DTEND:${fmt(b.endUTC)}`,
    `SUMMARY:${b.title}`,
    `DESCRIPTION:${b.description.replace(/\n/g, "\\n")}`,
    `LOCATION:${b.location}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
}
