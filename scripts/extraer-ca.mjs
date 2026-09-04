#!/usr/bin/env node
/**
 * Extrae el certificado intermedio de la cadena TLS de la NTA y lo deja en
 * certs/nta-cadena.pem, para pasárselo a Node con NODE_EXTRA_CA_CERTS.
 *
 * Por qué hace falta
 * ------------------
 * api.nationaltransport.ie está detrás de un balanceador con nodos mal
 * configurados: la mitad de las conexiones devuelven la cadena completa (3
 * certificados) y la otra mitad devuelven solo la hoja, sin el intermedio de
 * GoDaddy. Medido: 6 de 12 conexiones.
 *
 * Los navegadores y curl salvan ese caso descargando el intermedio que falta
 * por AIA (Authority Information Access). **Node no implementa AIA**, así que
 * en esas conexiones no puede construir la cadena y aborta con
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, que fetch presenta como "fetch failed".
 *
 * Ese es el motivo real de que curl funcionara siempre y el recolector fallara
 * la mitad de los sondeos.
 *
 * Uso:
 *   node scripts\extraer-ca.mjs
 *   $env:NODE_EXTRA_CA_CERTS = "C:\...\dublin-bus\certs\nta-cadena.pem"
 *
 * Hay que rehacerlo si la NTA renueva el certificado (el actual caduca en
 * septiembre de 2026).
 */

import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";

const HOST = "api.nationaltransport.ie";
const DESTINO = path.join("certs", "nta-cadena.pem");
const MAX_INTENTOS = 15;

/** DER -> PEM, que es solo base64 en líneas de 64 y unas cabeceras. */
function derAPem(der, etiqueta = "CERTIFICATE") {
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${etiqueta}-----\n${b64}\n-----END ${etiqueta}-----\n`;
}

function conectar() {
  return new Promise((res) => {
    const s = tls.connect(
      { host: HOST, port: 443, servername: HOST, rejectUnauthorized: false },
      () => {
        const cadena = [];
        let c = s.getPeerCertificate(true);
        const vistos = new Set();
        while (c && c.fingerprint && !vistos.has(c.fingerprint) && cadena.length < 8) {
          vistos.add(c.fingerprint);
          cadena.push(c);
          if (c.issuerCertificate === c) break;
          c = c.issuerCertificate;
        }
        res(cadena);
        s.destroy();
      },
    );
    s.on("error", () => { res([]); s.destroy(); });
    s.setTimeout(10_000, () => { res([]); s.destroy(); });
  });
}

let cadena = [];
let intentos = 0;
console.log(`Buscando una conexión a ${HOST} que devuelva la cadena completa...`);

while (intentos < MAX_INTENTOS) {
  intentos++;
  const c = await conectar();
  console.log(`  intento ${intentos}: ${c.length} certificado(s)`);
  if (c.length > cadena.length) cadena = c;
  if (cadena.length >= 2) break;
}

if (cadena.length < 2) {
  console.error(
    `\nNo he conseguido la cadena completa en ${MAX_INTENTOS} intentos.\n` +
      `Vuelve a probar; el balanceo es aleatorio.`,
  );
  process.exit(1);
}

// La hoja (índice 0) no se incluye: cambia cada pocos meses y no es una CA.
// Lo que necesita Node son los intermedios y la raíz.
const cas = cadena.slice(1);

fs.mkdirSync("certs", { recursive: true });
const pem = cas
  .map((c) => `# ${c.subject?.CN ?? "?"}\n#   emitido por: ${c.issuer?.CN ?? "?"}\n` + derAPem(c.raw))
  .join("\n");
fs.writeFileSync(DESTINO, pem, "utf8");

console.log(`\nEscrito ${DESTINO} con ${cas.length} certificado(s):`);
for (const c of cas) console.log(`  - ${c.subject?.CN}  (caduca ${c.valid_to})`);
console.log(
  `\nActívalo así:\n` +
    `  $env:NODE_EXTRA_CA_CERTS = "${path.resolve(DESTINO)}"\n\n` +
    `Los scripts .cmd del proyecto ya lo hacen solos.`,
);
