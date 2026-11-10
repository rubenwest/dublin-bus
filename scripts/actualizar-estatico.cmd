@echo off
rem Lanza actualizar-estatico.mjs con la cadena TLS de la NTA. Lo llama el
rem Programador de tareas de Windows (ver CLAUDE.md, "El estatico se actualiza solo").
cd /d "%~dp0.."
set "NODE_EXTRA_CA_CERTS=%CD%\certs\nta-cadena.pem"
node scripts\actualizar-estatico.mjs %*
