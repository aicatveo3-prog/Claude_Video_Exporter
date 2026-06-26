// engine.mjs — 범용 렌더링 엔진 v2
// Stage → __seek 방식 / 비-Stage → JS 시간 주입 + Web Animations API

import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';

export async function renderToMp4(url, outputPath, options = {}) {
  const {
    duration = 10,
    fps = 60,
    resolution = '1080p',
    onProgress = () => {}
  } = options;

  const scale = resolution === '4k' ? 2 : 1;
  const viewportWidth = 1920;
  const viewportHeight = 1080;

  // ───── 1. 브라우저 실행 ─────
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu'
    ]
  });
  const context = await browser.newContext({
    viewport: {
      width: viewportWidth * scale,
      height: viewportHeight * scale
    }
  });
  const page = await context.newPage();

  // 페이지 로드 전에 시간 제어 스크립트 주입
  await page.addInitScript(() => {
    const startReal = Date.now();
    let virtualTime = startReal;

    // Date.now() 가로채기
    Date.now = () => virtualTime;

    // performance.now() 가로채기
    performance.now = () => virtualTime - startReal;

    // requestAnimationFrame 가로채기
    let rafQueue = [];
    let rafId = 0;
    window.requestAnimationFrame = (cb) => {
      const id = ++rafId;
      rafQueue.push({ id, cb });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      rafQueue = rafQueue.filter(item => item.id !== id);
    };

    // setTimeout 가로채기
    const pendingTimeouts = [];
    let timeoutId = 10000;
    window.setTimeout = (cb, delay = 0, ...args) => {
      const id = ++timeoutId;
      pendingTimeouts.push({ id, cb, args, triggerAt: virtualTime + delay });
      return id;
    };
    window.clearTimeout = (id) => {
      const idx = pendingTimeouts.findIndex(t => t.id === id);
      if (idx >= 0) pendingTimeouts.splice(idx, 1);
    };

    // 외부에서 시간을 설정하는 함수
    window.__setVirtualTime = (ms) => {
      virtualTime = startReal + ms;

      // 만료된 setTimeout 실행
      const expired = [];
      for (let i = pendingTimeouts.length - 1; i >= 0; i--) {
        if (pendingTimeouts[i].triggerAt <= virtualTime) {
          expired.push(pendingTimeouts.splice(i, 1)[0]);
        }
      }
      expired.sort((a, b) => a.triggerAt - b.triggerAt);
      expired.forEach(t => { try { t.cb(...t.args); } catch(e) {} });

      // rAF 콜백 실행
      const cbs = rafQueue.splice(0);
      cbs.forEach(({ cb }) => { try { cb(virtualTime - startReal); } catch(e) {} });

      // CSS 애니메이션 시간 설정 (Web Animations API)
      try {
        document.getAnimations().forEach(anim => {
          anim.pause();
          anim.currentTime = ms;
        });
      } catch(e) {}
    };

    window.__timeControlReady = true;
  });

  // 페이지 로드
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // ───── 플레이어 컨트롤 숨기기 ─────
  await page.addStyleTag({
    content: `
      /* data-export-hide 속성이 있는 요소 */
      [data-export-hide] { display: none !important; }

      /* 클로드 디자인 플레이어 컨트롤 자동 감지 & 숨김 */
      [class*="player" i], [class*="playback" i], [class*="controls" i],
      [class*="toolbar" i], [class*="timeline" i], [class*="scrubber" i],
      [class*="transport" i], [class*="seekbar" i],
      [id*="player" i], [id*="controls" i], [id*="toolbar" i] {
        display: none !important;
      }
    `
  });

  // CSS로 못 잡은 컨트롤을 JS로 추가 감지 (하단 고정 요소)
  await page.evaluate(() => {
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      // 화면 하단에 고정된 작은 요소 = 플레이어 컨트롤일 가능성 높음
      if (
        (style.position === 'fixed' || style.position === 'absolute') &&
        rect.bottom >= window.innerHeight - 80 &&
        rect.height < 100 &&
        rect.width > window.innerWidth * 0.3
      ) {
        el.style.display = 'none';
      }
    }
  });

  // ───── 2. Stage 감지 ─────
  const stageInfo = await page.evaluate(() => {
    if (window.__videoMeta && typeof window.__seek === 'function') {
      return {
        isStage: true,
        width: window.__videoMeta.width,
        height: window.__videoMeta.height,
        duration: window.__videoMeta.duration,
        fps: window.__videoMeta.fps || 60
      };
    }
    return { isStage: false };
  });

  let actualDuration = duration;
  let actualFps = fps;

  if (stageInfo.isStage) {
    actualDuration = stageInfo.duration;
    actualFps = stageInfo.fps || fps;
    await page.setViewportSize({
      width: stageInfo.width * scale,
      height: stageInfo.height * scale
    });
    onProgress({ status: 'info', message: 'Stage 감지됨 (' + actualDuration + '초)' });
  } else {
    onProgress({ status: 'info', message: '범용 모드 (JS 시간 제어, ' + actualDuration + '초)' });
  }

  const totalFrames = Math.ceil(actualDuration * actualFps);
  const frameDurationMs = 1000 / actualFps;

  // ───── 3. ffmpeg 시작 ─────
  const ffmpeg = spawn(ffmpegPath, [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(actualFps),
    '-i', '-',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-crf', '18',
    '-movflags', '+faststart',
    outputPath
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  ffmpeg.stderr.on('data', () => {});

  // 긴 렌더 중 파이프가 끊겨도 프로세스 전체가 죽지 않도록 stdin 에러를 흡수
  let ffmpegExited = false;
  ffmpeg.on('exit', () => { ffmpegExited = true; });
  ffmpeg.stdin.on('error', () => {});

  // ───── 4. 프레임별 렌더링 ─────
  try {
    for (let i = 0; i < totalFrames; i++) {
      const timeMs = i * frameDurationMs;
      const timeSec = timeMs / 1000;

      if (stageInfo.isStage) {
        await page.evaluate((t) => window.__seek(t), timeSec);
      } else {
        await page.evaluate((ms) => window.__setVirtualTime(ms), timeMs);
      }

      // DOM 업데이트 대기
      await page.waitForTimeout(10);

      // ffmpeg가 먼저 죽었으면 즉시 중단 (긴 렌더 중 인코더 OOM 등)
      if (ffmpegExited) {
        throw new Error('ffmpeg가 예기치 않게 종료되었습니다 (프레임 ' + (i + 1) + ')');
      }

      // 스크린샷 (타임아웃 60초)
      const buf = await page.screenshot({ type: 'jpeg', quality: 90, timeout: 60000 });

      // 백프레셔: 인코딩이 스크린샷보다 느릴 때 프레임이 메모리에 무한정 쌓이지 않도록
      // write()가 false면 drain(또는 ffmpeg 종료)까지 대기 — 7200프레임급 긴 렌더의 OOM 방지
      const ok = ffmpeg.stdin.write(buf);
      if (!ok) {
        await new Promise((resolve) => {
          const done = () => {
            ffmpeg.stdin.off('drain', done);
            ffmpeg.off('close', done);
            resolve();
          };
          ffmpeg.stdin.once('drain', done);
          ffmpeg.once('close', done);
        });
      }

      // 매 10프레임마다 진행률 전송
      if (i % 10 === 0 || i === totalFrames - 1) {
        onProgress({
          status: 'rendering',
          frame: i + 1,
          totalFrames,
          percent: ((i + 1) / totalFrames * 100).toFixed(1)
        });
      }
    }

    // ───── 5. 마무리 ─────
    ffmpeg.stdin.end();
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg 오류 (코드 ' + code + ')'));
      });
    });

    onProgress({ status: 'done', frame: totalFrames, totalFrames, percent: '100.0' });
    return outputPath;
  } finally {
    // 성공·실패와 무관하게 리소스 정리 — 렌더 중 크래시해도 브라우저/ffmpeg가 남지 않도록
    try { ffmpeg.stdin.destroy(); } catch (e) {}
    try { if (!ffmpegExited) ffmpeg.kill('SIGKILL'); } catch (e) {}
    await browser.close().catch(() => {});
  }
}
