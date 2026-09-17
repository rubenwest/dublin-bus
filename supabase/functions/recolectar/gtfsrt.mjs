/**
 * Lógica del feed GTFS-Realtime de la NTA. **Esta es la única copia.**
 *
 * La usan el recolector, el script de consola, el backend local y la Edge
 * Function de Supabase. Llegó a estar duplicada en cuatro sitios y derivó una
 * vez: el fallo de los SKIPPED sin `arrival` estaba en dos a la vez.
 *
 * `supabase/functions/recolectar/gtfsrt.mjs` es un espejo byte a byte de este
 * fichero, porque una Edge Function no puede importar del repo. No se edita a
 * mano: se copia. `scripts/pruebas.mjs` compara los hashes y falla si alguien
 * toca uno solo.
 */

/** Por encima de esto un delay no es un retraso, es basura del feed. */
export const LIMITE_DELAY_SEGUNDOS = 45 * 60;

/**
 * Estado de una parada según los stop_time_update, que vienen salteados
 * (16, 17, 18, 20, 23, 27...). Reglas de la spec:
 *
 *  - un update aplica a las paradas siguientes hasta el próximo update;
 *  - NO_DATA se propaga hacia adelante y prohíbe que haya delay;
 *  - SKIPPED NO se propaga: aplica solo a su parada. Pero el delay sí atraviesa
 *    una parada saltada, y los SKIPPED de la NTA vienen sin arrival ni
 *    departure, así que hay que seguir hacia atrás hasta encontrar uno.
 *
 * Devuelve { rel, delay, horaAbs, origen }.
 *   rel: SCHEDULED | SKIPPED | NO_DATA | SIN_UPDATE
 */
export function estadoParada(ups, seqObjetivo) {
  return estadoParadaPreparado(prepararUpdates(ups), seqObjetivo);
}

/**
 * Los stop_time_update de UN trip, ordenados de mayor a menor stop_sequence y
 * listos para consultarlos muchas veces.
 *
 * Existe por coste, no por gusto. `estadoParada` hacía map + filter + sort en
 * cada llamada, y el recolector la llama una vez por par (trip, parada):
 * 36.076 veces por pasada, reordenando los mismos ~40 updates una y otra vez.
 * Eso es lo que hacía que la Edge Function muriese con `CPU Time exceeded` al
 * pasar de 658 a 1.968 paradas en vivo.
 *
 * Quien recorra varias paradas del mismo trip debe preparar una vez y llamar
 * luego a `estadoParadaPreparado`. Para una parada suelta, `estadoParada` sigue
 * valiendo y hace exactamente lo mismo.
 */
export function prepararUpdates(ups) {
  return (ups ?? [])
    .map((u) => ({ u, seq: Number(u.stop_sequence) }))
    .filter((x) => !Number.isNaN(x.seq))
    .sort((a, b) => b.seq - a.seq);
}

/**
 * Lo mismo que `estadoParada`, sobre unos updates ya preparados.
 *
 * El recorte por `seq <= seqObjetivo` que antes hacía el `filter` se hace aquí
 * con una búsqueda binaria sobre el array ya ordenado: O(log u) en vez de O(u)
 * por parada, y sin crear un array nuevo cada vez. El sort de JavaScript es
 * estable, así que ante dos updates con la misma `stop_sequence` se elige el
 * mismo que antes.
 */
export function estadoParadaPreparado(previosTodos, seqObjetivo) {
  // Primer índice cuya seq es <= seqObjetivo. El array va de mayor a menor.
  let lo = 0, hi = previosTodos.length;
  while (lo < hi) {
    const medio = (lo + hi) >> 1;
    if (previosTodos[medio].seq > seqObjetivo) lo = medio + 1;
    else hi = medio;
  }
  const desde = lo;

  if (desde >= previosTodos.length) {
    return { rel: "SIN_UPDATE", delay: null, horaAbs: null };
  }

  const cercano = previosTodos[desde];
  const relCercano = cercano.u.schedule_relationship ?? "SCHEDULED";

  if (relCercano === "NO_DATA") {
    return { rel: "NO_DATA", delay: null, horaAbs: null, origen: cercano.seq };
  }

  const saltada = relCercano === "SKIPPED" && cercano.seq === seqObjetivo;

  // La hora absoluta NO se propaga: `arrival.time` es la llegada a SU parada y
  // a ninguna otra. Solo vale si la update es exactamente la de mi parada.
  // Heredarla de una anterior daba la hora de otra parada como si fuera esta,
  // siempre anterior, y salían buses "adelantados" una hora que no existen.
  // Lo que sí se propaga hacia adelante es el delay, que es un desfase.
  const tExacta = cercano.seq === seqObjetivo
    ? cercano.u.arrival?.time ?? cercano.u.departure?.time
    : undefined;
  const horaAbs = tExacta !== undefined ? Number(tExacta) : null;

  let delay = null,
    origen = horaAbs === null ? null : seqObjetivo;
  for (let i = desde; i < previosTodos.length; i++) {
    const { u, seq } = previosTodos[i];
    if ((u.schedule_relationship ?? "SCHEDULED") === "NO_DATA") break;
    const d = u.arrival?.delay ?? u.departure?.delay;
    if (d !== undefined) {
      delay = Number(d);
      origen = seq;
      break;
    }
  }

  if (saltada) return { rel: "SKIPPED", delay, horaAbs, origen: cercano.seq };
  if (delay === null && horaAbs === null) {
    return { rel: "SIN_UPDATE", delay: null, horaAbs: null, origen: cercano.seq };
  }
  return { rel: "SCHEDULED", delay, horaAbs, origen };
}

