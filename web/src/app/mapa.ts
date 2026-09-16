import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';

/**
 * Radio del encuadre inicial. Un autobús a media hora puede estar al otro lado
 * del área metropolitana, y meterlo en la foto deja la parada en un punto.
 */
const RADIO_ENCUADRE_KM = 3;

/** Distancia en kilómetros, con la fórmula del semiverseno. */
function distanciaKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Un autobús ya cruzado con su llegada: posición, línea y minutos que faltan. */
export interface BusEnMapa {
  tripId: string;
  linea: string;
  minutos: number;
  lat: number;
  lon: number;
}

/**
 * El mapa de "dónde está mi bus".
 *
 * No es el mapa de todos los autobuses de Dublín: son los de ESTA parada, los
 * que se ven en la lista de arriba. Ochocientos puntos de colores no contestan
 * a ninguna pregunta; tres puntos que son los buses que estoy esperando
 * contestan a la única que importa en la marquesina, que es si viene o no.
 *
 * Leaflet se carga aquí y no en el arranque: quien nunca abre el mapa no paga
 * ni el código ni los tiles. En el móvil eso son datos de alguien.
 */
@Component({
  selector: 'app-mapa',
  template: `<div class="lienzo" #lienzo [attr.aria-label]="etiqueta()" role="img"></div>`,
  styles: [
    `
      :host {
        display: block;
      }
      .lienzo {
        height: 16rem;
        border: 3px solid var(--hard);
        box-shadow: 4px 4px 0 var(--hard);
        background: var(--fondo2);
      }
      /* El pin de cada bus: la línea y los minutos, en el mismo pixel-art que
         el resto. Se dibuja con CSS y no con una imagen para que siga leyéndose
         en claro y en oscuro sin dos ficheros. */
      /* Se ancla al punto con un iconSize de cero y se centra desde aquí. Un
         iconSize fijo no vale: cada línea mide distinto ("1" no ocupa lo que
         "L25") y Leaflet calcula el margen con ese número, así que los pines
         se iban del mapa. */
      :host ::ng-deep .pin-bus {
        position: absolute;
        width: max-content;
        transform: translate(-50%, -125%);
        display: flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.1rem 0.25rem;
        border: 2px solid var(--hard);
        background: var(--fondo);
        color: var(--texto);
        font-family: var(--mono);
        font-size: 0.68rem;
        font-weight: 700;
        white-space: nowrap;
        box-shadow: 2px 2px 0 var(--hard);
      }
      :host ::ng-deep .pin-bus .min {
        color: var(--acento);
      }
      :host ::ng-deep .pin-parada {
        width: 0.9rem;
        height: 0.9rem;
        border: 3px solid var(--malo);
        border-radius: 50%;
        background: var(--fondo);
        box-shadow: 0 0 0 2px var(--hard);
      }
      /* Leaflet pinta los tiles con su propio fondo blanco; en tema oscuro
         cantaba. Bajarles el brillo los integra sin cargar otro juego. */
      @media (prefers-color-scheme: dark) {
        :host ::ng-deep .leaflet-tile-pane {
          filter: brightness(0.75) contrast(1.05);
        }
      }
    `,
  ],
})
export class Mapa implements OnDestroy {
  readonly lat = input.required<number>();
  readonly lon = input.required<number>();
  readonly nombreParada = input<string>('');
  readonly buses = input<BusEnMapa[]>([]);
  /** Texto para lectores de pantalla: un mapa sin alternativa no sirve. */
  readonly etiqueta = input<string>('');

  private readonly lienzo = viewChild.required<ElementRef<HTMLDivElement>>('lienzo');

  private mapa: L.Map | null = null;
  private capaBuses: L.LayerGroup | null = null;
  private observador: ResizeObserver | null = null;
  /** Ya se encuadró una vez: después manda el usuario, no el refresco. */
  private encuadrado = false;

  constructor() {
    effect(() => {
      // Leer las señales SIEMPRE, antes de cualquier salida, o el efecto no
      // vuelve a dispararse cuando cambien.
      const lat = this.lat();
      const lon = this.lon();
      const buses = this.buses();
      const el = this.lienzo().nativeElement;

      if (!this.mapa) this.crear(el, lat, lon);
      this.pintar(lat, lon, buses);
    });
  }

