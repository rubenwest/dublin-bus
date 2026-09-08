#!/usr/bin/env node
/**
 * Sube el histórico de datos/obs-*.jsonl a Supabase.
 *
 * Va aparte del recolector a propósito. El recolector tiene un solo trabajo,
 * que es no perder datos; si Supabase está caído, o la key caducó, o hay un
 * fallo de red, la recolección sigue y esto se pone al día después. El JSONL
 * en disco es la fuente de verdad, Supabase es una copia consultable.
 *
 * Uso:
 *   node scripts\sincronizar.mjs                 sube el día de hoy
 *   node scripts\sincronizar.mjs --todo          sube todos los días
 *   node scripts\sincronizar.mjs --seco          no sube nada, solo cuenta
 *   node scripts\sincronizar.mjs --dia 2026-09-04
 *
 * Necesita en .env:
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=...        (Project Settings > API Keys > service_role)
 *
 * La service_role key se salta RLS, que es justo lo que hace falta para
 * escribir: las políticas solo permiten lectura pública.
 */

import fs from "node:fs";
import path from "node:path";
import { cargarDotEnv } from "./entorno.mjs";

cargarDotEnv();

const args = process.argv.slice(2);
const SECO = args.includes("--seco");
const TODO = args.includes("--todo");
const HORARIO = args.includes("--horario");
const CENTRO = args.includes("--centro");
const DIA = args.includes("--dia") ? args[args.indexOf("--dia") + 1] : null;
const datosDir = "./datos";

/**
 * Caja del centro de Dublín por defecto: de Parnell Sq bajando por O'Connell,
 * cruzando el Liffey, College Green, Dame St y hasta St Stephen's Green.
 * Ajustable con  --caja <latMin> <latMax> <lonMin> <lonMax>.
 */
const CAJA_CENTRO = { latMin: 53.335, latMax: 53.36, lonMin: -6.29, lonMax: -6.24 };

function leerCaja() {
  const i = args.indexOf("--caja");
  if (i === -1) return CAJA_CENTRO;
  const [latMin, latMax, lonMin, lonMax] = args.slice(i + 1, i + 5).map(Number);
  if ([latMin, latMax, lonMin, lonMax].some((n) => Number.isNaN(n))) {
    console.error("Uso: --caja <latMin> <latMax> <lonMin> <lonMax>  (grados decimales)");
    process.exit(1);
  }
  return { latMin, latMax, lonMin, lonMax };
}

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SECO && (!URL_BASE || !SERVICE_KEY)) {
  console.error(
    "Faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY en .env\n\n" +
      "La service_role key está en:\n" +
      "  Supabase > tu proyecto > Project Settings > API Keys > service_role\n\n" +
      "Ojo: es secreta, salta el RLS. Nunca en el bundle de Angular.\n\n" +
      "Para ver qué se subiría sin subir nada: node scripts\\sincronizar.mjs --seco",
  );
  process.exit(1);
}

const LOTE = 500;

// --- Lectura ----------------------------------------------------------------

