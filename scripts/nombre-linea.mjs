/**
 * El nombre corto con el que se enseña una línea ("39A", "Red", "DART"). Una
 * sola copia, porque sale en cuatro sitios —el índice, las llegadas por
 * consola, el catálogo de Supabase y el mapa— y la web cruza unos con otros por
 * este nombre: si dos scripts lo calcularan distinto, el mapa no encontraría
 * el trazado de la línea que enseña el buscador.
 *
 * Casi siempre es `route_short_name` tal cual. La excepción es Irish Rail,
 * que pone `rail` en 16 rutas que no tienen nada que ver entre sí (Belfast,
 * Maynooth, Sligo, Rosslare…). Como la web agrupa por nombre corto, las 16
 * se fundían en una sola línea llamada "rail" con el recorrido de la que más
 * viajes tuviera. A esas se les pone el extremo que no es Dublín
 * ("Dublin - Belfast" -> "Belfast"), que es como se conoce un tren. El "via"
 * se quita para que "Dublin - Limerick via Nenagh" y "Dublin - Limerick" sean
 * la misma línea, como lo son para quien coge el tren en Heuston.
 *
 * "InterCity" y "Commuter" entran por lo mismo: son marcas de servicio, no
 * líneas, y en el estático las lleva una sola ruta cada una (Cork y
 * Portlaoise). Un chip "InterCity" que solo va a Cork hace creer que son todos
 * los trenes interurbanos. El DART sí es una línea y se queda como está.
 */
const NOMBRES_GENERICOS = new Set(["rail", "intercity", "commuter"]);

export function nombreLinea({ route_id, route_short_name, route_long_name }) {
  const corto = (route_short_name ?? "").trim();
  const largo = (route_long_name ?? "").trim();
  if (corto && !NOMBRES_GENERICOS.has(corto.toLowerCase())) return corto;
  if (largo) {
    const extremos = largo
      .split(/\s+-\s+/)
      .map((p) => p.replace(/\s+via\s+.*$/i, "").trim())
      .filter((p) => p && p.toLowerCase() !== "dublin");
    return extremos.length === 1 ? extremos[0] : largo;
  }
  return corto || route_id;
}