  ngOnDestroy(): void {
    this.observador?.disconnect();
    this.observador = null;
    this.mapa?.remove();
    this.mapa = null;
  }

  private crear(el: HTMLElement, lat: number, lon: number): void {
    this.mapa = L.map(el, {
      center: [lat, lon],
      zoom: 15,
      // En el móvil el mapa está dentro de una página que se desplaza: si se
      // queda el dedo, el usuario no puede pasar de él. Con esto el gesto de
      // una sola dirección sigue siendo scroll de la página.
      scrollWheelZoom: false,
      dragging: !L.Browser.mobile,
      attributionControl: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap',
    }).addTo(this.mapa);
    this.capaBuses = L.layerGroup().addTo(this.mapa);

    // Leaflet mide el contenedor al crearse y no vuelve a mirar. El mapa nace
    // dentro de un bloque que se acaba de desplegar, así que esa primera
    // medida se toma a destiempo y los tiles se quedan cubriendo una franja en
    // vez del ancho completo. Con esto se recoloca cada vez que el hueco
    // cambia de tamaño: al abrirlo, al girar el móvil y al cambiar de ancho.
    this.observador = new ResizeObserver(() => this.mapa?.invalidateSize());
    this.observador.observe(el);
  }

  private pintar(lat: number, lon: number, buses: BusEnMapa[]): void {
    const mapa = this.mapa;
    const capa = this.capaBuses;
    if (!mapa || !capa) return;

    capa.clearLayers();

    L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: '<div class="pin-parada"></div>', iconSize: [14, 14] }),
      title: this.nombreParada(),
      // La parada va por debajo de los buses: es el punto fijo, no la noticia.
      zIndexOffset: -100,
    }).addTo(capa);

    for (const b of buses) {
      const minutos = b.minutos <= 0 ? '' : `<span class="min">${b.minutos}'</span>`;
      L.marker([b.lat, b.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="pin-bus">${b.linea}${minutos}</div>`,
          // Cero: el ancho lo pone el contenido y el centrado lo hace el CSS.
          // Ver el comentario del `.pin-bus`.
          iconSize: [0, 0],
        }),
        title: `${b.linea} · ${b.minutos} min`,
      }).addTo(capa);
    }

    // Solo se encuadra la primera vez que hay algo que encuadrar. Si se
    // reencuadrara en cada refresco, el mapa daría un salto cada minuto
    // justo cuando el usuario acaba de moverlo para mirar otra cosa.
    // Las posiciones llegan en otra petición, después de las llegadas: si se
    // diera por encuadrado en el primer pintado —cuando `buses` aún está
    // vacío— el mapa se quedaría centrado en la parada y los autobuses, que
    // llegan un instante después, aparecerían fuera de la vista.
    if (!this.encuadrado && buses.length) {
      // Encuadrar con TODOS los buses enseñaba medio condado: un bus a 25
      // minutos puede estar en Blanchardstown, y por meterlo en la foto la
      // parada quedaba en un pixel. Manda el que está a punto de llegar, que
      // es a quien se mira; los lejanos siguen en el mapa, solo que fuera del
      // encuadre inicial hasta que el usuario se aleje.
      const cerca = buses.filter((b) => distanciaKm(lat, lon, b.lat, b.lon) <= RADIO_ENCUADRE_KM);
      if (cerca.length) {
        const limites = L.latLngBounds([
          [lat, lon],
          ...cerca.map((b) => [b.lat, b.lon] as [number, number]),
        ]);
        // Sin animación: Leaflet escala el contenedor de tiles mientras dura
        // la transición de zoom, y si algo la interrumpe —un invalidateSize
        // del observador, por ejemplo— se queda congelada a medias. Se veía
        // como una franja de mapa con el resto en gris, y los tiles del nivel
        // nuevo no llegaban a pedirse.
        mapa.fitBounds(limites, { padding: [35, 35], maxZoom: 16, animate: false });
      } else {
        // Todos lejos: la parada mandando, y el usuario que se aleje si quiere.
        mapa.setView([lat, lon], 14, { animate: false });
      }
      this.encuadrado = true;
    }
  }
}
