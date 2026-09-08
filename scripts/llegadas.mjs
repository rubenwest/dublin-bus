#!/usr/bin/env node
/**
 * Hito 1 — Próximas llegadas a una parada, cruzando GTFS-R v2 (NTA) con GTFS estático.
 *
 * Uso:
 *   export NTA_API_KEY=tu_key
 *   node llegadas.mjs 8220DB000334 ./gtfs
 *
 *   ./gtfs = carpeta con el ZIP estático ya descomprimido
 *            (necesita stop_times.txt, routes.txt, stops.txt)
 *
 * Modo offline (recomendado mientras desarrollas, para no gastar llamadas):
 *   node llegadas.mjs 8220DB000334 ./gtfs ./feed.json
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { cargarDotEnv } from './entorno.mjs';
import {
  estadoParada,
  momentoProgramado,
  LIMITE_DELAY_SEGUNDOS,
} from './gtfsrt.mjs';

cargarDotEnv();

const FEED_URL = 'https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json';

const [stopId, gtfsDir, feedFile] = process.argv.slice(2);

if (!stopId || !gtfsDir) {
  console.error('Uso: node llegadas.mjs <stop_id> <dir_gtfs> [feed.json]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Feed en tiempo real
// ---------------------------------------------------------------------------

async function cargarFeed() {
  if (feedFile) {
    console.error(`(usando snapshot local: ${feedFile})`);
    return JSON.parse(fs.readFileSync(feedFile, 'utf8'));
  }

  const key = process.env.NTA_API_KEY;
  if (!key) throw new Error('Falta NTA_API_KEY');

  const res = await fetch(FEED_URL, { headers: { 'x-api-key': key } });
  if (!res.ok) {
    throw new Error(`Feed devolvió ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// 2. CSV mínimo (los GTFS llevan campos entrecomillados con comas dentro)
// ---------------------------------------------------------------------------

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function* filasCsv(path) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });

  let cabecera = null;
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    const campos = parseCsvLine(linea);
    if (!cabecera) {
      // el BOM de los ficheros de la NTA se cuela en la primera columna
      campos[0] = campos[0].replace(/^\uFEFF/, '');
      cabecera = campos;
      continue;
    }
    const fila = {};
    cabecera.forEach((k, i) => { fila[k] = campos[i]; });
    yield fila;
  }
}

// ---------------------------------------------------------------------------
// 3. Horarios: GTFS admite "25:10:00" para trayectos que cruzan medianoche
// ---------------------------------------------------------------------------

function horaGtfsASegundos(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// momentoProgramado y offsetDublinEnMinutos viven en gtfsrt.mjs.

// ---------------------------------------------------------------------------
// 4. Regla clave: el delay se propaga hacia adelante
// ---------------------------------------------------------------------------

// estadoParada vive en gtfsrt.mjs: es la logica mas delicada del
// proyecto y tener copias ya costo un bug.

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------

async function main() {
  const feed = await cargarFeed();
  const entidades = feed.entity ?? [];
  console.error(`Feed: ${entidades.length} entidades, ts ${feed.header?.timestamp}`);

  // trip_id -> datos del trip en vivo.
  // Los trips que salen en el feed son, por definición, los que circulan hoy:
  // eso nos ahorra tener que tocar calendar.txt / calendar_dates.txt.
  const enVivo = new Map();
  let descartadosDeleted = 0;
  for (const e of entidades) {
    const tu = e.trip_update;
    // Los trips ADDED vienen sin trip_id: no existen en el estático, así que
    // no hay forma de cruzarlos y se caen aquí solos.
    if (!tu?.trip?.trip_id) continue;

    // DELETED: el operador quiere que el viaje desaparezca de la pantalla,
    // no que se muestre tachado. No se muestra jamás.
    if (tu.trip.schedule_relationship === 'DELETED') {
      descartadosDeleted++;
      continue;
    }
    enVivo.set(tu.trip.trip_id, tu);
  }
  if (descartadosDeleted) {
    console.error(`(${descartadosDeleted} trips DELETED descartados)`);
  }

  // routes.txt es pequeño: lo cargamos entero para traducir route_id -> "39A"
  const nombreRuta = new Map();
  for await (const r of filasCsv(`${gtfsDir}/routes.txt`)) {
    nombreRuta.set(r.route_id, r.route_short_name || r.route_long_name || r.route_id);
  }

  // stops.txt, solo para el título
  let nombreParada = stopId;
  for await (const s of filasCsv(`${gtfsDir}/stops.txt`)) {
    if (s.stop_id === stopId) { nombreParada = s.stop_name; break; }
  }

  // stop_times.txt es el fichero gordo (millones de filas): lo recorremos en
  // streaming y nos quedamos solo con nuestra parada Y trips que estén en vivo.
  const candidatos = [];
  for await (const st of filasCsv(`${gtfsDir}/stop_times.txt`)) {
    if (st.stop_id !== stopId) continue;
    const tu = enVivo.get(st.trip_id);
    if (!tu) continue;

    candidatos.push({
      tripId: st.trip_id,
      secuencia: Number(st.stop_sequence),
      programado: horaGtfsASegundos(st.arrival_time || st.departure_time),
      tu,
    });
  }

  // En modo offline el snapshot puede tener horas: si midiéramos contra el
  // reloj real, la ventana de 90 min se comería todas las llegadas y el script
  // diría "sin llegadas" siempre. Contra un snapshot, el "ahora" es su header.
  const ahora = feedFile && feed.header?.timestamp
    ? new Date(Number(feed.header.timestamp) * 1000)
    : new Date();
  const llegadas = [];

  for (const c of candidatos) {
    const est = estadoParada(c.tu.stop_time_update, c.secuencia);
    const { delay } = est;
    const programado = momentoProgramado(c.tu.trip.start_date, c.programado);

    // Si el feed da la hora absoluta, es mejor que programado + delay.
    const estimado = est.horaAbs !== null
      ? new Date(est.horaAbs * 1000)
      : new Date(programado.getTime() + (delay ?? 0) * 1000);
    const minutos = Math.round((estimado - ahora) / 60000);

    if (minutos < -2 || minutos > 90) continue; // fuera de ventana útil

    llegadas.push({
      linea: nombreRuta.get(c.tu.trip.route_id) ?? c.tu.trip.route_id,
      minutos,
      delayMin: delay === null ? null : Math.round(delay / 60),
      sinDatos: delay === null && est.horaAbs === null,
      rel: est.rel,
      // CANCELED: el viaje existe pero no se hace. Se muestra tachado, no se
      // esconde, para que quien lo esperaba entienda qué ha pasado.
      cancelado: (c.tu.trip.schedule_relationship ?? 'SCHEDULED') === 'CANCELED',
      sospechoso: delay !== null && Math.abs(delay) > LIMITE_DELAY_SEGUNDOS,
      programado,
      vehiculo: c.tu.vehicle?.id ?? null,
    });
  }

  llegadas.sort((a, b) => a.minutos - b.minutos);

  console.log(`\n${nombreParada}  (${stopId})`);
  console.log(`${ahora.toLocaleTimeString('es-ES', { timeZone: 'Europe/Dublin' })} hora de Dublín\n`);

  if (!llegadas.length) {
    console.log('  Sin llegadas en los próximos 90 min.');
    console.log('  Si esto pasa siempre, casi seguro el estático no corresponde');
    console.log('  al operador del feed: los stop_id no casan.\n');
    return;
  }

  const TACHADO = '\x1b[9m', APAGADO = '\x1b[2m', FIN = '\x1b[0m';

  for (const l of llegadas.slice(0, 10)) {
    const hora = l.programado.toLocaleTimeString('es-ES', {
      timeZone: 'Europe/Dublin', hour: '2-digit', minute: '2-digit',
    });

    // Una parada saltada no es una llegada: no se anuncian minutos, porque el
    // bus pasa de largo. Decir "3 min" aquí es mandar a alguien a esperar un
    // autobús que no va a parar.
    if (l.rel === 'SKIPPED') {
      console.log(
        `  ${String(l.linea).padEnd(8)} ${'NO PARA'.padStart(7)}   ` +
        `(prog. ${hora}, el operador marca esta parada como saltada)`
      );
      continue;
    }

    if (l.cancelado) {
      console.log(
        `  ${TACHADO}${String(l.linea).padEnd(8)} ${'--'.padStart(7)}${FIN}   ` +
        `(prog. ${hora}, ${APAGADO}viaje CANCELADO${FIN})`
      );
      continue;
    }

    const cuando = l.minutos <= 0 ? 'ya' : `${l.minutos} min`;

    let nota;
    if (l.rel === 'NO_DATA') nota = 'el operador no da datos aquí, solo horario';
    else if (l.sinDatos) nota = 'sin dato en vivo, solo horario';
    else if (l.delayMin === 0) nota = 'en hora';
    else if (l.delayMin > 0) nota = `+${l.delayMin} min tarde`;
    else nota = `${l.delayMin} min adelantado`;

    if (l.sospechoso) nota += '  <-- REVISAR, delay absurdo';

    console.log(
      `  ${String(l.linea).padEnd(8)} ${cuando.padStart(7)}   ` +
      `(prog. ${hora}, ${nota})`
    );
  }
  console.log();
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
