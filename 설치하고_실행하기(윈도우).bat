@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Universal Video Exporter

echo ============================================================
echo   HTML 애니메이션 -^> MP4 변환기
echo ============================================================
echo.

REM ── Node.js 설치 확인 ──
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js가 설치돼 있지 않아요.
  echo.
  echo     https://nodejs.org  에서 "LTS" 버전을 설치한 뒤
  echo     이 파일을 다시 더블클릭하세요.
  echo.
  start https://nodejs.org
  pause
  exit /b
)

echo [1/3] 필요한 프로그램 설치 중... (처음 한 번만 몇 분 걸려요)
call npm install
if errorlevel 1 goto fail

echo.
echo [2/3] 브라우저 엔진(Chromium) 설치 중...
call npx playwright install chromium
if errorlevel 1 goto fail

echo.
echo [3/3] 서버 시작! 잠시 후 브라우저가 자동으로 열립니다.
echo       (창을 닫으면 종료돼요. 다시 쓰려면 이 파일을 또 더블클릭)
echo.
timeout /t 3 >nul
start http://localhost:4747
call npm start
goto end

:fail
echo.
echo [!] 설치 중 문제가 생겼어요. 인터넷 연결을 확인하고 다시 실행해보세요.
:end
pause
