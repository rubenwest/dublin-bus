/**
 * Recolector, versión Edge Function.
 *
 * Vive en la infraestructura de Supabase, así que recolecta 24/7 sin que haya
 * que dejar ningún ordenador encendido. Lo dispara pg_cron cada minuto.
 *
 * Sigue siendo el ÚNICO que llama a la NTA: el fair usage es de una llamada
 * cada 30-60s para todos los usuarios juntos, y dos procesos sondeando a la
 * vez bastan para que devuelva HTTP 429.
 *
 * Recorre TRIPS VIVOS -> SUS PARADAS, no paradas -> trips. El feed ya viene
 * entero (~2.800 trips), así que abrir más paradas de llegadas en vivo no
 * cuesta ni una llamada más ni casi cómputo: solo se tira menos. Dos costes
 * separados en la tabla `parada`:
 *   en_vivo    -> se muestra en la web; se le reescribe `llegada_actual` (ancho)
 *   recolectar -> se guarda su histórico en `serie` vía `ingerir` (estrecho)
 *
 * Secreto que necesita: NTA_API_KEY
 */

// @ts-nocheck  -- gtfsrt.mjs es JavaScript plano, sin tipos.
import { createClient } from "jsr:@supabase/supabase-js@2";
// Es el MISMO fichero que scripts/gtfsrt.mjs, copiado byte a byte porque una
// Edge Function no puede importar del repo. No editar aquí: editar el de
// scripts y volver a copiar. scripts/pruebas.mjs compara los hashes.
import {
  estadoParada,
  fechaISO,
  LIMITE_DELAY_SEGUNDOS,
  momentoProgramado,
} from "./gtfsrt.mjs";

const FEED_URL =
  "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json";

const TIMEOUT_MS = 40_000;
const REINTENTOS = 4;
/** Ventana de llegadas que se guarda en la caché. */
const VENTANA_MIN = [-2, 90];
/** upsert de la caché por lotes: con cientos de paradas el body puede crecer. */
const LOTE_CACHE = 500;

const NTA_API_KEY = Deno.env.get("NTA_API_KEY");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
);

/**
 * Deno esconde el motivo real del fallo en `cause`. Sin esto solo se ve
 * "error sending request", que no dice nada.
 */
function detallar(err) {
  const partes = [];
  let e = err;
  let nivel = 0;
  while (e && nivel < 5) {
    partes.push(`${e.name ?? "Error"}: ${e.message ?? e}${e.code ? ` [${e.code}]` : ""}`);
    e = e.cause;
    nivel++;
  }
  return partes.join(" <- ");
}

/**
 * La NTA sirve la cadena TLS incompleta desde la mitad de sus nodos de
 * balanceo (mandan la hoja sin el intermedio de GoDaddy). Medido en Node:
 * 6 de 12 conexiones fallaban. Deno tampoco implementa AIA, así que aquí
 * podría pasar lo mismo y los reintentos no son un lujo.
 */
