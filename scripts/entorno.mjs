/**
 * Carga de .env, compartida por todos los scripts.
 *
 * Existe por una razón concreta: PowerShell 5.1 escribe UTF-16LE cuando haces
 * `echo "X=1" > .env`, con BOM y un byte nulo entre cada carácter. Node
 * leyéndolo como utf8 no casa ninguna regex, y el script jura que falta la
 * variable teniendo el fichero delante. Se tarda un rato en verlo.
 */

import fs from "node:fs";

/** Lee un fichero de texto respetando el BOM que le haya puesto Windows. */
export function leerTexto(fichero) {
  const b = fs.readFileSync(fichero);
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString("utf16le", 2);
  if (b[0] === 0xfe && b[1] === 0xff) return b.swap16().toString("utf16le", 2);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.toString("utf8", 3);
  return b.toString("utf8");
}

/** Vuelca las claves del .env en process.env. Lo ya definido en el entorno gana. */
export function cargarDotEnv(fichero = ".env") {
  if (!fs.existsSync(fichero)) return;
  for (const linea of leerTexto(fichero).split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    const valor = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = valor;
  }
}
