import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
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

  private get cabeceras() {
    return {
      apikey: entorno.supabaseKey,
      Authorization: `Bearer ${entorno.supabaseKey}`,
    };
  }

  /** Las paradas que se muestran en vivo. Pueden ser cientos: el buscador filtra. */
  async paradas(): Promise<Parada[]> {
    const filas = await firstValueFrom(
      this.http.get<any[]>(`${entorno.supabaseUrl}/rest/v1/parada`, {
        headers: this.cabeceras,
        params: {
          select: 'id,nombre,lat,lon,lineas',
          en_vivo: 'eq.true',
          order: 'nombre.asc',
        },
      }),
    );
    return filas.map((f) => ({
      id: f.id,
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
        ? { ...f.parada, lineas: f.parada.lineas ?? [] }
        : { id: f.stop_id, nombre: f.stop_id, lat: null, lon: null, lineas: [] },
      generado: f.generado,
      feedTs: f.feed_ts ?? null,
      antiguedadSegundos: f.feed_ts
        ? Math.max(0, Math.round(Date.now() / 1000 - f.feed_ts))
        : Math.round((Date.now() - new Date(f.generado).getTime()) / 1000),
      llegadas: (f.llegadas ?? []) as Llegada[],
    };
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