function ficheros() {
  const todos = fs
    .readdirSync(datosDir)
    .filter((f) => /^obs-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  if (DIA) return todos.filter((f) => f === `obs-${DIA}.jsonl`);
  if (TODO) return todos;
  return todos.slice(-1); // por defecto, el más reciente
}

function* observaciones(fichero) {
  const texto = fs.readFileSync(path.join(datosDir, fichero), "utf8");
  for (const linea of texto.split("\n")) {
    if (!linea.trim()) continue;
    try {
      yield JSON.parse(linea);
    } catch {
      /* última línea a medias si el recolector murió escribiendo */
    }
  }
}

// --- Codificación por longitud de serie -------------------------------------

/**
 * Convierte la secuencia de sondeos en tramos de delay constante.
 *
 * Un trip observado 60 veces con 5 valores distintos son 5 filas, no 60. Y no
 * se pierde información: `sondeos` (cuántas veces se repitió un valor) es
 * exactamente lo que necesita la detección de congelados.
 */
function aTramos(obs) {
  const porPaso = new Map();
  for (const o of obs) {
    if (!o.start_date) continue;
    const k = `${o.stop_id}|${o.trip_id}|${o.start_date}`;
    if (!porPaso.has(k)) porPaso.set(k, []);
    porPaso.get(k).push(o);
  }

  const tramos = [];
  for (const lista of porPaso.values()) {
    lista.sort((a, b) => a.ts - b.ts);
    let actual = null;

    for (const o of lista) {
      const mismo =
        actual &&
        actual.delay === (o.delay ?? null) &&
        actual.rel === o.rel &&
        actual.trip_rel === o.trip_rel;

      if (mismo) {
        actual.hasta = o.ts;
        actual.sondeos++;
        continue;
      }

      if (actual) tramos.push(actual);
      const f = o.start_date;
      actual = {
        stop_id: o.stop_id,
        trip_id: o.trip_id,
        fecha_servicio: `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`,
        seq: o.seq,
        prog_segs: o.prog_segs,
        route_id: o.route_id ?? null,
        delay: o.delay ?? null,
        rel: o.rel,
        trip_rel: o.trip_rel ?? "SCHEDULED",
        origen: o.origen ?? null,
        hora_abs: o.hora_abs ?? null,
        desde: o.ts,
        hasta: o.ts,
        sondeos: 1,
      };
    }
    if (actual) tramos.push(actual);
  }

  // epoch -> ISO, ya al final, para no hacerlo en cada iteración
  for (const t of tramos) {
    t.desde = new Date(t.desde * 1000).toISOString();
    t.hasta = new Date(t.hasta * 1000).toISOString();
  }
  return tramos;
}

// --- Subida -----------------------------------------------------------------

async function subir(filas) {
  const res = await fetch(
    `${URL_BASE}/rest/v1/serie?on_conflict=stop_id,trip_id,fecha_servicio,desde`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        // merge-duplicates = upsert: el tramo abierto se reescribe cada vez
        // con su hasta/sondeos actualizados. Hace la subida idempotente, así
        // que se puede relanzar sin miedo a duplicar.
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(filas),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${(await res.text()).slice(0, 400)}`);
  }
}

/**
 * Rellena el catálogo de paradas desde el índice, solo con las que aparecen en
 * los datos. Sale del estático, no de que nadie teclee nombres a mano.
 */
async function subirParadas(ids) {
  const catalogo = "./indice/paradas.json";
  if (!fs.existsSync(catalogo)) {
    console.log("(sin indice/paradas.json, me salto el catálogo de paradas)");
    return;
  }
  const todas = JSON.parse(fs.readFileSync(catalogo, "utf8"));
  const filas = todas
    .filter((p) => ids.has(p.id))
    .map((p) => ({ id: p.id, nombre: p.n, lat: p.lat, lon: p.lon }));
  if (!filas.length) return;

  const res = await fetch(`${URL_BASE}/rest/v1/parada?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(filas),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`paradas: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
  console.log(`catálogo: ${filas.length} paradas`);
}

/**
 * Sube a Supabase el recorte de stop_times.txt de las paradas indicadas.
 *
 * Lo necesita la Edge Function: sin el horario no sabe a qué hora estaba
 * programado cada trip, y sin eso no hay retraso que medir. El índice
 * completo son 179 MB y 10.181 paradas; aquí solo van las que se recolectan.
 *
 * Hay que relanzarlo cada vez que se baje un estático nuevo.
 */
async function subirHorario(paradas) {
  if (!paradas.length) {
    console.error(
      "Uso: node scripts\\sincronizar.mjs --horario <parada> [<parada>...]\n" +
        "Ejemplo: node scripts\\sincronizar.mjs --horario 8220DB000270 8250DB002039",
    );
    process.exit(1);
  }

  for (const stop of paradas) {
    const f = path.join("./indice/paradas", `${stop}.jsonl`);
    if (!fs.existsSync(f)) {
      console.error(`  ${stop}: no está en el índice. ¿Has corrido indexar.mjs?`);
      continue;
    }

    // La PK es (stop_id, trip_id); el índice puede traer el mismo trip dos
    // veces si la parada aparece dos veces en el recorrido (circulares).
    const porTrip = new Map();
    for (const linea of fs.readFileSync(f, "utf8").split("\n")) {
      if (!linea.trim()) continue;
      const [tripId, seq, prog] = JSON.parse(linea);
      porTrip.set(tripId, { stop_id: stop, trip_id: tripId, seq, prog_segs: prog });
    }
    const filas = [...porTrip.values()];

    if (SECO) {
      console.log(`  ${stop}: ${filas.length} trips (seco, no se sube)`);
      continue;
    }

    for (let i = 0; i < filas.length; i += LOTE) {
      const res = await fetch(`${URL_BASE}/rest/v1/horario?on_conflict=stop_id,trip_id`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(filas.slice(i, i + LOTE)),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        throw new Error(`horario ${stop}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
      }
    }
    console.log(`  ${stop}: ${filas.length} trips subidos`);
  }

  if (!SECO) {
    await subirParadas(new Set(paradas));
    await subirRutas();
    console.log(
      "\nActiva la recolección de esas paradas con:\n" +
        "  update parada set recolectar = true where id in (...);",
    );
  }
}