/**
 * trip_id -> trip_update, ya filtrado.
 *
 *  - DELETED fuera: el operador quiere que desaparezca, no que se tache.
 *  - ADDED viene sin trip_id, así que no cruza con el estático y cae solo.
 */
export function tripsEnVivo(feed) {
  const m = new Map();
  let deleted = 0;
  for (const e of feed.entity ?? []) {
    const tu = e.trip_update;
    if (!tu?.trip?.trip_id) continue;
    if (tu.trip.schedule_relationship === "DELETED") {
      deleted++;
      continue;
    }
    m.set(tu.trip.trip_id, tu);
  }
  return { trips: m, deleted };
}

// --- Horas ------------------------------------------------------------------

/**
 * Construir un `Intl.DateTimeFormat` cuesta mucho más que usarlo, así que se
 * construye una vez. Ver el comentario de `momentoProgramado`.
 */
const FMT_DUBLIN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Dublin",
  timeZoneName: "longOffset",
});

export function offsetDublinEnMinutos(fecha) {
  const p = FMT_DUBLIN.formatToParts(fecha).find((x) => x.type === "timeZoneName").value;
  const m = p.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

/** "20260904" -> "2026-09-04" */
export function fechaISO(startDate) {
  return `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`;
}

/**
 * Medianoche de un `start_date` en UTC, y el desfase horario de Dublín ese día.
 *
 * Se cachea por día, y no es un microajuste: `Intl` es lentísimo comparado con
 * la aritmética que hay alrededor. Medido con 36.000 llamadas, que es lo que
 * hace el recolector en UNA pasada: **2.296 ms en total, de los cuales 2.286
 * son el `Intl`**. Eso, y no el barrido de los updates (15 ms), es lo que
 * mataba la Edge Function con `CPU Time exceeded` al ensanchar las paradas.
 *
 * El offset se mide a mediodía a propósito, así que depende solo del día: para
 * un mismo `start_date` la respuesta es siempre la misma y cachearla no cambia
 * ningún resultado. El mapa crece una entrada por día de servicio visto.
 */
const DIAS = new Map();

function diaDeServicio(startDate) {
  let dia = DIAS.get(startDate);
  if (dia === undefined) {
    const y = +startDate.slice(0, 4);
    const mo = +startDate.slice(4, 6);
    const d = +startDate.slice(6, 8);
    const medianoche = Date.UTC(y, mo - 1, d, 0, 0, 0);
    const off = offsetDublinEnMinutos(new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)));
    dia = { base: medianoche - off * 60_000 };
    DIAS.set(startDate, dia);
  }
  return dia;
}

/**
 * start_date "20260904" + segundos desde medianoche -> Date.
 * GTFS admite "25:10:00" para trayectos que cruzan medianoche, y por eso los
 * segundos pueden pasar de 86400: se suman igual y sale el día siguiente.
 */
export function momentoProgramado(startDate, segundos) {
  return new Date(diaDeServicio(startDate).base + segundos * 1000);
}

/**
 * Calcula la llegada de un trip a una parada.
 *
 * @param tu        trip_update del feed
 * @param seq       stop_sequence de la parada en ese trip (del estático)
 * @param progSegs  hora programada en esa parada, segundos desde medianoche
 * @param ahora     Date contra el que se miden los minutos que faltan
 */
export function calcularLlegada(tu, seq, progSegs, ahora) {
  const est = estadoParada(tu.stop_time_update, seq);
  const startDate = tu.trip.start_date;
  const programado = momentoProgramado(startDate, progSegs);

  // Si el feed da la hora absoluta es mejor que sumar el delay al horario.
  const estimado =
    est.horaAbs !== null && est.horaAbs !== undefined
      ? new Date(est.horaAbs * 1000)
      : new Date(programado.getTime() + (est.delay ?? 0) * 1000);

  const tripRel = tu.trip.schedule_relationship ?? "SCHEDULED";

  return {
    minutos: Math.round((estimado - ahora) / 60000),
    programado,
    estimado,
    delay: est.delay,
    rel: est.rel,
    tripRel,
    cancelado: tripRel === "CANCELED",
    saltada: est.rel === "SKIPPED",
    sinDatos: est.delay === null && est.horaAbs == null,
    sospechoso: est.delay !== null && Math.abs(est.delay) > LIMITE_DELAY_SEGUNDOS,
    vehiculo: tu.vehicle?.id ?? null,
    tripId: tu.trip.trip_id,
    routeId: tu.trip.route_id ?? null,
  };
}
