# Proyecto: llegadas reales de bus en Dublín

## Qué es

App de llegadas de autobús para Dublín sobre el feed GTFS-Realtime de la NTA.

**El diferencial no es mostrar los minutos que faltan** — eso ya lo hacen la app
oficial y las marquesinas. El diferencial es **medir cuánto se equivoca la
predicción** y mostrar al usuario algo tipo "en esta parada, a esta hora, el 39A
suele llegar 4 min más tarde de lo que dice". Eso requiere guardar histórico.

Si el proyecto se queda en "muestro los minutos", no aporta nada.

## Estado actual

**Al día 2026-09-10: 338 paradas en vivo (el centro de Dublín), histórico en 3.**
La web ya no lista paradas a pelo: hay buscador por nombre o línea, chips con
las líneas de cada parada (que es lo que distingue las siete "O'Connell St") y
favoritas en `localStorage`. Cada resultado —y la cabecera de la pantalla de
llegadas— lleva un sprite pixel-art (8-bit) que distingue bus de tranvía: bus si
el id empieza por otra cosa, Luas (magenta, con pantógrafo) si empieza por
`8220GA`. Los sprites son SVG inline en `app.css` como data-URI, con colores
fijos que leen en claro y oscuro.

**Lo que entró el 2026-09-09/10** (desplegado, no pendiente):

- **Radar "cerca de ti"**: pantalla que ordena las paradas por distancia con
  `navigator.geolocation` (usa el `lat`/`lon` de `parada`). Era el punto 2 de la
  siguiente iteración; hecho.
- **Idioma ES/EN en caliente**, con banderas 8-bit. Los textos viven en
  `web/src/app/i18n.ts` y se cambian sin recargar; la elección se guarda en
  `localStorage`.
- **Migas de pan** en la navegación y el tag de tipo de parada más pequeño.
- **Feedback**: formulario que escribe en la tabla `feedback` de Supabase, con
  enlace de WhatsApp como alternativa. Ver más abajo cómo leerlo.
- **Analítica GoatCounter** (`https://dublin-bus.goatcounter.com`): snippet async
  en `index.html`, sin cookies ni banner de consentimiento. Como es un script de
  otro origen (`gc.zgo.at`), el service worker no lo cachea, así que offline
  simplemente no cuenta.

**La PWA se auto-actualiza** (`SwUpdate` en `app.ts`). Antes, tras un despliegue
el service worker seguía sirviendo la versión vieja hasta cerrar la app del todo
y abrirla dos veces —confundió: "he metido los iconos pero no los veo" era la
caché, no un fallo—. Ahora se recarga sola en cuanto el SW tiene lista la
versión nueva, y la busca al volver a la pestaña y cada 5 min. En `ng serve` el
SW está desactivado, así que no hace nada en local.


- Cuenta creada en developer.nationaltransport.ie, suscrito al producto
  GTFS-Realtime, API key obtenida.
- Los 3 endpoints probados manualmente desde el "Try it" del portal.
- Estático descargado y descomprimido en `gtfs/`: 7.696.107 filas en
  `stop_times.txt`, indexa en ~10 s. Completo, las 7 agencias.
- `scripts/llegadas.mjs` funciona y **ya tiene aplicados** los parches de
  `NO_DATA`, `SKIPPED` y filtrado de trips `CANCELED`/`DELETED`. En modo offline
  toma el "ahora" del `header.timestamp` del snapshot, no del reloj: si no, la
  ventana de 90 min se come todas las llegadas y parece que no hay datos.
- `scripts/diagnostico.mjs` funciona.
- `scripts/recolector.mjs` es el **único** recolector, con las tres paradas
  (`8220DB000270`, `8220DB001023`, `8250DB002039`). Timeout de 45 s, 4 intentos
  con backoff exponencial y jitter, y volcado de la cadena de `err.cause` a
  `datos/errores-YYYY-MM-DD.log`. Lee la key de `.env` o del entorno.
- Datos reales: `datos/obs-2026-09-04.jsonl`, 739 observaciones de 7 sondeos.

