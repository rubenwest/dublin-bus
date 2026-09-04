#!/usr/bin/env node
/**
 * El analizador. Esto es el proyecto: todo lo demás es fontanería para
 * alimentarlo.
 *
 * Uso:
 *   node scripts\congelados.mjs .\datos
 *   node scripts\congelados.mjs .\datos --detalle      (muestra pasos sueltos)
 *
 * La idea, de CLAUDE.md: las paradas ya servidas tienen el delay congelado al
 * segundo entre sondeos — es medición, no predicción. Las futuras bailan. Así
 * que **cuando el delay de una (parada, trip) deja de cambiar, el bus ya pasó**,
 * y ese valor es el retraso real. Comparándolo con lo que el feed decía antes
 * para esa misma parada sale el error de predicción, que es lo único que esta
 * app va a contar y la app oficial no.
 *
 * No hace falta GPS ni geometría contra shapes.txt.
 */

import fs from "node:fs";
import path from "node:path";

const [datosDir = "./datos", ...flags] = process.argv.slice(2);
const DETALLE = flags.includes("--detalle");

/** Sondeos seguidos con el mismo delay para dar una parada por servida. */
const ESTABLE_MIN = 2;
/** Por encima de esto el delay es basura del feed, no un retraso real. */
const LIMITE_DELAY = 3 * 3600;

// --- Carga ------------------------------------------------------------------

function cargar(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`No existe ${dir}`);
    process.exit(1);
  }
  const ficheros = fs
    .readdirSync(dir)
    .filter((f) => /^obs-.*\.jsonl$/.test(f))
    .sort();

  if (!ficheros.length) {
    console.error(`No hay ficheros obs-*.jsonl en ${dir}. ¿Ha corrido el recolector?`);
    process.exit(1);
  }

  const obs = [];
  for (const f of ficheros) {
    let n = 0;
    for (const linea of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!linea.trim()) continue;
      try {
        obs.push(JSON.parse(linea));
        n++;
      } catch {
        /* línea a medias: el recolector pudo morir a mitad de append */
      }
    }
    console.log(`  ${f}: ${n} observaciones`);
  }
  return obs;
}

// --- Horas ------------------------------------------------------------------

function offsetDublinEnMinutos(fecha) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin",
    timeZoneName: "longOffset",
  });
  const parte = fmt.formatToParts(fecha).find((p) => p.type === "timeZoneName").value;
  const m = parte.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
}

/** start_date "20260904" + segundos desde medianoche -> epoch en segundos. */
function momentoProgramado(startDate, segundos) {
  const y = +startDate.slice(0, 4);
  const mo = +startDate.slice(4, 6);
  const d = +startDate.slice(6, 8);
  const tentativo = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const off = offsetDublinEnMinutos(tentativo);
  return (Date.UTC(y, mo - 1, d, 0, 0, 0) - off * 60_000) / 1000 + segundos;
}

const hhmm = (epoch) =>
  new Date(epoch * 1000).toLocaleTimeString("es-ES", {
    timeZone: "Europe/Dublin",
    hour: "2-digit",
    minute: "2-digit",
  });

// --- Estadística ------------------------------------------------------------

const mediana = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const media = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const min1 = (s) => (s / 60).toFixed(1);

// --- Núcleo -----------------------------------------------------------------

/**
 * Agrupa por paso: una (parada, trip, día de servicio) es un autobús concreto
 * pasando por una parada concreta una vez.
 */
function agruparPasos(obs) {
  const pasos = new Map();
  for (const o of obs) {
    const k = `${o.stop_id}|${o.trip_id}|${o.start_date ?? "?"}`;
    if (!pasos.has(k)) pasos.set(k, []);
    pasos.get(k).push(o);
  }
  for (const lista of pasos.values()) lista.sort((a, b) => a.ts - b.ts);
  return pasos;
}

/**
 * Decide si un paso ya ocurrió y con qué retraso real.
 *
 * Condiciones para dar el delay por medido y no por predicho:
 *  - el último valor se repite en >= ESTABLE_MIN sondeos seguidos (congelado);
 *  - la llegada estimada con ese delay ya había pasado en el último sondeo
 *    en que vimos el trip (si no, la estabilidad es casualidad, no medición);
 *  - el update venía marcado SCHEDULED y con un delay creíble.
 */
