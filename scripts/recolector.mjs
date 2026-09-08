#!/usr/bin/env node
/**
 * Recolector. Sondea TripUpdates cada N segundos y guarda una observación por
 * (parada, trip) en un JSONL diario.
 *
 * Uso:
 *   $env:NTA_API_KEY = "..."          (o bien un fichero .env en la raíz)
 *   node scripts\recolector.mjs .\gtfs .\datos
 *
 * Deja la ventana abierta. Ctrl+C para parar.
 *
 * Se guarda una línea por sondeo aunque nada haya cambiado: es justamente la
 * repetición lo que permite detectar cuándo un delay se "congela" (= el bus ya
 * pasó, y ese valor es medición real, no predicción).
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { cargarDotEnv } from "./entorno.mjs";
import { tomarLock } from "./lock.mjs";

// Se rellena al arrancar, justo antes de indexar. Declarado aquí arriba para
// que el handler de "exit" pueda soltarlo aunque salgamos antes de tomarlo.
let lock = null;

// --- CONFIGURA ESTO ---------------------------------------------------------
const PARADAS = [
  "8220DB000270", // cabecera-ish, seq 3
  "8220DB001023", // mitad de recorrido
  "8250DB002039", // final de línea
];
const INTERVALO_MS = 60_000;

/** Tiempo máximo para una petición completa (cabeceras + los ~3 MB de cuerpo). */
const TIMEOUT_MS = 45_000;
/** Intentos por sondeo antes de darlo por perdido y esperar al siguiente ciclo. */
const REINTENTOS = 4;
/** Espera base del backoff exponencial: 2s, 4s, 8s (+ jitter). */
const BACKOFF_BASE_MS = 2_000;
// ----------------------------------------------------------------------------

// Sobrescribible con NTA_FEED_URL para poder probar el bucle contra un
// servidor local sin gastar llamadas a la API real.
const FEED_URL =
  process.env.NTA_FEED_URL ??
  "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json";
const [gtfsDir = "./gtfs", datosDir = "./datos"] = process.argv.slice(2);

// --- .env (sin dependencias) ------------------------------------------------

cargarDotEnv();

const API_KEY = process.env.NTA_API_KEY;
if (!API_KEY) {
  console.error(
    "Falta NTA_API_KEY (ponla en el entorno o en un fichero .env en la raíz)",
  );
  process.exit(1);
}

fs.mkdirSync(datosDir, { recursive: true });

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

// --- Índice estático (se construye una vez al arrancar) ---------------------

/** stop_id -> Map(trip_id -> { seq, progSegs }) */
const indice = new Map(PARADAS.map((s) => [s, new Map()]));

async function construirIndice() {
  console.log("Indexando stop_times.txt (tarda un rato)...");
  const t0 = Date.now();
  let filas = 0;

  for await (const st of filasCsv(path.join(gtfsDir, "stop_times.txt"))) {
    filas++;
    const m = indice.get(st.stop_id);
    if (!m) continue;
    const hora = st.arrival_time || st.departure_time;
    if (!hora) continue;
    const [h, mi, s] = hora.split(":").map(Number);
    m.set(st.trip_id, {
      seq: Number(st.stop_sequence),
      progSegs: h * 3600 + mi * 60 + s,
    });
  }

  const seg = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`Indexadas ${filas} filas en ${seg}s`);
  let vacias = 0;
  for (const [stop, m] of indice) {
    console.log(`  ${stop}: ${m.size} trips`);
    if (m.size === 0) vacias++;
  }
  if (vacias === PARADAS.length) {
    console.error(
      "\nNinguna parada tiene trips en el estático: casi seguro es el ZIP de " +
        "otro operador.\nComprueba con: grep -c <stop_id> gtfs/stop_times.txt\n",
    );
    process.exit(1);
  }
}

// --- Diagnóstico de errores -------------------------------------------------

