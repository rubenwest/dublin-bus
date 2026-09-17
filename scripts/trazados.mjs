#!/usr/bin/env node
/**
 * Genera el trazado geográfico de cada línea que usa el mapa del explorador.
 *
 * Sale de `shapes.txt`, que son 188 MB con la geometría punto a punto de cada
 * viaje. La reducción es la que hace esto viable:
 *
 *   4.030.455 filas -> 348 recorridos -> 40.707 puntos -> 0,77 MB (137 KB gzip)
 *
 * Tres recortes, en este orden:
 *
 * 1. **Solo lo que pasa por Dublín.** Están las siete agencias, porque el
 *    catálogo de la web incluye el DART, el InterCity y los Bus Éireann que
 *    salen del aeropuerto —sin ellos eran 26 líneas con el chip apagado—, pero
 *    se descarta el recorrido que no entra en la caja de Dublín. Eso deja
 *    fuera Cork, Galway y Waterford, que son la mayor parte de Bus Éireann.
 *
 *    Y lo que entra se **recorta a la caja**. El 32 va del aeropuerto a
 *    Letterkenny: sin recortar son 1,36 MB en vez de 0,95 y, peor, elegirlo
 *    encuadra media Irlanda y deja Dublín en un punto. Se guarda el tramo que
 *    se puede mirar. Un recorrido que sale y vuelve a entrar queda partido en
 *    varios trazos, que para dibujar da igual.
 * 2. **Un recorrido por línea y sentido.** Las líneas tienen muchas variantes
 *    (refuerzos que se quedan a medio camino); dibujarlas todas es una maraña
 *    ilegible y multiplica el peso por veinte. Lo que se pinta es "por dónde
 *    va normalmente el 14", no todos sus servicios, y la web lo dice en
 *    pantalla.
 *
 *    Quedarse con el shape de más viajes **no vale a secas**: el sentido 1 de
 *    la Luas Red tiene 278 viajes en una lanzadera de 14 puntos y salía un
 *    muñón en vez de la línea. Se pide primero que el recorrido mida al menos
 *    el 70% del más largo de ese sentido, y entre los que pasan ese corte se
 *    coge el de más viajes. Así se descartan los refuerzos cortos sin caer en
 *    la variante rarísima de un solo viaje al año.
 * 3. **Douglas-Peucker a 10 m.** A la escala de un móvil 10 m es menos de un
 *    píxel hasta zoom 17. Con 5 m son 1,13 MB para una diferencia que no se
 *    ve; con 20 m empiezan a cortarse las curvas de las rotondas.
 *
 * Las coordenadas van como [lat, lon] —el orden de Leaflet, no el de GeoJSON—
 * para no recorrer 40.000 puntos dándoles la vuelta en el navegador.
 *
 * Hay que relanzarlo cada vez que se descargue un estático nuevo, igual que
 * `indexar.mjs` y `codigos-parada.mjs`.
 *
 * Uso: node scripts/trazados.mjs [./gtfs] [web/public/trazados-linea.json]
 */

import fs from 'node:fs';
import readline from 'node:readline';

const [gtfsDir = './gtfs', salida = './web/public/trazados-linea.json'] = process.argv.slice(2);

/**
 * La caja que decide si un recorrido pinta algo aquí. Es el área metropolitana
 * con holgura: de Balbriggan a Bray y de Maynooth al mar.
 */
const DUBLIN = { latMin: 53.1, latMax: 53.7, lonMin: -6.75, lonMax: -5.95 };
/** Tolerancia de simplificación, en metros. */
const TOLERANCIA_M = 10;
/** Un recorrido candidato tiene que medir al menos esto del más largo. */
const LARGO_MINIMO = 0.7;
/** Grados de latitud por metro; sirve de sobra para una tolerancia. */
const GRADOS_POR_METRO = 1 / 111_320;

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

/** Lee un .txt del GTFS entero y devuelve filas ya indexadas por nombre. */
function leerTabla(nombre) {
  const texto = fs.readFileSync(`${gtfsDir}/${nombre}`, 'utf8');
  const lineas = texto.split('\n');
  const cabecera = parseCsvLine(lineas[0]);
  cabecera[0] = cabecera[0].replace(/^﻿/, '');
  const col = Object.fromEntries(cabecera.map((c, i) => [c.trim(), i]));
  const filas = [];
  for (let i = 1; i < lineas.length; i++) {
    if (!lineas[i].trim()) continue;
    filas.push(parseCsvLine(lineas[i]));
  }
  return { col, filas };
}

// --- 1. Las líneas que interesan ---------------------------------------------

const rutas = new Map(); // route_id -> nombre corto
{
  const { col, filas } = leerTabla('routes.txt');
  for (const f of filas) {
    const nombre = (f[col.route_short_name] || f[col.route_long_name] || '').trim();
    if (nombre) rutas.set(f[col.route_id], nombre);
  }
}

// --- 2. Las variantes de cada (línea, sentido) -------------------------------

const variantes = new Map(); // "route|dir" -> Map(shape_id -> viajes)
const candidatos = new Set(); // todos los shape_id que habrá que leer
{
  const { col, filas } = leerTabla('trips.txt');
  for (const f of filas) {
    const route = f[col.route_id];
    const shape = (f[col.shape_id] || '').trim();
    if (!shape || !rutas.has(route)) continue;
    const clave = `${route}|${f[col.direction_id]}`;
    let porShape = variantes.get(clave);
    if (!porShape) variantes.set(clave, (porShape = new Map()));
    porShape.set(shape, (porShape.get(shape) ?? 0) + 1);
    candidatos.add(shape);
  }
}

console.log(
  `${rutas.size} líneas, ${variantes.size} sentidos, ${candidatos.size} variantes de recorrido`,
);

