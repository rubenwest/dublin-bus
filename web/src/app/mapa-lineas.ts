import {
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';

/** La geometría de una línea: uno o varios trazos de puntos [lat, lon]. */
export interface TrazadoLinea {
  linea: string;
  trazos: [number, number][][];
}

/** Encuadre de reserva: el centro de Dublín, cuando no hay nada elegido. */
const DUBLIN: L.LatLngBoundsExpression = [
  [53.32, -6.34],
  [53.39, -6.18],
];

/**
 * El mapa de la red.
 *
 * Es la versión geográfica del explorador de líneas: lo mismo que el recorrido
 * vertical, pero por dónde pasa de verdad. El trazado sale de `shapes.txt` del
 * estático, así que son las calles reales y no un esquema dibujado a mano.
 *
 * La idea de fondo, y lo que hace que funcione: **el color es de la selección,
 * no de la línea.** Ciento cincuenta y cuatro líneas no admiten ciento
 * cincuenta y cuatro colores distinguibles —a partir de seis o siete ya nadie
 * separa uno de otro—, pero seis elegidas sobre una red en gris se leen sin
 * esfuerzo. Por eso lo no elegido no desaparece: sigue ahí, tenue, dando la
 * forma de la red y sirviendo de mapa base.
 *
 * Detalles que no son cosméticos:
 *
 * - **`preferCanvas`.** Son 348 recorridos y ~41.000 puntos. Con el renderer
 *   SVG por defecto eso son 348 nodos en el DOM con miles de vértices cada
 *   uno, y el paneo en un móvil se arrastra. En canvas es un solo elemento.
 * - **Los trazos de fondo también reciben clic.** El mapa es su propia
 *   leyenda: tocar una línea gris la elige, tocarla otra vez la suelta. Sin
 *   eso habría que buscarla en una lista de 154 chips para resaltar la que ya
 *   tienes debajo del dedo.
 * - **`animate: false` en `fitBounds`**, por lo mismo que en el otro mapa:
 *   Leaflet escala el contenedor de tiles durante la transición y si algo la
 *   interrumpe se queda congelada a medias, con el mapa en una franja.
 */
@Component({
  selector: 'app-mapa-lineas',
  template: `
    <div class="lienzo" #lienzo [attr.aria-label]="etiqueta()" role="img"></div>
    @if (esMovil) {
      <button type="button" class="candado" [attr.aria-pressed]="arrastre()" (click)="alternarArrastre()">
        {{ arrastre() ? etiquetaBloquear() : etiquetaMover() }}
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .candado {
        margin-top: 0.5rem;
        width: 100%;
        font-family: var(--mono);
        font-size: 0.8rem;
      }
      .lienzo {
        height: 22rem;
        border: 3px solid var(--hard);
        box-shadow: 4px 4px 0 var(--hard);
        background: var(--fondo2);
      }
      :host ::ng-deep .leaflet-container {
        cursor: default;
      }
      :host ::ng-deep .leaflet-interactive {
        cursor: pointer;
      }
      /* La base tiene que sostener los trazados, no competir con ellos: gris,
         desvaída y sin color que discuta con los seis de la selección. El
         filtro va SOLO sobre el panel de teselas, que en Leaflet es hermano
         del de los trazados, así que los colores de encima no se tocan.

         Se hace aquí y no cambiando de proveedor porque los mapas claros de
         CARTO y de Stadia piden API key desde hace un tiempo: el primer
         intento salió con "API KEY REQUIRED" estampado por encima. Con esto la
         única fuente de teselas del proyecto sigue siendo OpenStreetMap. */
      :host ::ng-deep .leaflet-tile-pane {
        filter: grayscale(1) contrast(0.55) brightness(1.25);
      }
      /* En oscuro se invierte: el gris claro se vuelve gris oscuro y la
         cartografía sale legible de las mismas teselas. El grayscale va antes
         del invert para no acabar con parques magenta y agua naranja. */
      @media (prefers-color-scheme: dark) {
        :host ::ng-deep .leaflet-tile-pane {
          filter: grayscale(1) invert(1) brightness(0.42) contrast(0.68);
        }
      }
    `,
  ],
})
export class MapaLineas implements OnDestroy {
  /**
   * La geometría, que no cambia nunca una vez cargada, y los colores, que
   * cambian a cada toque. Van en dos entradas separadas justamente por eso:
   * juntas, cada vez que alguien elegía una línea había que tirar las 776
   * polilíneas y volver a construirlas. Así los objetos se crean una vez y un
   * toque sólo les cambia el estilo.
   */
  readonly trazados = input<TrazadoLinea[]>([]);
  readonly colores = input<Record<string, string>>({});
  /** Texto para lectores de pantalla: un mapa sin alternativa no sirve. */
  readonly etiqueta = input<string>('');
  /** Tocar un trazado equivale a tocar su chip en la leyenda. */
  readonly alternar = output<string>();
  readonly etiquetaMover = input<string>('');
  readonly etiquetaBloquear = input<string>('');

  /**
   * En el móvil el mapa vive dentro de una página que se desplaza: si se queda
   * el dedo, no se puede pasar de él. El otro mapa lo resuelve desactivando el
   * arrastre y ya está, pero aquí el mapa es toda la red y no poder moverlo lo
   * deja en la mitad de lo que es. Así que arranca bloqueado —el dedo desplaza
   * la página— y hay un botón para soltarlo. Dos estados dichos en pantalla,
   * que es mejor que un gesto que hay que adivinar.
   */
  readonly esMovil = L.Browser.mobile;
  readonly arrastre = signal(false);

  private readonly lienzo = viewChild.required<ElementRef<HTMLDivElement>>('lienzo');

