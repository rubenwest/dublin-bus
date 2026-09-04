@echo off
REM Pone el recolector en el arranque de Windows para el usuario ACTUAL.
REM
REM La carpeta de Inicio es por usuario de Windows, asi que esto hay que
REM ejecutarlo en la cuenta donde quieras que corra la recoleccion. Y solo en
REM una: dos recolectores a la vez son dos llamadas por minuto a la NTA, y la
REM NTA responde con HTTP 429.
REM
REM Para quitarlo: scripts\desinstalar-inicio.cmd

setlocal
set "PROYECTO=%~dp0.."
for %%I in ("%PROYECTO%") do set "PROYECTO=%%~fI"
set "INICIO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "DESTINO=%INICIO%\DublinBus-Recolector.cmd"

if not exist "%PROYECTO%\scripts\recolector.cmd" (
  echo No encuentro recolector.cmd en %PROYECTO%\scripts
  exit /b 1
)

> "%DESTINO%" echo @echo off
>> "%DESTINO%" echo REM Arranca el recolector de dublin-bus al iniciar sesion.
>> "%DESTINO%" echo REM Para desactivarlo, borra este fichero.
>> "%DESTINO%" echo start "" /min "%PROYECTO%\scripts\recolector.cmd"

echo Instalado para el usuario %USERNAME%:
echo   %DESTINO%
echo Apunta a:
echo   %PROYECTO%\scripts\recolector.cmd
echo.
echo Se arrancara solo al iniciar sesion. Para arrancarlo AHORA sin reiniciar:
echo   start "" /min "%PROYECTO%\scripts\recolector.cmd"
echo.
echo Comprueba que no haya otro recolector corriendo en otra sesion de Windows.
endlocal