/**
 * Upsert genérico en lotes contra PostgREST. Comparte cabeceras y el troceado
 * de LOTE con el resto; se creó para `subirCentro`, que sube dos tablas.
 */
async function upsertLotes(tabla, onConflict, filas, timeoutMs = 60_000) {
  for (let i = 0; i < filas.length; i += LOTE) {
    const res = await fetch(`${URL_BASE}/rest/v1/${tabla}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(filas.slice(i, i + LOTE)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`${tabla}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    }
  }
}

/**
 * Da de alta de golpe todas las paradas de una caja geográfica (el centro por
 * defecto) para LLEGADAS EN VIVO. Lee el índice, no el estático crudo:
 *   - indice/paradas.json      -> qué paradas caen en la caja (id, nombre, lat, lon)
 *   - indice/paradas/<id>.jsonl -> [trip_id, seq, prog] de cada parada (el horario)
 *   - indice/trip-ruta.json    -> trip_id -> route_id, para poner route_id y líneas
 *   - indice/rutas.json        -> route_id -> nombre corto, para los chips del buscador
 *
 * Marca `en_vivo = true`, NO `recolectar`: el histórico se queda estrecho. Sube
 * también `route_id` en el horario y las `lineas` de cada parada, que la versión
 * vieja de --horario no ponía.
 */
async function subirCentro() {
  const caja = leerCaja();
  const catalogoP = "./indice/paradas.json";
  for (const f of [catalogoP, "./indice/trip-ruta.json", "./indice/rutas.json"]) {
    if (!fs.existsSync(f)) {
      console.error(`Falta ${f}. Corre antes: node scripts/indexar.mjs ./gtfs ./indice`);
      process.exit(1);
    }
  }

  const catalogo = JSON.parse(fs.readFileSync(catalogoP, "utf8"));
  const tripRuta = JSON.parse(fs.readFileSync("./indice/trip-ruta.json", "utf8"));
  const rutas = JSON.parse(fs.readFileSync("./indice/rutas.json", "utf8"));

  const dentro = catalogo.filter(
    (p) =>
      p.lat != null && p.lon != null &&
      p.lat >= caja.latMin && p.lat <= caja.latMax &&
      p.lon >= caja.lonMin && p.lon <= caja.lonMax,
  );

  console.log(
    `Caja lat[${caja.latMin}, ${caja.latMax}] lon[${caja.lonMin}, ${caja.lonMax}]\n` +
      `${dentro.length} paradas dentro (de ${catalogo.length} con servicio).`,
  );
  if (!dentro.length) {
    console.error("Ninguna parada en la caja. ¿Coordenadas al revés?");
    process.exit(1);
  }

  const horarioFilas = [];
  const paradaFilas = [];
  let sinFichero = 0;

  for (const p of dentro) {
    const f = path.join("./indice/paradas", `${p.id}.jsonl`);
    if (!fs.existsSync(f)) {
      sinFichero++;
      continue;
    }
    // La PK del horario es (stop_id, trip_id); una circular puede repetir trip.
    const porTrip = new Map();
    const lineas = new Set();
    for (const linea of fs.readFileSync(f, "utf8").split("\n")) {
      if (!linea.trim()) continue;
      const [tripId, seq, prog] = JSON.parse(linea);
      const routeId = tripRuta[tripId] ?? null;
      porTrip.set(tripId, {
        stop_id: p.id, trip_id: tripId, seq, prog_segs: prog, route_id: routeId,
      });
      if (routeId && rutas[routeId]) lineas.add(rutas[routeId]);
    }
    for (const fila of porTrip.values()) horarioFilas.push(fila);
    paradaFilas.push({
      id: p.id,
      nombre: p.n,
      lat: p.lat,
      lon: p.lon,
      en_vivo: true,
      lineas: [...lineas].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    });
  }

  const totalLineas = paradaFilas.reduce((n, p) => n + p.lineas.length, 0);
  console.log(
    `  ${paradaFilas.length} paradas con horario, ${horarioFilas.length} filas de horario, ` +
      `${(totalLineas / (paradaFilas.length || 1)).toFixed(1)} líneas/parada de media.` +
      (sinFichero ? `  (${sinFichero} sin fichero en el índice, saltadas)` : ""),
  );

  if (SECO) {
    console.log("[SECO] no se ha subido nada. Repite sin --seco para dar el alta.");
    return;
  }

  await subirRutas();
  process.stdout.write("  subiendo horario...");
  await upsertLotes("horario", "stop_id,trip_id", horarioFilas);
  process.stdout.write(" hecho\n  subiendo paradas...");
  await upsertLotes("parada", "id", paradaFilas);
  process.stdout.write(" hecho\n");
  console.log(
    `\nAlta completa: ${paradaFilas.length} paradas en vivo en el centro.\n` +
      "La Edge Function las recogerá en la próxima pasada del cron (cada minuto).",
  );
}

