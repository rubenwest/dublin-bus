#!/usr/bin/env node
/**
 * Backend. Existe por dos razones ineludibles:
 *
 *  1. La API key no puede ir en el bundle de Angular, y además hay CORS.
 *  2. Fair usage de la NTA: **una** llamada cada 30-60 s para todos los
 *     usuarios, nunca una por usuario. Este servidor mantiene una única copia
 *     del feed en memoria y la refresca en segundo plano; las peticiones de los
 *     clientes se sirven de esa copia y no disparan tráfico hacia la NTA.
 *
 * Uso:
 *   node servidor\api.mjs
 *   node servidor\api.mjs --puerto 3000 --indice .\indice
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

import { cargarDotEnv } from "../scripts/entorno.mjs";
import { crearClienteFeed, detallarError } from "../scripts/feed.mjs";
import { tripsEnVivo, calcularLlegada } from "../scripts/gtfsrt.mjs";

cargarDotEnv();

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, "..");

function arg(nombre, pordefecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
}

const PUERTO = Number(arg("puerto", process.env.PUERTO ?? 3000));
const INDICE = path.resolve(RAIZ, arg("indice", "./indice"));
const WEB = path.resolve(RAIZ, arg("web", "./web/dist/web/browser"));

/** Ventana de llegadas que se devuelve. */
const VENTANA_MIN = [-2, 90];

const API_KEY = process.env.NTA_API_KEY;

// --- Índice estático --------------------------------------------------------

if (!fs.existsSync(path.join(INDICE, "paradas.json"))) {
  console.error(
    `No encuentro el índice en ${INDICE}.\n` +
      `Genéralo antes con:  node scripts\\indexar.mjs .\\gtfs .\\indice`,
  );
  process.exit(1);
}