function retrasoReal(lista, ultimoSondeoGlobal) {
  const utiles = lista.filter(
    (o) => o.rel === "SCHEDULED" && o.delay !== null && Math.abs(o.delay) <= LIMITE_DELAY,
  );
  if (utiles.length < ESTABLE_MIN) return null;

  const ultima = utiles[utiles.length - 1];

  // ¿cuántos sondeos seguidos, contando hacia atrás, traen el mismo delay?
  let estables = 1;
  for (let i = utiles.length - 2; i >= 0 && utiles[i].delay === ultima.delay; i--) {
    estables++;
  }
  if (estables < ESTABLE_MIN) return null;

  const prog = momentoProgramado(ultima.start_date, ultima.prog_segs);
  const llegada = ultima.hora_abs ?? prog + ultima.delay;

  // La llegada tiene que quedar en el pasado respecto al último sondeo del
  // paso. Si además el trip desapareció del feed antes del final de la
  // recolección, es señal extra de que ya se sirvió (el productor los purga).
  if (llegada > ultima.ts) return null;

  return {
    delay: ultima.delay,
    llegada,
    prog,
    estables,
    purgado: ultima.ts < ultimoSondeoGlobal,
    seq: ultima.seq,
    salto: ultima.salto,
    route: ultima.route_id,
    stop: ultima.stop_id,
    trip: ultima.trip_id,
  };
}

/**
 * Predicciones: observaciones tomadas cuando la llegada aún era futura.
 * Error = real - predicho. Positivo = llegó más tarde de lo que decía.
 */
function erroresDePrediccion(lista, real) {
  const out = [];
  for (const o of lista) {
    if (o.ts >= real.llegada) continue; // ya no es predicción
    if (o.rel !== "SCHEDULED" || o.delay === null) continue;
    if (Math.abs(o.delay) > LIMITE_DELAY) continue;
    if (o.delay === real.delay && o.ts > real.llegada - 60) continue; // ya congelado
    out.push({
      error: real.delay - o.delay,
      anticipacion: (real.llegada - o.ts) / 60, // min antes de la llegada real
      predicho: o.delay,
      ts: o.ts,
    });
  }
  return out;
}

// --- Informe ----------------------------------------------------------------

const BANDAS = [
  [0, 5, "0-5 min antes"],
  [5, 15, "5-15 min antes"],
  [15, 30, "15-30 min antes"],
  [30, Infinity, "30+ min antes"],
];