/**
 * undici lanza siempre `TypeError: fetch failed` y esconde el motivo real en
 * `err.cause`, a veces anidado varios niveles. Imprimir solo `err.message`
 * garantiza no enterarse nunca de nada: por eso el recolector antiguo solo
 * sabía decir "fetch failed".
 */
function detallarError(err) {
  const lineas = [];
  let e = err,
    nivel = 0;
  while (e && nivel < 6) {
    const campos = ["code", "errno", "syscall", "address", "port", "reason"]
      .filter((k) => e[k] !== undefined)
      .map((k) => `${k}=${e[k]}`)
      .join(" ");
    lineas.push(
      `${"  ".repeat(nivel)}${nivel === 0 ? "" : "cause: "}` +
        `${e.name ?? "Error"}: ${e.message ?? e}` +
        (campos ? `  [${campos}]` : ""),
    );
    if (e.errors?.length) {
      // AggregateError: p.ej. falla IPv6 y también IPv4 (Happy Eyeballs)
      for (const sub of e.errors) {
        lineas.push(
          `${"  ".repeat(nivel + 1)}- ${sub.name}: ${sub.message}` +
            (sub.code ? `  [code=${sub.code}]` : ""),
        );
      }
    }
    e = e.cause;
    nivel++;
  }
  return lineas.join("\n");
}

function ficheroErrores() {
  return path.join(datosDir, `errores-${fechaDublin()}.log`);
}

function registrarError(err, contexto) {
  const bloque =
    `\n[${new Date().toISOString()}] ${contexto}\n${detallarError(err)}\n` +
    (err.stack ? `${err.stack}\n` : "");
  try {
    fs.appendFileSync(ficheroErrores(), bloque, "utf8");
  } catch {
    /* si ni siquiera podemos escribir el log, no montamos un drama */
  }
  return bloque;
}

// --- Red --------------------------------------------------------------------

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** 5xx y 429 son transitorios; 401/403 no se arreglan reintentando. */
function esReintentable(err) {
  if (err.estado !== undefined) return err.estado === 429 || err.estado >= 500;
  return true; // error de transporte (socket, DNS, TLS, timeout): reintentable
}

async function pedirFeed() {
  let ultimo;

  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      const res = await fetch(FEED_URL, {
        headers: { "x-api-key": API_KEY, "Cache-Control": "no-cache" },
        // Cubre conexión, cabeceras Y lectura del cuerpo. Sin esto undici
        // aguanta 300s por defecto y el bucle se queda colgado sin decir nada.
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        // Hay que consumir el cuerpo o el socket se queda a medias.
        const cuerpo = await res.text().catch(() => "");
        const e = new Error(
          `HTTP ${res.status} ${res.statusText}` +
            (cuerpo ? ` — ${cuerpo.slice(0, 200)}` : ""),
        );
        e.estado = res.status;
        throw e;
      }

      return await res.json();
    } catch (err) {
      ultimo = err;
      if (!esReintentable(err) || intento === REINTENTOS) break;

      // Exponencial + jitter. El reintento abre un socket nuevo, que es justo
      // lo que hace falta si el anterior era una conexión keep-alive ya cerrada
      // por el otro lado: el "fetch failed" clásico de un bucle cada 60s.
      const espera = BACKOFF_BASE_MS * 2 ** (intento - 1);
      const conJitter = Math.round(espera * (0.5 + Math.random()));
      console.error(
        `\n[${horaLocal()}] intento ${intento}/${REINTENTOS} falló, ` +
          `reintento en ${(conJitter / 1000).toFixed(1)}s\n${detallarError(err)}`,
      );
      await esperar(conJitter);
    }
  }

  throw ultimo;
}

// --- Lógica de delay --------------------------------------------------------

/**
 * Estado de una parada según los stop_time_update, que vienen salteados
 * (16, 17, 18, 20, 23, 27...). Reglas de la spec:
 *
 *  - un update aplica a las paradas siguientes hasta el próximo update;
 *  - NO_DATA se propaga hacia adelante y prohíbe que haya delay;
 *  - SKIPPED NO se propaga: aplica solo a su parada. Pero el delay sí
 *    atraviesa una parada saltada, y los SKIPPED de la NTA vienen sin arrival
 *    ni departure, así que hay que seguir hacia atrás hasta encontrarlo.
 */
