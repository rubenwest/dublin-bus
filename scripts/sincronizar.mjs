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
import { idPatron } from "./patron.mjs";

cargarDotEnv();

const args = process.argv.slice(2);
const SECO = args.includes("--seco");
const TODO = args.includes("--todo");
const HORARIO = args.includes("--horario");
const CENTRO = args.includes("--centro");
const NUCLEO = args.includes("--nucleo");
const DIA = args.includes("--dia") ? args[args.indexOf("--dia") + 1] : null;
const datosDir = "./datos";

/**
 * Caja urbana de Dublín por defecto: amplía el centro hasta Rialto por el oeste
 * y East Wall por el este, sin abrir todavía todo el núcleo metropolitano.
 * Ajustable con  --caja <latMin> <latMax> <lonMin> <lonMax>.
 */
const CAJA_CENTRO = { latMin: 53.33, latMax: 53.365, lonMin: -6.31, lonMax: -6.22 };

/**
 * Paradas que entran siempre, caigan o no en la caja: son las del histórico
 * (`parada.recolectar`) que quedan fuera del centro. Si se quedaran sin horario
 * la serie se corta, que es lo único que no se puede reconstruir después.
 */
const EXCEPCIONES = new Set(["8250DB002039"]);

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
 * `--horario <parada>` ya no existe, y no es un olvido.
 *
 * Subía una parada suelta a la tabla `horario`, que era una fila por (parada,
 * viaje). Ahora el horario se guarda por PATRÓN de recorrido, y un patrón es
 * una propiedad del viaje entero: no se puede meter una parada en medio sin
 * recalcular los patrones de todos los viajes que pasan por ella, que es
 * exactamente lo que hace `--centro` / `--nucleo` de una pasada.
 *
 * Con `--nucleo` cargado son las 1.877 paradas de Dublin Bus, así que la parada
 * que quisieras dar de alta a mano ya está: activarla es un UPDATE de un
 * `boolean`, no una subida.
 */
