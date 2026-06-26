# Playwright 공식 이미지 사용 (Chromium + 필수 라이브러리 포함)
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

# 패키지 파일 복사 후 설치
COPY package.json .
RUN npm install && npx playwright install chromium

# 소스 복사
COPY . .

# 포트 설정 (Railway가 자동으로 PORT 환경변수를 설정함)
EXPOSE 4747

CMD ["node", "server.mjs"]
