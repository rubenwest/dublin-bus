/**
 * Lógica del feed GTFS-Realtime de la NTA, para Deno.
 *
 * Es un port de scripts/gtfsrt.mjs. Duplicar duele, pero la alternativa es
 * que la Edge Function importe desde el repo, y no puede. Si tocas una,
 * toca la otra: el mismo fallo de los SKIPPED ya estuvo duplicado una vez.
 */

/** Por encima de esto un delay no es un retraso, es basura del feed. */
export const LIMITE_DELAY_SEGUNDOS = 45 * 60;

export interface Estado {
  rel: "SCHEDULED" | "SKIPPED" | "NO_DATA" | "SIN_UPDATE";
  delay: number | null;
  horaAbs: number | null;
  origen: number | null;
}

// deno-lint-ignore no-explicit-any
type Update = any;

/**
 * Estado de una parada según los stop_time_update, que vienen salteados
 * (16, 17, 18, 20, 23, 27...). Reglas de la spec:
 *
 *  - un update aplica a las paradas siguientes hasta el próximo update;
 *  - NO_DATA se propaga hacia adelante y prohíbe que haya delay;
 *  - SKIPPED NO se propaga: aplica solo a su parada. Pero el delay sí
 *    atraviesa una parada saltada, y los SKIPPED de la NTA vienen sin
 *    arrival ni departure, así que hay que seguir hacia atrás a buscarlo.
 */
export function estadoParada(ups: Update[] | undefined, seqObjetivo: number): Estado {
  const previos = (ups ?? [])
    .map((u: Update) => ({ u, seq: Number(u.stop_sequence) }))
    .filter((x) => !Number.isNaN(x.seq) && x.seq <= seqObjetivo)
    .sort((a, b) => b.seq - a.seq);

  if (!previos.length) {
    return { rel: "SIN_UPDATE", delay: null, horaAbs: null, origen: null };
  }

  const cercano = previos[0];
  const relCercano = cercano.u.schedule_relationship ?? "SCHEDULED";

  if (relCercano === "NO_DATA") {
    return { rel: "NO_DATA", delay: null, horaAbs: null, origen: cercano.seq };
  }

  const saltada = relCercano === "SKIPPED" && cercano.seq === seqObjetivo;

  let delay: number | null = null;
  let horaAbs: number | null = null;
  let origen: number | null = null;

  for (const { u, seq } of previos) {
    if ((u.schedule_relationship ?? "SCHEDULED") === "NO_DATA") break;
    const d = u.arrival?.delay ?? u.departure?.delay;
    const t = u.arrival?.time ?? u.departure?.time;
    if (d !== undefined) {
      delay = Number(d);
      origen = seq;
      if (t !== undefined) horaAbs = Number(t);
      break;
    }
    if (t !== undefined && horaAbs === null) {
      horaAbs = Number(t);
      origen = seq;
    }
  }

  if (saltada) return { rel: "SKIPPED", delay, horaAbs, origen: cercano.seq };
  if (delay === null && horaAbs === null) {
    return { rel: "SIN_UPDATE", delay: null, horaAbs: null, origen: cercano.seq };
  }
  return { rel: "SCHEDULED", delay, horaAbs, origen };
}

/** Offset de Dublín en minutos para una fecha dada (resuelve el horario de verano). */
function offsetDublinEnMinutos(fecha: Date): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin",
    timeZoneName: "longOffset",
  });
  const parte = fmt.formatToParts(fecha).find((p) => p.type === "timeZoneName")!.value;
  const m = parte.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * start_date "20260904" + segundos desde medianoche -> Date.
 * GTFS admite "25:10:00" para trayectos que cruzan medianoche; los segundos
 * pueden pasar de 86400 y se suman igual, saliendo el día siguiente.
 */
export function momentoProgramado(startDate: string, segundos: number): Date {
  const y = Number(startDate.slice(0, 4));
  const mo = Number(startDate.slice(4, 6));
  const d = Number(startDate.slice(6, 8));
  const tentativo = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const off = offsetDublinEnMinutos(tentativo);
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0) - off * 60_000 + segundos * 1000);
}

/** "20260904" -> "2026-09-04" */
export function fechaISO(startDate: string): string {
  return `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`;
}
