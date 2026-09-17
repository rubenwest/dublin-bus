import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import {
  Api,
  Fiabilidad,
  Llegada,
  Llegadas,
  Parada,
  SentidoLinea,
  TrazadosLinea,
  Vehiculo,
} from './api';
import { BusEnMapa, Mapa } from './mapa';
import { MapaLineas, TrazadoLinea } from './mapa-lineas';
import { entorno } from './entorno';
import { Idioma, traducir } from './i18n';

/** Estado del envío de feedback, para no repetir strings sueltos por ahí. */
type EnvioFeedback = 'inactivo' | 'enviando' | 'enviado' | 'error';

const CLAVE_ULTIMA = 'dublin-bus.ultima-parada';
const CLAVE_LINEAS = 'dublin-bus.lineas';
const CLAVE_FAV = 'dublin-bus.favoritas';
const CLAVE_IDIOMA = 'dublin-bus.idioma';
const CLAVE_MAPA = 'dublin-bus.mapa';
const CLAVE_VISTA_LINEAS = 'dublin-bus.vista-lineas';

/**
 * Los colores del mapa de la red, y son seis a propósito.
 *
 * El color es de la selección, no de la línea: 154 líneas no admiten 154
 * colores que alguien pueda separar de un vistazo, pero seis sobre una red en
 * gris se leen sin esfuerzo. Seis es además donde está el límite de verdad —
 * con ocho ya hay dos que discuten—, así que el tope de la selección no es una
 * limitación técnica sino la misma razón.
 *
 * Ni rojo ni verde puros: los tiene la Luas y ahí el color es parte del nombre
 * de la línea. Ver COLOR_FIJO.
 */
const PALETA_MAPA = ['#1f6feb', '#e8590c', '#9c36b5', '#0c8599', '#c2255c', '#b8860b'];

/** Las dos líneas que ya vienen con color puesto. Dibujar la Red en naranja
 *  sería contradecir su propio nombre. */
const COLOR_FIJO: Record<string, string> = { Red: '#e23b3b', Green: '#16b34a' };

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

/** Recuerda que ya se concedió la ubicación, para localizar sin volver a pedir. */
const CLAVE_GEO = 'dublin-bus.geo-ok';
/** Cuántas paradas cercanas se pintan en el radar y su lista. */
const RADAR_CERCANAS = 6;
/** Radio del área del radar en el SVG (viewBox 300, centro 150). */
const RADAR_MAX_R = 118;