function estadoParada(ups, seqObjetivo) {
  // Updates aplicables (seq <= objetivo), del más cercano al más lejano.
  const previos = (ups ?? [])
    .map((u) => ({ u, seq: Number(u.stop_sequence) }))
    .filter((x) => !Number.isNaN(x.seq) && x.seq <= seqObjetivo)
    .sort((a, b) => b.seq - a.seq);

  if (!previos.length) return { rel: "SIN_UPDATE" };

  const cercano = previos[0];
  const relCercano = cercano.u.schedule_relationship ?? "SCHEDULED";

  // NO_DATA se propaga: si el update vigente es NO_DATA, no hay delay válido.
  if (relCercano === "NO_DATA") return { rel: "NO_DATA", origen: cercano.seq };

  // SKIPPED solo aplica a su propia parada.
  const saltada = relCercano === "SKIPPED" && cercano.seq === seqObjetivo;

  // El delay se hereda del update aplicable más cercano que traiga uno,
  // atravesando paradas saltadas (que vienen sin arrival/departure).
  let delay = null,
    origen = null,
    horaAbs = null;
  for (const { u, seq } of previos) {
    const rel = u.schedule_relationship ?? "SCHEDULED";
    if (rel === "NO_DATA") break; // hacia atrás tampoco vale
    const d = u.arrival?.delay ?? u.departure?.delay;
    const t = u.arrival?.time ?? u.departure?.time;
    if (d !== undefined) {
      delay = Number(d);
      origen = seq;
      if (t !== undefined) horaAbs = Number(t);
      break;
    }
    if (t !== undefined && horaAbs === null) {
      // Algunos updates traen hora absoluta y ningún delay (~1% de los
      // SCHEDULED). Nos la guardamos por si no aparece ningún delay.
      horaAbs = Number(t);
      origen = seq;
    }
  }

  if (saltada) return { rel: "SKIPPED", origen: cercano.seq, delay, horaAbs };
  if (delay === null && horaAbs === null)
    return { rel: "SIN_UPDATE", origen: cercano.seq };

  return { rel: "SCHEDULED", origen, delay, horaAbs };
}

// --- Sondeo -----------------------------------------------------------------