// --- 3. Los puntos, leyendo shapes.txt en streaming --------------------------

const puntos = new Map(); // shape_id -> [[lat, lon, secuencia], ...]
{
  const rl = readline.createInterface({
    input: fs.createReadStream(`${gtfsDir}/shapes.txt`, 'utf8'),
    crlfDelay: Infinity,
  });
  let col = null;
  let leidas = 0;
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    const f = parseCsvLine(linea);
    if (!col) {
      f[0] = f[0].replace(/^\ufeff/, '');
      col = Object.fromEntries(f.map((c, i) => [c.trim(), i]));
      continue;
    }
    leidas++;
    const shape = f[col.shape_id];
    if (!candidatos.has(shape)) continue;
    let arr = puntos.get(shape);
    if (!arr) puntos.set(shape, (arr = []));
    arr.push([
      Number(f[col.shape_pt_lat]),
      Number(f[col.shape_pt_lon]),
      Number(f[col.shape_pt_sequence]),
    ]);
  }
  for (const arr of puntos.values()) arr.sort((a, b) => a[2] - b[2]);
  console.log(`${leidas} filas de shapes.txt leídas`);
}

/** Largo del trazado en grados; solo se usa para comparar variantes entre sí. */
function largo(arr) {
  let total = 0;
  for (let i = 1; i < arr.length; i++) {
    total += Math.hypot(arr[i][0] - arr[i - 1][0], arr[i][1] - arr[i - 1][1]);
  }
  return total;
}

// --- 4. Elegir un recorrido por (línea, sentido) ------------------------------

const elegidos = []; // { nombre, shape }
for (const [clave, porShape] of variantes) {
  const nombre = rutas.get(clave.slice(0, clave.lastIndexOf('|')));
  const conLargo = [...porShape]
    .map(([shape, viajes]) => ({ shape, viajes, largo: largo(puntos.get(shape) ?? []) }))
    .filter((v) => v.largo > 0);
  if (!conLargo.length) continue;

  const corte = Math.max(...conLargo.map((v) => v.largo)) * LARGO_MINIMO;
  const enPie = conLargo.filter((v) => v.largo >= corte);
  // Empate a viajes: gana el shape_id menor, para que dos ejecuciones sobre el
  // mismo estático den el mismo fichero byte a byte.
  enPie.sort((a, b) => b.viajes - a.viajes || (a.shape < b.shape ? -1 : 1));
  elegidos.push({ nombre, shape: enPie[0].shape });
}

console.log(`${elegidos.length} recorridos elegidos (línea × sentido)`);

// --- 4. Simplificar ----------------------------------------------------------

/**
 * Douglas-Peucker sobre grados. La distancia se mide al segmento recto entre
 * los extremos, que a estas escalas es indistinguible de la geodésica.
 */
function simplificar(p, tol) {
  if (p.length < 3) return p;
  const [x1, y1] = p[0];
  const [x2, y2] = p[p.length - 1];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const den = Math.hypot(dx, dy) || 1e-12;
  let max = 0;
  let idx = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs(dy * (p[i][0] - x1) - dx * (p[i][1] - y1)) / den;
    if (d > max) {
      max = d;
      idx = i;
    }
  }
  if (max <= tol) return [p[0], p[p.length - 1]];
  return [...simplificar(p.slice(0, idx + 1), tol).slice(0, -1), ...simplificar(p.slice(idx), tol)];
}

/** Dentro de la caja de Dublín. */
function dentro([lat, lon]) {
  return (
    lat >= DUBLIN.latMin && lat <= DUBLIN.latMax && lon >= DUBLIN.lonMin && lon <= DUBLIN.lonMax
  );
}

/**
 * Parte un trazado en los tramos que caen dentro de la caja. Se guarda un
 * punto de más a cada lado para que la línea llegue hasta el borde en vez de
 * quedarse a medio camino del último punto interior.
 */
function recortar(trazo) {
  const tramos = [];
  let actual = null;
  for (let i = 0; i < trazo.length; i++) {
    if (dentro(trazo[i])) {
      if (!actual) {
        actual = [];
        if (i > 0) actual.push(trazo[i - 1]);
        tramos.push(actual);
      }
      actual.push(trazo[i]);
    } else if (actual) {
      actual.push(trazo[i]);
      actual = null;
    }
  }
  return tramos.filter((t) => t.length >= 2);
}

const tol = TOLERANCIA_M * GRADOS_POR_METRO;
const trazados = {}; // nombre -> [[[lat, lon], ...], ...]
let totalPuntos = 0;

// Ordenado para que el JSON salga byte a byte igual en cada pasada y no
// ensucie el diff cuando el estático no ha cambiado.
elegidos.sort((a, b) => (a.nombre === b.nombre ? (a.shape < b.shape ? -1 : 1) : a.nombre < b.nombre ? -1 : 1));

for (const { nombre, shape } of elegidos) {
  const arr = puntos.get(shape);
  // 5 decimales son ~1,1 m: por debajo de la tolerancia y la mitad de bytes.
  const trazo = simplificar(arr, tol).map(([lat, lon]) => [
    Number(lat.toFixed(5)),
    Number(lon.toFixed(5)),
  ]);
  if (trazo.length < 2) continue;
  for (const tramo of recortar(trazo)) {
    totalPuntos += tramo.length;
    (trazados[nombre] ??= []).push(tramo);
  }
}

const json = JSON.stringify(trazados);
fs.writeFileSync(salida, json);
console.log(
  `${Object.keys(trazados).length} líneas, ${totalPuntos} puntos, ` +
    `${(json.length / 1024 / 1024).toFixed(2)} MB en ${salida}`,
);
