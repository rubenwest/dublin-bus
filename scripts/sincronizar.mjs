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
const DIA = args.includes("--dia") ? args[args.indexOf("--dia") + 1] : null;
const datosDir = "./datos";

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

// --- Main -------------------------------------------------------------------

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
