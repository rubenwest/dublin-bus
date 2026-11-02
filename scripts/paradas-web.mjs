#!/usr/bin/env node
/**
 * Vuelca las paradas `en_vivo` a un JSON estático para la web.
 *
 * Existe por el egress. La web se bajaba esta lista de Supabase cada vez que
 * alguien abría la app: 5.431 paradas en 6 páginas, ~130 KB comprimidos, el
 * 85% de lo que gasta una visita. Y solo cambia cuando se recarga el estático.
 * Servida desde GitHub Pages no cuenta contra la cuota de Supabase, y el
 * service worker la guarda hasta el siguiente despliegue.
 *
 * Se lee de `parada` y no del índice a propósito: es la lista que veía la web,
 * incluido lo que se haya marcado `en_vivo` a mano.
 *
 * Hay que relanzarlo tras cada `sincronizar --nucleo`, como `trazados.mjs` y
 * `codigos-parada.mjs`, y desplegar.
 *
 * Uso: node scripts/paradas-web.mjs [web/public/paradas.json]
 */

import fs from "node:fs";
import { cargarDotEnv } from "./entorno.mjs";

cargarDotEnv();

const [salida = "./web/public/paradas.json"] = process.argv.slice(2);
const URL_BASE = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!URL_BASE || !SERVICE_KEY) {
  console.error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY en .env");
  process.exit(1);
}

// Paginado: PostgREST corta en 1.000 filas y no avisa. El `order` incluye `id`
// para que ninguna fila caiga en dos páginas o en ninguna (hay siete
// "O'Connell St").
const PAGINA = 1000;
const filas = [];
for (let desde = 0; ; desde += PAGINA) {
  const res = await fetch(
    `${URL_BASE}/rest/v1/parada?select=id,nombre,lat,lon,lineas&en_vivo=eq.true&order=nombre.asc,id.asc`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${desde}-${desde + PAGINA - 1}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) {
    throw new Error(`paradas: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
  const pagina = await res.json();
  filas.push(...pagina);
  if (pagina.length < PAGINA) break;
}

if (!filas.length) {
  console.error("Ninguna parada en_vivo: no se escribe nada para no dejar la web vacía.");
  process.exit(1);
}

const paradas = filas.map((f) => ({
  id: f.id,
  nombre: f.nombre,
  lat: f.lat,
  lon: f.lon,
  lineas: Array.isArray(f.lineas) ? f.lineas : [],
}));

fs.writeFileSync(salida, JSON.stringify(paradas));
console.log(
  `${paradas.length} paradas escritas en ${salida} ` +
    `(${(fs.statSync(salida).size / 1024).toFixed(0)} KB)`,
);
