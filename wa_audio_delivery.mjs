import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_CONVERSION_TIMEOUT_MS = 15_000;
const VOICE_NOTE_MIMETYPE = 'audio/ogg; codecs=opus';
const VOICE_NOTE_ENCODING_VERSION = 'opus-96k-48k-mono-v1';

function runFfmpegProcess({ executable, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readNonEmptyFile(filePath) {
  const data = await fs.promises.readFile(filePath);
  return data.length > 0 ? data : null;
}

/**
 * Normaliza el resultado de readAudio para Baileys.
 *
 * Buffer conserva el contrato anterior (MP3 normal), de modo que los stubs y
 * cualquier fallback sigan funcionando. El lector de produccion devuelve la
 * forma { buffer, mimetype, ptt } cuando la conversion Opus tuvo exito.
 */
export function toWhatsAppAudioContent(value) {
  if (Buffer.isBuffer(value)) {
    return { audio: value, mimetype: 'audio/mpeg', ptt: false };
  }
  if (!value || typeof value !== 'object' || !Buffer.isBuffer(value.buffer)) return null;

  return {
    audio: value.buffer,
    mimetype: typeof value.mimetype === 'string' && value.mimetype
      ? value.mimetype
      : (value.ptt === true ? VOICE_NOTE_MIMETYPE : 'audio/mpeg'),
    ptt: value.ptt === true,
  };
}

/**
 * Normaliza el resultado de readVideo para Baileys.
 */
export function toWhatsAppVideoContent(value) {
  if (Buffer.isBuffer(value)) {
    return { video: value, mimetype: 'video/mp4' };
  }
  if (!value || typeof value !== 'object' || !Buffer.isBuffer(value.buffer)) return null;

  return {
    video: value.buffer,
    mimetype: typeof value.mimetype === 'string' && value.mimetype
      ? value.mimetype
      : 'video/mp4',
  };
}

/**
 * Crea un lector seguro de archivos de video dentro de videoDir.
 */
export function createWhatsAppVideoReader({
  videoDir,
  logger = console,
} = {}) {
  if (typeof videoDir !== 'string' || !videoDir) throw new TypeError('videoDir is required');
  const resolvedVideoDir = path.resolve(videoDir);

  return async function readVideo(filename) {
    if (typeof filename !== 'string' || !filename) return null;
    const sourcePath = path.resolve(resolvedVideoDir, filename);
    if (!isWithinDirectory(resolvedVideoDir, sourcePath)) {
      logger.warn?.('[WA VIDEO] Invalid video path ignored');
      return null;
    }

    try {
      const buffer = await readNonEmptyFile(sourcePath);
      if (!buffer) return null;
      const ext = path.extname(sourcePath).toLowerCase();
      const mimetype = ext === '.webm'
        ? 'video/webm'
        : (ext === '.mov' ? 'video/quicktime' : 'video/mp4');
      return { buffer, mimetype };
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.('[WA VIDEO] Video read failed; skipping file');
      return null;
    }
  };
}

/**
 * Crea un lector que convierte los MP3 a OGG/Opus una sola vez y reutiliza el
 * resultado por hash. Ante cualquier fallo devuelve el MP3 original.
 */
export function createWhatsAppVoiceNoteReader({
  audioDir,
  cacheDir,
  ffmpegPath = 'ffmpeg',
  timeoutMs = DEFAULT_CONVERSION_TIMEOUT_MS,
  enabled = true,
  logger = console,
  runFfmpeg = runFfmpegProcess,
} = {}) {
  if (typeof audioDir !== 'string' || !audioDir) throw new TypeError('audioDir is required');
  if (typeof cacheDir !== 'string' || !cacheDir) throw new TypeError('cacheDir is required');
  if (typeof runFfmpeg !== 'function') throw new TypeError('runFfmpeg must be a function');

  const resolvedAudioDir = path.resolve(audioDir);
  const resolvedCacheDir = path.resolve(cacheDir);
  const conversionTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_CONVERSION_TIMEOUT_MS;
  const inFlight = new Map();
  const failedConversions = new Set();

  async function convertOne({ sourcePath, cachePath, cacheKey }) {
    await fs.promises.mkdir(resolvedCacheDir, { recursive: true });

    try {
      const cached = await readNonEmptyFile(cachePath);
      if (cached) return cached;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const temporaryPath = path.join(
      resolvedCacheDir,
      `${cacheKey}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp.ogg`,
    );
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', sourcePath,
      '-vn',
      '-map_metadata', '-1',
      '-c:a', 'libopus',
      '-b:a', '96k',
      '-vbr', 'on',
      '-compression_level', '10',
      '-application', 'voip',
      '-ar', '48000',
      '-ac', '1',
      temporaryPath,
    ];

    try {
      await runFfmpeg({
        executable: ffmpegPath,
        args,
        inputPath: sourcePath,
        outputPath: temporaryPath,
        timeoutMs: conversionTimeoutMs,
      });
      const converted = await readNonEmptyFile(temporaryPath);
      if (!converted) throw new Error('ffmpeg produced an empty voice note');

      try {
        await fs.promises.rename(temporaryPath, cachePath);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
        const winner = await readNonEmptyFile(cachePath);
        if (!winner) throw error;
        return winner;
      }
      return converted;
    } finally {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  return async function readAudio(filename) {
    if (typeof filename !== 'string' || !filename) return null;
    const sourcePath = path.resolve(resolvedAudioDir, filename);
    if (!isWithinDirectory(resolvedAudioDir, sourcePath)) {
      logger.warn?.('[WA AUDIO] Invalid audio path ignored');
      return null;
    }

    let original;
    try {
      original = await fs.promises.readFile(sourcePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn?.('[WA AUDIO] Audio read failed; skipping file');
      return null;
    }

    if (!enabled || path.extname(sourcePath).toLowerCase() !== '.mp3') return original;

    const cacheKey = crypto.createHash('sha256')
      .update(VOICE_NOTE_ENCODING_VERSION)
      .update('\0')
      .update(original)
      .digest('hex');
    if (failedConversions.has(cacheKey)) return original;
    const cachePath = path.join(resolvedCacheDir, `${cacheKey}.ogg`);

    let pending = inFlight.get(cacheKey);
    if (!pending) {
      pending = convertOne({ sourcePath, cachePath, cacheKey });
      inFlight.set(cacheKey, pending);
    }

    try {
      const converted = await pending;
      return {
        buffer: converted,
        mimetype: VOICE_NOTE_MIMETYPE,
        ptt: true,
      };
    } catch {
      failedConversions.add(cacheKey);
      logger.warn?.(`[WA AUDIO] Opus conversion failed for ${path.basename(sourcePath)}; using MP3`);
      return original;
    } finally {
      if (inFlight.get(cacheKey) === pending) inFlight.delete(cacheKey);
    }
  };
}
