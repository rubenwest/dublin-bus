import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { Api, Llegada, Parada, RespuestaLlegadas } from './api';

const CLAVE_ULTIMA = 'dublin-bus.ultima-parada';
const REFRESCO_MS = 20_000;

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  private api = inject(Api);

  readonly consulta = signal('');
  readonly resultados = signal<Parada[]>([]);
  readonly buscando = signal(false);

  readonly parada = signal<Parada | null>(null);
  readonly datos = signal<RespuestaLlegadas | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly actualizado = signal<Date | null>(null);

  /** Segundos de antigüedad del feed. Si crece, el recolector está caído. */
  readonly antiguedad = computed(() => this.datos()?.feed.antiguedadSegundos ?? null);

  readonly hayLlegadas = computed(() => (this.datos()?.llegadas.length ?? 0) > 0);

  private temporizador: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const ultima = localStorage.getItem(CLAVE_ULTIMA);
    if (ultima) {
      try {
        this.seleccionar(JSON.parse(ultima) as Parada);
      } catch {
        localStorage.removeItem(CLAVE_ULTIMA);
      }
    }
  }

  ngOnDestroy(): void {
    this.pararRefresco();
    if (this.debounce) clearTimeout(this.debounce);
  }

  alEscribir(valor: string): void {
    this.consulta.set(valor);
    if (this.debounce) clearTimeout(this.debounce);
    if (valor.trim().length < 2) {
      this.resultados.set([]);
      return;
    }
    this.debounce = setTimeout(() => void this.buscar(valor), 250);
  }

  private async buscar(valor: string): Promise<void> {
    this.buscando.set(true);
    try {
      this.resultados.set(await this.api.buscarParadas(valor));
    } catch {
      this.resultados.set([]);
    } finally {
      this.buscando.set(false);
    }
  }

  seleccionar(p: Parada): void {
    this.parada.set(p);
    this.resultados.set([]);
    this.consulta.set('');
    localStorage.setItem(CLAVE_ULTIMA, JSON.stringify(p));
    void this.refrescar();
    this.arrancarRefresco();
  }

  volver(): void {
    this.pararRefresco();
    this.parada.set(null);
    this.datos.set(null);
    this.error.set(null);
    localStorage.removeItem(CLAVE_ULTIMA);
  }

  async refrescar(): Promise<void> {
    const p = this.parada();
    if (!p) return;
    this.cargando.set(true);
    this.error.set(null);
    try {
      this.datos.set(await this.api.llegadas(p.id));
      this.actualizado.set(new Date());
    } catch {
      this.error.set('No he podido hablar con el servidor. ¿Está arrancado?');
    } finally {
      this.cargando.set(false);
    }
  }

  private arrancarRefresco(): void {
    this.pararRefresco();
    this.temporizador = setInterval(() => void this.refrescar(), REFRESCO_MS);
  }

  private pararRefresco(): void {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
  }

  // --- Presentación ---------------------------------------------------------

  cuando(l: Llegada): string {
    if (l.estado === 'SALTADA') return 'NO PARA';
    if (l.estado === 'CANCELADO') return '--';
    if (l.minutos <= 0) return 'ya';
    return String(l.minutos);
  }

  /** Solo se pone unidad cuando el texto es un número. */
  unidad(l: Llegada): string {
    return l.estado === 'SALTADA' || l.estado === 'CANCELADO' || l.minutos <= 0
      ? ''
      : 'min';
  }

  nota(l: Llegada): string {
    switch (l.estado) {
      case 'SALTADA':
        return 'el operador marca esta parada como saltada';
      case 'CANCELADO':
        return 'viaje cancelado';
      case 'SIN_DATOS':
        return 'el operador no da datos aquí, solo horario';
      case 'SOLO_HORARIO':
        return 'sin dato en vivo, solo horario';
    }
    const s = l.retrasoSegundos ?? 0;
    const m = Math.round(s / 60);
    if (m === 0) return 'en hora';
    return m > 0 ? `${m} min tarde` : `${Math.abs(m)} min adelantado`;
  }

  horaProgramada(l: Llegada): string {
    return new Date(l.programado).toLocaleTimeString('es-ES', {
      timeZone: 'Europe/Dublin',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  horaActualizado(): string {
    const d = this.actualizado();
    return d ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  }
}