async function pedirFeed() {
  let ultimo;

  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      const res = await fetch(FEED_URL, {
        headers: { "x-api-key": NTA_API_KEY, "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const cuerpo = await res.text().catch(() => "");
        const e = new Error(
          `HTTP ${res.status} ${res.statusText}${cuerpo ? ` — ${cuerpo.slice(0, 200)}` : ""}`,
        );
        e.estado = res.status;
        // 401/403 no se arreglan reintentando; 429 y 5xx sí.
        if (res.status !== 429 && res.status < 500) throw Object.assign(e, { fatal: true });
        throw e;
      }

      return { feed: await res.json(), intentos: intento };
    } catch (err) {
      ultimo = err;
      if (err?.fatal || intento === REINTENTOS) break;
      const espera = Math.round(1000 * 2 ** (intento - 1) * (0.5 + Math.random()));
      console.warn(`intento ${intento} falló, reintento en ${espera}ms: ${detallar(err)}`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }

  throw ultimo;
}

Deno.serve(async (_req) => {
  const t0 = Date.now();

  if (!NTA_API_KEY) {
    return Response.json(
      { ok: false, error: "Falta el secreto NTA_API_KEY en la Edge Function" },
      { status: 500 },
    );
  }

  try {
    // 1. Qué paradas nos importan, y para qué. Se lee en cada pasada a
    //    propósito: abrir una parada es un INSERT, no un despliegue.
    const { data: paradas, error: e1 } = await supabase
      .from("parada").select("id, en_vivo, recolectar")
      .or("en_vivo.eq.true,recolectar.eq.true");
    if (e1) throw new Error(`leyendo paradas: ${e1.message}`);
    if (!paradas?.length) {
      return Response.json({ ok: true, aviso: "ninguna parada en_vivo ni recolectar" });
    }
    const enVivo = new Set(paradas.filter((p) => p.en_vivo).map((p) => p.id));
    const historico = new Set(paradas.filter((p) => p.recolectar).map((p) => p.id));

    // 2. Nombres de línea. El feed trae route_id crudos ("1 F1 a"); en pantalla
    //    tiene que poner "F1". Son ~403 filas, caben de una.
    const nombreRuta = new Map();
    {
      const { data, error } = await supabase.from("ruta").select("id, nombre");
      if (error) throw new Error(`leyendo rutas: ${error.message}`);
      for (const r of data ?? []) nombreRuta.set(r.id, r.nombre);
    }

    // 3. El feed. Una sola llamada a la NTA.
    const { feed, intentos } = await pedirFeed();
    const feedTs = Number(feed.header?.timestamp) || Math.floor(Date.now() / 1000);
    const momento = new Date(feedTs * 1000).toISOString();
    const ahora = new Date();

    // 4. Trips vivos ahora mismo: trip_id -> trip_update, ya filtrados.
    //    ADDED viene sin trip_id; DELETED el operador quiere que desaparezca.
    const tuPorTrip = new Map();
    for (const e of feed.entity ?? []) {
      const tu = e.trip_update;
      const tripId = tu?.trip?.trip_id;
      if (!tripId) continue;
      if ((tu.trip.schedule_relationship ?? "SCHEDULED") === "DELETED") continue;
      tuPorTrip.set(tripId, tu);
    }
    const vivos = [...tuPorTrip.keys()];

    // 5. El horario SOLO de esos trips. Acotado por el feed (~2.800 trips), no
    //    por el número de paradas: por eso abrir el centro no dispara el coste.
    //    Sustituye a paginar todo el horario estático en cada pasada.
    const indicePorTrip = new Map();
    if (vivos.length) {
      const { data: filasHorario, error: e2 } = await supabase
        .rpc("horario_de_trips", { trips: vivos });
      if (e2) throw new Error(`horario_de_trips: ${e2.message}`);
      for (const h of filasHorario ?? []) {
        // `horario` solo tiene paradas seguidas, pero por si queda alguna fila
        // vieja de una parada ya apagada, nos ceñimos a las que nos importan.
        if (!enVivo.has(h.stop_id) && !historico.has(h.stop_id)) continue;
        if (!indicePorTrip.has(h.trip_id)) indicePorTrip.set(h.trip_id, []);
        indicePorTrip.get(h.trip_id).push({
          stop_id: h.stop_id, seq: h.seq, prog: h.prog_segs, route: h.route_id,
        });
      }
    }

    // 6. Cruce: por cada trip vivo, sus paradas seguidas.
    const observaciones = [];
    const porParada = new Map();
    for (const id of enVivo) porParada.set(id, []);

    for (const [tripId, paradasDelTrip] of indicePorTrip) {
      const tu = tuPorTrip.get(tripId);
      if (!tu) continue;
      const tripRel = tu.trip.schedule_relationship ?? "SCHEDULED";
      const startDate = tu.trip.start_date;
      if (!startDate) continue;

      for (const est of paradasDelTrip) {
        const stopId = est.stop_id;
        const s = estadoParada(tu.stop_time_update, est.seq);

        // Histórico: solo las paradas recolectadas. Estrecho a propósito, es lo
        // que crece y lo único que llena el plan gratuito.
        if (historico.has(stopId)) {
          observaciones.push({
            stop_id: stopId,
            trip_id: tripId,
            fecha_servicio: fechaISO(startDate),
            seq: est.seq,
            prog_segs: est.prog,
            route_id: tu.trip.route_id ?? est.route ?? null,
            delay: s.delay,
            rel: s.rel,
            trip_rel: tripRel,
            origen: s.origen,
            hora_abs: s.horaAbs,
          });
        }

        // Caché para la web: todas las paradas en vivo.
        if (!enVivo.has(stopId)) continue;
        const programado = momentoProgramado(startDate, est.prog);
        const estimado = s.horaAbs !== null && s.horaAbs !== undefined
          ? new Date(s.horaAbs * 1000)
          : new Date(programado.getTime() + (s.delay ?? 0) * 1000);
        const minutos = Math.round((estimado.getTime() - ahora.getTime()) / 60000);
        if (minutos < VENTANA_MIN[0] || minutos > VENTANA_MIN[1]) continue;
        // Delays de horas son trips viejos sin purgar, no autobuses.
        if (s.delay !== null && Math.abs(s.delay) > LIMITE_DELAY_SEGUNDOS) continue;

        const routeId = tu.trip.route_id ?? est.route ?? null;
        porParada.get(stopId).push({
          linea: (routeId && nombreRuta.get(routeId)) || routeId,
          minutos,
          programado: programado.toISOString(),
          estimado: estimado.toISOString(),
          retrasoSegundos: s.delay,
          estado: s.rel === "SKIPPED"
            ? "SALTADA"
            : tripRel === "CANCELED"
            ? "CANCELADO"
            : s.rel === "NO_DATA"
            ? "SIN_DATOS"
            : s.delay === null && s.horaAbs === null
            ? "SOLO_HORARIO"
            : "EN_VIVO",
          tripId,
          vehiculo: tu.vehicle?.id ?? null,
        });
      }
    }

    // 7. Histórico, en un solo viaje y transaccional
    let tramos = 0;
    if (observaciones.length) {
      const { data, error } = await supabase.rpc("ingerir", {
        obs: observaciones,
        momento,
      });
      if (error) throw new Error(`ingerir: ${error.message}`);
      tramos = data ?? 0;
    }

    // 8. Caché de llegadas: una fila por parada en vivo (vacía si no hay bus).
    const filas = [...porParada.entries()].map(([stop_id, llegadas]) => ({
      stop_id,
      generado: ahora.toISOString(),
      feed_ts: feedTs,
      llegadas: llegadas.sort((a, b) => a.minutos - b.minutos).slice(0, 15),
    }));
    for (let i = 0; i < filas.length; i += LOTE_CACHE) {
      const { error: e3 } = await supabase
        .from("llegada_actual")
        .upsert(filas.slice(i, i + LOTE_CACHE), { onConflict: "stop_id" });
      if (e3) throw new Error(`llegada_actual: ${e3.message}`);
    }

    return Response.json({
      ok: true,
      ms: Date.now() - t0,
      intentos,
      feed_ts: feedTs,
      entidades: feed.entity?.length ?? 0,
      trips_vivos: vivos.length,
      paradas_en_vivo: enVivo.size,
      paradas_historico: historico.size,
      observaciones: observaciones.length,
      tramos_tocados: tramos,
      con_llegadas: filas.filter((f) => f.llegadas.length).length,
    });
  } catch (err) {
    console.error(detallar(err));
    return Response.json(
      { ok: false, ms: Date.now() - t0, error: detallar(err) },
      { status: 500 },
    );
  }
});