function main() {
  console.log("\nLeyendo observaciones:");
  const obs = cargar(datosDir);

  const sondeos = [...new Set(obs.map((o) => o.ts))].sort((a, b) => a - b);
  const ultimoSondeo = sondeos[sondeos.length - 1];
  const ventanaMin = (ultimoSondeo - sondeos[0]) / 60;

  console.log(
    `\nTotal: ${obs.length} observaciones, ${sondeos.length} sondeos, ` +
      `${ventanaMin.toFixed(0)} min de ventana ` +
      `(${hhmm(sondeos[0])} a ${hhmm(ultimoSondeo)} Dublín)`,
  );

  // Calidad del dato: cuánto del feed es inservible
  const porRel = {};
  for (const o of obs) porRel[o.rel] = (porRel[o.rel] ?? 0) + 1;
  console.log("\nEstado de los updates:");
  for (const [k, v] of Object.entries(porRel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(6)}  ${((v / obs.length) * 100).toFixed(1)}%`);
  }

  const pasos = agruparPasos(obs);
  console.log(`\nPasos distintos (parada, trip, día): ${pasos.size}`);

  // --- Detección de congelados ---
  const servidos = [];
  const motivos = { pocos: 0, noCongelado: 0, futuro: 0 };
  for (const lista of pasos.values()) {
    const real = retrasoReal(lista, ultimoSondeo);
    if (real) servidos.push({ real, lista });
    else if (lista.filter((o) => o.rel === "SCHEDULED" && o.delay !== null).length < ESTABLE_MIN)
      motivos.pocos++;
    else motivos.noCongelado++;
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log("PASOS CON RETRASO REAL MEDIDO (delay congelado + llegada pasada)");
  console.log("=".repeat(64));
  console.log(`  detectados: ${servidos.length} de ${pasos.size} pasos`);
  console.log(`  descartados por pocas observaciones: ${motivos.pocos}`);
  console.log(`  descartados por no congelar / llegada aún futura: ${motivos.noCongelado}`);

  if (!servidos.length) {
    console.log(
      `\n  Todavía no hay ningún paso medible. Es lo esperable con una ventana\n` +
        `  de ${ventanaMin.toFixed(0)} min: hace falta que un bus llegue a la parada\n` +
        `  Y que sigamos sondeando un rato después. Con sondeos cada 60s bastan\n` +
        `  un par de horas para ver los primeros.\n`,
    );
    return;
  }

  const delays = servidos.map((s) => s.real.delay);
  console.log(`\n  Retraso real medido: mediana ${min1(mediana(delays))} min, ` +
    `media ${min1(media(delays))} min`);
  console.log(`  Rango: ${min1(Math.min(...delays))} a ${min1(Math.max(...delays))} min`);

  // --- Error de predicción ---
  const todos = [];
  for (const { real, lista } of servidos) {
    for (const e of erroresDePrediccion(lista, real)) {
      todos.push({ ...e, stop: real.stop, route: real.route });
    }
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log("ERROR DE PREDICCIÓN  (real - predicho; + = llegó más tarde)");
  console.log("=".repeat(64));

  if (!todos.length) {
    console.log(
      "\n  Hay pasos medidos, pero ninguno con predicciones anteriores\n" +
        "  guardadas. Hace falta empezar a sondear antes de que el bus llegue.\n",
    );
    return;
  }

  console.log(`  ${todos.length} predicciones evaluadas\n`);
  console.log("  anticipación      n   error mediano   error medio   |error| mediano");
  console.log("  " + "-".repeat(68));
  for (const [lo, hi, etiqueta] of BANDAS) {
    const b = todos.filter((t) => t.anticipacion >= lo && t.anticipacion < hi);
    if (!b.length) continue;
    const errs = b.map((t) => t.error);
    console.log(
      `  ${etiqueta.padEnd(16)} ${String(b.length).padStart(3)}   ` +
        `${(min1(mediana(errs)) + " min").padStart(11)}   ` +
        `${(min1(media(errs)) + " min").padStart(9)}   ` +
        `${(min1(mediana(errs.map(Math.abs))) + " min").padStart(13)}`,
    );
  }

  // --- Por parada y línea: esto es lo que verá el usuario final ---
  console.log(`\n${"=".repeat(64)}`);
  console.log("POR PARADA Y LÍNEA");
  console.log("=".repeat(64));
  const porLinea = new Map();
  for (const t of todos) {
    const k = `${t.stop}|${t.route}`;
    if (!porLinea.has(k)) porLinea.set(k, []);
    porLinea.get(k).push(t.error);
  }
  const filas = [...porLinea.entries()]
    .map(([k, errs]) => {
      const [stop, route] = k.split("|");
      return { stop, route, n: errs.length, med: mediana(errs) };
    })
    .sort((a, b) => b.n - a.n);

  console.log("  parada          línea        n   sesgo mediano");
  console.log("  " + "-".repeat(52));
  for (const f of filas.slice(0, 20)) {
    const signo = f.med > 0 ? "+" : "";
    console.log(
      `  ${f.stop.padEnd(15)} ${String(f.route).padEnd(10)} ${String(f.n).padStart(3)}   ` +
        `${signo}${min1(f.med)} min`,
    );
  }

  const flojas = filas.filter((f) => f.n < 30).length;
  if (flojas) {
    console.log(
      `\n  Aviso: ${flojas} de ${filas.length} combinaciones tienen n < 30.\n` +
        `  Son anécdotas, no estadística. Hacen falta 2-3 semanas.`,
    );
  }

  if (DETALLE) {
    console.log(`\n${"=".repeat(64)}`);
    console.log("PASOS MEDIDOS EN DETALLE");
    console.log("=".repeat(64));
    for (const { real, lista } of servidos.slice(0, 25)) {
      console.log(
        `\n  ${real.stop}  ${real.route}  trip ${real.trip}  seq ${real.seq}` +
          `  (salto ${real.salto})`,
      );
      console.log(
        `    programado ${hhmm(real.prog)}  real ${hhmm(real.llegada)}  ` +
          `retraso ${min1(real.delay)} min  ` +
          `[congelado en ${real.estables} sondeos${real.purgado ? ", luego purgado" : ""}]`,
      );
      const serie = lista
        .filter((o) => o.delay !== null)
        .map((o) => `${hhmm(o.ts)}:${o.delay}`)
        .join("  ");
      console.log(`    serie: ${serie}`);
    }
  }

  console.log();
}

main();
