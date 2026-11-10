/** Tipos de `gtfsrt.mjs`, que es JavaScript plano y espejo de scripts/gtfsrt.mjs. */
export interface ViajeDeParada {
  trip_id: string;
  start_date: string;
  rel: string;
  linea: string;
  vehiculo: string | null;
  seq: number;
  prog_segs: number;
  updates: unknown[];
}

export function llegadaDeViaje(
  v: ViajeDeParada,
  ahora: Date,
): {
  linea: string;
  minutos: number;
  programado: string;
  estimado: string;
  retrasoSegundos: number | null;
  estado: 'EN_VIVO' | 'SOLO_HORARIO' | 'SIN_DATOS' | 'CANCELADO' | 'SALTADA';
  tripId: string;
  vehiculo: string | null;
} | null;