function avisarHorarioRetirado() {
  console.error(
    "`--horario <parada>` se retiró: el horario ya no se guarda por parada, se\n" +
      "guarda por patrón de recorrido, y un patrón es de un viaje entero.\n\n" +
      "Para ensanchar la cobertura:\n" +
      "  node scripts\\sincronizar.mjs --nucleo --seco   cuenta las 1.877 del núcleo\n" +
      "  node scripts\\sincronizar.mjs --nucleo          las da de alta en vivo\n\n" +
      "Para empezar a guardar el histórico de una parada que ya está en vivo:\n" +
      "  update parada set recolectar = true where id in ('8220DB000270');",
  );
  process.exit(1);
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
  // `--nucleo` añade a la caja las 1.877 paradas de Dublin Bus. Con el horario
  // por patrones eso cabe: la caja del centro ocupaba 144 MB y el núcleo entero
  // se queda en decenas, no en los ~410 MB de antes.
  //
  // AÑADE, no sustituye, y eso es a propósito: el prefijo `8220DB` deja fuera
  // el Luas (`8220GA`), Irish Rail (`8220IR`) y los andenes `8220B1` del
  // centro, que sí estaban en vivo. Como la carga termina barriendo todo viaje
  // que no venga de esta pasada, elegir solo por prefijo los dejaba en vivo
  // pero sin horario: 91 paradas mudas, 56 de ellas Luas, que es justo lo que
  // más llegadas tiene. La selección tiene que ser un superconjunto de lo que
  // ya estaba en vivo, o la limpieza se lleva por delante lo que no recarga.
  const prefijoNucleo = NUCLEO ? "8220DB" : null;
  for (const f of [catalogoP, "./indice/trip-ruta.json", "./indice/rutas.json"]) {
    if (!fs.existsSync(f)) {
      console.error(`Falta ${f}. Corre antes: node scripts/indexar.mjs ./gtfs ./indice`);
      process.exit(1);
    }
  }

  const catalogo = JSON.parse(fs.readFileSync(catalogoP, "utf8"));
  const tripRuta = JSON.parse(fs.readFileSync("./indice/trip-ruta.json", "utf8"));
  const rutas = JSON.parse(fs.readFileSync("./indice/rutas.json", "utf8"));

  const enCaja = (p) =>
    p.lat != null && p.lon != null &&
    p.lat >= caja.latMin && p.lat <= caja.latMax &&
    p.lon >= caja.lonMin && p.lon <= caja.lonMax;

  const dentro = catalogo.filter(
    (p) =>
      enCaja(p) ||
      EXCEPCIONES.has(p.id) ||
      (prefijoNucleo != null && p.id.startsWith(prefijoNucleo)),
  );

  console.log(
    (prefijoNucleo
      ? `Núcleo Dublin Bus (${prefijoNucleo}*) + caja del centro\n`
      : `Caja lat[${caja.latMin}, ${caja.latMax}] lon[${caja.lonMin}, ${caja.lonMax}]\n`) +
      `${dentro.length} paradas dentro (de ${catalogo.length} con servicio).`,
  );
  if (!dentro.length) {
    console.error("Ninguna parada en la caja. ¿Coordenadas al revés?");
    process.exit(1);
  }

  // El índice está por parada, pero un patrón es por VIAJE: hay que darle la
  // vuelta igual que se le dio la vuelta al bucle del recolector. Se junta todo
  // en memoria (son ~2,5 M de tuplas pequeñas en el núcleo entero) y luego se
  // agrupa por trip.
  const porViaje = new Map();
  const paradaFilas = [];
  let sinFichero = 0;

  for (const p of dentro) {
    const f = path.join("./indice/paradas", `${p.id}.jsonl`);
    if (!fs.existsSync(f)) {
      sinFichero++;
      continue;
    }
    // Una circular puede pasar dos veces por la misma parada en el mismo viaje.
    // Se queda el paso de mayor `seq`, que es lo que hacía la PK (stop_id,
    // trip_id) de la tabla vieja: la vista `horario` sigue siendo 1 a 1.
    const ultimoPaso = new Map();
    const lineas = new Set();
    for (const linea of fs.readFileSync(f, "utf8").split("\n")) {
      if (!linea.trim()) continue;
      const [tripId, seq, prog] = JSON.parse(linea);
      const previo = ultimoPaso.get(tripId);
      if (!previo || seq > previo.seq) ultimoPaso.set(tripId, { seq, prog });
      const routeId = tripRuta[tripId] ?? null;
      if (routeId && rutas[routeId]) lineas.add(rutas[routeId]);
    }
    for (const [tripId, paso] of ultimoPaso) {
      if (!porViaje.has(tripId)) porViaje.set(tripId, []);
      porViaje.get(tripId).push({ stop_id: p.id, seq: paso.seq, prog: paso.prog });
    }
    paradaFilas.push({
      id: p.id,
      nombre: p.n,
      lat: p.lat,
      lon: p.lon,
      en_vivo: true,
      lineas: [...lineas].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    });
  }

  const { patronFilas, patronParadaFilas, viajeFilas, tuplas } = aPatrones(porViaje, tripRuta);

  const totalLineas = paradaFilas.reduce((n, p) => n + p.lineas.length, 0);
  console.log(
    `  ${paradaFilas.length} paradas con horario, ` +
      `${(totalLineas / (paradaFilas.length || 1)).toFixed(1)} líneas/parada de media.` +
      (sinFichero ? `  (${sinFichero} sin fichero en el índice, saltadas)` : ""),
  );
  console.log(
    `  ${tuplas} paradas-por-viaje -> ${viajeFilas.length} viajes en ` +
      `${patronFilas.length} patrones (${patronParadaFilas.length} filas de recorrido). ` +
      `${(tuplas / (patronParadaFilas.length || 1)).toFixed(1)}x menos que una fila por parada y viaje.`,
  );

  if (SECO) {
    console.log("[SECO] no se ha subido nada. Repite sin --seco para dar el alta.");
    return;
  }

  // Marca de esta carga. Va en cada viaje que se sube y al final sirve para
  // barrer los de la carga anterior: el upsert añade y actualiza, pero no borra.
  const cargado = new Date().toISOString();
  for (const v of viajeFilas) v.cargado = cargado;

  await subirRutas();
  // Orden obligatorio: el patrón antes que sus paradas y que los viajes, porque
  // las dos tablas lo referencian con una FK.
  process.stdout.write("  subiendo patrones...");
  await upsertLotes("patron", "id", patronFilas);
  process.stdout.write(" hecho\n  subiendo recorridos...");
  await upsertLotes("patron_parada", "patron,orden", patronParadaFilas);
  process.stdout.write(" hecho\n  subiendo viajes...");
  await upsertLotes("viaje", "trip_id", viajeFilas);
  process.stdout.write(" hecho\n  subiendo paradas...");
  await upsertLotes("parada", "id", paradaFilas);
  process.stdout.write(" hecho\n  limpiando la carga anterior...");
  const limpieza = await limpiarHorario(cargado);
  process.stdout.write(` hecho (${limpieza})\n`);

  console.log(
    `\nAlta completa: ${paradaFilas.length} paradas en vivo.\n` +
      "La Edge Function las recogerá en la próxima pasada del cron (cada minuto).",
  );
}