**La key vive solo en `.env`** (gitignorado). Sin él, el recolector aborta al
arrancar. `NTA_FEED_URL` permite apuntar a un servidor local para probar el
bucle sin gastar llamadas.

## La API (verificado a mano, no asumido)

Auth: cabecera `x-api-key`. Añadir `Cache-Control: no-cache` en el cron.

| Endpoint | Tamaño | Contenido |
|---|---|---|
| `https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json` | ~4 MB | retrasos por parada |
| `https://api.nationaltransport.ie/gtfsr/v2/Vehicles?format=json` | ~400 KB | posiciones GPS |
| `https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json` | ~4 MB | alias de TripUpdates |

- **`?format=json` está soportado oficialmente.** No hace falta protobuf ni
  `gtfs-realtime-bindings`.
- Cobertura: Dublin Bus, Bus Éireann, Go-Ahead Ireland **y también el Luas**.
  Lo de "solo autobuses" era falso: comprobado el 2026-09-08, el feed trae
  trip_updates de las paradas `8220GA*` con líneas `Red` y `Green`, que son los
  tranvías. De las 336 paradas del centro dadas de alta, 34 son de Luas y son
  las que más llegadas tienen (33 de 34 activas a las 21:15, cuando los buses
  ya van flojos). No estorba, pero que no sorprenda.
- **No hay endpoint de ServiceAlerts.** Sin incidencias de servicio. Un desvío se
  ve como paradas `SKIPPED` y nada más, sin explicación.
- Tras suscribirse, la API tarda ~15 min en activarse. Un 403 recién suscrito no
  es un bug del código.
- Throttling por fair usage: una sola llamada cada 30-60s para todos los
  usuarios. Nunca una llamada por usuario.

## Lo que NO trae el feed (y condiciona el diseño)

**TripUpdates da `delay` en segundos casi siempre.** `arrival.time` y
`departure.time` **sí existen** (esto se creía que no; comprobado el 2026-09-04
sobre `snapshots/feed-1.json`), pero son minoría: 266 de 23.903 updates, un ~1%.
No se puede construir nada sobre ellos. Para el 99% restante hay que sumar el
delay a la hora programada de `stop_times.txt`, así que **el estático sigue
siendo obligatorio desde el minuto uno**, no hay atajo. Cuando la hora absoluta
viene es preferible a sumar, y los scripts ya la prefieren si está — **pero solo
si es de tu propia parada**; ver la trampa de abajo.

**`uncertainty` también viene ya** (266 casos, los mismos que traen hora
absoluta). Pero **vale siempre `0`**, y en la spec `uncertainty: 0` significa
"esta hora es exacta / medida", no "el error esperado es de 0 segundos". No es
la métrica de fiabilidad publicada por el operador que se esperaba, y no
sustituye a nada. **La tesis del histórico sigue intacta: no sobra ni una
línea.** Vale la pena volver a mirarlo si algún día aparecen valores != 0.

**Vehicles viene capado.** Solo `latitude`, `longitude`, `bearing`. Faltan
`current_stop_sequence`, `current_status`, `stop_id`, `speed` y `occupancy`
(todos opcionales en la spec; la NTA no los manda). Sin `current_stop_sequence`
no se puede saber a qué parada va sin hacer geometría contra `shapes.txt`.

**Conclusión: Vehicles no sirve para calcular llegadas.** Sirve para pintar un
puntito en un mapa. Dejarlo para fase 3.

## Trampas confirmadas

**Los `stop_time_update` vienen salteados** (16, 17, 18, 20, 23, 27...). Regla de
la spec: cada update aplica a las paradas siguientes hasta el próximo update. Si
tu parada es la 22, usas el delay de la 20. Buscar coincidencia exacta de
`stop_sequence` deja la mitad de las paradas vacías.

**`NO_DATA` se propaga hacia adelante** y prohíbe que haya `delay`. Hay que mirar
el `schedule_relationship` del update aplicable, no solo sacar el delay.

**`SKIPPED` NO se propaga**, aplica solo a su parada — pero el delay sí atraviesa
una parada saltada. Mostrar una parada `SKIPPED` como llegada normal es el peor
bug posible: le dices a alguien que espere un bus que no va a parar ahí.