/**
 * Catálogo de rutas. El feed trae route_id crudos ("1 F1 a"); lo que la gente
 * conoce es "F1". Son 403 filas, se suben enteras y ya.
 */
async function subirRutas() {
  const catalogo = "./indice/rutas.json";
  if (!fs.existsSync(catalogo)) return;

  const r = JSON.parse(fs.readFileSync(catalogo, "utf8"));
  const filas = Object.entries(r).map(([id, nombre]) => ({ id, nombre }));

  for (let i = 0; i < filas.length; i += LOTE) {
    const res = await fetch(`${URL_BASE}/rest/v1/ruta?on_conflict=id`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(filas.slice(i, i + LOTE)),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`rutas: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
    }
  }
  console.log(`rutas: ${filas.length} subidas`);
}

// --- Main -------------------------------------------------------------------

if (CENTRO) {
  await subirCentro();
  process.exit(0);
}

if (HORARIO) {
  const paradas = args.filter((a) => /^[0-9]{4}[A-Z]{2}/i.test(a));
  await subirHorario(paradas);
  process.exit(0);
}

const fs_ = ficheros();
if (!fs_.length) {
  console.error("No hay ficheros obs-*.jsonl que subir.");
  process.exit(1);
}

let totalObs = 0, totalTramos = 0, subidos = 0;
const paradasVistas = new Set();

for (const f of fs_) {
  const obs = [...observaciones(f)];
  const tramos = aTramos(obs);
  totalObs += obs.length;
  totalTramos += tramos.length;
  for (const t of tramos) paradasVistas.add(t.stop_id);

  const ratio = obs.length ? (obs.length / tramos.length).toFixed(1) : "0";
  console.log(`${f}: ${obs.length} observaciones -> ${tramos.length} tramos  (${ratio}x menos)`);

  if (SECO) continue;

  for (let i = 0; i < tramos.length; i += LOTE) {
    const lote = tramos.slice(i, i + LOTE);
    await subir(lote);
    subidos += lote.length;
    process.stdout.write(`\r  subidos ${subidos}/${totalTramos}   `);
  }
  process.stdout.write("\n");
}

if (!SECO) await subirParadas(paradasVistas);

console.log(
  `\n${SECO ? "[SECO] " : ""}${totalObs} observaciones -> ${totalTramos} tramos` +
    (SECO ? " (no se ha subido nada)" : `, ${subidos} subidos`),
);