/**
 * Agrupa los viajes en patrones de recorrido.
 *
 * Un viaje es "el patrón P saliendo en el segundo S". Medido sobre las 658
 * paradas del centro, 72.593 viajes caben en 7.364 patrones: el mismo recorrido
 * se repite cada pocos minutos y sólo cambia la hora de salida. Eso es lo que
 * hace que quepa el núcleo entero en el plan gratuito.
 *
 * El id del patrón es el md5 de su contenido, no un contador, para que la
 * subida siga siendo idempotente: repetir la carga da los mismos ids y el
 * upsert no duplica nada. La misma fórmula está en la migración
 * `20260917120000_horario_por_patron.sql`; si cambia una hay que cambiar las dos.
 */
function aPatrones(porViaje, tripRuta) {
  const patrones = new Map();
  const viajeFilas = [];
  let tuplas = 0;

  for (const [tripId, pasos] of porViaje) {
    pasos.sort((a, b) => a.seq - b.seq);
    tuplas += pasos.length;
    // El desfase se mide contra la PRIMERA parada por `seq`, no contra el
    // `prog` mínimo: es lo que significa "sale".
    const sale = pasos[0].prog;
    const texto = pasos.map((p) => `${p.stop_id}:${p.seq}:${p.prog - sale}`).join(",");
    const id = idPatron(texto);

    if (!patrones.has(id)) {
      patrones.set(id, pasos.map((p, i) => ({
        patron: id,
        orden: i,
        stop_id: p.stop_id,
        seq: p.seq,
        desfase: p.prog - sale,
      })));
    }
    viajeFilas.push({
      trip_id: tripId,
      patron: id,
      sale,
      route_id: tripRuta[tripId] ?? null,
    });
  }

  const patronParadaFilas = [];
  for (const filas of patrones.values()) patronParadaFilas.push(...filas);

  return {
    patronFilas: [...patrones].map(([id, filas]) => ({ id, paradas: filas.length })),
    patronParadaFilas,
    viajeFilas,
    tuplas,
  };
}

/** Barre los viajes de la carga anterior y los patrones que quedan huérfanos. */
async function limpiarHorario(desde) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/limpiar_horario`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_desde: desde }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`limpiar_horario: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
  const r = await res.json();
  return `${r.viajes_borrados} viajes, ${r.patrones_borrados} patrones`;
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

if (CENTRO || NUCLEO) {
  await subirCentro();
  process.exit(0);
}

if (HORARIO) avisarHorarioRetirado();

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