**Y los `SKIPPED` de la NTA vienen pelados**, sin `arrival` ni `departure`:
`{"stop_sequence":26,"stop_id":"8460B5550401","schedule_relationship":"SKIPPED"}`.
O sea que si el update aplicable a tu parada es un `SKIPPED`, quedarte ahí no te
deja sin bandera: te deja **sin delay**. Hay que seguir hacia atrás hasta el
update anterior que traiga uno. Este fallo estuvo en `llegadas.mjs` y en
`recolector.mjs` a la vez, que es lo que pasa con la lógica duplicada.

**La hora absoluta NO se propaga, y el delay sí.** Esto es lo contrario de lo
que hace el resto de la función y por eso se coló. El delay es un desfase y
vale para las paradas siguientes; `arrival.time` es una hora concreta y vale
solo para SU parada. Heredarla de una update anterior da la hora de llegada a
*otra* parada — siempre anterior a la tuya — y como los llamantes prefieren la
hora absoluta sobre `programado + delay`, salían buses que llegaban "ya"
estando programados una hora más tarde: un `E2` de las 15:47 anunciado a las
14:33, con `retrasoSegundos: 75`. La fila se contradecía sola.

No era raro: **212 de las 620 horas absolutas del snapshot (34%) venían de otra
parada**. Arreglado el 2026-09-08 en `estadoParada`, con tres pruebas nuevas.
Tras el arreglo son 408 y ninguna de otra parada, que es exactamente el número
de `arrival.time` que contiene el snapshot. El delay no se tocó: idéntico en
las 32.025 combinaciones.

**Los trips `ADDED` vienen sin `trip_id`** — solo `route_id`, `start_time` y
`direction_id` — y con horas absolutas en vez de delay. Por definición no cruzan
con el estático: no hay clave con la que casarlos. Se descartan y ya está (7 de
2.416 entidades).

**Filtrar trips por `trip.schedule_relationship`:** `DELETED` no se muestra jamás
(el operador quiere que desaparezca para no distraer). `CANCELED` se muestra
tachado. `SCHEDULED` es lo normal.

**El productor puede purgar updates pasados.** Un delay ya medido puede
desaparecer del feed. El recolector tiene que persistir cada snapshot; no vale
confiar en que el valor final siga ahí cuando lo vayas a buscar.

**PowerShell 5.1 escribe UTF-16LE.** `echo "X=1" > .env` produce un fichero con
BOM `ff fe` y un byte nulo entre cada carácter. Node leyéndolo como `utf8` no
casa ni una regex, y el script jura que falta la variable teniendo el `.env`
delante. `cargarDotEnv()` ya detecta el BOM; si aparece otro lector de ficheros
de configuración, que haga lo mismo.

**`fetch failed` no es un mensaje de error, es una pared.** undici (el fetch de
Node) pone *siempre* ese texto en `err.message` y esconde el motivo real en
`err.cause`, a veces anidado varios niveles. Un `catch` que imprima
`err.message` garantiza no enterarse nunca de nada. Hay que recorrer la cadena
de `cause` y sacar `code`/`errno`/`syscall`.

**La causa real es la cadena TLS de la NTA, y esto es lo importante del
apartado.** `api.nationaltransport.ie` está detrás de un balanceador con nodos
mal configurados: **la mitad de las conexiones devuelven la cadena completa (3
certificados) y la otra mitad devuelven solo la hoja**, sin el intermedio de
GoDaddy. Medido con handshakes TLS crudos, 12 conexiones seguidas:

```
intento 1: 3 certs -> autorizado    intento 2: 1 cert -> UNABLE_TO_VERIFY_LEAF_SIGNATURE
intento 3: 3 certs -> autorizado    intento 4: 1 cert -> UNABLE_TO_VERIFY_LEAF_SIGNATURE
...                                  autorizados: 6/12
```

