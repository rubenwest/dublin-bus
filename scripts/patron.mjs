/**
 * El id de un patrón de recorrido.
 *
 * Va en su propio módulo porque la fórmula está duplicada a propósito en dos
 * sitios que no se pueden importar entre sí: aquí, para `sincronizar.mjs`, y en
 * SQL dentro de `supabase/migrations/20260917120000_horario_por_patron.sql`,
 * que es quien rellenó la tabla la primera vez. `scripts/pruebas.mjs` compara
 * las dos contra ids reales de la base; si divergen, la siguiente carga
 * duplicaría el horario entero en vez de reescribirlo.
 *
 * md5 del contenido truncado a 60 bits, en decimal y como TEXTO. Los 60 bits no
 * caben en un `number` de JavaScript (53 de mantisa): devolverlo como número
 * redondearía ids distintos al mismo. PostgREST lo mete en el `bigint` sin
 * pasar por el float.
 */
import crypto from "node:crypto";

export function idPatron(texto) {
  const hex = crypto.createHash("md5").update(texto, "utf8").digest("hex").slice(0, 15);
  return BigInt(`0x${hex}`).toString();
}
