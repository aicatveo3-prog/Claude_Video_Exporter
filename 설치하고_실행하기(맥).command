#!/bin/bash
cd "$(dirname "$0")"

echo "============================================================"
echo "  HTML 애니메이션 -> MP4 변환기"
echo "============================================================"
echo

# ── Node.js 설치 확인 ──
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js가 설치돼 있지 않아요."
  echo
  echo "    https://nodejs.org 에서 'LTS' 버전을 설치한 뒤"
  echo "    이 파일을 다시 더블클릭하세요."
  open https://nodejs.org
  read -n 1 -s -r -p "아무 키나 누르면 닫혀요..."
  exit 1
fi

echo "[1/3] 필요한 프로그램 설치 중... (처음 한 번만 몇 분 걸려요)"
npm install || { echo "[!] 설치 실패 — 인터넷 확인 후 다시 실행"; read -n 1 -s -r; exit 1; }

echo
echo "[2/3] 브라우저 엔진(Chromium) 설치 중..."
npx playwright install chromium || { echo "[!] 설치 실패"; read -n 1 -s -r; exit 1; }

echo
echo "[3/3] 서버 시작! 잠시 후 브라우저가 자동으로 열립니다."
echo "      (창을 닫으면 종료돼요. 다시 쓰려면 이 파일을 또 더블클릭)"
sleep 3
open http://localhost:4747
npm start