console.log("Cargando índice...");
const paradas = JSON.parse(fs.readFileSync(path.join(INDICE, "paradas.json"), "utf8"));
const rutas = JSON.parse(fs.readFileSync(path.join(INDICE, "rutas.json"), "utf8"));
const tripRuta = JSON.parse(fs.readFileSync(path.join(INDICE, "trip-ruta.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(INDICE, "meta.json"), "utf8"));

const porId = new Map(paradas.map((p) => [p.id, p]));
console.log(`  ${paradas.size ?? paradas.length} paradas, ${Object.keys(rutas).length} rutas`);

/** Caché LRU cutre de ficheros de parada. Sobra para el tamaño que tiene esto. */
const cacheParadas = new Map();
const CACHE_MAX = 300;

function indiceDeParada(stopId) {
  if (cacheParadas.has(stopId)) {
    const v = cacheParadas.get(stopId);
    cacheParadas.delete(stopId);
    cacheParadas.set(stopId, v); // reinsertar = marcar como reciente
    return v;
  }
  const f = path.join(INDICE, "paradas", `${stopId}.jsonl`);
  if (!fs.existsSync(f)) return null;

  const m = new Map();
  for (const linea of fs.readFileSync(f, "utf8").split("\n")) {
    if (!linea.trim()) continue;
    const [tripId, seq, prog] = JSON.parse(linea);
    m.set(tripId, { seq, prog });
  }

  cacheParadas.set(stopId, m);
  if (cacheParadas.size > CACHE_MAX) {
    cacheParadas.delete(cacheParadas.keys().next().value);
  }
  return m;
}

// --- Feed compartido --------------------------------------------------------

/**
 * De dónde sale el feed.
 *
 * Por defecto NO se llama a la NTA: se lee el volcado que deja el recolector
 * en datos/ultimo-feed.json. El fair usage de la NTA es de una llamada cada
 * 30-60 s **para todos los usuarios**, y si el recolector y el servidor
 * llamasen cada uno por su cuenta ya serían dos. Se comprobó por las malas:
 * dos procesos sondeando a la vez dan HTTP 429.
 *
 * Con --directo el servidor llama él mismo, para cuando corra sin recolector
 * al lado (por ejemplo desplegado en un sitio y el recolector en otro).
 */
const DIRECTO = process.argv.includes("--directo");
const FICHERO_FEED = path.resolve(RAIZ, arg("feed", "./datos/ultimo-feed.json"));

if (DIRECTO && !API_KEY) {
  console.error("--directo necesita NTA_API_KEY (ponla en .env o en el entorno)");
  process.exit(1);
}

/**
 * Con --directo se llama a la NTA, y ahí manda el fair usage: 45 s.
 * Leyendo el fichero del recolector solo se mira un mtime, que es gratis.
 */
const REFRESCO_MS = DIRECTO ? 45_000 : 5_000;

const cliente = DIRECTO
  ? crearClienteFeed({
      apiKey: API_KEY,
      alReintentar: (err, intento, espera) =>
        console.error(
          `[feed] intento ${intento} falló, reintento en ${(espera / 1000).toFixed(1)}s\n` +
            detallarError(err),
        ),
    })
  : null;

const estado = {
  feed: null,
  trips: new Map(),
  obtenido: null, // Date del último refresco correcto
  headerTs: null, // timestamp que trae el propio feed
  origen: DIRECTO ? "nta" : "recolector",
  refrescos: 0,
  fallos: 0,
  ultimoError: null,
  mtimeLeido: 0,
};

async function refrescar() {
  try {
    let feed;

    if (DIRECTO) {
      feed = await cliente.pedir();
    } else {
      if (!fs.existsSync(FICHERO_FEED)) {
        throw new Error(
          `No existe ${FICHERO_FEED}. Arranca el recolector, o usa --directo.`,
        );
      }
      const st = fs.statSync(FICHERO_FEED);
      if (st.mtimeMs === estado.mtimeLeido) return; // sin novedad, no releer
      feed = JSON.parse(fs.readFileSync(FICHERO_FEED, "utf8"));
      estado.mtimeLeido = st.mtimeMs;
    }

    const { trips, deleted } = tripsEnVivo(feed);
    estado.feed = feed;
    estado.trips = trips;
    estado.obtenido = new Date();
    estado.headerTs = Number(feed.header?.timestamp) || null;
    estado.refrescos++;
    estado.ultimoError = null;
    console.log(
      `[feed] ${new Date().toLocaleTimeString("es-ES")} ` +
        `${trips.size} trips vivos (${deleted} DELETED) vía ${estado.origen}`,
    );
  } catch (err) {
    estado.fallos++;
    estado.ultimoError = { cuando: new Date().toISOString(), detalle: detallarError(err) };
    console.error(`[feed] fallo:\n${detallarError(err)}`);
  }
}

// --- Lógica de llegadas -----------------------------------------------------

function llegadasDeParada(stopId, limite = 12) {
  const parada = porId.get(stopId);
  if (!parada) return { error: "parada desconocida" };

  const idx = indiceDeParada(stopId);
  if (!idx) return { error: "parada sin horarios en el estático" };
  if (!estado.feed) return { error: "el feed aún no está disponible" };

  const ahora = new Date();
  const salida = [];
  let sospechosos = 0;

  for (const [tripId, tu] of estado.trips) {
    const est = idx.get(tripId);
    if (!est) continue;

    const ll = calcularLlegada(tu, est.seq, est.prog, ahora);
    if (ll.minutos < VENTANA_MIN[0] || ll.minutos > VENTANA_MIN[1]) continue;

    // Delays de horas son basura del feed (trips viejos sin purgar), no buses.
    if (ll.sospechoso) {
      sospechosos++;
      continue;
    }

    salida.push({
      linea: rutas[ll.routeId] ?? tripRuta[tripId] ?? ll.routeId,
      minutos: ll.minutos,
      programado: ll.programado.toISOString(),
      estimado: ll.estimado.toISOString(),
      retrasoSegundos: ll.delay,
      estado: ll.saltada
        ? "SALTADA"
        : ll.cancelado
          ? "CANCELADO"
          : ll.rel === "NO_DATA"
            ? "SIN_DATOS"
            : ll.sinDatos
              ? "SOLO_HORARIO"
              : "EN_VIVO",
      tripId,
      vehiculo: ll.vehiculo,
    });
  }

  salida.sort((a, b) => a.minutos - b.minutos);

  return {
    parada: { id: parada.id, nombre: parada.n, lat: parada.lat, lon: parada.lon },
    generado: ahora.toISOString(),
    feed: {
      obtenido: estado.obtenido?.toISOString() ?? null,
      antiguedadSegundos: estado.obtenido
        ? Math.round((ahora - estado.obtenido) / 1000)
        : null,
    },
    descartadosPorDelayAbsurdo: sospechosos,
    llegadas: salida.slice(0, limite),
  };
}

function buscarParadas(q, limite = 20) {
  const t = (q ?? "").trim().toLowerCase();
  if (t.length < 2) return [];
  const exactas = [], parciales = [];
  for (const p of paradas) {
    const nombre = p.n.toLowerCase();
    if (p.id.toLowerCase() === t) exactas.push(p);
    else if (nombre.startsWith(t)) exactas.push(p);
    else if (nombre.includes(t) || p.id.toLowerCase().includes(t)) parciales.push(p);
    if (exactas.length >= limite) break;
  }
  return [...exactas, ...parciales]
    .slice(0, limite)
    .map((p) => ({ id: p.id, nombre: p.n, lat: p.lat, lon: p.lon, pasadas: p.t }));
}

// --- HTTP -------------------------------------------------------------------

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

function json(res, codigo, cuerpo) {
  const txt = JSON.stringify(cuerpo);
  res.writeHead(codigo, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*", // el front en dev vive en :4200
  });
  res.end(txt);
}

function servirEstatico(res, rutaRel) {
  const limpio = path
    .normalize(rutaRel)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  let f = path.join(WEB, limpio);
  if (!f.startsWith(WEB)) return json(res, 403, { error: "prohibido" });

  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!fs.existsSync(f)) {
    // SPA: cualquier ruta desconocida cae en index.html
    const idx = path.join(WEB, "index.html");
    if (!fs.existsSync(idx)) {
      return json(res, 404, {
        error: "front sin construir",
        pista: "cd web && npm install && npm run build",
      });
    }
    f = idx;
  }
  res.writeHead(200, { "Content-Type": TIPOS[path.extname(f)] ?? "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const ruta = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    return res.end();
  }

  if (ruta === "/api/salud") {
    return json(res, 200, {
      ok: estado.feed !== null,
      indice: meta,
      feed: {
        origen: estado.origen,
        fichero: DIRECTO ? null : FICHERO_FEED,
        obtenido: estado.obtenido?.toISOString() ?? null,
        headerTs: estado.headerTs,
        antiguedadFeedSegundos: estado.headerTs
          ? Math.round(Date.now() / 1000 - estado.headerTs)
          : null,
        tripsVivos: estado.trips.size,
        refrescos: estado.refrescos,
        fallos: estado.fallos,
        ultimoError: estado.ultimoError,
      },
      refrescoSegundos: REFRESCO_MS / 1000,
    });
  }

  if (ruta === "/api/paradas") {
    return json(res, 200, buscarParadas(url.searchParams.get("q"), 20));
  }

  if (ruta.startsWith("/api/llegadas/")) {
    const stopId = decodeURIComponent(ruta.slice("/api/llegadas/".length));
    const r = llegadasDeParada(stopId, Number(url.searchParams.get("limite") ?? 12));
    return json(res, r.error ? 404 : 200, r);
  }

  if (ruta.startsWith("/api/")) return json(res, 404, { error: "ruta desconocida" });

  return servirEstatico(res, ruta === "/" ? "index.html" : ruta);
});

await refrescar();
setInterval(refrescar, REFRESCO_MS);

servidor.listen(PUERTO, () => {
  console.log(`\nAPI escuchando en http://localhost:${PUERTO}`);
  console.log(`  GET /api/salud`);
  console.log(`  GET /api/paradas?q=oconnell`);
  console.log(`  GET /api/llegadas/8250DB002039`);
  console.log(
    DIRECTO
      ? `\nUna sola llamada a la NTA cada ${REFRESCO_MS / 1000}s, ` +
          `da igual cuántos clientes haya.\n`
      : `\nCero llamadas a la NTA: el feed lo pone el recolector en\n` +
          `${FICHERO_FEED}\n(se comprueba cada ${REFRESCO_MS / 1000}s por mtime).\n`,
  );
});
