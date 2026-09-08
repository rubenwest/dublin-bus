import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { Api, Llegada, Llegadas, Parada } from './api';
import { entorno } from './entorno';

const CLAVE_ULTIMA = 'dublin-bus.ultima-parada';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  private api = inject(Api);

  readonly paradas = signal<Parada[]>([]);
  readonly parada = signal<Parada | null>(null);
  readonly datos = signal<Llegadas | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly actualizado = signal<Date | null>(null);

  /**
   * Si el feed envejece, es que el cron se ha caído. Más de tres minutos ya
   * es raro: escribe cada minuto. Vale la pena avisar en pantalla en vez de
   * enseñar horarios viejos como si fueran buenos.
   */
  readonly rancio = computed(() => (this.datos()?.antiguedadSegundos ?? 0) > 180);

  readonly hayLlegadas = computed(() => (this.datos()?.llegadas.length ?? 0) > 0);

  private temporizador: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void this.cargarParadas();
  }

  ngOnDestroy(): void {
    this.pararRefresco();
  }

  private async cargarParadas(): Promise<void> {
    this.cargando.set(true);
    try {
      const lista = await this.api.paradas();
      this.paradas.set(lista);

      const ultima = localStorage.getItem(CLAVE_ULTIMA);
      const previa = lista.find((p) => p.id === ultima);
      if (previa) this.seleccionar(previa);
      else if (lista.length === 1) this.seleccionar(lista[0]);
    } catch {
      this.error.set('No he podido cargar las paradas. ¿Hay conexión?');
    } finally {
      this.cargando.set(false);
    }
  }

  seleccionar(p: Parada): void {
    this.parada.set(p);
    this.datos.set(null);
    localStorage.setItem(CLAVE_ULTIMA, p.id);
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
      const d = await this.api.llegadas(p.id);
      if (!d) {
        this.error.set('Esta parada aún no tiene datos recogidos.');
      } else {
        this.datos.set(d);
        this.actualizado.set(new Date());
      }
    } catch {
      this.error.set('No he podido hablar con el servidor.');
    } finally {
      this.cargando.set(false);
    }
  }

  private arrancarRefresco(): void {
    this.pararRefresco();
    this.temporizador = setInterval(() => void this.refrescar(), entorno.refrescoMs);
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
    const m = Math.round((l.retrasoSegundos ?? 0) / 60);
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
    return d
      ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
  }
}
