# Llegadas de bus en Dublín

App de llegadas sobre el feed GTFS-Realtime de la NTA. El diferencial no es
mostrar los minutos que faltan —eso ya lo hace la app oficial— sino **medir
cuánto se equivoca la predicción**. Ver `CLAUDE.md` para el contexto completo
y las trampas del feed.

## Levantarlo desde cero

Hace falta Node 20+.

### 1. Lo que no viene en el repo

Tres cosas están gitignoradas y hay que conseguirlas aparte:

| Qué | Dónde | Tamaño |
|---|---|---|
| `.env` | se crea a mano, ver abajo | — |
| `gtfs/` | enlace `(download)` de la página del producto GTFS-Realtime en el portal de la NTA | ~700 MB |
| `datos/` | **es el histórico recolectado; no se regenera** | crece |

`gtfs/` tiene que salir del enlace del producto GTFS-Realtime, **no** del portal
de datos abiertos general: hay varias versiones circulando y solo una casa con
este feed. Si `llegadas.mjs` dice siempre "sin llegadas", comprueba con
`grep -c "<stop_id>" gtfs/stop_times.txt`; si sale 0, es el ZIP equivocado.

`datos/` es el único que no se puede recrear. Si cambias de máquina, cópialo:
cada día que falte es un día que se suma al final del proyecto.

### 2. El `.env`

En la raíz, y **en UTF-8**:

```
NTA_API_KEY=...
SUPABASE_URL=https://ihtyzacidpvnvcnfocen.supabase.co
SUPABASE_SERVICE_KEY=...
```

Ojo con crearlo desde PowerShell: `echo "X=1" > .env` escribe **UTF-16LE**, y
Node lo lee como bytes nulos y jura que falta la variable teniendo el fichero
delante. Usa `Set-Content -Encoding utf8`, o el editor.

La `SUPABASE_SERVICE_KEY` está en Supabase > dublin-bus > Project Settings >
API Keys > service_role. Se salta el RLS: nunca en el bundle de Angular.

### 3. Índice y dependencias

```powershell
node scripts\indexar.mjs .\gtfs .\indice   # ~24s, genera 179 MB
cd web; npm install; npm run build; cd ..
```

El índice hay que regenerarlo cada vez que se baje un estático nuevo.

### 4. Arrancar

```powershell
iniciar.cmd
```

Levanta el recolector y la API, y sirve la web en http://localhost:3000.

Para que el recolector sobreviva a los reinicios hay una copia de
`scripts\recolector.cmd` en la carpeta de Inicio de Windows
(`shell:startup`). **Es por usuario de Windows**: si cambias de cuenta, hay
que volver a ponerlo.

## Comandos

```powershell
node scripts\llegadas.mjs 8250DB002039 .\gtfs   # consulta por consola
node scripts\congelados.mjs .\datos             # analisis del historico
node scripts\sincronizar.mjs                    # sube a Supabase
node scripts\sincronizar.mjs --seco             # cuenta sin subir
node scripts\extraer-ca.mjs                     # si la NTA renueva el certificado
```

## Dos cosas que parecen bugs y no lo son

**`fetch failed` a mitad de los sondeos.** La NTA sirve la cadena TLS
incompleta desde la mitad de sus nodos de balanceo. Node no descarga
intermedios que falten (no implementa AIA); curl y los navegadores sí, por eso
curl funciona siempre. Se arregla con `NODE_EXTRA_CA_CERTS` apuntando a
`certs/nta-cadena.pem`, y los `.cmd` del proyecto ya lo hacen solos.

**`HTTP 429`.** El fair usage de la NTA es de una llamada cada 30-60s **para
todos los usuarios juntos**. Dos procesos sondeando a la vez bastan para que
salte. Por eso solo el recolector llama a la NTA, y el backend lee el volcado
que este deja en `datos/ultimo-feed.json`.