Los navegadores y `curl` sobreviven porque descargan el intermedio que falta por
AIA (Authority Information Access). **Node no implementa AIA.** De ahí que curl
funcionara siempre y Node fallara la mitad de las veces; y de ahí que "un fetch
suelto devolvió 200 a la primera" fuese simplemente cara en vez de cruz.

Solución: darle a Node el intermedio con `NODE_EXTRA_CA_CERTS`. Está en
`certs/nta-cadena.pem`, lo regenera `node scripts\extraer-ca.mjs`, y los `.cmd`
del proyecto ya lo exportan solos. **Verificado: 6/12 sin el arreglo, 12/12
con él.**

Aparte de eso, sin `AbortSignal.timeout` explícito undici aguanta 300 s por
defecto y el bucle se queda colgado sin decir ni pío. Y los reintentos siguen
haciendo falta para lo demás (429, 5xx, cortes de red).

**Ojo con el 429.** El fair usage es real y salta enseguida: dos procesos
sondeando a la vez (recolector + backend) bastan para que la NTA empiece a
devolver `HTTP 429`. Por eso solo el recolector llama a la NTA; ver más abajo.

**No cruzar los dos feeds por `vehicle.id`.** En Vehicles se ven ids `"3"`,
`"4"`, `"20"`; en TripUpdates `"7182"`. Posiblemente espacios de nombres
distintos por operador. **Cruzar siempre por `trip_id`.**

## El estático

Bajarlo del enlace `(download)` de la página del producto GTFS-Realtime en el
portal, **no** del portal de datos abierto general. Hay varias versiones del
estático circulando y solo una casa con este feed.

**URL directa, verificada el 2026-09-08** (no hace falta login ni la API key):

```
https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip
```

93 MB, 5.988.909 filas en `stop_times.txt`, 181.488 trips, 10.181 paradas.
**Casa al 100% con el feed**: de los 2.232 trip_id vivos del feed, los 2.232
estaban en el índice. Esa es la comprobación que hay que repetir tras cada
descarga — si el solapamiento no es ~100%, el ZIP es el equivocado.

Ya no es un ZIP para toda Irlanda: viene troceado por operador.

**Si `llegadas.mjs` dice "sin llegadas" siempre, el 90% de las veces es que el
estático es de otro operador que la parada.** Verificar con:
`grep -c "<stop_id>" gtfs/stop_times.txt` — si sale 0, ZIP equivocado.

## Regalo: no hace falta calendar.txt

Los trips que aparecen en el feed son, por definición, los que circulan hoy. Eso
ahorra toda la lógica de servicios de calendario, que es de lo más pesado de
GTFS. Solo hay que intersecar `stop_times.txt` con los `trip_id` del feed.

## Descubrimiento que hace viable el histórico

Comparando dos snapshots separados 390s del mismo trip:

| seq | snapshot A | snapshot B |
|---|---|---|
| 16 | 2794 | 2794 |
| 17 | 2679 | 2679 |
| 18 | 2616 | 2616 |
| 20 | 2484 | 2484 |
| 23 | 2394 | **2424** |
| 27 | 2389 | **desaparece** |

Las paradas ya servidas tienen el delay **congelado al segundo**: es medición
real. Las futuras son predicción y bailan.

Eso da el ground truth sin necesidad de GPS ni geometría: **cuando el delay de
una `stop_sequence` deja de cambiar entre polls, el bus ya pasó**, y ese valor es
el retraso real. Se compara contra las predicciones guardadas antes para esa
misma parada y sale la métrica de fiabilidad.

## Arquitectura prevista

**La recolección ya NO depende de ningún PC encendido.** Vive en Supabase:

```
        pg_cron (cada minuto)
             |
             v
   Edge Function `recolectar`  --1 llamada-->  NTA GTFS-R
             |
             +--> ingerir()       --> serie           (histórico, crece)
             +--> llegada_actual  --> caché que sirve la web
```

Esto fue el desbloqueo del proyecto. El histórico necesita semanas seguidas y
el proyecto se usa desde varios ordenadores que se apagan; recolectar desde un
PC no era viable. Corriendo en Supabase sale gratis (1/min son 43.200
invocaciones al mes frente a las 500.000 del plan) y, de propina, **un proyecto
gratuito se pausa tras una semana sin actividad pero con el cron latiendo no se
pausa nunca**.

