/**
 * Mantiene el horario de Supabase al día con el estático de la NTA, sin manos.
 *
 * Por qué existe: cada vez que la NTA publica un estático nuevo cambian los
 * `trip_id` de Dublin Bus y, hasta que se recarga el horario, la mayoría de
 * paradas salen sin llegadas (20-09, 30-09 y 09-11 de 2026). Recargar son cinco
 * pasos a mano; esto los hace y, sobre todo, NO carga nada que no case.
 *
 * Qué hace, en orden:
 *   1. Mira `Last-Modified` del ZIP. Si es el que ya se cargó, termina.
 *   2. Baja el ZIP a una carpeta temporal y lo descomprime allí.
 *   3. Compara los trip_id vivos del feed con los de su trips.txt. Por debajo
 *      de UMBRAL no carga: el feed puede ir por delante del estático publicado
 *      (09-11: prefijos 6055/6037 que no estaban en ningún ZIP) y cargar algo
 *      que no casa sería quitar un horario malo para poner otro igual de malo.
 *   4. Copia a gtfs/, reindexa y sube con `sincronizar.mjs --nucleo`.
 *   5. Regenera trazados y códigos de parada en web/public (NO los commitea ni
 *      los despliega: eso sigue siendo cosa de una PR).
 *
 * Es idempotente: se puede lanzar cuantas veces se quiera. Si algo falla no
 * se anota como cargado y la siguiente pasada lo reintenta.
 *
 *   node scripts/actualizar-estatico.mjs            lo hace
 *   node scripts/actualizar-estatico.mjs --seco     descarga y comprueba, no carga
 *   node scripts/actualizar-estatico.mjs --forzar   ignora Last-Modified
 *
 * Necesita NODE_EXTRA_CA_CERTS (lo pone actualizar-estatico.cmd).
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { cargarDotEnv, leerTexto } from "./entorno.mjs";

cargarDotEnv();

const ZIP_URL = "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip";
const FEED_URL = "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json";
const UMBRAL = 0.9;

const args = process.argv.slice(2);
const SECO = args.includes("--seco");
const FORZAR = args.includes("--forzar");

const RAIZ = path.resolve(import.meta.dirname, "..");
const ESTADO = path.join(RAIZ, "datos", "estatico-estado.json");
const LOG = path.join(RAIZ, "datos", "actualizar-estatico.log");
const TMP = path.join(RAIZ, "datos", "estatico-nuevo");
const FICHEROS = [
  "agency", "calendar", "calendar_dates", "feed_info", "routes",
  "shapes", "stop_times", "stops", "translations", "trips",
];

function log(msg) {
  const linea = `${new Date().toISOString()} ${msg}`;
  console.log(linea);
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, linea + "\n");
}

function leerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ESTADO, "utf8"));
  } catch {
    return {};
  }
}

function paso(titulo, cmd, cmdArgs) {
  log(`> ${titulo}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: RAIZ, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const salida = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n    ");
  if (r.status !== 0) {
    throw new Error(`${titulo} falló (código ${r.status}):\n    ${salida}`);
  }
  log(`  ${salida.split("\n").pop()}`);
}

async function main() {
  if (!process.env.NODE_EXTRA_CA_CERTS) {
    log("AVISO: sin NODE_EXTRA_CA_CERTS, la mitad de las llamadas a la NTA fallarán.");
  }
  const estado = leerEstado();

  // 1. ¿Hay estático nuevo?
  const cab = await fetch(ZIP_URL, { method: "HEAD", signal: AbortSignal.timeout(60_000) });
  if (!cab.ok) throw new Error(`HEAD del ZIP: HTTP ${cab.status}`);
  const modificado = cab.headers.get("last-modified");
  if (!FORZAR && modificado && modificado === estado.lastModified) {
    log(`sin cambios (ZIP del ${modificado}, ya cargado)`);
    return;
  }

  // 2. Bajarlo y descomprimirlo en una carpeta propia.
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const zip = path.join(TMP, "estatico.zip");
  log(`bajando el ZIP (${modificado ?? "sin Last-Modified"})...`);
  const res = await fetch(ZIP_URL, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`GET del ZIP: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
  const sacados = path.join(TMP, "x");
  fs.mkdirSync(sacados);
  // tar de Windows 10+ (bsdtar) abre ZIP; evita depender de unzip.
  // Ruta completa: con Git for Windows en el PATH, `tar` es el GNU tar, que
  // toma "C:" por un host remoto.
  const tarWin = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  paso("descomprimir", tarWin, ["-xf", zip, "-C", sacados]);
  for (const f of FICHEROS) {
    if (!fs.existsSync(path.join(sacados, `${f}.txt`))) throw new Error(`falta ${f}.txt en el ZIP`);
  }
  const version = leerTexto(path.join(sacados, "feed_info.txt")).trim().split(/\r?\n/).pop().split(",")[5];

  // 3. ¿Casa con el feed vivo?
  const cuerpo = leerTexto(path.join(sacados, "trips.txt")).split(/\r?\n/);
  const col = cuerpo[0].split(",").indexOf("trip_id");
  const ids = new Set();
  for (let i = 1; i < cuerpo.length; i++) if (cuerpo[i]) ids.add(cuerpo[i].split(",")[col]);
  const fr = await fetch(FEED_URL, {
    headers: { "x-api-key": process.env.NTA_API_KEY, "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!fr.ok) throw new Error(`feed: HTTP ${fr.status}`);
  const vivos = ((await fr.json()).entity ?? [])
    .map((e) => e.trip_update?.trip?.trip_id)
    .filter(Boolean);
  const casan = vivos.filter((t) => ids.has(t)).length;
  const frac = vivos.length ? casan / vivos.length : 0;
  log(`versión ${version}: casan ${casan} de ${vivos.length} viajes vivos (${(frac * 100).toFixed(1)}%)`);

  if (frac < UMBRAL) {
    log(`NO se carga: por debajo del ${UMBRAL * 100}%. El feed va por delante del ZIP publicado; se reintenta en la próxima pasada.`);
    fs.rmSync(TMP, { recursive: true, force: true });
    return;
  }
  if (SECO) {
    log("--seco: casa, pero no se carga nada.");
    fs.rmSync(TMP, { recursive: true, force: true });
    return;
  }

  // 4. Cargar.
  for (const f of FICHEROS) fs.copyFileSync(path.join(sacados, `${f}.txt`), path.join(RAIZ, "gtfs", `${f}.txt`));
  paso("indexar", process.execPath, ["scripts/indexar.mjs", "./gtfs", "./indice"]);
  paso("sincronizar --nucleo", process.execPath, ["scripts/sincronizar.mjs", "--nucleo"]);

  // Hasta aquí la base ya está bien: se anota antes de lo accesorio.
  fs.writeFileSync(ESTADO, JSON.stringify({ lastModified: modificado, version, cargado: new Date().toISOString() }, null, 2));

  // 5. Lo que va a la web (sin commitear).
  try {
    paso("trazados", process.execPath, ["scripts/trazados.mjs"]);
    paso("codigos-parada", process.execPath, ["scripts/codigos-parada.mjs"]);
    paso("paradas-web", process.execPath, ["scripts/paradas-web.mjs"]);
    log("web/public regenerado: falta commitearlo y desplegar.");
  } catch (e) {
    log(`AVISO (la base ya está cargada): ${e.message}`);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  log("hecho.");
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
