@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title CreativeStudio
cd /d "%~dp0"

echo ============================================
echo   CreativeStudio 一键启动
echo ============================================

rem ---- 1. 检查 pnpm ----
where pnpm >nul 2>nul
if not errorlevel 1 goto pnpmready
echo [1/4] 未检测到 pnpm，尝试通过 corepack 启用...
call corepack enable >nul 2>nul
where pnpm >nul 2>nul
if not errorlevel 1 goto pnpmready
echo [错误] 未找到 pnpm。请先安装 Node.js 20+，然后在终端运行: corepack enable
pause
exit /b 1
:pnpmready
echo [1/4] pnpm 就绪

rem ---- 2. 检查 Docker ----
docker info >nul 2>nul
if not errorlevel 1 goto dockready
echo [2/4] Docker 未运行，正在启动 Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
    goto waitdocker
)
if exist "%LocalAppData%\Docker\Docker Desktop.exe" (
    start "" "%LocalAppData%\Docker\Docker Desktop.exe"
    goto waitdocker
)
echo [错误] 未找到 Docker Desktop，请先安装并启动它，再重新运行本脚本
pause
exit /b 1

:waitdocker
echo       等待 Docker 就绪（最多 120 秒）...
set /a waits=0
:waitdockerloop
timeout /t 3 /nobreak >nul
docker info >nul 2>nul
if not errorlevel 1 goto dockready
set /a waits+=1
if !waits! lss 40 goto waitdockerloop
echo [错误] Docker 在 120 秒内未就绪，请手动启动 Docker Desktop 后重试
pause
exit /b 1

:dockready
echo [2/4] Docker 就绪

rem ---- 3. 安装依赖（仅首次） ----
if exist "node_modules" (
    echo [3/4] 依赖已安装
    goto depsdone
)
echo [3/4] 首次运行，正在安装依赖（可能需要几分钟）...
call pnpm install
if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
)
:depsdone

rem ---- 4. 启动完整开发栈 ----
echo [4/4] 启动完整开发栈（PostgreSQL / Temporal / MinIO / Qdrant / API / Worker / Web）
echo.
echo       Web:         http://127.0.0.1:5173
echo       Novel V2 API: http://127.0.0.1:4770
echo       Temporal UI:  http://127.0.0.1:8088
echo       MinIO 控制台:  http://127.0.0.1:9001
echo       按 Ctrl+C 可停止全部服务
echo.
call pnpm dev
pause
