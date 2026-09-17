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

/**
 * Un autobús en el mapa. Viene del feed Vehicles, que está capado: trae la
 * posición y poco más. No sirve para calcular llegadas —falta
 * `current_stop_sequence`, así que no se sabe a qué parada va— pero sí para
 * enseñar dónde está el bus que uno espera, que es la pregunta de la marquesina.
 */
export interface Vehiculo {
  tripId: string;
  lat: number;
  lon: number;
  /** Opcional de verdad: la NTA solo lo manda en un tercio de los vehículos. */
  bearing: number | null;
  /** Momento de la medida según el feed, para poder decir "hace 40 s". */
  ts: string | null;
}

/** Por debajo de esto la celda no dice nada y es mejor callarse. */
export const MIN_BUSES_FIABLE = 12;

/** Un sentido representativo de una línea, limitado a las paradas disponibles. */
export interface SentidoLinea {
  id: string;
  paradas: string[];
}

/**
 * Un recorrido de una línea, tal y como lo devuelve `recorridos_de_linea`. Ya
 * viene ordenado de más largo a más corto y con los viajes sumados, así que el
 * cliente sólo elige los dos sentidos.
 *
 * `patron` es de 60 bits y llega como texto a propósito: un `number` de
 * JavaScript sólo garantiza 53. Aquí es un identificador opaco.
 */
interface RecorridoLinea {
  patron: string;
  veces: number;
  paradas: string[] | null;
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
   * Dónde están los autobuses de estos viajes, ahora mismo.
   *
   * Se cruza por `trip_id` y nunca por `vehicle.id`: los dos feeds usan
   * espacios de nombres distintos para los vehículos ("3" en uno, "7182" en el
   * otro) y cruzarlos da emparejamientos falsos.
   *
   * Se piden solo los viajes que se ven en pantalla (como mucho quince), no los
   * ochocientos de la tabla: en el móvil eso es la diferencia entre unos bytes
   * y varios cientos de kilobytes por refresco.
   */
  async vehiculos(tripIds: string[]): Promise<Vehiculo[]> {
    if (!tripIds.length) return [];
    const filas = await this.leer(
      this.http.get<any[]>(`${entorno.supabaseUrl}/rest/v1/vehiculo`, {
        headers: this.cabeceras,
        params: {
          select: 'trip_id,lat,lon,bearing,ts',
          trip_id: `in.(${tripIds.map((t) => `"${t}"`).join(',')})`,
        },
      }),
    );
    return filas.map((f) => ({
      tripId: f.trip_id,
      lat: f.lat,
      lon: f.lon,
      bearing: f.bearing ?? null,
      ts: f.ts ?? null,
    }));
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
    // Antes esto leía `horario` a pelo y paginaba de 1.000 en 1.000 para
    // reconstruir los recorridos viaje a viaje: 16 peticiones para acabar
    // pintando 15 nodos de la línea 14, y ~63 cuando la cobertura se ensanche.
    // El agrupado ya lo hace la base (`recorridos_de_linea`), que devuelve un
    // puñado de recorridos con cuántos viajes usa cada uno.
    const recorridos = await this.leer(
      this.http.post<RecorridoLinea[]>(
        `${entorno.supabaseUrl}/rest/v1/rpc/recorridos_de_linea`,
        { p_linea: linea },
        { headers: this.cabeceras },
      ),
    );

    const candidatos = recorridos
      .map((r) => ({
        // Una circular puede repetir parada seguida; en el dibujo es un nodo.
        paradas: (r.paradas ?? []).filter((id, i, todos) => i === 0 || id !== todos[i - 1]),
        veces: r.veces,
      }))
      .filter((r) => r.paradas.length);
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