El cron se autentica leyendo la clave secreta de Vault, así que no queda
escrita en la definición del job:
`cron.job` -> `net.http_post` -> `vault.decrypted_secrets`.

**Ampliar paradas es un INSERT, no un despliegue**: la función lee en cada
pasada `parada.recolectar`. Lo único que hay que hacer antes es subir su
horario con `sincronizar.mjs --horario <parada>`.

Queda además el montaje local, que sigue sirviendo para desarrollo:

```
NTA GTFS-R  -->  recolector.mjs  --> datos/obs-*.jsonl + datos/ultimo-feed.json
                                                |
                                                v
                                     servidor/api.mjs --> Angular PWA (web/)
```

**Si se usa el local, el recolector es el único proceso que habla con la NTA.**
Deja el feed crudo en `datos/ultimo-feed.json` (escritura atómica, tmp +
rename) y el backend lo lee de ahí mirando el `mtime`. Con `--directo` el
servidor llama él mismo. `scripts/lock.mjs` impide que corran dos a la vez.

**Cuidado: el cron de Supabase y un recolector local sondean los dos.** Si se
levanta el local mientras el cron está activo, son dos llamadas por minuto y
vuelve el 429. Para desarrollo local, pausar el cron:
`select cron.unschedule('recolectar-nta');`

La key no puede ir en el bundle de Angular y además hay CORS: por eso el
backend, aunque acabe siendo una función serverless.

**El índice es obligatorio para la web.** `llegadas.mjs` recorre los 405 MB de
`stop_times.txt` en cada consulta y tarda 7-10 s: vale para consola, es
imposible para una petición HTTP. `scripts/indexar.mjs` hace una pasada y deja
un fichero por parada en `indice/paradas/`. Tarda 24 s y ocupa 179 MB.
**Hay que regenerarlo cada vez que se baje un estático nuevo.**

Ojo con desplegarlo en serverless tal cual: una función Vercel no puede mantener
ni la caché del feed ni un temporizador de fondo. Allí haría falta un cron que
refresque y algo con estado (Supabase o KV) donde dejar el feed; si cada
invocación llamara a la NTA, vuelve el 429.

## Orden de trabajo

1. ~~**Validar que los datos casan**~~ (script de consola, una parada, sin BD,
   sin Angular). **HECHO.** Llegadas correctas contra snapshot local, y las
   trampas del feed verificadas sobre datos reales, no supuestas.
2. Cron que persiste snapshots. ← **ESTAMOS AQUÍ, y es lo único que queda.**
   El recolector corre con arranque automático (hay un `.cmd` en la carpeta de
   Inicio de Windows) y ya no falla. Solo hay que dejarlo semanas.
3. ~~API JSON~~ **HECHA**: `servidor/api.mjs`. Falta ponerla sobre lo
   persistido, que hoy sirve solo tiempo real.
4. ~~Frontend Angular + PWA~~ **HECHO**: `web/`, Angular 21 con signals.
5. Mapa con Vehicles (opcional, decorativo).

## Desplegado

**https://rubenwest.github.io/dublin-bus/** — repo `rubenwest/dublin-bus`,
público, GitHub Pages con origen *GitHub Actions*
(`.github/workflows/desplegar.yml`).

Se puede publicar como sitio estático porque la web habla directamente con
Supabase y no necesita backend. Contra la NTA no se podría: no manda cabeceras
CORS (comprobado) y su `x-api-key` quedaría a la vista.

Dos cosas que rompen el despliegue si se olvidan, y ya mordieron:
- Pages sirve en `/<repo>/`, no en la raíz. Sin `--base-href` correcto la
  página sale en blanco. El workflow lo saca del nombre del repo.
- **Hay que activar Pages ANTES de que corra el workflow.** Si no, construye
  bien y falla al publicar con un `404` que no dice lo que pasa.

## Siguiente iteración, por orden de impacto