/** Distancia en metros entre dos puntos (haversine). */
function distanciaMetros(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Rumbo en grados desde el punto 1 hacia el 2: 0 = norte, sentido horario. */
function rumboGrados(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLon = rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  imports: [Mapa, MapaLineas],
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

  /**
   * Lo que el histórico sabe de esta parada, por (línea, franja horaria).
   * Vacío mientras no haya muestra: hoy solo se recolecta en tres paradas.
   */
  readonly fiabilidad = signal<Fiabilidad[]>([]);

  /** Posiciones GPS de los buses que vienen. Se piden con cada refresco. */
  readonly vehiculos = signal<Vehiculo[]>([]);
  /**
   * El mapa arranca plegado y se recuerda la elección. Desplegado descarga
   * tiles de OpenStreetMap con cada movimiento, y eso son datos del usuario:
   * que lo abra quien lo quiera, no todo el que consulte una parada.
   */
  readonly mapaAbierto = signal(this.mapaGuardado());
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);
  /**
   * El último refresco falló. No es lo mismo que `error`: aquí SÍ hay datos en
   * pantalla, solo que son de antes. Sin esto, quien entra en el metro se
   * quedaba mirando "Cargando" para siempre sin saber que lo que ve es viejo.
   */
  readonly sinConexion = signal(false);
  readonly actualizado = signal<Date | null>(null);

  /** Ubicación del usuario, si la ha compartido. Solo alimenta "cerca de ti". */
  readonly ubicacion = signal<{ lat: number; lon: number } | null>(null);
  /** En qué punto está la petición de geolocalización. */
  readonly estadoGeo = signal<
    'inicial' | 'pidiendo' | 'ok' | 'denegado' | 'no-soportado' | 'error'
  >('inicial');

  /**
   * Cómo elige parada quien entra: por cercanía (radar) o buscando por nombre.
   * Arranca en 'buscar' a propósito, para no plantar el radar en la cara nada
   * más abrir; el radar se ve al tocar su pestaña.
   */
  readonly modo = signal<'cerca' | 'buscar' | 'lineas'>('buscar');

  /** Línea abierta en el explorador de recorridos de la pantalla inicial. */
  readonly lineaActiva = signal<string | null>(null);
  readonly busquedaLinea = signal('');
  readonly sentidos = signal<SentidoLinea[]>([]);
  readonly sentidoActivo = signal(0);
  readonly cargandoLinea = signal(false);
  readonly errorLinea = signal<string | null>(null);

  /**
   * El explorador enseña la misma línea de dos maneras: la lista de chips de
   * siempre y el mapa de la red. Se recuerda la elección porque quien ha
   * venido a mirar la red va a volver a mirarla.
   */
  readonly vistaLineas = signal<'lista' | 'mapa'>(this.vistaLineasGuardada());
  /** La geometría de `trazados-linea.json`. Se pide al abrir el mapa, no antes. */
  readonly trazados = signal<TrazadosLinea | null>(null);
  readonly cargandoRed = signal(false);
  readonly errorRed = signal<string | null>(null);
  /**
   * La selección del mapa, por huecos de color. Un array de posiciones fijas y
   * no una lista: si fuera una lista, quitar la primera línea le cambiaría el
   * color a todas las demás justo cuando el usuario las está comparando.
   */
  readonly huecosMapa = signal<(string | null)[]>(PALETA_MAPA.map(() => null));
  /** Se ha intentado elegir una séptima línea. Se avisa en vez de no hacer nada. */
  readonly topeMapa = signal(false);

  /** Idioma de la interfaz. Se cambia en caliente desde las banderas de arriba. */
  readonly lang = signal<Idioma>(this.idiomaInicial());

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
            (p.codigo?.toLowerCase().includes(q) ?? false) ||
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

  /** Catálogo único de líneas presentes en las paradas que ya tienen tiempos. */
  readonly lineasTodas = computed(() =>
    [...new Set(this.paradas().flatMap((p) => p.lineas))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
  );

  /** El catálogo recortado por lo que se haya escrito en el buscador. */
  readonly lineasCatalogo = computed(() => {
    const q = normaliza(this.busquedaLinea().trim());
    const todas = this.lineasTodas();
    return q ? todas.filter((linea) => normaliza(linea).includes(q)) : todas;
  });

  // --- Mapa de la red -------------------------------------------------------

  /** Las líneas elegidas en el mapa, en el orden de sus huecos de color. */
  readonly lineasMapa = computed(() =>
    this.huecosMapa().filter((l): l is string => l !== null),
  );

  /**
   * La geometría que se le da al mapa: TODAS las líneas del catálogo que la
   * tengan. Las no elegidas no se quitan —se pintan en gris— porque son las
   * que dan la forma de la red y son también lo que se puede tocar para
   * elegirlas.
   *
   * No depende de la selección a propósito: así el mapa construye sus
   * polilíneas una vez y elegir una línea sólo les cambia el estilo.
   */
  readonly trazadosMapa = computed<TrazadoLinea[]>(() => {
    const geo = this.trazados();
    if (!geo) return [];
    return this.lineasTodas().flatMap((linea) => {
      const trazos = geo[linea];
      return trazos?.length ? [{ linea, trazos }] : [];
    });
  });

  /** El color de cada línea elegida, que es lo único que cambia al tocar. */
  readonly coloresMapa = computed<Record<string, string>>(() => {
    const colores: Record<string, string> = {};
    this.huecosMapa().forEach((linea, hueco) => {
      if (linea) colores[linea] = COLOR_FIJO[linea] ?? PALETA_MAPA[hueco];
    });
    return colores;
  });

  /**
   * Los chips de la leyenda. Las elegidas van primero y siempre, aunque el
   * buscador las excluya: si no, escribir "39" después de elegir el 14 dejaba
   * el 14 pintado en el mapa y sin manera de soltarlo.
   */
  readonly leyendaMapa = computed(() => {
    const elegidas = this.lineasMapa();
    const resto = this.lineasCatalogo().filter((l) => !elegidas.includes(l));
    return [...elegidas, ...resto];
  });

  /** Cuántas del catálogo se quedan fuera del mapa por no tener trazado. */
  readonly lineasSinTrazado = computed(() => {
    const geo = this.trazados();
    if (!geo) return 0;
    return this.lineasTodas().filter((l) => !geo[l]?.length).length;
  });

  /** Los ids del recorrido se enlazan con el catálogo cargado y seleccionable. */
  readonly sentidosConParadas = computed(() => {
    const porId = new Map(this.paradas().map((p) => [p.id, p]));
    return this.sentidos()
      .map((sentido) => ({
        ...sentido,
        paradas: sentido.paradas.map((id) => porId.get(id)).filter((p): p is Parada => !!p),
      }))
      .filter((sentido) => sentido.paradas.length);
  });

  /** En móvil se enseña un sentido cada vez para que los nombres sigan leyendo bien. */
  readonly sentidoVisible = computed(() => {
    const sentidos = this.sentidosConParadas();
    return sentidos[this.sentidoActivo()] ?? sentidos[0] ?? null;
  });

  /**
   * Las paradas más cercanas a la ubicación, con su distancia y rumbo ya
   * calculados. Vacío si aún no hay ubicación. Solo entran las que tienen
   * coordenadas; el catálogo las trae casi todas.
   */
  readonly cercanas = computed(() => {
    const u = this.ubicacion();
    if (!u) return [];
    return this.paradas()
      .filter((p) => p.lat != null && p.lon != null)
      .map((p) => ({
        parada: p,
        metros: distanciaMetros(u.lat, u.lon, p.lat!, p.lon!),
        rumbo: rumboGrados(u.lat, u.lon, p.lat!, p.lon!),
      }))
      .sort((a, b) => a.metros - b.metros)
      .slice(0, RADAR_CERCANAS);
  });

  /**
   * Radio que abarca el radar, en metros: la más lejana de las mostradas,
   * redondeada a la centena y con un mínimo de 300 m para que de pie a una
   * parada no salga todo pegado al centro.
   */
  readonly radioMetros = computed(() => {
    const c = this.cercanas();
    if (!c.length) return 300;
    return Math.max(300, Math.ceil(c[c.length - 1].metros / 100) * 100);
  });

  /** Posición y color de cada parada cercana dentro del SVG del radar. */
  readonly radarBlips = computed(() => {
    const radio = this.radioMetros();
    return this.cercanas().map((c, i) => {
      const rr = Math.min(c.metros / radio, 1) * RADAR_MAX_R;
      const a = (c.rumbo * Math.PI) / 180;
      return {
        x: +(150 + rr * Math.sin(a)).toFixed(1),
        y: +(150 - rr * Math.cos(a)).toFixed(1),
        color: this.esTram(c.parada) ? this.colorLuas(c.parada) : 'bus',
        n: i + 1,
      };
    });
  });

  // --- Feedback -------------------------------------------------------------

  /** El panel de feedback está abierto. */
  readonly feedbackAbierto = signal(false);
  readonly feedbackTexto = signal('');
  readonly feedbackContacto = signal('');
  readonly feedbackEstado = signal<EnvioFeedback>('inactivo');

  /**
   * Enlace `wa.me` con un saludo prerrellenado. Se abre en la app de WhatsApp.
   * El saludo va en el idioma de la interfaz.
   */
  readonly whatsappUrl = computed(
    () =>
      `https://wa.me/${entorno.whatsapp}?text=${encodeURIComponent(this.t('feedback_saludo_wa'))}`,
  );

  private temporizador: ReturnType<typeof setInterval> | null = null;
  private comprobarVersion: ReturnType<typeof setInterval> | null = null;

  private readonly visibilidad = () => this.alCambiarVisibilidad();

  constructor() {
    void this.cargarParadas();
    this.vigilarActualizaciones();
    document.addEventListener('visibilitychange', this.visibilidad);
    // Si ya dio permiso en una visita anterior, localizar sin volver a pedir:
    // así "cerca de ti" es de verdad la pantalla de inicio y no un botón más.
    if (this.geoConcedidoAntes()) this.ubicar();
  }

  ngOnDestroy(): void {
    this.pararRefresco();
    document.removeEventListener('visibilitychange', this.visibilidad);
    if (this.comprobarVersion) clearInterval(this.comprobarVersion);
  }

  // --- Idioma ---------------------------------------------------------------

  /** Traduce una clave al idioma actual, sustituyendo `{x}` por `params`. */
  t(clave: string, params?: Record<string, string | number>): string {
    return traducir(this.lang(), clave, params);
  }

  cambiarIdioma(l: Idioma): void {
    this.lang.set(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem(CLAVE_IDIOMA, l);
    } catch {
      /* modo privado: no se recuerda, se vuelve a elegir la próxima vez */
    }
  }

  /** Idioma guardado; si no hay, el del navegador (es → español, si no inglés). */
  private idiomaInicial(): Idioma {
    try {
      const g = localStorage.getItem(CLAVE_IDIOMA);
      if (g === 'es' || g === 'en') return g;
    } catch {
      /* sin localStorage: se cae al idioma del navegador */
    }
    return (navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
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
      this.error.set(this.t('err_cargar_paradas'));
    } finally {
      this.cargando.set(false);
    }
  }

  seleccionar(p: Parada): void {
    this.parada.set(p);
    this.datos.set(null);
    this.sinConexion.set(false);
    this.cargarFiabilidad(p.id);
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
    this.fiabilidad.set([]);
    this.sinConexion.set(false);
    this.vehiculos.set([]);
    this.error.set(null);
    this.lineasElegidas.set([]);
    this.sinTope.set(false);
    localStorage.removeItem(CLAVE_ULTIMA);
  }

  /** Vuelve al inicio completo, cerrando también un recorrido abierto. */
  irInicio(): void {
    this.volver();
    this.cerrarLinea();
  }

  verLineas(): void {
    this.modo.set('lineas');
    if (this.vistaLineas() === 'mapa') void this.cargarTrazados();
  }

  /** Cambia entre la lista de chips y el mapa de la red. */
  verVistaLineas(vista: 'lista' | 'mapa'): void {
    this.vistaLineas.set(vista);
    try {
      localStorage.setItem(CLAVE_VISTA_LINEAS, vista);
    } catch {
      /* modo privado: se vuelve a elegir la próxima vez */
    }
    if (vista === 'mapa') void this.cargarTrazados();
  }

  private vistaLineasGuardada(): 'lista' | 'mapa' {
    try {
      return localStorage.getItem(CLAVE_VISTA_LINEAS) === 'mapa' ? 'mapa' : 'lista';
    } catch {
      return 'lista';
    }
  }

  /**
   * Trae la geometría la primera vez que hace falta. Son 800 KB: el que entra a
   * mirar los minutos de su parada no los paga, y el que abre el mapa los paga
   * una vez porque la promesa se queda cacheada en `Api`.
   */
  private async cargarTrazados(): Promise<void> {
    if (this.trazados() || this.cargandoRed()) return;
    this.errorRed.set(null);
    this.cargandoRed.set(true);
    try {
      this.trazados.set(await this.api.trazados());
    } catch {
      this.errorRed.set(this.t('err_cargar_red'));
    } finally {
      this.cargandoRed.set(false);
    }
  }

  /** El color con el que se pinta una línea, o `null` si no está elegida. */
  colorDeLinea(linea: string): string | null {
    return this.coloresMapa()[linea] ?? null;
  }

  /** Una línea del catálogo sin trazado no se puede pintar; el chip se apaga. */
  hayTrazado(linea: string): boolean {
    return !!this.trazados()?.[linea]?.length;
  }

  /**
   * Elige o suelta una línea en el mapa. Al soltarla su hueco de color queda
   * libre y las demás no se mueven, que es lo que se está comparando.
   */
  alternarLineaMapa(linea: string): void {
    if (!this.hayTrazado(linea)) return;
    const huecos = [...this.huecosMapa()];
    const puesto = huecos.indexOf(linea);
    if (puesto >= 0) {
      huecos[puesto] = null;
      this.topeMapa.set(false);
    } else {
      const libre = huecos.indexOf(null);
      if (libre < 0) {
        this.topeMapa.set(true);
        return;
      }
      huecos[libre] = linea;
    }
    this.huecosMapa.set(huecos);
  }

  limpiarMapa(): void {
    this.huecosMapa.set(PALETA_MAPA.map(() => null));
    this.topeMapa.set(false);
  }

  /**
   * Del recorrido vertical al mapa, con la línea ya resaltada.
   *
   * El camino sólo iba en un sentido: del mapa se entraba a las paradas, pero
   * de las paradas no se volvía al trazado sin salir al catálogo y elegir otra
   * vez la línea. Parecía que el mapa había desaparecido.
   *
   * Hay que esperar a la geometría antes de elegir: si se acaba de entrar por
   * aquí, `trazados` todavía no está y `alternarLineaMapa` no haría nada.
   */
  async verEnMapa(linea: string): Promise<void> {
    this.cerrarLinea();
    this.verVistaLineas('mapa');
    await this.cargarTrazados();
    if (!this.hayTrazado(linea) || this.colorDeLinea(linea)) return;

    const huecos = [...this.huecosMapa()];
    const libre = huecos.indexOf(null);
    // Con los seis ocupados se pisa el último en vez de avisar del tope: quien
    // pulsa "ver en el mapa" ha pedido ESTA línea, y llegar al mapa sin ella
    // es el mismo desconcierto que veníamos a arreglar.
    huecos[libre >= 0 ? libre : huecos.length - 1] = linea;
    this.huecosMapa.set(huecos);
    this.topeMapa.set(false);
  }

  verBuscar(): void {
    this.cerrarLinea();
    this.modo.set('buscar');
  }

  volverAListaLineas(): void {
    this.volver();
    this.cerrarLinea();
  }

  async abrirLinea(linea: string): Promise<void> {
    this.lineaActiva.set(linea);
    this.sentidoActivo.set(0);
    this.sentidos.set([]);
    this.errorLinea.set(null);
    this.cargandoLinea.set(true);
    try {
      this.sentidos.set(await this.api.sentidosLinea(linea));
    } catch {
      this.errorLinea.set(this.t('err_cargar_linea'));
    } finally {
      this.cargandoLinea.set(false);
    }
  }

  cerrarLinea(): void {
    this.lineaActiva.set(null);
    this.sentidoActivo.set(0);
    this.sentidos.set([]);
    this.errorLinea.set(null);
  }

  destinoSentido(sentido: { paradas: Parada[] }): string {
    return sentido.paradas.at(-1)?.nombre ?? this.t('destino_desconocido');
  }

  codigoVisible(p: Parada): string {
    return p.codigo ?? p.id;
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
   * El Luas se llama por colores (Red, Green), así que el punto del radar toma
   * el color de su línea en vez del magenta genérico. Un intercambiador que
   * sirve las dos se pinta 'both' (magenta), que es justo "las dos".
   */
  private colorLuas(p: Parada): 'green' | 'red' | 'both' {
    const l = p.lineas.map((x) => x.toLowerCase());
    const red = l.includes('red');
    const green = l.includes('green');
    if (red && green) return 'both';
    return red ? 'red' : 'green';
  }

  // --- Cerca de ti (geolocalización) ---------------------------------------

  /** Abre la pestaña del radar y localiza (si no lo está ya). */
  verCerca(): void {
    this.cerrarLinea();
    this.modo.set('cerca');
    if (this.estadoGeo() !== 'ok') this.ubicar();
  }

  private geoConcedidoAntes(): boolean {
    try {
      return localStorage.getItem(CLAVE_GEO) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Pide la ubicación y ordena las paradas por cercanía. Bajo demanda (o
   * automático si ya se concedió), nunca al primer arranque sin permiso: un
   * prompt del navegador en frío ahuyenta. Norte siempre arriba; la brújula
   * del móvil pide su propio permiso y se deja para más adelante.
   */
  ubicar(): void {
    if (!('geolocation' in navigator)) {
      this.estadoGeo.set('no-soportado');
      return;
    }
    this.estadoGeo.set('pidiendo');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.ubicacion.set({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        this.estadoGeo.set('ok');
        try {
          localStorage.setItem(CLAVE_GEO, '1');
        } catch {
          /* modo privado: no se recuerda, se volverá a pulsar el botón */
        }
      },
      (err) => {
        this.estadoGeo.set(err.code === err.PERMISSION_DENIED ? 'denegado' : 'error');
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  /** "450 m" cerca, "1.2 km" lejos. */
  distanciaTexto(metros: number): string {
    return metros < 1000 ? `${Math.round(metros)} m` : `${(metros / 1000).toFixed(1)} km`;
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
    if (this.sinTope()) return this.t('ver_solo_proximas');
    const n = this.recortadas();
    return n === 1 ? this.t('ver_una_mas') : this.t('ver_n_mas', { n });
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
        this.error.set(this.t('err_sin_datos_parada'));
      } else {
        this.datos.set(d);
        this.actualizado.set(new Date());
        this.sinConexion.set(false);
        void this.cargarVehiculos();
      }
    } catch {
      // Si ya hay llegadas en pantalla no se borran por un fallo de red: unos
      // horarios de hace dos minutos, avisando de que lo son, valen más que una
      // pantalla de error. Solo se corta del todo cuando no hay nada que dar.
      if (this.datos()) this.sinConexion.set(true);
      else this.error.set(this.t('err_servidor'));
    } finally {
      this.cargando.set(false);
    }
  }

  /**
   * El refresco solo corre con la pestaña delante. En el bolsillo, una pantalla
   * abierta seguía pidiendo llegadas cada pocos segundos: batería y datos del
   * usuario gastados en algo que nadie está mirando.
   *
   * Al volver se refresca de inmediato, porque lo que quedó en pantalla es de
   * cuando se guardó el móvil y puede ser de hace una hora.
   */
  private arrancarRefresco(): void {
    this.pararRefresco();
    if (document.visibilityState === 'hidden') return;
    this.temporizador = setInterval(() => void this.refrescar(), entorno.refrescoMs);
  }

  private alCambiarVisibilidad(): void {
    if (!this.parada()) return;
    if (document.visibilityState === 'visible') {
      void this.refrescar();
      this.arrancarRefresco();
    } else {
      this.pararRefresco();
    }
  }

  private pararRefresco(): void {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
  }

  /**
   * El histórico va aparte del refresco de llegadas y no lo bloquea: son datos
   * de semanas, y si fallan la pantalla sigue dando los minutos de siempre.
   */
  private cargarFiabilidad(stopId: string): void {
    this.fiabilidad.set([]);
    this.api
      .fiabilidad(stopId)
      .then((filas) => {
        // Puede haber cambiado de parada mientras se pedía.
        if (this.parada()?.id === stopId) this.fiabilidad.set(filas);
      })
      .catch(() => this.fiabilidad.set([]));
  }

  /** Índice por línea y franja, que es como se consulta al pintar cada fila. */
  private readonly celdas = computed(() => {
    const m = new Map<string, Fiabilidad>();
    for (const f of this.fiabilidad()) m.set(`${f.linea}|${f.franjaHora}`, f);
    return m;
  });

  /**
   * La franja es la de la hora a la que LLEGA el bus, no la actual: quien mira
   * a las 17:58 un bus de las 18:03 quiere saber cómo va la franja de las 18.
   */
  private franjaDe(l: Llegada): number {
    const iso = this.hayEstimacion(l) ? l.estimado : l.programado;
    return Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Dublin',
        hour: 'numeric',
        hour12: false,
      }).format(new Date(iso)),
    );
  }

  /**
   * La celda aplicable a una llegada, si la hay. Una parada saltada o un viaje
   * cancelado no llegan a ninguna hora: ahí el sesgo no significa nada.
   */
  celda(l: Llegada): Fiabilidad | null {
    if (l.estado === 'SALTADA' || l.estado === 'CANCELADO') return null;
    return this.celdas().get(`${l.linea}|${this.franjaDe(l)}`) ?? null;
  }

  /**
   * La frase que da sentido al proyecto: no "faltan 5 minutos" —eso ya lo dice
   * la app oficial— sino cuánto se suele equivocar ese 5.
   *
   * Se redondea al minuto porque es la unidad en la que se enseña todo lo
   * demás, y por debajo de medio minuto se dice que acierta: anunciar "+0,4
   * min tarde" es ruido disfrazado de precisión.
   */
  bandaFiabilidad(l: Llegada): string | null {
    const c = this.celda(l);
    if (!c || !this.primeraDeSuCelda(l)) return null;
    const m = Math.round(c.sesgoMin);
    return m === 0
      ? this.t('fiab_acierta')
      : m > 0
        ? this.t('fiab_tarde', { m })
        : this.t('fiab_pronto', { m: Math.abs(m) });
  }

  /**
   * De qué tamaño es la muestra, al pasar el ratón. Fuera de la línea a
   * propósito: en un móvil de 375 px "28 buses, 4 días" ocupaba un renglón
   * entero de los cuatro que ya gastaba la frase.
   */
  detalleBanda(l: Llegada): string {
    const c = this.celda(l);
    return c ? this.t('fiab_muestra', { n: c.n, dias: c.dias }) : '';
  }

  /**
   * La banda se dice una vez por (línea, franja), no en cada fila. Tres E2
   * seguidos comparten celda y repetían la misma frase tres veces: la misma
   * información, tres veces el ruido.
   */
  private primeraDeSuCelda(l: Llegada): boolean {
    return this.primerasConBanda().has(l.tripId + l.programado);
  }

  private readonly primerasConBanda = computed(() => {
    const vistas = new Set<string>();
    const filas = new Set<string>();
    for (const l of this.llegadasVisibles()) {
      const c = this.celda(l);
      if (!c) continue;
      const clave = `${c.linea}|${c.franjaHora}`;
      if (vistas.has(clave)) continue;
      vistas.add(clave);
      filas.add(l.tripId + l.programado);
    }
    return filas;
  });

  /** Para pintar en rojo solo lo que de verdad se desvía. */
  bandaDesvia(l: Llegada): boolean {
    const c = this.celda(l);
    return !!c && Math.abs(Math.round(c.sesgoMin)) >= 2;
  }

  /** Si ninguna fila tiene banda, no se enseña la explicación al pie. */
  readonly hayFiabilidad = computed(() =>
    this.llegadasVisibles().some((l) => this.celda(l) !== null),
  );

  /**
   * Los buses que se pintan: los de la lista de arriba que además emiten
   * posición. Medido sobre el feed real, son unos seis de cada diez; el resto
   * no aparece en el mapa y no se puede hacer nada, Vehicles no los trae.
   */
  readonly busesEnMapa = computed<BusEnMapa[]>(() => {
    const pos = new Map(this.vehiculos().map((v) => [v.tripId, v]));
    return this.llegadasVisibles()
      // Un viaje cancelado o una parada saltada no son un bus que venga a
      // recogerte: pintarlos sería la misma mentira que en la lista.
      .filter((l) => l.estado !== 'CANCELADO' && l.estado !== 'SALTADA')
      .flatMap((l) => {
        const v = pos.get(l.tripId);
        return v ? [{ tripId: l.tripId, linea: l.linea, minutos: l.minutos, lat: v.lat, lon: v.lon }] : [];
      });
  });

  /** Sin coordenadas de la parada no hay dónde centrar: no se ofrece el mapa. */
  readonly hayMapa = computed(() => {
    const p = this.datos()?.parada ?? this.parada();
    return p?.lat != null && p?.lon != null;
  });

  readonly textoMapa = computed(() =>
    this.mapaAbierto() ? this.t('ocultar_mapa') : this.t('ver_mapa'),
  );

  /**
   * Cuántos de los que vienen salen en el mapa. Se dice en pantalla porque si
   * no, faltar la mitad parece un fallo: es el feed, que viene así.
   */
  readonly notaMapa = computed(() =>
    this.t('mapa_de_n', {
      n: this.busesEnMapa().length,
      total: this.llegadasVisibles().filter(
        (l) => l.estado !== 'CANCELADO' && l.estado !== 'SALTADA',
      ).length,
    }),
  );

  alternarMapa(): void {
    const abierto = !this.mapaAbierto();
    this.mapaAbierto.set(abierto);
    try {
      localStorage.setItem(CLAVE_MAPA, abierto ? '1' : '0');
    } catch {
      /* modo privado: se vuelve a elegir la próxima vez */
    }
    if (abierto) void this.cargarVehiculos();
  }

  private mapaGuardado(): boolean {
    try {
      return localStorage.getItem(CLAVE_MAPA) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Las posiciones solo se piden con el mapa abierto: es una consulta más por
   * refresco y no tiene sentido pagarla para no enseñarla.
   */
  private async cargarVehiculos(): Promise<void> {
    if (!this.mapaAbierto()) return;
    const trips = this.llegadasVisibles().map((l) => l.tripId);
    try {
      this.vehiculos.set(await this.api.vehiculos(trips));
    } catch {
      // El mapa se queda con las posiciones anteriores. Es un extra: que falle
      // no puede llevarse por delante los minutos, que es lo que importa.
    }
  }

  // --- Presentación ---------------------------------------------------------

  cuando(l: Llegada): string {
    if (l.estado === 'SALTADA') return this.t('no_para');
    if (l.estado === 'CANCELADO') return '--';
    if (l.minutos <= 0) return this.t('ya');
    return String(l.minutos);
  }

  /** Solo se pone unidad cuando el texto es un número. */
  unidad(l: Llegada): string {
    return l.estado === 'SALTADA' || l.estado === 'CANCELADO' || l.minutos <= 0
      ? ''
      : this.t('min');
  }

  nota(l: Llegada): string {
    switch (l.estado) {
      case 'SALTADA':
        return this.t('nota_saltada');
      case 'CANCELADO':
        return this.t('nota_cancelado');
      case 'SIN_DATOS':
        return this.t('nota_sin_datos');
      case 'SOLO_HORARIO':
        return this.t('nota_solo_horario');
    }
    const m = this.minutosRetraso(l);
    if (m === 0) return this.t('en_hora');
    return m > 0 ? this.t('min_tarde', { m }) : this.t('min_adelantado', { m: Math.abs(m) });
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
      ? this.t('programado', { hora: this.horaProgramada(l), nota })
      : nota;
  }

  horaActualizado(): string {
    const d = this.actualizado();
    return d
      ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
  }

  // --- Feedback -------------------------------------------------------------

  alternarFeedback(): void {
    this.feedbackAbierto.update((v) => !v);
    // Al reabrir tras un envío correcto, se empieza de cero.
    if (this.feedbackAbierto() && this.feedbackEstado() === 'enviado') {
      this.feedbackEstado.set('inactivo');
    }
  }

  /** Se envía si hay texto y no hay un envío en curso. */
  puedeEnviarFeedback(): boolean {
    return this.feedbackTexto().trim().length > 0 && this.feedbackEstado() !== 'enviando';
  }

  async enviarFeedback(): Promise<void> {
    if (!this.puedeEnviarFeedback()) return;
    this.feedbackEstado.set('enviando');
    try {
      await this.api.enviarFeedback(
        this.feedbackTexto().trim(),
        this.feedbackContacto(),
        this.parada()?.id,
      );
      this.feedbackEstado.set('enviado');
      this.feedbackTexto.set('');
      this.feedbackContacto.set('');
    } catch {
      this.feedbackEstado.set('error');
    }
  }
}
