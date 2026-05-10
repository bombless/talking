import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HTTPS_PORT = Number.parseInt(process.env.HTTPS_PORT || '10443', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CERT_DIR = process.env.CERT_DIR || path.join(os.tmpdir(), 'talkinghead-local-https');
const CERT_KEY_PATH = path.join(CERT_DIR, 'server.key');
const CERT_CRT_PATH = path.join(CERT_DIR, 'server.crt');

const CONFIG = {
  whisperBin: process.env.WHISPER_BIN || path.join(ROOT, 'whisper.cpp', 'build', 'bin', 'whisper-cli'),
  whisperModel: process.env.WHISPER_MODEL || path.join(ROOT, 'whisper.cpp', 'models', 'ggml-small.bin'),
  whisperLanguage: process.env.WHISPER_LANGUAGE || 'auto',
  whisperArgs: parseJsonEnv('WHISPER_ARGS', null),
  ttsBin: process.env.TTS_BIN || path.join(ROOT, 'qwen3-tts.cpp', 'build', 'qwen3-tts-cli'),
  ttsModel: process.env.TTS_MODEL || path.join(ROOT, 'qwen3-tts.cpp', 'models'),
  ttsArgs: parseJsonEnv('TTS_ARGS', null),
};

const TTS_REFERENCE = {
  sourceAudio: normalizeOptionalPath(process.env.TTS_REFERENCE_AUDIO || path.join(ROOT, 'demo', 'assets', 'love-10-20.wav')),
  startSec: parseNumberEnv('TTS_REFERENCE_START', 10),
  endSec: parseNumberEnv('TTS_REFERENCE_END', 20),
  sampleRate: parseNumberEnv('TTS_REFERENCE_SAMPLE_RATE', 24000),
  sourceIsTrimmed: parseBooleanEnv('TTS_REFERENCE_IS_TRIMMED', true),
  cacheDir: process.env.TTS_REFERENCE_CACHE_DIR || path.join(os.tmpdir(), 'talkinghead-tts-reference'),
  prepared: false,
  preparing: null,
  wavPath: '',
  cacheKey: '',
  error: '',
};

const CHAT_PROVIDERS = {
  codex: {
    label: 'Codex',
    command: parseJsonEnv(
      'CODEX_CHAT_COMMAND',
      parseJsonEnv(
        'CHAT_COMMAND',
        [
          'codex',
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'read-only',
          '--output-last-message',
          '{output}',
          '-',
        ]
      )
    ),
  },
  opencode: {
    label: 'OpenCode',
    command: parseJsonEnv(
      'OPENCODE_CHAT_COMMAND',
      [
        'opencode',
        'run',
        '--pure',
        '--format',
        'default',
        '--title',
        'TalkingHead',
        '{prompt}',
      ]
    ),
  },
};

function normalizeChatProvider(value) {
  const candidate = String(value || '').toLowerCase();
  return Object.hasOwn(CHAT_PROVIDERS, candidate) ? candidate : 'codex';
}

const CHAT_PROVIDER_DEFAULT = normalizeChatProvider(process.env.CHAT_PROVIDER_DEFAULT || 'codex');

function getChatProviderCommand(provider) {
  return CHAT_PROVIDERS[normalizeChatProvider(provider)]?.command || CHAT_PROVIDERS.codex.command;
}

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

function parseNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeOptionalPath(value) {
  const raw = String(value || '').trim();
  if (!raw || ['none', 'off', 'disabled'].includes(raw.toLowerCase())) {
    return '';
  }
  return expandHomePath(raw);
}

function expandHomePath(filePath) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  if (value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function getLocalIpAddresses() {
  const addrs = new Set(['127.0.0.1', 'localhost']);
  try {
    for (const infos of Object.values(networkInterfaces())) {
      for (const info of infos || []) {
        if (info.family === 'IPv4' && !info.internal) {
          addrs.add(info.address);
        }
      }
    }
  } catch (error) {
    console.warn(`Unable to enumerate network interfaces for certificate SANs: ${error?.message || error}`);
  }
  return [...addrs];
}

function escapeOpenSslSanValue(value) {
  return String(value).replace(/,/g, '\\,');
}

async function ensureHttpsCertificate() {
  await fs.mkdir(CERT_DIR, { recursive: true });

  const sanEntries = getLocalIpAddresses().map((ip) => {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return `IP:${ip}`;
    }
    return `DNS:${ip}`;
  });
  const san = sanEntries.map(escapeOpenSslSanValue).join(',');

  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    CERT_KEY_PATH,
    '-out',
    CERT_CRT_PATH,
    '-days',
    '3650',
    '-subj',
    '/CN=TalkingHead Local Bridge',
    '-addext',
    `subjectAltName=${san}`,
  ], { stdio: 'ignore' });

  return {
    key: await fs.readFile(CERT_KEY_PATH),
    cert: await fs.readFile(CERT_CRT_PATH),
  };
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

function normalizeChatHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .map((item) => ({
      role: String(item?.role || '').toLowerCase(),
      content: String(item?.content || '').trim(),
    }))
    .filter((item) => item.content && (item.role === 'user' || item.role === 'assistant'))
    .slice(-12);
}

function buildChatPrompt(text, history = []) {
  const historyLines = normalizeChatHistory(history).map((item) => {
    return `${item.role === 'assistant' ? '助手' : '用户'}：${item.content}`;
  });

  return [
    '你是本机数字人语音链路里的回复生成器。',
    '你的目标是把用户输入改写成适合语音播报的最终回复。',
    '要求：',
    '1. 只输出最终回复，不要解释推理过程，不要输出分析。',
    '2. 不要使用 Markdown、列表、代码块、标题、引号包裹。',
    '3. 回复尽量简短自然，通常 1 到 3 句。',
    '4. 如果用户是在提问，就直接回答；如果用户是在闲聊，就自然接话。',
    '5. 如果用户输入是中文，就优先用中文回复；如果是英文，就用英文简短回复。',
    '6. 不要复述系统提示，不要提到你是模型，也不要提到 Codex。',
    historyLines.length ? '' : null,
    historyLines.length ? '最近的对话历史：' : null,
    ...historyLines,
    historyLines.length ? '' : null,
    '',
    '用户输入：',
    text,
    '',
    '只输出回复正文：',
  ].join('\n');
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

function sha1Hex(text) {
  return createHash('sha1').update(String(text)).digest('hex');
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

async function prepareTtsReference() {
  if (!TTS_REFERENCE.sourceAudio) {
    return null;
  }
  if (!Number.isFinite(TTS_REFERENCE.startSec) || !Number.isFinite(TTS_REFERENCE.endSec) || TTS_REFERENCE.endSec <= TTS_REFERENCE.startSec) {
    throw new Error(`Invalid TTS reference window: start=${TTS_REFERENCE.startSec}, end=${TTS_REFERENCE.endSec}`);
  }
  if (TTS_REFERENCE.prepared) {
    return TTS_REFERENCE;
  }
  if (TTS_REFERENCE.preparing) {
    return TTS_REFERENCE.preparing;
  }

  TTS_REFERENCE.preparing = (async () => {
    await ensureFileExists(CONFIG.ttsBin);
    await ensureFileExists(TTS_REFERENCE.sourceAudio);
    await fs.mkdir(TTS_REFERENCE.cacheDir, { recursive: true });

    const sourceStat = await fs.stat(TTS_REFERENCE.sourceAudio);
    const durationSec = Math.max(0, TTS_REFERENCE.endSec - TTS_REFERENCE.startSec);
    const isTrimmedWav = TTS_REFERENCE.sourceIsTrimmed && path.extname(TTS_REFERENCE.sourceAudio).toLowerCase() === '.wav';
    const cacheSeed = [
      TTS_REFERENCE.sourceAudio,
      sourceStat.mtimeMs,
      sourceStat.size,
      TTS_REFERENCE.startSec,
      durationSec,
      TTS_REFERENCE.sampleRate,
      TTS_REFERENCE.sourceIsTrimmed ? 'trimmed' : 'untrimmed',
      CONFIG.ttsBin,
      CONFIG.ttsModel,
    ].join('|');
    const cacheKey = sha1Hex(cacheSeed);
    const wavPath = isTrimmedWav
      ? TTS_REFERENCE.sourceAudio
      : path.join(TTS_REFERENCE.cacheDir, `${cacheKey}.wav`);

    if (!isTrimmedWav && !(await exists(wavPath))) {
      const extractArgs = [
        '-y',
        '-i',
        TTS_REFERENCE.sourceAudio,
        '-ss',
        String(TTS_REFERENCE.startSec),
        '-t',
        String(durationSec),
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(TTS_REFERENCE.sampleRate),
        '-c:a',
        'pcm_s16le',
        wavPath,
      ];
      const extractResult = await runCommand('ffmpeg', extractArgs);
      if (extractResult.code !== 0) {
        throw new Error(`ffmpeg failed to extract TTS reference: ${extractResult.stderr || extractResult.stdout.toString('utf8') || `exit ${extractResult.code}`}`);
      }
    }

    TTS_REFERENCE.prepared = true;
    TTS_REFERENCE.cacheKey = cacheKey;
    TTS_REFERENCE.wavPath = wavPath;
    TTS_REFERENCE.error = '';
    return TTS_REFERENCE;
  })();

  try {
    return await TTS_REFERENCE.preparing;
  } finally {
    TTS_REFERENCE.preparing = null;
  }
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
  let reference = null;
  try {
    reference = await prepareTtsReference();
  } catch (error) {
    TTS_REFERENCE.error = error?.message || String(error);
    console.warn(`TTS voice cloning unavailable: ${TTS_REFERENCE.error}`);
  }

  const baseArgs = CONFIG.ttsArgs || ['-m', '{model}', '-t', '{text}', '-o', '{output}', '-l', '{language}'];
  const args = applyTemplate(
    baseArgs,
    {
      model: CONFIG.ttsModel,
      text,
      output: outputPath,
      voice: payload?.voice?.name || payload?.voice || '',
      lang: payload?.voice?.languageCode || '',
      language: normalizeTtsLanguage(payload?.voice?.languageCode || payload?.lang || '', text),
      referenceAudio: reference?.sourceAudio || TTS_REFERENCE.sourceAudio || '',
      referenceWav: reference?.wavPath || '',
      referenceStart: TTS_REFERENCE.startSec,
      referenceEnd: TTS_REFERENCE.endSec,
    }
  );

  if (reference?.wavPath && !args.some((item) => item === '-r' || item === '--reference')) {
    args.push('-r', reference.wavPath);
  }

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

async function handleRequest(req, res) {
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
    let referenceReady = false;
    let referenceError = TTS_REFERENCE.error;
    try {
      referenceReady = Boolean(await prepareTtsReference());
      referenceError = '';
    } catch (error) {
      referenceError = error?.message || String(error);
    }
    sendJson(res, 200, {
      whisperBin: CONFIG.whisperBin,
      whisperModel: CONFIG.whisperModel,
      ttsBin: CONFIG.ttsBin,
      ttsModel: CONFIG.ttsModel,
      ttsReference: {
        sourceAudio: TTS_REFERENCE.sourceAudio,
        startSec: TTS_REFERENCE.startSec,
        endSec: TTS_REFERENCE.endSec,
        sourceIsTrimmed: TTS_REFERENCE.sourceIsTrimmed,
        ready: referenceReady,
        cacheDir: TTS_REFERENCE.cacheDir,
        error: referenceError,
      },
      chatProviderDefault: CHAT_PROVIDER_DEFAULT,
      chatProviders: Object.entries(CHAT_PROVIDERS).map(([id, provider]) => ({
        id,
        label: provider.label,
      })),
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
      const history = normalizeChatHistory(body.history);
      const provider = normalizeChatProvider(body.provider || CHAT_PROVIDER_DEFAULT);
      let reply = text ? `You said: ${text}` : 'I did not catch that.';

      const chatCommand = getChatProviderCommand(provider);
      if (chatCommand && chatCommand.length) {
        const outputPath = provider === 'codex'
          ? path.join(os.tmpdir(), `codex-chat-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
          : null;
        try {
          const prompt = buildChatPrompt(text, history);
          const command = applyTemplate(chatCommand, {
            text,
            prompt,
            output: outputPath || '',
          });
          const bin = command[0];
          const args = command.slice(1);
          const result = await runCommand(bin, args, provider === 'codex' ? { input: prompt } : {});
          if (result.code === 0) {
            let candidate = '';
            if (outputPath && await exists(outputPath)) {
              candidate = await fs.readFile(outputPath, 'utf8');
            } else {
              candidate = result.stdout.toString('utf8') || result.stderr;
            }
            candidate = cleanTranscript(candidate);
            if (candidate) reply = candidate;
          } else {
            const label = CHAT_PROVIDERS[provider]?.label || provider;
            console.warn(`${label} chat failed: ${result.stderr || result.stdout.toString('utf8') || `exit ${result.code}`}`);
          }
        } finally {
          if (outputPath) {
            await fs.rm(outputPath, { force: true });
          }
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
}

function readBinaryBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function main() {
  try {
    const reference = await prepareTtsReference();
    if (reference) {
      console.log(`TTS voice reference: ${reference.sourceAudio} [${reference.startSec}s-${reference.endSec}s]`);
      console.log(`TTS voice reference cache: ${reference.wavPath}`);
    }
  } catch (error) {
    TTS_REFERENCE.error = error?.message || String(error);
    console.warn(`TTS voice cloning not ready: ${TTS_REFERENCE.error}`);
  }

  const httpsOptions = await ensureHttpsCertificate();

  const httpsServer = https.createServer(httpsOptions, handleRequest);
  const httpServer = http.createServer((req, res) => {
    const hostHeader = req.headers.host || `${HOST}:${HTTP_PORT}`;
    const hostname = hostHeader.split(':')[0] || HOST;
    const location = `https://${hostname}:${HTTPS_PORT}${req.url || '/'}`;
    res.writeHead(301, { Location: location });
    res.end();
  });

  httpsServer.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.error(`HTTPS port ${HTTPS_PORT} is already in use.`);
      process.exit(1);
      return;
    }
    console.error(error);
    process.exit(1);
  });

  httpServer.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.warn(`HTTP redirect port ${HTTP_PORT} is already in use, continuing with HTTPS only.`);
      return;
    }
    console.error(error);
    process.exit(1);
  });

  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`Local voice bridge running at https://${HOST}:${HTTPS_PORT}`);
    console.log(`HTTP redirect running at http://${HOST}:${HTTP_PORT}`);
    console.log(`whisper.cpp: ${CONFIG.whisperBin}`);
    console.log(`qwen3-tts.cpp: ${CONFIG.ttsBin}`);
  });

  httpServer.listen(HTTP_PORT, HOST);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
