import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, retry, throwError, timer } from 'rxjs';
import { entorno } from './entorno';

/** Estados que puede tener una llegada. Los tres últimos NO son un bus normal. */
export type EstadoLlegada =
  | 'EN_VIVO'       // hay dato en tiempo real
  | 'SOLO_HORARIO'  // el trip está vivo pero sin delay aplicable
  | 'SIN_DATOS'     // el operador dice NO_DATA de esta parada en adelante
  | 'CANCELADO'     // el viaje entero está cancelado
  | 'SALTADA';      // el bus pasa de largo por esta parada

export interface Llegada {
  linea: string;
  minutos: number;
  programado: string;
  estimado: string;
  retrasoSegundos: number | null;
  estado: EstadoLlegada;
  tripId: string;
  vehiculo: string | null;
}

export interface Parada {
  id: string;
  /** Código corto que se ve en Google Maps y en la marquesina (p. ej. 998013). */
  codigo: string | null;
  nombre: string;
  lat: number | null;
  lon: number | null;
  /** Líneas que pasan por la parada, para distinguir las 7 "O'Connell St". */
  lineas: string[];
}

export interface Llegadas {
  parada: Parada;
  generado: string;
  feedTs: number | null;
  /** Segundos desde que la NTA generó el feed. Si crece, el cron está caído. */
  antiguedadSegundos: number;
  llegadas: Llegada[];
}

/**
 * Lo que dice el histórico de una celda (parada, línea, franja horaria).
 *
 * `n` son AUTOBUSES distintos, no predicciones: cada paso deja una veintena de
 * predicciones sucesivas del mismo bus y contarlas todas prometía una
 * confianza veinte veces mayor de la que hay.
 */
export interface Fiabilidad {
  linea: string;
  /** Hora del día en Dublín, 0-23, a la que llega el bus. */
  franjaHora: number;
  n: number;
  dias: number;
  /** Mediana del error, en minutos. Positivo = llega más tarde de lo anunciado. */
  sesgoMin: number;
  errorAbsMin: number;
  p90Min: number;
}

/** Por debajo de esto la celda no dice nada y es mejor callarse. */
export const MIN_BUSES_FIABLE = 12;

/** Un sentido representativo de una línea, limitado a las paradas disponibles. */
export interface SentidoLinea {
  id: string;
  paradas: string[];
}

interface FilaHorarioLinea {
  stop_id: string;
  trip_id: string;
  seq: number;
}

/**
 * Habla directamente con Supabase, sin backend propio.
 *
 * Se puede porque el cron deja las llegadas ya calculadas en `llegada_actual`:
 * el navegador solo lee una tabla. La clave publicable está pensada para vivir
 * en el bundle — lo que protege los datos es el RLS, que da lectura pública y
 * ninguna escritura.
 *
 * Contra la API de la NTA esto NO se podría hacer: no manda ni una cabecera
 * CORS (comprobado), y su `x-api-key` quedaría a la vista de cualquiera.
 */
