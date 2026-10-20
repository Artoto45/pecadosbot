import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createWhatsAppVideoReader,
  createWhatsAppVoiceNoteReader,
  toWhatsAppAudioContent,
  toWhatsAppVideoContent,
} from '../wa_audio_delivery.mjs';

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-audio-delivery-'));
  const audioDir = path.join(root, 'audios');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(audioDir);
  fs.writeFileSync(path.join(audioDir, 'reply.mp3'), Buffer.from('source-mp3'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { audioDir, cacheDir };
}

test('Buffer conserva el envio MP3 anterior', () => {
  const buffer = Buffer.from('legacy');
  assert.deepEqual(toWhatsAppAudioContent(buffer), {
    audio: buffer,
    mimetype: 'audio/mpeg',
    ptt: false,
  });
});

test('convierte una sola vez, reutiliza cache y produce una nota de voz', async (t) => {
  const { audioDir, cacheDir } = createFixture(t);
  const invocations = [];
  const reader = createWhatsAppVoiceNoteReader({
    audioDir,
    cacheDir,
    runFfmpeg: async details => {
      invocations.push(details);
      await fs.promises.writeFile(details.outputPath, Buffer.from('ogg-opus'));
    },
    logger: { warn() {} },
  });

  const [first, concurrent] = await Promise.all([reader('reply.mp3'), reader('reply.mp3')]);
  const cached = await reader('reply.mp3');

  assert.equal(invocations.length, 1);
  assert.ok(invocations[0].args.includes('libopus'));
  assert.ok(invocations[0].args.includes('96k'));
  for (const value of [first, concurrent, cached]) {
    assert.equal(value.mimetype, 'audio/ogg; codecs=opus');
    assert.equal(value.ptt, true);
    assert.deepEqual(value.buffer, Buffer.from('ogg-opus'));
  }
  assert.deepEqual(toWhatsAppAudioContent(first), {
    audio: Buffer.from('ogg-opus'),
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  });
});

test('si ffmpeg falla devuelve el MP3 y no bloquea los siguientes envios', async (t) => {
  const { audioDir, cacheDir } = createFixture(t);
  let attempts = 0;
  const warnings = [];
  const reader = createWhatsAppVoiceNoteReader({
    audioDir,
    cacheDir,
    runFfmpeg: async () => {
      attempts += 1;
      throw new Error('ffmpeg unavailable');
    },
    logger: { warn: message => warnings.push(message) },
  });

  const first = await reader('reply.mp3');
  const second = await reader('reply.mp3');

  assert.deepEqual(first, Buffer.from('source-mp3'));
  assert.deepEqual(second, Buffer.from('source-mp3'));
  assert.equal(attempts, 1);
  assert.equal(warnings.length, 1);
  assert.equal(toWhatsAppAudioContent(first).ptt, false);
});

test('rechaza rutas fuera del directorio de audios', async (t) => {
  const { audioDir, cacheDir } = createFixture(t);
  const reader = createWhatsAppVoiceNoteReader({
    audioDir,
    cacheDir,
    logger: { warn() {} },
  });

  assert.equal(await reader('../secret.mp3'), null);
});

test('lector de video entrega buffer con mimetype mp4 y bloquea path traversal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-video-delivery-'));
  const videoDir = path.join(root, 'videos');
  fs.mkdirSync(videoDir);
  fs.writeFileSync(path.join(videoDir, 'promo.mp4'), Buffer.from('mp4-bytes'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const readVideo = createWhatsAppVideoReader({
    videoDir,
    logger: { warn() {} },
  });
  const payload = await readVideo('promo.mp4');
  assert.deepEqual(toWhatsAppVideoContent(payload), {
    video: Buffer.from('mp4-bytes'),
    mimetype: 'video/mp4',
  });
  assert.equal(await readVideo('../secret.mp4'), null);
  assert.equal(await readVideo('missing.mp4'), null);
});
