#!/usr/bin/env node
/**
 * Genera el catálogo ligero stop_id -> stop_code que usa la web. Google Maps y
 * las marquesinas muestran stop_code; la NTA usa stop_id internamente y puede
 * tener dos andenes distintos con el mismo código público.
 *
 * Uso: node scripts/codigos-parada.mjs [gtfs/stops.txt] [web/public/codigos-parada.json]
 */

import fs from 'node:fs';
import readline from 'node:readline';

const [entrada = './gtfs/stops.txt', salida = './web/public/codigos-parada.json'] =
  process.argv.slice(2);

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += char;
  }
  out.push(cur);
  return out;
}

const rl = readline.createInterface({ input: fs.createReadStream(entrada, 'utf8'), crlfDelay: Infinity });
let columnas = null;
const codigos = {};

for await (const linea of rl) {
  if (!linea.trim()) continue;
  const valores = parseCsvLine(linea);
  if (!columnas) {
    valores[0] = valores[0].replace(/^﻿/, '');
    columnas = Object.fromEntries(valores.map((nombre, i) => [nombre, i]));
    continue;
  }
  const id = valores[columnas.stop_id];
  const codigo = valores[columnas.stop_code];
  if (id && codigo) codigos[id] = codigo;
}

fs.writeFileSync(salida, JSON.stringify(codigos));
console.log(`${Object.keys(codigos).length} códigos escritos en ${salida}`);