@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);
  private recorridos = new Map<string, Promise<SentidoLinea[]>>();
  private fiabilidades = new Map<string, Promise<Fiabilidad[]>>();

  private get cabeceras() {
    return {
      apikey: entorno.supabaseKey,
      Authorization: `Bearer ${entorno.supabaseKey}`,
    };
  }

  /** Las paradas que se muestran en vivo. Pueden ser cientos: el buscador filtra. */
  async paradas(): Promise<Parada[]> {
    const [filas, codigos] = await Promise.all([
      firstValueFrom(this.http.get<any[]>(`${entorno.supabaseUrl}/rest/v1/parada`, {
        headers: this.cabeceras,
        params: {
          select: 'id,nombre,lat,lon,lineas',
          en_vivo: 'eq.true',
          order: 'nombre.asc',
        },
      })),
      firstValueFrom(this.http.get<Record<string, string>>('codigos-parada.json')).catch(
        () => ({}) as Record<string, string>,
      ),
    ]);
    return filas.map((f) => ({
      id: f.id,
      codigo: codigos[f.id] ?? null,
      nombre: f.nombre,
      lat: f.lat,
      lon: f.lon,
      lineas: Array.isArray(f.lineas) ? f.lineas : [],
    }));
  }

  async llegadas(stopId: string): Promise<Llegadas | null> {
    const filas = await firstValueFrom(
      this.http.get<any[]>(`${entorno.supabaseUrl}/rest/v1/llegada_actual`, {
        headers: this.cabeceras,
        params: {
          select: 'stop_id,generado,feed_ts,llegadas,parada(id,nombre,lat,lon)',
          stop_id: `eq.${stopId}`,
        },
      }),
    );
    if (!filas.length) return null;
    const f = filas[0];

    return {
      parada: f.parada
        ? { ...f.parada, codigo: null, lineas: f.parada.lineas ?? [] }
        : { id: f.stop_id, codigo: null, nombre: f.stop_id, lat: null, lon: null, lineas: [] },
      generado: f.generado,
      feedTs: f.feed_ts ?? null,
      antiguedadSegundos: f.feed_ts
        ? Math.max(0, Math.round(Date.now() / 1000 - f.feed_ts))
        : Math.round((Date.now() - new Date(f.generado).getTime()) / 1000),
      llegadas: (f.llegadas ?? []) as Llegada[],
    };
  }

  /**
   * El sesgo medido de cada (línea, franja horaria) de una parada. Es la razón
   * de ser del proyecto: los minutos que faltan ya los da la app oficial, lo
   * que no da nadie es cuánto se equivoca ese número.
   *
   * Se piden solo las celdas con muestra suficiente, y se cachea por parada:
   * el histórico se mueve en días, no en el minuto del refresco.
   */
  fiabilidad(stopId: string): Promise<Fiabilidad[]> {
    const guardado = this.fiabilidades.get(stopId);
    if (guardado) return guardado;
    const peticion = this.leer(
      this.http.get<any[]>(`${entorno.supabaseUrl}/rest/v1/fiabilidad`, {
        headers: this.cabeceras,
        params: {
          select: 'linea,franja_hora,n,dias,sesgo_min,error_abs_min,p90_min',
          stop_id: `eq.${stopId}`,
          n: `gte.${MIN_BUSES_FIABLE}`,
        },
      }),
    )
      .then((filas) =>
        filas
          // `linea` sale de un LEFT JOIN con `ruta`: si el estático no trae esa
          // ruta no hay con qué casar la llegada y la fila no sirve.
          .filter((f) => f.linea)
          .map((f) => ({
            linea: f.linea as string,
            franjaHora: Number(f.franja_hora),
            n: Number(f.n),
            dias: Number(f.dias),
            // PostgREST manda los `numeric` como cadena, no como número.
            sesgoMin: Number(f.sesgo_min),
            errorAbsMin: Number(f.error_abs_min),
            p90Min: Number(f.p90_min),
          })),
      )
      .catch((error) => {
        // Sin histórico la pantalla sigue siendo útil: son los minutos de
        // siempre. No se deja el fallo cacheado, para que reintente.
        this.fiabilidades.delete(stopId);
        throw error;
      });
    this.fiabilidades.set(stopId, peticion);
    return peticion;
  }

  /**
   * Supabase puede responder puntualmente con un 5xx o perderse una petición
   * móvil. Las lecturas son idempotentes, así que hacemos dos reintentos breves
   * sin ocultar errores permanentes (permisos, consulta mal formada, etc.).
   */
  private leer<T>(peticion: Observable<T>): Promise<T> {
    return firstValueFrom(
      peticion.pipe(
        retry({
          count: 2,
          delay: (error: { status?: number }, intento) =>
            error.status && error.status >= 400 && error.status < 500
              ? throwError(() => error)
              : timer(300 * intento),
        }),
      ),
    );
  }

  /**
   * Reconstruye los sentidos de una línea a partir del horario que ya hay en
   * Supabase. No hace falta añadir otra tabla: se agrupan las paradas por viaje,
   * se eliminan patrones repetidos y se eligen los dos recorridos principales
   * que avanzan en sentidos opuestos.
   */
  sentidosLinea(linea: string): Promise<SentidoLinea[]> {
    const guardado = this.recorridos.get(linea);
    if (guardado) return guardado;
    const peticion = this.cargarSentidosLinea(linea).catch((error) => {
      this.recorridos.delete(linea);
      throw error;
    });
    this.recorridos.set(linea, peticion);
    return peticion;
  }

  private async cargarSentidosLinea(linea: string): Promise<SentidoLinea[]> {
    const rutas = await this.leer(
      this.http.get<Array<{ id: string }>>(`${entorno.supabaseUrl}/rest/v1/ruta`, {
        headers: this.cabeceras,
        params: { select: 'id', nombre: `eq.${linea}` },
      }),
    );
    if (!rutas.length) return [];

    // PostgREST limita cada respuesta. Se pagina porque una línea frecuente
    // puede sumar miles de filas aunque solo cubramos el centro de Dublín.
    const filtroRutas = `in.(${rutas
      .map((r) => `"${r.id.replaceAll('"', '\\"')}"`)
      .join(',')})`;
    const filas: FilaHorarioLinea[] = [];
    const lote = 1000;
    for (let offset = 0; ; offset += lote) {
      const pagina = await this.leer(
        this.http.get<FilaHorarioLinea[]>(`${entorno.supabaseUrl}/rest/v1/horario`, {
          headers: this.cabeceras,
          params: {
            select: 'stop_id,trip_id,seq',
            route_id: filtroRutas,
            order: 'trip_id.asc,seq.asc',
            limit: String(lote),
            offset: String(offset),
          },
        }),
      );
      filas.push(...pagina);
      if (pagina.length < lote) break;
    }

    const porViaje = new Map<string, FilaHorarioLinea[]>();
    for (const fila of filas) {
      if (!porViaje.has(fila.trip_id)) porViaje.set(fila.trip_id, []);
      porViaje.get(fila.trip_id)!.push(fila);
    }

    const patrones = new Map<string, { paradas: string[]; veces: number }>();
    for (const viaje of porViaje.values()) {
      const paradas = viaje
        .sort((a, b) => a.seq - b.seq)
        .map((f) => f.stop_id)
        .filter((id, i, todos) => i === 0 || id !== todos[i - 1]);
      if (!paradas.length) continue;
      const firma = paradas.join('|');
      const patron = patrones.get(firma);
      if (patron) patron.veces++;
      else patrones.set(firma, { paradas, veces: 1 });
    }

    const candidatos = [...patrones.values()].sort(
      (a, b) => b.paradas.length - a.paradas.length || b.veces - a.veces,
    );
    if (!candidatos.length) return [];

    const primero = candidatos[0];
    const posiciones = new Map(primero.paradas.map((id, i) => [id, i]));
    // El segundo patrón debe cruzar al menos dos paradas del primero en orden
    // inverso. Así no confundimos una variante corta con el viaje de vuelta.
    const opuesto = candidatos.slice(1).find((candidato) => {
      const comunes = candidato.paradas
        .map((id) => posiciones.get(id))
        .filter((i): i is number => i != null);
      return comunes.length >= 2 && comunes[0] > comunes[comunes.length - 1];
    });

    // En calles de sentido único los dos viajes pueden usar paradas totalmente
    // distintas. En ese caso no hay orden común que invertir: escogemos el
    // patrón largo con poco solape antes que una pequeña variante del primero.
    const pocoSolape = candidatos.slice(1).find((candidato) => {
      const comunes = candidato.paradas.filter((id) => posiciones.has(id)).length;
      return comunes / Math.min(primero.paradas.length, candidato.paradas.length) < 0.5;
    });
    const segundo = opuesto ?? pocoSolape ?? candidatos[1];

    return [primero, segundo]
      .filter((p): p is { paradas: string[]; veces: number } => p != null)
      .map((p, i) => ({ id: `${linea}-${i + 1}`, paradas: p.paradas }));
  }

  /**
   * Guarda un mensaje de feedback en la tabla `feedback`. Funciona con la clave
   * publicable porque el RLS da INSERT a `anon` y ninguna policy de SELECT: se
   * puede escribir pero no leer lo que escriben otros.
   *
   * `Prefer: return=minimal` es obligatorio: sin él PostgREST intenta devolver
   * la fila recién creada, y como no hay policy de SELECT esa lectura da 0 filas
   * y el POST falla. Con `minimal` PostgREST responde 201 sin leer nada.
   */
  async enviarFeedback(texto: string, contacto?: string, parada?: string): Promise<void> {
    await firstValueFrom(
      this.http.post(
        `${entorno.supabaseUrl}/rest/v1/feedback`,
        {
          texto,
          contacto: contacto?.trim() || null,
          parada: parada ?? null,
          user_agent: navigator.userAgent.slice(0, 400),
        },
        { headers: { ...this.cabeceras, Prefer: 'return=minimal' } },
      ),
    );
  }
}
