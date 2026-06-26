// server.mjs — 웹 서버
// ZIP 폴더 또는 단일 HTML 파일 모두 지원

import express from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { renderToMp4 } from './engine.mjs';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4747;
console.log('Listening on port:', PORT);

// ───── Supabase (로그인 + 일일 한도) ─────
// 환경변수가 없으면 인증 없이 동작(기존 그대로). 넣으면 자동으로 로그인+제한이 켜짐.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '2', 10);

const authEnabled = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
const supabaseAdmin = authEnabled
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  : null;
console.log('Auth/daily-limit:', authEnabled
  ? `ENABLED (${DAILY_LIMIT}/day)`
  : 'disabled (set SUPABASE_URL & SUPABASE_SECRET_KEY to enable)');

// 임시 디렉토리
const TEMP_DIR = path.join(os.tmpdir(), 'universal-video-exporter');
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// 파일 업로드 설정
const upload = multer({ dest: path.join(TEMP_DIR, 'uploads') });

// 정적 파일 (UI)
app.use(express.static(path.join(__dirname, 'public')));

// 프론트가 Supabase에 연결할 공개 설정 (url·publishable 키는 공개해도 안전)
app.get('/api/config', (req, res) => {
  res.json({
    authEnabled,
    supabaseUrl: SUPABASE_URL || null,
    supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY || null,
    dailyLimit: DAILY_LIMIT
  });
});

// 업로드 + 렌더링 (SSE로 실시간 진행률)
app.post('/api/render', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '파일이 없습니다' });
  }

  const duration = parseFloat(req.body.duration) || 10;
  const fps = parseInt(req.body.fps) || 60;
  const resolution = req.body.resolution || '1080p';

  // SSE 설정
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // ───── 인증 + 일일 한도 (authEnabled일 때만) ─────
  if (authEnabled) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const fail = (msg) => {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      send({ status: 'error', message: msg });
      return res.end();
    };
    if (!token) return fail('로그인이 필요합니다.');
    const { data: u, error: uErr } = await supabaseAdmin.auth.getUser(token);
    if (uErr || !u?.user) return fail('로그인이 만료되었어요. 다시 로그인해주세요.');
    const { data: quota, error: qErr } = await supabaseAdmin.rpc('consume_render', {
      p_user_id: u.user.id,
      p_daily_limit: DAILY_LIMIT
    });
    if (qErr) return fail('사용량 확인 실패: ' + qErr.message);
    if (!quota || !quota.allowed) {
      return fail(`오늘 무료 ${DAILY_LIMIT}회를 모두 사용했어요. 내일 다시 시도해주세요. 🙂`);
    }
  }

  try {
    // ───── 파일 처리 ─────
    const projectId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const projectDir = path.join(TEMP_DIR, 'projects', projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const originalName = req.file.originalname.toLowerCase();

    if (originalName.endsWith('.zip')) {
      // ZIP 파일 → 압축 해제
      send({ status: 'info', message: 'ZIP 압축 해제 중...' });
      const zip = new AdmZip(req.file.path);
      zip.extractAllTo(projectDir, true);

      // index.html 찾기 (하위 폴더에 있을 수 있음)
      const htmlFile = findFile(projectDir, 'index.html');
      if (!htmlFile) {
        send({ status: 'error', message: 'ZIP 안에 index.html을 찾을 수 없습니다' });
        return res.end();
      }
      // index.html이 있는 폴더를 프로젝트 루트로 사용
      var serveDir = path.dirname(htmlFile);
      var entryFile = 'index.html';

    } else if (originalName.endsWith('.html') || originalName.endsWith('.htm')) {
      // 단일 HTML 파일
      send({ status: 'info', message: 'HTML 파일 처리 중...' });
      const destPath = path.join(projectDir, 'index.html');
      fs.copyFileSync(req.file.path, destPath);
      var serveDir = projectDir;
      var entryFile = 'index.html';

    } else {
      send({ status: 'error', message: '지원하지 않는 파일 형식입니다. ZIP 또는 HTML 파일을 올려주세요.' });
      return res.end();
    }

    // 업로드 임시 파일 삭제
    fs.unlinkSync(req.file.path);

    // ───── 프로젝트 서빙용 임시 서버 ─────
    const servApp = express();
    servApp.use(express.static(serveDir));
    const servServer = servApp.listen(0, async () => {
      const servPort = servServer.address().port;
      const projectUrl = `http://localhost:${servPort}/${entryFile}`;
      const outputPath = path.join(OUTPUT_DIR, `${projectId}.mp4`);

      send({ status: 'info', message: '렌더링 시작...' });

      try {
        await renderToMp4(projectUrl, outputPath, {
          duration,
          fps,
          resolution,
          onProgress: (progress) => send(progress)
        });

        send({
          status: 'complete',
          downloadUrl: `/api/download/${projectId}`
        });
      } catch (err) {
        send({ status: 'error', message: err.message });
      } finally {
        servServer.close();
        res.end();
      }
    });

  } catch (err) {
    send({ status: 'error', message: err.message });
    res.end();
  }
});

// MP4 다운로드
app.get('/api/download/:id', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, `${req.params.id}.mp4`);
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'animation.mp4');
  } else {
    res.status(404).json({ error: '파일을 찾을 수 없습니다' });
  }
});

// ───── 유틸 ─────
function findFile(dir, filename) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === filename) {
      return fullPath;
    }
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      const found = findFile(fullPath, filename);
      if (found) return found;
    }
  }
  return null;
}

app.listen(parseInt(PORT), '0.0.0.0', () => {
  console.log('');
  console.log('  ▶ Universal Video Exporter');
  console.log(`    http://localhost:${PORT}`);
  console.log('');
});
