@echo off
REM Levanta todo el tinglado: recolector + API + web.
REM
REM   iniciar.cmd          arranca los dos procesos
REM   iniciar.cmd api      solo la API (el recolector ya corre por su cuenta)
REM
REM La web queda en http://localhost:3000

cd /d "%~dp0"

REM Sin esto Node falla en la mitad de las conexiones con la NTA: sus nodos de
REM balanceo mandan la cadena TLS incompleta. Ver scripts\extraer-ca.mjs
set "NODE_EXTRA_CA_CERTS=%CD%\certs\nta-cadena.pem"

if not exist "indice\meta.json" (
  echo No existe el indice. Generandolo, tarda medio minuto...
  node scripts\indexar.mjs .\gtfs .\indice || exit /b 1
)

if not exist "web\dist\web\browser\index.html" (
  echo La web no esta construida. Construyendola...
  pushd web && call npm run build && popd
)

if /i "%~1"=="api" goto :soloapi

echo Arrancando recolector...
start "recolector" /min cmd /c "scripts\recolector.cmd"

:soloapi
echo Arrancando API en http://localhost:3000
node servidor\api.mjs --puerto 3000
