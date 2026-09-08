import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { Api, Llegada, Llegadas, Parada } from './api';
import { entorno } from './entorno';

const CLAVE_ULTIMA = 'dublin-bus.ultima-parada';
const CLAVE_LINEAS = 'dublin-bus.lineas';
const CLAVE_FAV = 'dublin-bus.favoritas';

/**
 * Por encima de esto la lista plana no se enseña entera: hay que buscar. Con
 * las 3 paradas de la demo la lista cabía; con el centro son cientos y una
 * lista de cientos no se recorre con el bus entrando.
 */
const LISTA_SIN_BUSCAR = 25;
/** Tope de resultados de una búsqueda, para no pintar cientos de golpe. */
const MAX_RESULTADOS = 60;

/**
 * Cuántas llegadas se enseñan de cada línea. La ventana del recolector son 90
 * minutos, y en una parada de paso frecuente eso son siete filas del mismo
 * autobús: las tres primeras se usan, el resto es horario. Quien quiera el
 * horario tiene el botón de abajo.
 */
const POR_LINEA = 3;

/** Sin acentos y en minúsculas, para que "dun" case con "Dún". */
function normaliza(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy {
  private api = inject(Api);
  private swUpdate = inject(SwUpdate);

  readonly paradas = signal<Parada[]>([]);
  readonly parada = signal<Parada | null>(null);

  /** Texto del buscador de paradas. */
  readonly busqueda = signal('');
  /** Ids de paradas favoritas, ancladas arriba. En localStorage. */
  readonly favoritas = signal<string[]>(this.favoritasGuardadas());
  readonly datos = signal<Llegadas | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  readonly actualizado = signal<Date | null>(null);

  /**
   * Líneas elegidas en el filtro. Vacío significa "todas", no "ninguna": es
   * el estado por defecto y el que ve quien entra por primera vez.
   */
  readonly lineasElegidas = signal<string[]>([]);

  /** El usuario ha pedido ver también las llegadas lejanas que se recortan. */
  readonly sinTope = signal(false);

  /**
   * Si el feed envejece, es que el cron se ha caído. Más de tres minutos ya
   * es raro: escribe cada minuto. Vale la pena avisar en pantalla en vez de
   * enseñar horarios viejos como si fueran buenos.
   */
  readonly rancio = computed(() => (this.datos()?.antiguedadSegundos ?? 0) > 180);

  readonly hayLlegadas = computed(() => (this.datos()?.llegadas.length ?? 0) > 0);

  /**
   * Las líneas que ofrece el filtro. Se juntan las que hay ahora mismo con
   * las elegidas: si el 39A está filtrado y deja de pasar por la ventana de
   * 90 minutos, su chip tiene que seguir ahí. Si no, la lista se queda vacía
   * y sin nada que tocar para volver a verla.
   */
  readonly lineas = computed(() => {
    const presentes = (this.datos()?.llegadas ?? []).map((l) => l.linea);
    return [...new Set([...presentes, ...this.lineasElegidas()])].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
  });

  private readonly llegadasFiltradas = computed(() => {
    const todas = this.datos()?.llegadas ?? [];
    const elegidas = this.lineasElegidas();
    if (!elegidas.length) return todas;
    return todas.filter((l) => elegidas.includes(l.linea));
  });

  /**
   * Se recorta por línea, no por total: si una línea muy frecuente se come el
   * hueco, las demás siguen apareciendo. Vienen ya ordenadas por llegada, así
   * que quedarse con las primeras de cada una es quedarse con las próximas.
   */
  readonly llegadasVisibles = computed(() => {
    const filtradas = this.llegadasFiltradas();
    if (this.sinTope()) return filtradas;
    const vistas = new Map<string, number>();
    return filtradas.filter((l) => {
      const n = (vistas.get(l.linea) ?? 0) + 1;
      vistas.set(l.linea, n);
      return n <= POR_LINEA;
    });
  });

  /** Cuántas quedan fuera por el recorte. */
  readonly recortadas = computed(
    () => this.llegadasFiltradas().length - this.llegadasVisibles().length,
  );

  /** Hay llegadas, pero el filtro las esconde todas. Merece otro mensaje. */
  readonly filtradasTodas = computed(
    () => this.hayLlegadas() && this.llegadasFiltradas().length === 0,
  );

  /** Las paradas marcadas como favoritas, en el orden del catálogo. */
  readonly favoritasParadas = computed(() => {
    const fav = new Set(this.favoritas());
    return this.paradas().filter((p) => fav.has(p.id));
  });

  /**
   * Lo que se pinta bajo el buscador: los resultados de la búsqueda, o —si no
   * se ha escrito nada y hay pocas paradas— la lista entera. Con cientos de
   * paradas y sin texto no se pinta nada: para eso está el buscador. Las
   * favoritas se sacan de aquí porque ya van ancladas arriba.
   */
  readonly resultados = computed(() => {
    const q = normaliza(this.busqueda().trim());
    const fav = new Set(this.favoritas());
    const base = q
      ? this.paradas().filter(
          (p) =>
            normaliza(p.nombre).includes(q) ||
            p.id.toLowerCase().includes(q) ||
            p.lineas.some((l) => normaliza(l).includes(q)),
        )
      : this.paradas().length <= LISTA_SIN_BUSCAR
        ? this.paradas()
        : [];
    return base.filter((p) => !fav.has(p.id)).slice(0, MAX_RESULTADOS);
  });

  /** Hay más paradas de las que se enseñan y aún no se ha buscado nada. */
  readonly pisteBuscar = computed(
    () => !this.busqueda().trim() && this.paradas().length > LISTA_SIN_BUSCAR,
  );

  private temporizador: ReturnType<typeof setInterval> | null = null;
  private comprobarVersion: ReturnType<typeof setInterval> | null = null;

  constructor() {
    void this.cargarParadas();
    this.vigilarActualizaciones();
  }

  ngOnDestroy(): void {
    this.pararRefresco();
    if (this.comprobarVersion) clearInterval(this.comprobarVersion);
  }

  /**
   * Auto-actualización de la PWA. Sin esto, tras un despliegue el service worker
   * sigue sirviendo la versión vieja hasta que cierras la app del todo y la
   * abres dos veces: la primera baja la nueva en segundo plano, la segunda la
   * muestra. Con esto la app se recarga sola en cuanto el SW tiene lista la
   * versión nueva, y además la busca al volver a la pestaña y cada pocos
   * minutos, para no depender de reabrir. En `ng serve` el SW está desactivado,
   * así que `isEnabled` es false y esto no hace nada.
   */
  private vigilarActualizaciones(): void {
    if (!this.swUpdate.isEnabled) return;

    this.swUpdate.versionUpdates.subscribe((ev) => {
      if (ev.type === 'VERSION_READY') document.location.reload();
    });
    // Si el SW queda en un estado del que no puede recuperarse, recargar limpio.
    this.swUpdate.unrecoverable.subscribe(() => document.location.reload());

    const comprobar = () => {
      void this.swUpdate.checkForUpdate().catch(() => {});
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') comprobar();
    });
    this.comprobarVersion = setInterval(comprobar, 5 * 60_000);
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
    this.lineasElegidas.set(this.filtroGuardado(p.id));
    this.sinTope.set(false);
    localStorage.setItem(CLAVE_ULTIMA, p.id);
    void this.refrescar();
    this.arrancarRefresco();
  }

  volver(): void {
    this.pararRefresco();
    this.parada.set(null);
    this.datos.set(null);
    this.error.set(null);
    this.lineasElegidas.set([]);
    this.sinTope.set(false);
    localStorage.removeItem(CLAVE_ULTIMA);
  }

  // --- Buscador y favoritas -------------------------------------------------

  buscar(texto: string): void {
    this.busqueda.set(texto);
  }

  esFavorita(id: string): boolean {
    return this.favoritas().includes(id);
  }

  /**
   * El Luas (tranvía) vive en el espacio de ids `8220GA*`, con líneas Red y
   * Green; todo lo demás del feed es autobús. Sirve para pintar el sprite de
   * tranvía en vez del de bus. Que el feed traiga Luas fue una sorpresa: el
   * CLAUDE.md decía "solo autobuses" y era falso.
   */
  esTram(p: Parada): boolean {
    return p.id.startsWith('8220GA');
  }

  /**
   * La estrella vive dentro del botón de la parada; sin parar la propagación,
   * marcar favorita seleccionaría la parada y saltaría a sus llegadas.
   */
  alternarFavorita(p: Parada, ev: Event): void {
    ev.stopPropagation();
    const actual = this.favoritas();
    const nuevas = actual.includes(p.id)
      ? actual.filter((x) => x !== p.id)
      : [...actual, p.id];
    this.favoritas.set(nuevas);
    try {
      localStorage.setItem(CLAVE_FAV, JSON.stringify(nuevas));
    } catch {
      /* modo privado o almacenamiento lleno: la favorita no persiste, ni pasa nada */
    }
  }

  private favoritasGuardadas(): string[] {
    try {
      const crudo = localStorage.getItem(CLAVE_FAV);
      const leido = crudo ? JSON.parse(crudo) : null;
      return Array.isArray(leido) ? leido.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  // --- Filtro por línea -----------------------------------------------------

  /**
   * El filtro se guarda por parada, no global: quien espera el 39A en una
   * parada suele esperar otra cosa en la siguiente, y arrastrar la elección
   * de una a otra deja la pantalla vacía sin explicar por qué.
   */
  private clave(stopId: string): string {
    return `${CLAVE_LINEAS}.${stopId}`;
  }

  private filtroGuardado(stopId: string): string[] {
    try {
      const crudo = localStorage.getItem(this.clave(stopId));
      const leido = crudo ? JSON.parse(crudo) : null;
      return Array.isArray(leido) ? leido.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  elegida(linea: string): boolean {
    return this.lineasElegidas().includes(linea);
  }

  alternarLinea(linea: string): void {
    const actual = this.lineasElegidas();
    this.guardarFiltro(
      actual.includes(linea) ? actual.filter((l) => l !== linea) : [...actual, linea],
    );
  }

  verTodas(): void {
    this.guardarFiltro([]);
  }

  alternarTope(): void {
    this.sinTope.update((v) => !v);
  }

  textoTope(): string {
    if (this.sinTope()) return 'Ver solo las próximas';
    const n = this.recortadas();
    return n === 1 ? 'Ver 1 llegada más' : `Ver ${n} llegadas más`;
  }

  private guardarFiltro(lineas: string[]): void {
    this.lineasElegidas.set(lineas);
    const p = this.parada();
    if (!p) return;
    if (lineas.length) localStorage.setItem(this.clave(p.id), JSON.stringify(lineas));
    else localStorage.removeItem(this.clave(p.id));
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
    const m = this.minutosRetraso(l);
    if (m === 0) return 'en hora';
    return m > 0 ? `${m} min tarde` : `${Math.abs(m)} min adelantado`;
  }

  /**
   * El retraso que se anuncia sale de restar las dos horas ya recortadas al
   * minuto, no de redondear `retrasoSegundos`. Si no, las dos cuentas no dan
   * lo mismo y la fila se contradice sola: 515 segundos redondean a 9 min,
   * pero el reloj tira los segundos y 13:57 + 515 s se enseña como 14:05, que
   * son 8. Medido sobre la parada real, 4 de cada 13 filas no cuadraban.
   *
   * El precio es anunciar 8 donde el dato crudo dice 8,6. Es el correcto: en
   * pantalla manda lo que el usuario puede sumar. El retraso exacto en
   * segundos sigue entero en `serie`, que es lo que alimenta el histórico.
   */
  private minutosRetraso(l: Llegada): number {
    const alMinuto = (iso: string) => Math.floor(new Date(iso).getTime() / 60_000);
    return alMinuto(l.estimado) - alMinuto(l.programado);
  }

  /** Todas las horas se pintan en la de Dublín, que es donde está el bus. */
  private hora(iso: string): string {
    return new Date(iso).toLocaleTimeString('es-ES', {
      timeZone: 'Europe/Dublin',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  horaProgramada(l: Llegada): string {
    return this.hora(l.programado);
  }

  /**
   * Hay estimación de llegada cuando el operador da un dato en vivo. Un viaje
   * cancelado o una parada saltada no llegan a ninguna hora, y sin dato en
   * vivo la estimación es el propio horario.
   */
  private hayEstimacion(l: Llegada): boolean {
    return l.estado === 'EN_VIVO';
  }

  /**
   * La hora grande es la de llegada estimada, no la del horario: es la que
   * contesta a "¿a qué hora llega?" y la única que cuadra con los minutos que
   * hay al lado. Enseñar la programada aquí obligaba a sumarle el retraso
   * mentalmente, y hacía parecer desordenada una lista que no lo estaba: un
   * bus de las 10:48 con 17 minutos de retraso llega antes que el de las
   * 11:05, porque alcanza al siguiente.
   */
  horaLlegada(l: Llegada): string {
    return this.hayEstimacion(l) ? this.hora(l.estimado) : this.hora(l.programado);
  }

  /**
   * Solo se enseña la hora del horario si no es ya la de arriba. Se comparan
   * las horas ya formateadas, no los instantes: un retraso de 20 segundos no
   * mueve el reloj, y repetir "11:05 · programado 11:05" es ruido.
   */
  private repiteProgramado(l: Llegada): boolean {
    return this.hayEstimacion(l) && this.hora(l.estimado) !== this.hora(l.programado);
  }

  /** "programado 10:48 · 17 min tarde", o solo la nota si no hay dos horas. */
  detalle(l: Llegada): string {
    const nota = this.nota(l);
    return this.repiteProgramado(l)
      ? `programado ${this.horaProgramada(l)} · ${nota}`
      : nota;
  }

  horaActualizado(): string {
    const d = this.actualizado();
    return d
      ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
  }
}
