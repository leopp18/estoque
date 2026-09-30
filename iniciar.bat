@echo off
title Painel de Estoque
cd /d "%~dp0"

rem O painel agora sobe sozinho no logon, pela tarefa agendada "Painel de Estoque"
rem (que executa iniciar-oculto.vbs). Este arquivo so abre o navegador.
rem Se por algum motivo o painel nao estiver no ar, ele sobe aqui mesmo.

powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3030); exit 0 } catch { exit 1 }" >nul 2>&1

if %errorlevel%==0 (
  echo   Painel ja esta no ar. Abrindo o navegador...
  start "" "http://localhost:3030"
  exit /b
)

echo   Painel parado. Subindo...

rem Primeira vez nesta pasta: instala o driver do banco (Neon).
if not exist "%~dp0node_modules\@neondatabase" (
  echo   Instalando dependencias...
  call npm install --omit=dev
)

start "" wscript.exe "%~dp0iniciar-oculto.vbs"

rem Espera a porta responder antes de abrir o navegador.
for /l %%i in (1,1,20) do (
  timeout /t 1 /nobreak >nul
  powershell -NoProfile -Command "try { (New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',3030); exit 0 } catch { exit 1 }" >nul 2>&1
  if not errorlevel 1 (
    start "" "http://localhost:3030"
    exit /b
  )
)

echo.
echo   Nao consegui subir o painel. Verifique se o Node.js esta instalado.
echo.
pause
