/**
 * Cliente del feed GTFS-R de la NTA, con timeout y reintentos.
 *
 * Lo comparten el recolector y el backend. Dos cosas que no son opcionales:
 *
 *  1. `AbortSignal.timeout`. Sin él undici aguanta 300 s por defecto y el
 *     proceso se queda colgado sin decir nada.
 *  2. Reintentos. El fallo habitual es `SocketError: other side closed`
 *     (UND_ERR_SOCKET): undici reutiliza la conexión keep-alive, la NTA ya la
 *     cerró, y revienta. Se midió ~2 de cada 7 sondeos. El reintento abre
 *     socket nuevo, que es justo lo que hace falta.
 */

export const URL_TRIP_UPDATES =
  "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json";

/**
 * undici pone SIEMPRE "fetch failed" en err.message y esconde el motivo real
 * en err.cause, a veces anidado. Un catch que imprima err.message garantiza no
 * enterarse nunca de nada.
 */
export function detallarError(err) {
  const lineas = [];
  let e = err,
    nivel = 0;
  while (e && nivel < 6) {
    const campos = ["code", "errno", "syscall", "address", "port", "reason"]
      .filter((k) => e[k] !== undefined)
      .map((k) => `${k}=${e[k]}`)
      .join(" ");
    lineas.push(
      `${"  ".repeat(nivel)}${nivel === 0 ? "" : "cause: "}` +
        `${e.name ?? "Error"}: ${e.message ?? e}` +
        (campos ? `  [${campos}]` : ""),
    );
    if (e.errors?.length) {
      for (const sub of e.errors) {
        lineas.push(
          `${"  ".repeat(nivel + 1)}- ${sub.name}: ${sub.message}` +
            (sub.code ? `  [code=${sub.code}]` : ""),
        );
      }
    }
    e = e.cause;
    nivel++;
  }
  return lineas.join("\n");
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** 5xx y 429 son transitorios; 401/403 no se arreglan reintentando. */
function esReintentable(err) {
  if (err.estado !== undefined) return err.estado === 429 || err.estado >= 500;
  return true; // transporte (socket, DNS, TLS, timeout)
}

export function crearClienteFeed({
  url = URL_TRIP_UPDATES,
  apiKey,
  timeoutMs = 45_000,
  reintentos = 4,
  backoffBaseMs = 2_000,
  alReintentar = null,
} = {}) {
  if (!apiKey) throw new Error("crearClienteFeed necesita apiKey");

  async function pedir() {
    let ultimo;

    for (let intento = 1; intento <= reintentos; intento++) {
      try {
        const res = await fetch(url, {
          headers: { "x-api-key": apiKey, "Cache-Control": "no-cache" },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          // Hay que consumir el cuerpo o el socket se queda a medias.
          const cuerpo = await res.text().catch(() => "");
          const e = new Error(
            `HTTP ${res.status} ${res.statusText}` +
              (cuerpo ? ` — ${cuerpo.slice(0, 200)}` : ""),
          );
          e.estado = res.status;
          throw e;
        }

        return await res.json();
      } catch (err) {
        ultimo = err;
        if (!esReintentable(err) || intento === reintentos) break;
        const espera = Math.round(
          backoffBaseMs * 2 ** (intento - 1) * (0.5 + Math.random()),
        );
        alReintentar?.(err, intento, espera);
        await esperar(espera);
      }
    }

    throw ultimo;
  }

  return { pedir };
}
