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
 * Y hay un segundo riesgo, más tonto y más probable: **la lógica está copiada
 * en varios ficheros**. Ya derivaron una vez (el fallo de los SKIPPED estaba
 * en dos sitios a la vez). Así que además de comprobar que la función acierta,
 * se comprueba que todas las copias dicen exactamente lo mismo sobre un
 * snapshot real, parada por parada.
 *
 * Uso: node scripts\pruebas.mjs
 */

import fs from "node:fs";
import path from "node:path";

const SNAPSHOT = "./snapshots/feed-1.json";

// --- Extracción de las copias ------------------------------------------------

/** Corta el texto de una función a partir de su declaración, contando llaves. */
function recortarFuncion(src, nombre) {
  const i = src.indexOf(`function ${nombre}`);
  if (i < 0) return null;
  let nivel = 0, j = i, visto = false;
  for (; j < src.length; j++) {
    if (src[j] === "{") { nivel++; visto = true; }
    else if (src[j] === "}") { nivel--; if (visto && nivel === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

/**
 * Quita las anotaciones de tipo del port a Deno para poder ejecutarlo en Node.
 * Es un apaño, pero permite comprobar que la copia de la Edge Function no ha
 * derivado, que es justo lo que más miedo da: no se ejecuta en local nunca.
 */
function quitarTipos(codigo) {
  return codigo
    .replace(/:\s*Update\[\]\s*\|\s*undefined/g, "")
    .replace(/\)\s*:\s*Estado\s*\{/, ") {")
    .replace(/:\s*number\s*\|\s*null/g, "")
    .replace(/:\s*\{\s*seq:\s*number\s*\}/g, "")
    .replace(/\(u:\s*Update\)/g, "(u)")
    .replace(/:\s*(number|string|boolean)\b/g, "");
}

async function cargarCopia(ruta, transformar = (x) => x) {
  if (!fs.existsSync(ruta)) return null;
  const codigo = recortarFuncion(fs.readFileSync(ruta, "utf8"), "estadoParada");
  if (!codigo) return null;
  const mod = await import(
    "data:text/javascript," + encodeURIComponent("export " + transformar(codigo))
  );
  return mod.estadoParada;
}

// --- Aserciones --------------------------------------------------------------

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

// --- Main --------------------------------------------------------------------

const copias = {
  "scripts/gtfsrt.mjs": await cargarCopia("./scripts/gtfsrt.mjs"),
  "scripts/llegadas.mjs": await cargarCopia("./scripts/llegadas.mjs"),
  "scripts/recolector.mjs": await cargarCopia("./scripts/recolector.mjs"),
  "supabase/functions/recolectar/gtfsrt.ts": await cargarCopia(
    "./supabase/functions/recolectar/gtfsrt.ts",
    quitarTipos,
  ),
};

const presentes = Object.entries(copias).filter(([, f]) => typeof f === "function");
console.log(`\nCopias de estadoParada encontradas: ${presentes.length}`);
for (const [ruta] of presentes) console.log(`  ${ruta}`);
if (presentes.length > 1) {
  console.log(
    `\n  Aviso: ${presentes.length} copias de la misma lógica. Ya derivaron una vez.\n` +
      `  Lo de abajo es el seguro; el arreglo de verdad es dejar una sola.`,
  );
}

const referencia = presentes[0]?.[1];
if (!referencia) {
  console.error("\nNo he encontrado ninguna copia de estadoParada.");
  process.exit(1);
}

console.log("\n1. Updates salteados: la parada 22 hereda de la 20");
comprueba(
  "hereda el delay de la seq 20",
  referencia([conDelay(16, 2794), conDelay(20, 2484), conDelay(27, 2389)], 22),
  { rel: "SCHEDULED", delay: 2484, origen: 20 },
);

console.log("\n2. NO_DATA se propaga hacia adelante y prohíbe delay");
comprueba(
  "NO_DATA vigente deja sin delay",
  referencia([conDelay(10, 300), u(18, { schedule_relationship: "NO_DATA" })], 22),
  { rel: "NO_DATA", delay: null, origen: 18 },
);
comprueba(
  "un NO_DATA posterior no me afecta",
  referencia([conDelay(10, 300), u(30, { schedule_relationship: "NO_DATA" })], 22),
  { rel: "SCHEDULED", delay: 300 },
);

console.log("\n3. SKIPPED aplica solo a su parada, pero el delay la atraviesa");
comprueba(
  "mi parada saltada",
  referencia([conDelay(20, 500), u(22, { schedule_relationship: "SKIPPED" })], 22),
  { rel: "SKIPPED", origen: 22, delay: 500 },
);
comprueba(
  "parada anterior saltada: yo normal, y NO pierdo el delay",
  referencia([conDelay(18, 500), u(20, { schedule_relationship: "SKIPPED" })], 22),
  { rel: "SCHEDULED", delay: 500, origen: 18 },
);
comprueba(
  "sin ningún update aplicable",
  referencia([conDelay(30, 500)], 22),
  { rel: "SIN_UPDATE", delay: null },
);

console.log("\n4. Hora absoluta cuando no hay delay");
comprueba(
  "usa arrival.time",
  referencia([u(22, { arrival: { time: "1788511934", uncertainty: 0 } })], 22),
  { rel: "SCHEDULED", horaAbs: 1788511934 },
);
comprueba(
  "el delay manda si vienen los dos",
  referencia([u(22, { arrival: { time: "1788511934" }, departure: { delay: 496 } })], 22),
  { rel: "SCHEDULED", delay: 496, horaAbs: 1788511934 },
);

// --- Contra datos reales -----------------------------------------------------

if (!fs.existsSync(SNAPSHOT)) {
  console.log(`\n5. (me salto el snapshot: no existe ${SNAPSHOT})`);
} else {
  console.log("\n5. Contra el snapshot real, y todas las copias a la vez");
  const feed = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));

  let comparadas = 0, saltadas = 0, discrepancias = 0, excepciones = 0;
  const ejemplos = [];

  for (const e of feed.entity ?? []) {
    const ups = e.trip_update?.stop_time_update;
    if (!ups?.length) continue;
    const maxSeq = Math.max(...ups.map((x) => Number(x.stop_sequence) || 0));

    for (let s = 1; s <= maxSeq; s++) {
      let base = null;
      for (const [ruta, fn] of presentes) {
        let r;
        try {
          r = fn(ups, s);
        } catch (err) {
          excepciones++;
          if (ejemplos.length < 3) ejemplos.push(`${ruta} lanzó: ${err.message}`);
          continue;
        }
        if (base === null) {
          base = { ruta, r };
          comparadas++;
          if (r.rel === "SKIPPED") saltadas++;
          continue;
        }
        const igual =
          r.rel === base.r.rel &&
          (r.delay ?? null) === (base.r.delay ?? null) &&
          (r.horaAbs ?? null) === (base.r.horaAbs ?? null) &&
          (r.origen ?? null) === (base.r.origen ?? null);
        if (!igual) {
          discrepancias++;
          if (ejemplos.length < 3) {
            ejemplos.push(
              `seq ${s} de ${e.trip_update.trip.trip_id}: ` +
                `${base.ruta}=${JSON.stringify(base.r)} vs ${ruta}=${JSON.stringify(r)}`,
            );
          }
        }
      }
    }
  }

  console.log(`  combinaciones (trip, parada) evaluadas: ${comparadas}`);
  console.log(`  paradas SKIPPED detectadas:             ${saltadas}`);
  console.log(`  discrepancias entre copias:             ${discrepancias}`);
  console.log(`  excepciones:                            ${excepciones}`);
  for (const ej of ejemplos) console.log(`    ${ej}`);

  // 411 es el número de SKIPPED que contiene ese snapshot. Si cambia, o el
  // snapshot es otro o la detección se ha roto.
  if (saltadas !== 411) {
    console.log(`FALLO  esperaba 411 SKIPPED en el snapshot, he visto ${saltadas}`);
    fallos++;
  }
  if (discrepancias) fallos++;
  if (excepciones) fallos++;
}

console.log(fallos ? `\n${fallos} FALLOS\n` : "\nTodo correcto\n");
process.exit(fallos ? 1 : 0);
