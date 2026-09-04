/**
 * Lógica del feed GTFS-Realtime de la NTA, compartida por el recolector, el
 * script de consola y el backend.
 *
 * Estaba duplicada en dos sitios y ya derivó una vez: el mismo fallo de los
 * SKIPPED estaba en ambos. Una sola copia.
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
  const previos = (ups ?? [])
    .map((u) => ({ u, seq: Number(u.stop_sequence) }))
    .filter((x) => !Number.isNaN(x.seq) && x.seq <= seqObjetivo)
    .sort((a, b) => b.seq - a.seq);

  if (!previos.length) return { rel: "SIN_UPDATE", delay: null, horaAbs: null };

  const cercano = previos[0];
  const relCercano = cercano.u.schedule_relationship ?? "SCHEDULED";

  if (relCercano === "NO_DATA") {
    return { rel: "NO_DATA", delay: null, horaAbs: null, origen: cercano.seq };
  }

  const saltada = relCercano === "SKIPPED" && cercano.seq === seqObjetivo;

  let delay = null,
    horaAbs = null,
    origen = null;
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

export function offsetDublinEnMinutos(fecha) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin",
    timeZoneName: "longOffset",
  });
  const p = fmt.formatToParts(fecha).find((x) => x.type === "timeZoneName").value;
  const m = p.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

/**
 * start_date "20260904" + segundos desde medianoche -> Date.
 * GTFS admite "25:10:00" para trayectos que cruzan medianoche, y por eso los
 * segundos pueden pasar de 86400: se suman igual y sale el día siguiente.
 */
export function momentoProgramado(startDate, segundos) {
  const y = +startDate.slice(0, 4);
  const mo = +startDate.slice(4, 6);
  const d = +startDate.slice(6, 8);
  const tentativo = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const off = offsetDublinEnMinutos(tentativo);
  return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0) - off * 60_000 + segundos * 1000);
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
