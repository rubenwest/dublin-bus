/**
 * Lock de instancia única para el recolector.
 *
 * El PC se usa con dos cuentas de Windows (Ayesa por las mañanas, Ruben por
 * las tardes) y la carpeta de Inicio es por usuario, así que el recolector
 * está instalado en las dos. Con el cambio rápido de usuario la sesión
 * anterior NO se cierra: los dos recolectores se solaparían y serían dos
 * llamadas por minuto a la NTA, que responde con HTTP 429.
 *
 * El lock vive en datos/, que las dos cuentas comparten. El primero que
 * arranca recolecta; el segundo se entera y se va sin gastar una llamada.
 *
 * No sirve un lock a base de "existe el fichero": si el proceso muere sin
 * limpiar (apagón, kill), el fichero se queda y nadie vuelve a recolectar
 * nunca. Por eso se guarda el PID y un latido que se refresca en cada sondeo,
 * y se puede robar el lock si el dueño está muerto o lleva demasiado callado.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tres sondeos de margen. Menos que esto y un sondeo lento con reintentos
// (45s de timeout x 4 intentos) haría que otra instancia robase el lock.
const LATIDO_MAXIMO_MS = 3 * 60_000;

/**
 * ¿Sigue vivo ese PID?
 *
 * Ojo con el caso que nos ocupa: el proceso puede ser de OTRA cuenta de
 * Windows. Entonces kill(pid, 0) lanza EPERM, que significa "existe pero no
 * es tuyo" — o sea, vivo. Solo ESRCH quiere decir que no hay nadie ahí.
 */
function sigueVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function leer(fichero) {
  try {
    return JSON.parse(fs.readFileSync(fichero, "utf8"));
  } catch {
    // Ilegible o a medio escribir: lo tratamos como que no hay lock.
    return null;
  }
}

function escribir(fichero, datos) {
  // Atómico, como el volcado del feed: si nos matan a mitad, nadie lee basura.
  const tmp = `${fichero}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(datos, null, 2));
  fs.renameSync(tmp, fichero);
}

/**
 * Intenta quedarse con el lock.
 *
 * Devuelve { ok: true, refrescar, soltar } si somos los que recolectan, o
 * { ok: false, duenyo } si ya hay otro vivo.
 */
export function tomarLock(datosDir) {
  const fichero = path.join(datosDir, "recolector.lock");

  const previo = leer(fichero);
  if (previo && sigueVivo(previo.pid)) {
    const silencio = Date.now() - (previo.latido ?? 0);
    if (silencio < LATIDO_MAXIMO_MS) {
      return { ok: false, duenyo: previo, silencio };
    }
    // Vivo pero mudo: colgado en una petición eterna, o parado en un
    // breakpoint. Se lo quitamos, porque si no dejamos de recolectar.
  }

  const mio = {
    pid: process.pid,
    usuario: os.userInfo().username,
    host: os.hostname(),
    desde: new Date().toISOString(),
    latido: Date.now(),
  };
  escribir(fichero, mio);

  // Carrera posible: dos recolectores arrancando en el mismo instante. El
  // rename es atómico, así que gana el último en escribir; releemos para ver
  // si el lock acabó siendo nuestro.
  const confirmado = leer(fichero);
  if (!confirmado || confirmado.pid !== process.pid) {
    return { ok: false, duenyo: confirmado, silencio: 0 };
  }

  let soltado = false;
  const soltar = () => {
    if (soltado) return;
    soltado = true;
    // Solo borramos si sigue siendo nuestro: puede que nos lo hayan robado
    // por quedarnos mudos, y no vamos a tirar el lock de otro.
    const actual = leer(fichero);
    if (actual?.pid === process.pid) {
      try {
        fs.unlinkSync(fichero);
      } catch {
        /* si no se puede borrar, el latido rancio lo resolverá */
      }
    }
  };

  const refrescar = () => {
    const actual = leer(fichero);
    if (actual?.pid !== process.pid) return false; // nos lo han robado
    escribir(fichero, { ...actual, latido: Date.now() });
    return true;
  };

  return { ok: true, refrescar, soltar, fichero };
}

export { LATIDO_MAXIMO_MS };