**1. ~~Abrir a más paradas~~ HECHO el 2026-09-08: 338 en vivo (el centro).**
Se partió `recolectar` en dos banderas (`en_vivo` / `recolectar`) y se le dio la
vuelta al bucle. El alta se hace con `sincronizar.mjs --centro`, que elige por
caja geográfica. Queda pendiente, si algún día hace falta, subir de 338 a las
1.877 del núcleo `8220DB`. Las medidas que llevaron aquí:

| Llegadas en vivo (horario, coste fijo) | Paradas | Espacio |
|---|---|---|
| Todo el estático | 10.181 | 462 MB |
| Dublín y alrededores (`82*`) | 5.288 | 260 MB |
| **Dublin Bus núcleo (`8220DB`)** | **1.877** | **122 MB** |

| Histórico (`serie`, crece) | Filas/mes | Espacio/mes |
|---|---|---|
| 3 paradas | 0,1 M | 13 MB |
| 20 paradas | 0,8 M | 83 MB |
| 100 paradas | 4,2 M | 417 MB |

Medido: **1.389 tramos por parada y día**. El plan gratuito son 500 MB en
total. Conclusión: **llegadas en vivo, anchas; histórico, estrecho.**

**El bucle ya está del revés** (hecho el 2026-09-08). Antes recorría
*paradas → trips* y paginaba TODO el `horario` de las paradas seguidas en cada
pasada; con cientos de paradas eso son millones de filas por minuto. Ahora
recorre *trips en vivo → sus paradas*: se sacan del feed los ~2.300 trip_id
vivos y se pide solo su horario con la RPC `horario_de_trips(text[])`. El coste
queda **acotado por el feed, no por el número de paradas**, que es justo lo que
permite ensanchar gratis. Necesitó un índice en `horario(trip_id)`: la PK es
`(stop_id, trip_id)` y no sirve para buscar solo por trip.

La RPC tiene el EXECUTE revocado a `anon`/`public` y concedido a `service_role`,
igual que `ingerir()`.

**2. ~~Geolocalización~~ HECHO el 2026-09-09: radar "cerca de ti".** Pantalla
que ordena las paradas por distancia con `navigator.geolocation` sobre el
`lat`/`lon` de `parada`. El buscador por nombre **mostrando las líneas de cada
parada** (hay siete "O'Connell St") y las favoritas en `localStorage` ya estaban
desde el 08. Es la diferencia entre una web y algo que se usa, y ya está.

**3. Pausar el refresco con la pestaña oculta.** SIGUE PENDIENTE (verificado el
2026-09-10): el temporizador de llegadas arranca en `seleccionar()` y solo para
en `volver()`; el `visibilitychange` de `app.ts` únicamente dispara el chequeo
de versión del SW, no toca el refresco. Así que en el bolsillo sigue consumiendo
batería y datos. Falta además un estado offline honesto: hoy sin cobertura se
queda en "Cargando" para siempre en vez de decir de cuándo son los datos (ya se
guarda la hora del último refresco en la señal `actualizado`, solo falta usarla
para eso).

## Móvil, comprobado a 375 px

Sin desbordamiento horizontal, sin texto cortado, fuente base 16 px (por
debajo iOS hace zoom al enfocar un campo), tema claro/oscuro automático, PWA
instalable, zonas táctiles de 44 px.

Cuántos días hacen falta de verdad, medido sobre las tres paradas actuales: el
tamaño de muestra por día lo fija el horario, no la frecuencia de sondeo
(sondear más a menudo da más fotos del mismo autobús, no más autobuses). Con
n=30 por celda *(parada, línea, franja horaria)*: E2 en Dun Laoghaire ~12
pasadas/hora-día → 3 días; una línea normal 2-3/hora-día → 2-3 semanas; las
flojas (142, 111) → 6 semanas. **Ampliar la lista de paradas no cuesta ni una
llamada más a la API** — ya nos bajamos todo Dublín y tiramos el 99% —, y aunque
no acelera una celda concreta, da muchas más celdas y permite conclusiones a
nivel línea en días.

## Supabase

