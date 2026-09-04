#!/usr/bin/env node
/**
 * Genera el índice que usa el backend.
 *
 * El problema que resuelve: `llegadas.mjs` recorre los 405 MB de
 * `stop_times.txt` en cada consulta y tarda 7-10 s. Vale para consola, es
 * imposible para una petición web. Aquí se recorre UNA vez y se deja un
 * fichero por parada, que el servidor lee en un milisegundo.
 *
 * Uso:
 *   node scripts\indexar.mjs .\gtfs .\indice
 *
 * Hay que volver a lanzarlo cada vez que se descargue un estático nuevo
 * (la NTA lo actualiza cada pocas semanas).
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const [gtfsDir = "./gtfs", indiceDir = "./indice"] = process.argv.slice(2);

// --- CSV --------------------------------------------------------------------

function parseCsvLine(line) {
  const out = [];
  let cur = "",
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

async function* filasCsv(p) {
  const rl = readline.createInterface({
    input: fs.createReadStream(p, "utf8"),
    crlfDelay: Infinity,
  });
  let cab = null;
  for await (const l of rl) {
    if (!l.trim()) continue;
    const c = parseCsvLine(l);
    if (!cab) {
      c[0] = c[0].replace(/^﻿/, "");
      cab = c;
      continue;
    }
    const f = {};
    cab.forEach((k, i) => {
      f[k] = c[i];
    });
    yield f;
  }
}

const segundos = (hhmmss) => {
  const [h, m, s] = hhmmss.split(":").map(Number);
  return h * 3600 + m * 60 + s;
};

// --- Generación -------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  fs.rmSync(indiceDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(indiceDir, "paradas"), { recursive: true });

  // 1. Catálogo de paradas y rutas (ficheros pequeños, caben en memoria)
  console.log("1/3  Leyendo stops.txt y routes.txt...");
  const paradas = new Map();
  for await (const s of filasCsv(path.join(gtfsDir, "stops.txt"))) {
    if (!s.stop_id) continue;
    paradas.set(s.stop_id, {
      id: s.stop_id,
      nombre: s.stop_name ?? s.stop_id,
      lat: s.stop_lat ? Number(s.stop_lat) : null,
      lon: s.stop_lon ? Number(s.stop_lon) : null,
      trips: 0,
    });
  }

  const rutas = {};
  for await (const r of filasCsv(path.join(gtfsDir, "routes.txt"))) {
    rutas[r.route_id] = r.route_short_name || r.route_long_name || r.route_id;
  }
  console.log(`     ${paradas.size} paradas, ${Object.keys(rutas).length} rutas`);

  // 2. trip_id -> route_id, para no tener que abrir trips.txt en cada consulta
  console.log("2/3  Leyendo trips.txt...");
  const tripRuta = new Map();
  for await (const t of filasCsv(path.join(gtfsDir, "trips.txt"))) {
    tripRuta.set(t.trip_id, t.route_id);
  }
  console.log(`     ${tripRuta.size} trips`);

  // 3. El fichero gordo. Una pasada, acumulando por parada.
  //    No cabe entero en memoria como objetos JS, así que se vuelca por lotes.
  console.log("3/3  Recorriendo stop_times.txt (los 405 MB, tarda ~1 min)...");
  const buffers = new Map(); // stop_id -> array de [trip_id, seq, prog]
  let filas = 0,
    volcados = 0;

  const volcar = (stopId) => {
    const datos = buffers.get(stopId);
    if (!datos?.length) return;
    const f = path.join(indiceDir, "paradas", `${stopId}.jsonl`);
    fs.appendFileSync(f, datos.map((d) => JSON.stringify(d)).join("\n") + "\n");
    buffers.set(stopId, []);
    volcados++;
  };

  for await (const st of filasCsv(path.join(gtfsDir, "stop_times.txt"))) {
    filas++;
    const hora = st.arrival_time || st.departure_time;
    if (!hora || !st.stop_id) continue;
    const p = paradas.get(st.stop_id);
    if (!p) continue; // stop_time que apunta a una parada inexistente

    if (!buffers.has(st.stop_id)) buffers.set(st.stop_id, []);
    buffers.get(st.stop_id).push([st.trip_id, Number(st.stop_sequence), segundos(hora)]);
    p.trips++;

    // Volcado por lotes para no acumular 7,7 M de arrays en memoria
    if (buffers.get(st.stop_id).length >= 500) volcar(st.stop_id);
    if (filas % 1_000_000 === 0) {
      process.stdout.write(`\r     ${(filas / 1e6).toFixed(0)}M filas...`);
    }
  }
  for (const stopId of buffers.keys()) volcar(stopId);
  process.stdout.write("\r".padEnd(40) + "\r");
  console.log(`     ${filas} filas, ${volcados} volcados`);

  // 4. Catálogo: solo paradas con servicio, que es lo que buscará el usuario
  const conServicio = [...paradas.values()].filter((p) => p.trips > 0);
  conServicio.sort((a, b) => b.trips - a.trips);

  fs.writeFileSync(
    path.join(indiceDir, "paradas.json"),
    JSON.stringify(conServicio.map((p) => ({ id: p.id, n: p.nombre, lat: p.lat, lon: p.lon, t: p.trips }))),
  );
  fs.writeFileSync(path.join(indiceDir, "rutas.json"), JSON.stringify(rutas));
  fs.writeFileSync(
    path.join(indiceDir, "trip-ruta.json"),
    JSON.stringify(Object.fromEntries(tripRuta)),
  );
  fs.writeFileSync(
    path.join(indiceDir, "meta.json"),
    JSON.stringify({
      generado: new Date().toISOString(),
      filas,
      paradas: conServicio.length,
      rutas: Object.keys(rutas).length,
      trips: tripRuta.size,
    }, null, 2),
  );

  const seg = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\nÍndice generado en ${seg}s`);
  console.log(`  ${conServicio.length} paradas con servicio (de ${paradas.size})`);
  console.log(`  destino: ${path.resolve(indiceDir)}`);
  console.log(`  más concurridas:`);
  for (const p of conServicio.slice(0, 5)) {
    console.log(`    ${p.id.padEnd(15)} ${String(p.trips).padStart(6)} pasadas  ${p.nombre}`);
  }
}

main().catch((e) => {
  console.error("\nError:", e.message);
  process.exit(1);
});
