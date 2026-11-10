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
 * Solo ESCRIBE: deja el feed en `trip_vivo` y las posiciones en `vehiculo`, y
 * no lee nada de la base de datos. Es a propósito. Leer cuenta como egress
 * aunque quien lee sea esta función, y bajarse el horario en cada pasada eran
 * ~10 MB por minuto contra los 5 GB al mes del plan gratuito: agotó la cuota y
 * Supabase dejó la app en 402. Ver "El egress" en CLAUDE.md.
 *
 * Secreto que necesita: NTA_API_KEY
 */

// @ts-nocheck  -- gtfsrt.mjs es JavaScript plano, sin tipos.
import { createClient } from "jsr:@supabase/supabase-js@2";
// Es el MISMO fichero que scripts/gtfsrt.mjs, copiado byte a byte porque una
// Edge Function no puede importar del repo. No editar aquí: editar el de
// scripts y volver a copiar. scripts/pruebas.mjs compara los hashes.
import { updatesCompactos } from "./gtfsrt.mjs";

const FEED_URL =
  "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json";
/**
 * Posiciones GPS. Es una segunda llamada por pasada, y el fair usage de la NTA
 * es real: se pide DESPUÉS de haber guardado todo lo demás y con menos
 * reintentos, para que un 429 aquí no toque las llegadas.
 */
const VEHICULOS_URL =
  "https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json";

const TIMEOUT_MS = 40_000;
const REINTENTOS = 4;
/** upsert por lotes: con miles de filas el body puede crecer. */
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
async function pedirFeed(url = FEED_URL, reintentos = REINTENTOS) {
  let ultimo;

  for (let intento = 1; intento <= reintentos; intento++) {
    try {
      const res = await fetch(url, {
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
      if (err?.fatal || intento === reintentos) break;
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
    // 1. El feed. Una sola llamada a la NTA.
    const { feed, intentos } = await pedirFeed();
    const feedTs = Number(feed.header?.timestamp) || Math.floor(Date.now() / 1000);
    const ahora = new Date();

    // 2. Trips vivos ahora mismo. ADDED viene sin trip_id y sin `start_date`
    //    no hay hora programada; DELETED el operador quiere que desaparezca.
    const filasPorTrip = new Map();
    for (const e of feed.entity ?? []) {
      const tu = e.trip_update;
      const tripId = tu?.trip?.trip_id;
      if (!tripId || !/^\d{8}$/.test(tu.trip.start_date ?? "")) continue;
      const rel = tu.trip.schedule_relationship ?? "SCHEDULED";
      if (rel === "DELETED") continue;
      filasPorTrip.set(tripId, {
        trip_id: tripId,
        start_date: tu.trip.start_date,
        rel,
        route_id: tu.trip.route_id ?? null,
        vehiculo: tu.vehicle?.id ?? null,
        updates: updatesCompactos(tu.stop_time_update),
        feed_ts: feedTs,
        visto: ahora.toISOString(),
      });
    }

    // 3. Se guarda y ya está. Escribir no gasta egress y leer sí: esta función
    //    no lee NADA de la base de datos. Las llegadas las calcula la web, de
    //    una parada y cuando alguien la mira.
    const filas = [...filasPorTrip.values()];
    for (let i = 0; i < filas.length; i += LOTE_CACHE) {
      const { error } = await supabase
        .from("trip_vivo")
        .upsert(filas.slice(i, i + LOTE_CACHE), { onConflict: "trip_id" });
      if (error) throw new Error(`trip_vivo: ${error.message}`);
    }
    {
      const corte = new Date(ahora.getTime() - 10 * 60_000).toISOString();
      const { error } = await supabase.from("trip_vivo").delete().lt("visto", corte);
      if (error) throw new Error(`trip_vivo (limpieza): ${error.message}`);
    }

    // 4. Posiciones GPS, para el mapa. Va al final y en su propio try: si la
    //    NTA responde 429 a la segunda llamada, ya está guardado lo que
    //    importa —el feed— y esta pasada no se pierde. El mapa simplemente
    //    enseña las posiciones de hace un minuto.
    let vehiculos = 0;
    let errorVehiculos = null;
    try {
      const { feed: fv } = await pedirFeed(VEHICULOS_URL, 2);
      const filasV = [];
      const vistos = new Set();
      for (const e of fv.entity ?? []) {
        const v = e.vehicle;
        const tripId = v?.trip?.trip_id;
        const pos = v?.position;
        // Sin trip_id no hay con qué casarlo: los `vehicle.id` de los dos
        // feeds son espacios de nombres distintos y cruzarlos da falsos.
        if (!tripId || !pos || pos.latitude == null || pos.longitude == null) continue;
        // El feed puede traer dos entidades del mismo trip; la primera manda.
        if (vistos.has(tripId)) continue;
        vistos.add(tripId);
        filasV.push({
          trip_id: tripId,
          route_id: v.trip.route_id ?? null,
          lat: pos.latitude,
          lon: pos.longitude,
          // `bearing` es opcional y la NTA lo manda a ratos: null sin drama.
          bearing: pos.bearing ?? null,
          ts: Number(v.timestamp)
            ? new Date(Number(v.timestamp) * 1000).toISOString()
            : null,
          visto: ahora.toISOString(),
        });
      }
      for (let i = 0; i < filasV.length; i += LOTE_CACHE) {
        const { error } = await supabase
          .from("vehiculo")
          .upsert(filasV.slice(i, i + LOTE_CACHE), { onConflict: "trip_id" });
        if (error) throw new Error(`vehiculo: ${error.message}`);
      }
      // Un bus que deja de emitir tiene que desaparecer del mapa, no quedarse
      // clavado en su última posición como si siguiera ahí.
      const corte = new Date(ahora.getTime() - 10 * 60_000).toISOString();
      await supabase.from("vehiculo").delete().lt("visto", corte);
      vehiculos = filasV.length;
    } catch (err) {
      errorVehiculos = detallar(err);
      console.warn(`vehiculos (no critico): ${errorVehiculos}`);
    }

    return Response.json({
      ok: true,
      ms: Date.now() - t0,
      intentos,
      vehiculos,
      error_vehiculos: errorVehiculos,
      feed_ts: feedTs,
      entidades: feed.entity?.length ?? 0,
      trips_vivos: filas.length,
    });
  } catch (err) {
    console.error(detallar(err));
    return Response.json(
      { ok: false, ms: Date.now() - t0, error: detallar(err) },
      { status: 500 },
    );
  }
});