Proyecto `dublin-bus`, región `eu-west-1` (Irlanda), plan gratuito.
`https://ihtyzacidpvnvcnfocen.supabase.co`

**No se guarda una fila por sondeo, se guarda una fila por tramo de delay
constante.** Un trip observado 60 veces con 5 valores distintos son 5 filas, no
60: medido, 10,8x menos. Y no se pierde nada, porque `sondeos` (cuántas veces se
repitió un valor) es justo lo que necesita la detección de congelados.

**Dos costes distintos, dos banderas distintas** (esto era el punto 1 de la
siguiente iteración y ya está hecho, 2026-09-08):

- `parada.en_vivo` → se muestra en la web y se le reescribe `llegada_actual`.
  **Ancho: 338 paradas** (las 336 del centro más Rathmines y Dún Laoghaire).
  Abrirlo no cuesta ni una llamada más a la NTA, el feed ya viene entero.
- `parada.recolectar` → se guarda su histórico en `serie`. **Estrecho: sigue en
  3**, porque el histórico es lo único que llena el plan gratuito (100 paradas
  ≈ 417 MB/mes de 500).

Juntarlas en una sola bandera era lo que impedía ampliar. Separarlas es lo que
permite "llegadas en vivo, anchas; histórico, estrecho".

| Objeto | Qué es |
|---|---|
| `parada` | catálogo, sale del estático. `en_vivo`, `recolectar`, `lineas` |
| `horario` | recorte de `stop_times` de las paradas `en_vivo`. 335.549 filas |
| `serie` | los tramos. Es la tabla que crece |
| `paso_medido` | vista: un bus concreto en una parada, con su retraso ya medido |
| `error_prediccion` | vista: cada predicción del feed contra lo que pasó |
| `fiabilidad` | vista: sesgo por parada, línea y franja horaria, con su `n` |
| `feedback` | mensajes del formulario. INSERT anónimo; lectura solo `service_role` |

Un paso se da por medido cuando el último tramo con delay cumple **las dos**
condiciones: `sondeos >= 2` (el valor se repitió, no es una predicción que
pasaba por ahí) **y** la llegada estimada quedó antes de `hasta` (si no, la
estabilidad es casualidad y el bus aún no había llegado).

La anticipación se mide desde `hasta`, no desde `desde`: "aún a 9 minutos vista
seguía diciendo +3". Es la lectura útil, y la conservadora.

RLS activo: lectura pública para `anon`, y ninguna política de escritura. Sólo
la `service_role` key escribe, porque se salta RLS por diseño. **Esa key nunca
puede ir en el bundle de Angular.** La RPC `ingerir()` tiene el EXECUTE
revocado a `anon`; comprobado desde fuera: devuelve `401 permission denied`.

**La tabla `feedback` es la excepción a "ninguna política de escritura":** tiene
un INSERT abierto a `anon` (para que el formulario funcione con la clave
publicable) pero **sin política de SELECT**, así que la clave pública puede
escribir y no leer. Para leer el feedback: panel de Supabase → Table Editor →
`feedback`, o una consulta con la `service_role`. Con la clave pública devuelve
vacío, es a propósito.

**NUNCA añadir `net` a los esquemas expuestos** (Project Settings > API >
Exposed schemas). `pg_net` se instala dando `EXECUTE` a `PUBLIC` sobre
`net.http_post`, `http_get` y `http_delete`, y `anon` lo hereda. Hoy no es
explotable porque PostgREST solo expone `public` y `graphql_public` — probado:
forzar `Content-Profile: net` devuelve
`406 Only the following schemas are exposed`. Pero el día que alguien exponga
ese esquema, cualquiera con la clave publicable convierte la base de datos en
un proxy HTTP y alcanza servicios internos. SSRF de manual.

**Y no se puede arreglar desde aquí**: esos objetos son propiedad de
`supabase_admin` y la conexión del panel y del MCP es `postgres`. Un `REVOKE`
que no lanza el propietario **no falla, no hace nada** — se aplicó y el permiso
seguía puesto. Si alguna vez hace falta cerrarlo de verdad, hay que ir por
soporte de Supabase; mientras tanto, la mitigación real es no exponer `net`.

