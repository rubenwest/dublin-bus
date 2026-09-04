@echo off
REM Quita el recolector del arranque de Windows para el usuario ACTUAL.
REM No para el proceso que ya este corriendo; solo evita que vuelva a arrancar.

setlocal
set "DESTINO=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DublinBus-Recolector.cmd"

if exist "%DESTINO%" (
  del "%DESTINO%"
  echo Quitado del arranque de %USERNAME%.
) else (
  echo No estaba instalado para %USERNAME%.
)

echo.
echo Si hay un recolector corriendo ahora mismo, sigue vivo hasta que cierres
echo sesion o lo mates. Para verlo:
echo   powershell -c "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" ^| Where-Object { $_.CommandLine -match 'recolector' } ^| Select ProcessId"
endlocal