/** Fecha del día de servicio en hora de Dublín (en UTC, a las 00:30 fallaría). */
function fechaDublin(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const horaLocal = () => new Date().toLocaleTimeString("es-ES");

function ficheroDeHoy() {
  return path.join(datosDir, `obs-${fechaDublin()}.jsonl`);
}

let sondeos = 0,
  errores = 0,
  observaciones = 0;

async function sondear() {
  const feed = await pedirFeed();
  const ts = Number(feed.header?.timestamp) || Math.floor(Date.now() / 1000);

  // Deja el feed crudo en disco para que el backend lo sirva sin llamar él
  // también a la NTA. Fair usage: UNA llamada cada 30-60s para todos los
  // usuarios, no una por proceso. Escritura atómica (tmp + rename) para que
  // el servidor nunca lea un JSON a medio escribir.
  try {
    const tmp = path.join(datosDir, ".ultimo-feed.tmp");
    fs.writeFileSync(tmp, JSON.stringify(feed));
    fs.renameSync(tmp, path.join(datosDir, "ultimo-feed.json"));
  } catch {
    /* que falle el volcado no puede tumbar la recolección, que es lo serio */
  }

  const lineas = [];

  for (const e of feed.entity ?? []) {
    const tu = e.trip_update;
    const tripId = tu?.trip?.trip_id;
    // Los trips ADDED vienen sin trip_id: no cruzan con el estático, fuera.
    if (!tripId) continue;

    const tripRel = tu.trip.schedule_relationship ?? "SCHEDULED";
    // DELETED: el operador quiere que desaparezca. Ni se guarda.
    if (tripRel === "DELETED") continue;

    for (const [stopId, m] of indice) {
      const est = m.get(tripId);
      if (!est) continue;

      const s = estadoParada(tu.stop_time_update, est.seq);

      lineas.push(
        JSON.stringify({
          ts,
          stop_id: stopId,
          trip_id: tripId,
          route_id: tu.trip.route_id ?? null,
          start_date: tu.trip.start_date ?? null,
          seq: est.seq,
          prog_segs: est.progSegs, // hora programada, segs desde medianoche
          delay: s.delay ?? null,
          hora_abs: s.horaAbs ?? null, // epoch, si el feed la da (es raro)
          origen: s.origen ?? null, // seq de la que hereda el delay
          salto: s.origen == null ? null : est.seq - s.origen,
          rel: s.rel,
          trip_rel: tripRel,
          veh: tu.vehicle?.id ?? null,
          tu_ts: Number(tu.timestamp) || null,
        }),
      );
    }
  }

  if (lineas.length) {
    fs.appendFileSync(ficheroDeHoy(), lineas.join("\n") + "\n", "utf8");
    observaciones += lineas.length;
  }

  sondeos++;
  process.stdout.write(
    `\r[${horaLocal()}] sondeos:${sondeos} errores:${errores} ` +
      `ultimo:${lineas.length} obs  total:${observaciones}   `,
  );
}

// --- Bucle ------------------------------------------------------------------

async function bucle() {
  for (;;) {
    const t0 = Date.now();
    // Si nos han robado el lock es que nos habíamos quedado mudos demasiado
    // tiempo y otro recolector tomó el relevo. Nos apartamos.
    if (!lock.refrescar()) {
      console.error(
        "\nOtro recolector se ha quedado con el lock. Salgo para no duplicar\n" +
          "llamadas a la NTA.\n",
      );
      process.exit(0);
    }
    try {
      await sondear();
    } catch (err) {
      errores++;
      const bloque = registrarError(err, `sondeo #${sondeos + errores} falló`);
      console.error(`\n[${horaLocal()}] sondeo descartado.${bloque}`);
      if (err.estado === 401 || err.estado === 403) {
        console.error(
          "La API rechaza la key. Si acabas de suscribirte tarda ~15 min en\n" +
            "activarse; si no, revisa NTA_API_KEY. Abortando.\n",
        );
        process.exit(1);
      }
    }
    // Cadencia fija: descuenta lo que ha tardado el sondeo con sus reintentos.
    const resto = INTERVALO_MS - (Date.now() - t0);
    await esperar(resto > 0 ? resto : 0);
  }
}

process.on("exit", () => lock?.soltar?.());
process.on("SIGINT", () => {
  console.log(
    `\n\nParado. ${sondeos} sondeos correctos, ${errores} fallidos, ` +
      `${observaciones} observaciones en ${ficheroDeHoy()}\n`,
  );
  process.exit(0);
});

// Antes de indexar: si ya hay otro recolector vivo no merece la pena pasarse
// diez segundos leyendo stop_times.txt para acabar saliendo.
lock = tomarLock(datosDir);
if (!lock.ok) {
  const d = lock.duenyo;
  console.error(
    `\nYa hay un recolector vivo (PID ${d?.pid}, usuario ${d?.usuario}, ` +
      `desde ${d?.desde}).\n` +
      "Dos a la vez son dos llamadas por minuto a la NTA y salta el HTTP 429,\n" +
      "así que este se aparta. La recolección sigue en el otro proceso.\n",
  );
  process.exit(0);
}

await construirIndice();
console.log(
  `\nRecolectando cada ${INTERVALO_MS / 1000}s ` +
    `(timeout ${TIMEOUT_MS / 1000}s, ${REINTENTOS} intentos). Ctrl+C para parar.\n`,
);
await bucle();
