#!/usr/bin/env node
/**
 * Diagnóstico: ¿de dónde viene realmente el delay que mostramos?
 *
 * Uso: node scripts\diagnostico.mjs <stop_id> .\gtfs .\snapshots\feed-1.json
 */

import fs from 'node:fs';
import readline from 'node:readline';

const [stopId, gtfsDir, feedFile] = process.argv.slice(2);

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function* filasCsv(path) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });
  let cab = null;
  for await (const l of rl) {
    if (!l.trim()) continue;
    const c = parseCsvLine(l);
    if (!cab) { c[0] = c[0].replace(/^\uFEFF/, ''); cab = c; continue; }
    const f = {};
    cab.forEach((k, i) => { f[k] = c[i]; });
    yield f;
  }
}

const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));

const enVivo = new Map();
for (const e of feed.entity ?? []) {
  if (e.trip_update?.trip?.trip_id) enVivo.set(e.trip_update.trip.trip_id, e.trip_update);
}

// Trips del feed que pasan por nuestra parada, según el estático
const nuestros = [];
for await (const st of filasCsv(`${gtfsDir}/stop_times.txt`)) {
  if (st.stop_id !== stopId) continue;
  const tu = enVivo.get(st.trip_id);
  if (!tu) continue;
  nuestros.push({ tripId: st.trip_id, seq: Number(st.stop_sequence), tu });
}

console.log(`\nParada ${stopId} — ${nuestros.length} trips en vivo\n`);
console.log('trip_id            seq  origen  salto  delay  veh  rel');
console.log('-'.repeat(62));

const saltos = [];
let conVehiculo = 0, exactos = 0;

for (const n of nuestros.sort((a, b) => a.seq - b.seq)) {
  const ups = n.tu.stop_time_update ?? [];

  let apl = null;
  for (const u of ups) {
    const s = Number(u.stop_sequence);
    if (Number.isNaN(s) || s > n.seq) continue;
    if (!apl || s > Number(apl.stop_sequence)) apl = u;
  }

  const origen = apl ? Number(apl.stop_sequence) : null;
  const salto = origen === null ? null : n.seq - origen;
  const delay = apl ? (apl.arrival?.delay ?? apl.departure?.delay ?? null) : null;
  const veh = n.tu.vehicle?.id ?? '-';
  const rel = apl?.schedule_relationship ?? 'SCHEDULED';

  if (veh !== '-') conVehiculo++;
  if (salto === 0) exactos++;
  if (salto !== null) saltos.push(salto);

  console.log(
    `${n.tripId.padEnd(18)} ${String(n.seq).padStart(3)}  ` +
    `${String(origen ?? '-').padStart(6)}  ${String(salto ?? '-').padStart(5)}  ` +
    `${String(delay ?? '-').padStart(5)}  ${veh.padStart(4)}  ${rel}`
  );
}

const media = saltos.length ? (saltos.reduce((a, b) => a + b, 0) / saltos.length).toFixed(1) : '-';

console.log(`\n  Con vehículo asignado:  ${conVehiculo} / ${nuestros.length}`);
console.log(`  Update exacto (salto 0): ${exactos} / ${nuestros.length}`);
console.log(`  Salto medio:             ${media} paradas`);
console.log(`  Salto máximo:            ${saltos.length ? Math.max(...saltos) : '-'}\n`);