  private mapa: L.Map | null = null;
  private lienzoTrazos: L.Canvas | null = null;
  private capa: L.LayerGroup | null = null;
  private observador: ResizeObserver | null = null;
  private oscuro: MediaQueryList | null = null;
  private readonly alTemaCambiar = () => this.colorear(this.colores());
  /** Las polilíneas ya creadas, por línea. */
  private dibujadas = new Map<string, L.Polyline[]>();
  /** La geometría con la que se construyeron, para saber si hay que rehacerlas. */
  private geometria: TrazadoLinea[] | null = null;
  /** La última selección encuadrada, para no dar saltos en cada repintado. */
  private encuadrada = '';

  constructor() {
    effect(() => {
      // Leer las señales SIEMPRE antes de cualquier salida, o el efecto deja
      // de dispararse cuando cambien.
      const trazados = this.trazados();
      const colores = this.colores();
      const el = this.lienzo().nativeElement;

      if (!this.mapa) this.crear(el);
      if (trazados !== this.geometria) this.construir(trazados);
      this.colorear(colores);
    });
  }

  ngOnDestroy(): void {
    this.observador?.disconnect();
    this.observador = null;
    this.oscuro?.removeEventListener('change', this.alTemaCambiar);
    this.oscuro = null;
    this.mapa?.remove();
    this.mapa = null;
  }

  private crear(el: HTMLElement): void {
    this.mapa = L.map(el, {
      // Ver el comentario de la clase: con SVG esto no se mueve en un móvil.
      preferCanvas: true,
      scrollWheelZoom: false,
      dragging: !this.esMovil,
      attributionControl: true,
    });
    this.mapa.fitBounds(DUBLIN, { animate: false });

    this.oscuro = window.matchMedia('(prefers-color-scheme: dark)');
    this.oscuro.addEventListener('change', this.alTemaCambiar);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap',
    }).addTo(this.mapa);

    // Un trazo de 1,5 px es imposible de acertar con el dedo. La tolerancia
    // ensancha la zona sensible sin engordar la línea dibujada; 8 px es lo que
    // hace falta para que tocar "cerca" cuente, que es como se toca un mapa.
    this.lienzoTrazos = L.canvas({ tolerance: 8 });
    this.lienzoTrazos.addTo(this.mapa);

    this.capa = L.layerGroup().addTo(this.mapa);

    // Leaflet mide el contenedor al crearse y no vuelve a mirar. Este mapa nace
    // dentro de un bloque que se acaba de desplegar, así que esa primera medida
    // se toma a destiempo y las teselas cubren una franja en vez del ancho.
    this.observador = new ResizeObserver(() => this.mapa?.invalidateSize());
    this.observador.observe(el);
  }

  alternarArrastre(): void {
    const suelto = !this.arrastre();
    this.arrastre.set(suelto);
    if (suelto) this.mapa?.dragging.enable();
    else this.mapa?.dragging.disable();
  }

  /** Crea las polilíneas. Se hace una vez, al llegar la geometría. */
  private construir(trazados: TrazadoLinea[]): void {
    const capa = this.capa;
    if (!capa) return;
    capa.clearLayers();
    this.dibujadas.clear();
    this.geometria = trazados;
    this.encuadrada = '';

    for (const t of trazados) {
      const lineas = t.trazos.map((trazo) =>
        L.polyline(trazo, {
          renderer: this.lienzoTrazos ?? undefined,
          bubblingMouseEvents: false,
          interactive: true,
        })
          .on('click', () => this.alternar.emit(t.linea))
          .addTo(capa),
      );
      this.dibujadas.set(t.linea, lineas);
    }
  }

  /** Aplica la selección: color a las elegidas, gris de fondo a las demás. */
  private colorear(colores: Record<string, string>): void {
    if (!this.mapa || !this.capa) return;

    // Un gris por tema, y hace falta: el canvas de Leaflet no entiende `var()`,
    // así que el color se elige aquí a mano. Con un solo gris para los dos, el
    // que funciona sobre la base clara sale como una maraña de hilos blancos
    // sobre la oscura —776 recorridos son mucha línea— y el que funciona en
    // oscuro desaparece en claro.
    //
    // La referencia no es el fondo, son las autopistas de la base: la red
    // tiene que pesar más que la M50 o la jerarquía queda del revés.
    const oscuro = this.oscuro?.matches ?? false;
    const fondo: L.PathOptions = {
      color: oscuro ? '#8d96a3' : '#9aa3ad',
      weight: 1.6,
      opacity: oscuro ? 0.85 : 0.8,
    };

    for (const [linea, polilineas] of this.dibujadas) {
      const color = colores[linea];
      for (const p of polilineas) {
        p.setStyle(color ? { color, weight: 4, opacity: 1 } : fondo);
        // Las elegidas, por encima: si una gris queda encima de una elegida,
        // la corta visualmente justo en los cruces, que es donde más importa.
        if (color) p.bringToFront();
      }
    }

    // Encuadrar solo cuando cambia la selección. Si se reencuadrara en cada
    // repintado, el mapa daría un salto cada vez que el usuario acaba de
    // moverlo para mirar otra cosa.
    const elegidas = Object.keys(colores).sort();
    const firma = elegidas.join(',');
    if (firma === this.encuadrada) return;
    this.encuadrada = firma;

    const puntos = elegidas.flatMap(
      (linea) => this.trazados().find((t) => t.linea === linea)?.trazos.flat() ?? [],
    );
    if (puntos.length) {
      this.mapa.fitBounds(L.latLngBounds(puntos as L.LatLngExpression[]), {
        padding: [24, 24],
        animate: false,
      });
    } else {
      this.mapa.fitBounds(DUBLIN, { animate: false });
    }
  }
}
