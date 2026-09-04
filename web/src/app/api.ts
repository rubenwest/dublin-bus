import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

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
  pasadas?: number;
}

export interface RespuestaLlegadas {
  parada: Parada;
  generado: string;
  feed: { obtenido: string | null; antiguedadSegundos: number | null };
  descartadosPorDelayAbsurdo: number;
  llegadas: Llegada[];
}

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  buscarParadas(q: string): Promise<Parada[]> {
    return firstValueFrom(
      this.http.get<Parada[]>('/api/paradas', { params: { q } }),
    );
  }

  llegadas(stopId: string): Promise<RespuestaLlegadas> {
    return firstValueFrom(
      this.http.get<RespuestaLlegadas>(`/api/llegadas/${encodeURIComponent(stopId)}`),
    );
  }
}