`sincronizar.mjs` va aparte del recolector a propósito: el recolector tiene un
solo trabajo, que es no perder datos. Si Supabase está caído, la recolección
sigue y la subida se pone al día luego. El JSONL en disco es la fuente de
verdad; Supabase es una copia consultable. La subida es idempotente (upsert por
`stop_id, trip_id, fecha_servicio, desde`), así que se puede relanzar sin miedo.

## Cómo se arranca

```
iniciar.cmd            recolector + API + web en http://localhost:3000
iniciar.cmd api        solo la API (si el recolector ya corre)
node scripts\llegadas.mjs <parada> .\gtfs      consulta suelta por consola
node scripts\congelados.mjs .\datos            análisis del histórico (local)
node scripts\indexar.mjs .\gtfs .\indice       tras bajar estático nuevo
node scripts\sincronizar.mjs --centro --seco   cuenta las paradas del centro
node scripts\sincronizar.mjs --centro          da de alta el centro (en_vivo)
node scripts\sincronizar.mjs                   sube el día de hoy a Supabase
node scripts\sincronizar.mjs --seco            cuenta sin subir
node scripts\sincronizar.mjs --todo            sube todos los días
node scripts\extraer-ca.mjs                    si la NTA renueva el certificado
node scripts\pruebas.mjs                       pruebas de estadoParada
```

## Pruebas

`scripts/pruebas.mjs`, y son las que son por un motivo: **todos los fallos
serios de este proyecto han sido de interpretación del feed, no de interfaz.**
Los SKIPPED sin `arrival` que hacían perder el delay, el `NO_DATA` que se
propaga, los `ADDED` sin `trip_id`, la cadena TLS, el 429, el UTF-16. Ninguno
lo habría cazado un test de navegador.

Cubren tres cosas:

1. **Que sigue habiendo una sola copia.** Llegó a haber cuatro y ya derivaron
   una vez. Ahora `scripts/gtfsrt.mjs` es la única, y `llegadas.mjs`,
   `recolector.mjs` y el backend la importan. La prueba falla si vuelve a
   aparecer un `function estadoParada` suelto.
2. Que `estadoParada` acierta en los casos de la spec, con ejemplos escritos a
   mano donde la respuesta correcta se sabe de antemano.
3. Que no revienta sobre las 55.352 combinaciones (trip, parada) del snapshot
   real, y que sigue detectando las 411 paradas `SKIPPED` que contiene.

**El espejo de la Edge Function.** Una Edge Function no puede importar del
repo, así que `supabase/functions/recolectar/gtfsrt.mjs` es una copia **byte a
byte** de `scripts/gtfsrt.mjs`. No se edita a mano: se edita el de `scripts` y
se copia encima. La prueba compara los **hashes SHA-256**, no el
comportamiento: dos ficheros pueden coincidir hoy sobre el snapshot y diferir
mañana en un caso que no cubra.

```
copy scripts\gtfsrt.mjs supabase\functions\recolectar\
```

Y luego hay que volver a desplegar la función.

Para la interfaz, si algún día se añaden pruebas de navegador, que sean cuatro
recorridos concretos (elegir parada, ver llegadas, que una `SKIPPED` diga NO
PARA, que el aviso de datos rancios salga) y no una persecución de cobertura.
Cobertura al 100% mide líneas ejecutadas, no aciertos.

`.env` (gitignorado) necesita:

```
NTA_API_KEY=...
SUPABASE_URL=https://ihtyzacidpvnvcnfocen.supabase.co
SUPABASE_SERVICE_KEY=...
```

**Riesgo real del proyecto:** morir en el paso 1-2 con "ya muestro los minutos",
que es exactamente lo que ya hace la app oficial. Si el histórico da pereza,
replantear el alcance antes de empezar, no a mitad.

## Stack

Angular es la especialización del autor. Node para el backend. Supabase para
persistencia. Sin dependencias innecesarias: el feed es JSON y el estático es
CSV, todo parseable con la librería estándar.
