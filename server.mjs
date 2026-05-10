import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const CONFIG = {
  whisperBin: process.env.WHISPER_BIN || path.join(ROOT, 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
  whisperModel: process.env.WHISPER_MODEL || path.join(ROOT, 'whisper.cpp', 'models', 'ggml-tiny.en.bin'),
  whisperLanguage: process.env.WHISPER_LANGUAGE || 'en',
  whisperArgs: parseJsonEnv('WHISPER_ARGS', null),
  ttsBin: process.env.TTS_BIN || path.join(ROOT, 'qwen3-tts.cpp', 'build', 'qwen3-tts-cli'),
  ttsModel: process.env.TTS_MODEL || path.join(ROOT, 'qwen3-tts.cpp', 'models'),
  ttsArgs: parseJsonEnv('TTS_ARGS', null),
  chatCommand: parseJsonEnv('CHAT_COMMAND', null),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function applyTemplate(value, vars) {
  if (Array.isArray(value)) {
    return value.map((item) => applyTemplate(item, vars));
  }
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const replacement = vars[key];
    return replacement === undefined || replacement === null ? '' : String(replacement);
  });
}

function cleanTranscript(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/u, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSSML(text) {
  return String(text || '')
    .replace(/<break\s+time="[^"]*"\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTtsLanguage(lang, text) {
  const candidate = String(lang || '').toLowerCase();
  if (candidate.startsWith('zh')) return 'zh';
  if (candidate.startsWith('ja')) return 'ja';
  if (candidate.startsWith('ko')) return 'ko';
  if (candidate.startsWith('de')) return 'de';
  if (candidate.startsWith('fr')) return 'fr';
  if (candidate.startsWith('es')) return 'es';
  if (candidate.startsWith('ru')) return 'ru';
  if (/[\u4e00-\u9fff]/u.test(text)) return 'zh';
  return 'en';
}

function extractWords(text) {
  return String(text || '')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function wavHeader(dataSize, sampleRate, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

async function writeTempWav(pcmBuffer, sampleRate, prefix) {
  const file = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  const wav = Buffer.concat([wavHeader(pcmBuffer.length, sampleRate), pcmBuffer]);
  await fs.writeFile(file, wav);
  return file;
}

function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || ROOT,
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = [];
    let stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });

    if (options.input !== undefined && options.input !== null) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

async function ensureFileExists(filePath) {
  await fs.access(filePath);
}

async function transcribeBuffer(pcmBuffer, sampleRate) {
  await ensureFileExists(CONFIG.whisperBin);
  const wavPath = await writeTempWav(pcmBuffer, sampleRate, 'whisper-input');
  const args = applyTemplate(
    CONFIG.whisperArgs || ['-m', '{model}', '-f', '{input}', '-nt', '-oj', '-of', '{output}', '-l', '{language}'],
    {
      model: CONFIG.whisperModel,
      input: wavPath,
      output: `${wavPath}.whisper`,
      language: CONFIG.whisperLanguage,
    }
  );
  const result = await runCommand(CONFIG.whisperBin, args);
  await fs.rm(wavPath, { force: true });
  if (result.code !== 0) {
    throw new Error(`whisper.cpp failed: ${result.stderr || result.stdout.toString('utf8') || `exit ${result.code}`}`);
  }
  const transcript = await readWhisperTranscript(`${wavPath}.whisper.json`, result.stdout.toString('utf8'));
  await fs.rm(`${wavPath}.whisper.json`, { force: true });
  return transcript;
}

function deriveTimepoints(text, durationMs) {
  const words = extractWords(text);
  if (!words.length || !Number.isFinite(durationMs) || durationMs <= 0) {
    return [];
  }
  const step = durationMs / words.length;
  return words.map((_, index) => ({
    markName: String(index),
    timeSeconds: (index * step) / 1000,
  }));
}

async function synthesizeText(payload) {
  const text = stripSSML(payload?.input?.ssml || payload?.text || payload?.input?.text || '');
  if (!text) {
    return {
      audioContent: '',
      timepoints: [],
    };
  }

  await ensureFileExists(CONFIG.ttsBin);
  const outputPath = path.join(os.tmpdir(), `qwen3-tts-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);
  const args = applyTemplate(
    CONFIG.ttsArgs || ['-m', '{model}', '-t', '{text}', '-o', '{output}', '-l', '{language}'],
    {
      model: CONFIG.ttsModel,
      text,
      output: outputPath,
      voice: payload?.voice?.name || payload?.voice || '',
      lang: payload?.voice?.languageCode || '',
      language: normalizeTtsLanguage(payload?.voice?.languageCode || payload?.lang || '', text),
    }
  );

  const result = await runCommand(CONFIG.ttsBin, args);

  let audioBuffer = null;
  if (await exists(outputPath)) {
    audioBuffer = await fs.readFile(outputPath);
    await fs.rm(outputPath, { force: true });
  } else if (result.stdout.length) {
    audioBuffer = result.stdout;
  }

  if (!audioBuffer || audioBuffer.length < 44) {
    throw new Error(`qwen3-tts.cpp did not return usable audio: ${result.stderr || result.stdout.toString('utf8') || 'empty output'}`);
  }

  const durationMs = wavDurationMs(audioBuffer);
  return {
    audioContent: audioBuffer.toString('base64'),
    timepoints: deriveTimepoints(text, durationMs),
  };
}

function wavDurationMs(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return 0;
  }
  const sampleRate = buffer.readUInt32LE(24);
  const dataSize = buffer.readUInt32LE(40);
  const bytesPerSample = buffer.readUInt16LE(34) / 8;
  const channels = buffer.readUInt16LE(22);
  const frames = dataSize / (bytesPerSample * channels);
  return (frames / sampleRate) * 1000;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readWhisperTranscript(jsonPath, fallbackStdout) {
  if (await exists(jsonPath)) {
    const raw = await fs.readFile(jsonPath, 'utf8');
    const data = JSON.parse(raw);
    const segments = Array.isArray(data.transcription) ? data.transcription : [];
    const text = segments.map((segment) => segment?.text || '').join(' ');
    return cleanTranscript(text);
  }
  return cleanTranscript(fallbackStdout);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, statusCode, data) {
  send(res, statusCode, JSON.stringify(data, null, 2), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/demo/index.html';
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = path.join(ROOT, normalized);

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch {
    if (pathname === '/') {
      filePath = path.join(ROOT, 'demo', 'index.html');
    }
  }

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    send(res, 200, data, { 'Content-Type': contentTypeFor(filePath) });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    send(res, 204, '', {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sample-Rate',
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    sendJson(res, 200, {
      whisperBin: CONFIG.whisperBin,
      whisperModel: CONFIG.whisperModel,
      ttsBin: CONFIG.ttsBin,
      ttsModel: CONFIG.ttsModel,
      chatCommand: CONFIG.chatCommand,
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/transcribe') {
    try {
      const sampleRate = Number.parseInt(req.headers['x-sample-rate'] || url.searchParams.get('sampleRate') || '16000', 10);
      const body = await readBinaryBody(req);
      const text = await transcribeBuffer(body, sampleRate);
      sendJson(res, 200, { text });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || String(error) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    try {
      const body = await readJson(req);
      const text = String(body.text || '').trim();
      let reply = text ? `You said: ${text}` : 'I did not catch that.';

      if (CONFIG.chatCommand && CONFIG.chatCommand.length) {
        const command = applyTemplate(CONFIG.chatCommand, { text });
        const bin = command[0];
        const args = command.slice(1);
        const result = await runCommand(bin, args, { input: `${text}\n` });
        if (result.code === 0) {
          const candidate = cleanTranscript(result.stdout.toString('utf8') || result.stderr);
          if (candidate) reply = candidate;
        } else {
          reply = result.stderr || reply;
        }
      }

      sendJson(res, 200, { reply });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || String(error) });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/tts') {
    try {
      const body = await readJson(req);
      const result = await synthesizeText(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { error: error?.message || String(error) });
    }
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    await serveStatic(req, res, pathname);
    return;
  }

  send(res, 405, 'Method not allowed');
});

function readBinaryBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Local voice bridge running at http://${HOST}:${PORT}`);
  console.log(`whisper.cpp: ${CONFIG.whisperBin}`);
  console.log(`qwen3-tts.cpp: ${CONFIG.ttsBin}`);
});
