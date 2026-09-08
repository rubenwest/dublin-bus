#!/usr/bin/env node
/**
 * Pruebas de `estadoParada`, que es donde vive el riesgo real del proyecto.
 *
 * Por qué estas y no otras: todos los fallos serios que ha tenido esto han
 * sido de interpretación del feed, no de interfaz. Los SKIPPED que llegaban
 * sin `arrival` y hacían perder el delay. El `NO_DATA` que se propaga. Los
 * trips `ADDED` sin `trip_id`. Ninguno lo habría cazado un test de navegador;
 * todos los caza una función pura con datos reales delante.
 *
 * Uso: node scripts\pruebas.mjs
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { estadoParada } from "./gtfsrt.mjs";

const SNAPSHOT = "./snapshots/feed-1.json";
const ORIGEN = "./scripts/gtfsrt.mjs";
const ESPEJO = "./supabase/functions/recolectar/gtfsrt.mjs";

let fallos = 0;

function comprueba(nombre, real, esperado) {
  const ok = Object.entries(esperado).every(([k, v]) => real[k] === v);
  console.log(`${ok ? "  ok  " : "FALLO "} ${nombre}`);
  if (!ok) {
    fallos++;
    console.log(`         esperaba ${JSON.stringify(esperado)}`);
    console.log(`         obtuvo   ${JSON.stringify(real)}`);
  }
}

const u = (seq, extra = {}) => ({ stop_sequence: seq, ...extra });
const conDelay = (seq, d, rel) =>
  u(seq, { arrival: { delay: d }, ...(rel ? { schedule_relationship: rel } : {}) });

// --- 0. Que siga habiendo una sola copia -------------------------------------

console.log("\n0. Una sola copia de la lógica");

const hash = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// Una Edge Function no puede importar del repo, así que el fichero se copia.
// Comparar comportamiento no basta: dos ficheros pueden coincidir hoy sobre el
// snapshot y diferir mañana en un caso que no cubrimos. Se comparan los bytes.
if (fs.existsSync(ORIGEN) && fs.existsSync(ESPEJO)) {
  const a = hash(ORIGEN);
  const b = hash(ESPEJO);
  if (a === b) {
    console.log(`  ok   el espejo de la Edge Function es idéntico (${a.slice(0, 12)})`);
  } else {
    fallos++;
    console.log("FALLO  el espejo de la Edge Function ha derivado del original");
    console.log(`         ${ORIGEN}  ${a.slice(0, 16)}`);
    console.log(`         ${ESPEJO}  ${b.slice(0, 16)}`);
    console.log("         se arregla copiando el de scripts encima del otro,");
    console.log("         y volviendo a desplegar la función.");
  }
} else {
  console.log("  (falta alguno de los dos ficheros)");
}

// Si vuelve a aparecer una copia suelta, el arreglo es quitarla, no taparla
// con más tests. Llegó a haber cuatro.
const sueltas = ["./scripts/llegadas.mjs", "./scripts/recolector.mjs", "./servidor/api.mjs"]
  .filter((p) => fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("function estadoParada"));
if (sueltas.length) {
  fallos++;
  console.log(`FALLO  han vuelto a aparecer copias de estadoParada en: ${sueltas.join(", ")}`);
} else {
  console.log("  ok   nadie ha vuelto a duplicar estadoParada");
}

// --- Casos de la spec --------------------------------------------------------

console.log("\n1. Updates salteados: la parada 22 hereda de la 20");
comprueba(
  "hereda el delay de la seq 20",
  estadoParada([conDelay(16, 2794), conDelay(20, 2484), conDelay(27, 2389)], 22),
  { rel: "SCHEDULED", delay: 2484, origen: 20 },
);

console.log("\n2. NO_DATA se propaga hacia adelante y prohíbe delay");
comprueba(
  "NO_DATA vigente deja sin delay",
  estadoParada([conDelay(10, 300), u(18, { schedule_relationship: "NO_DATA" })], 22),
  { rel: "NO_DATA", delay: null, origen: 18 },
);
comprueba(
  "un NO_DATA posterior no me afecta",
  estadoParada([conDelay(10, 300), u(30, { schedule_relationship: "NO_DATA" })], 22),
  { rel: "SCHEDULED", delay: 300 },
);

console.log("\n3. SKIPPED aplica solo a su parada, pero el delay la atraviesa");
comprueba(
  "mi parada saltada",
  estadoParada([conDelay(20, 500), u(22, { schedule_relationship: "SKIPPED" })], 22),
  { rel: "SKIPPED", origen: 22, delay: 500 },
);
comprueba(
  "parada anterior saltada: yo normal, y NO pierdo el delay",
  estadoParada([conDelay(18, 500), u(20, { schedule_relationship: "SKIPPED" })], 22),
  { rel: "SCHEDULED", delay: 500, origen: 18 },
);
comprueba(
  "sin ningún update aplicable",
  estadoParada([conDelay(30, 500)], 22),
  { rel: "SIN_UPDATE", delay: null },
);

console.log("\n4. Hora absoluta cuando no hay delay");
comprueba(
  "usa arrival.time",
  estadoParada([u(22, { arrival: { time: "1788511934", uncertainty: 0 } })], 22),
  { rel: "SCHEDULED", horaAbs: 1788511934 },
);
comprueba(
  "el delay manda si vienen los dos",
  estadoParada([u(22, { arrival: { time: "1788511934" }, departure: { delay: 496 } })], 22),
  { rel: "SCHEDULED", delay: 496, horaAbs: 1788511934 },
);

// La hora absoluta es de SU parada. El delay se propaga hacia adelante porque
// es un desfase; una hora concreta no. Heredarla daba la llegada a otra parada
// como si fuera esta —siempre anterior— y salían buses "adelantados" una hora
// que no existían: 212 de 620 casos del snapshot, un 34%.
comprueba(
  "la hora absoluta NO se hereda de una parada anterior",
  estadoParada([conDelay(10, 75), u(20, { arrival: { time: "1788511934" } })], 25),
  { rel: "SCHEDULED", delay: 75, horaAbs: null, origen: 10 },
);
comprueba(
  "solo hay hora de otra parada: no hay dato, no me la invento",
  estadoParada([u(20, { arrival: { time: "1788511934" } })], 25),
  { rel: "SIN_UPDATE", delay: null, horaAbs: null },
);
comprueba(
  "la hora de MI parada vale aunque el delay venga de atrás",
  estadoParada([conDelay(10, 75), u(25, { arrival: { time: "1788511934" } })], 25),
  { rel: "SCHEDULED", delay: 75, horaAbs: 1788511934, origen: 10 },
);

// --- 5. Contra datos reales --------------------------------------------------

if (!fs.existsSync(SNAPSHOT)) {
  console.log(`\n5. (me salto el snapshot: no existe ${SNAPSHOT})`);
} else {
  console.log("\n5. Contra el snapshot real");
  const feed = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));

  let evaluadas = 0, saltadas = 0, excepciones = 0;

  for (const e of feed.entity ?? []) {
    const ups = e.trip_update?.stop_time_update;
    if (!ups?.length) continue;
    const maxSeq = Math.max(...ups.map((x) => Number(x.stop_sequence) || 0));

    for (let s = 1; s <= maxSeq; s++) {
      try {
        const r = estadoParada(ups, s);
        evaluadas++;
        if (r.rel === "SKIPPED") saltadas++;
      } catch {
        excepciones++;
      }
    }
  }

  console.log(`  combinaciones (trip, parada) evaluadas: ${evaluadas}`);
  console.log(`  paradas SKIPPED detectadas:             ${saltadas}`);
  console.log(`  excepciones:                            ${excepciones}`);

  // 411 es el número de SKIPPED que contiene ese snapshot. Si cambia, o el
  // snapshot es otro o la detección se ha roto.
  if (saltadas !== 411) {
    console.log(`FALLO  esperaba 411 SKIPPED en el snapshot, he visto ${saltadas}`);
    fallos++;
  }
  if (excepciones) fallos++;
}

console.log(fallos ? `\n${fallos} FALLOS\n` : "\nTodo correcto\n");
process.exit(fallos ? 1 : 0);
