@echo off
REM Envoltorio para dejar el recolector corriendo sin vigilancia.
REM Si el proceso muere (corte de red largo, OOM, lo que sea), lo relanza.
REM Se instala solo: hay una copia en la carpeta de Inicio de Windows.

cd /d "%~dp0.."

REM La NTA sirve la cadena TLS incompleta desde la mitad de sus nodos de
REM balanceo: mandan la hoja sin el intermedio de GoDaddy. Node no descarga
REM intermedios que falten (no implementa AIA), asi que esas conexiones mueren
REM con UNABLE_TO_VERIFY_LEAF_SIGNATURE, que fetch presenta como "fetch failed".
REM Con esto Node ya tiene el intermedio y no falla ninguna.
REM Regenerar con: node scripts\extraer-ca.mjs
set "NODE_EXTRA_CA_CERTS=%CD%\certs\nta-cadena.pem"

:loop
echo [%date% %time%] arrancando recolector >> datos\recolector.log
node scripts\recolector.mjs .\gtfs .\datos >> datos\recolector.log 2>&1
echo [%date% %time%] el recolector ha salido, reintento en 30s >> datos\recolector.log
timeout /t 30 /nobreak > nul
goto loop
