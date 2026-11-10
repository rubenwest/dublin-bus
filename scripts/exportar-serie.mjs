#!/usr/bin/env node
/**
 * Vuelca `serie` de Supabase a disco, un fichero por día de servicio:
 * datos/serie/serie-YYYY-MM-DD.jsonl.gz
 *
 * Existe por la retención (`podar_serie`). La base sólo guarda el crudo de
 * los últimos días y de lo viejo se queda una fila por autobús en
 * `paso_archivado`, que es lo que necesita `fiabilidad`. Pero si algún día
 * cambia la definición —la ventana de 15 minutos, el `sondeos >= 2`— lo
 * archivado no se puede recalcular sin el crudo. Esto es esa copia.
 *
 * Uso:
 *   node scripts\exportar-serie.mjs                  todo lo anterior a hoy
 *   node scripts\exportar-serie.mjs --hasta 2026-10-18
 *
 * Una sola pasada por id (keyset, de 1.000 en 1.000, que es el tope de
 * PostgREST) repartiendo las filas por día. Filtrar por día obligaría a un
 * recorrido entero de la tabla por cada uno: no hay índice por fecha sola.
 *
 * Los días que ya tienen fichero se saltan. Cada fichero se escribe en .tmp
 * y se renombra al acabar, y al final se imprime el recuento por día para
 * compararlo con `select fecha_servicio, count(*) from serie group by 1`.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { cargarDotEnv } from "./entorno.mjs";

cargarDotEnv();

const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_BASE || !SERVICE_KEY) {
  console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en .env");
  process.exit(1);
}

const args = process.argv.slice(2);
const ayer = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);
const HASTA = args.includes("--hasta") ? args[args.indexOf("--hasta") + 1] : ayer;
const DIR = "./datos/serie";
const PAGINA = 1000;

const cabeceras = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function pedir(url) {
  for (let intento = 1; ; intento++) {
    try {
      const res = await fetch(url, { headers: cabeceras, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return res.json();
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      if (intento >= 4) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** intento));
    }
  }
}

const destino = (dia) => path.join(DIR, `serie-${dia}.jsonl.gz`);
fs.mkdirSync(DIR, { recursive: true });

/** dia -> { gz, salida, filas } */
const abiertos = new Map();
const yaEstaban = new Set();

function flujo(dia) {
  let f = abiertos.get(dia);
  if (!f) {
    const gz = zlib.createGzip();
    const salida = fs.createWriteStream(destino(dia) + ".tmp");
    gz.pipe(salida);
    f = { gz, salida, filas: 0 };
    abiertos.set(dia, f);
  }
  return f;
}

let ultimo = 0;
let leidas = 0;
for (;;) {
  const pagina = await pedir(
    `${URL_BASE}/rest/v1/serie?select=*&id=gt.${ultimo}&fecha_servicio=lte.${HASTA}&order=id&limit=${PAGINA}`
  );
  for (const fila of pagina) {
    const dia = fila.fecha_servicio;
    if (yaEstaban.has(dia)) continue;
    if (!abiertos.has(dia) && fs.existsSync(destino(dia))) {
      yaEstaban.add(dia);
      continue;
    }
    const f = flujo(dia);
    f.gz.write(JSON.stringify(fila) + "\n");
    f.filas++;
  }
  leidas += pagina.length;
  if (pagina.length < PAGINA) break;
  ultimo = pagina[pagina.length - 1].id;
  if (leidas % 50_000 === 0) console.log(`  ${leidas} filas leídas (id ${ultimo})`);
}

const resumen = {};
for (const [dia, f] of [...abiertos].sort()) {
  f.gz.end();
  await new Promise((ok, mal) => f.salida.on("finish", ok).on("error", mal));
  fs.renameSync(destino(dia) + ".tmp", destino(dia));
  resumen[dia] = f.filas;
  console.log(`${dia}  ${f.filas} filas  ${(fs.statSync(destino(dia)).size / 1e6).toFixed(1)} MB`);
}
if (yaEstaban.size) console.log(`Ya estaban: ${[...yaEstaban].sort().join(", ")}`);
fs.writeFileSync(path.join(DIR, `recuento-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(resumen, null, 1));
