// Generate the narration with ElevenLabs (voice Jessica, eleven_multilingual_v2), one clip per
// scene, cached by text so re-running costs nothing. Reads ELEVENLABS_API_KEY from .env.
// Copyright (C) 2026 chinesepowered. SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('ELEVENLABS_API_KEY missing');
const spec = JSON.parse(readFileSync(join(root, 'demo', 'narration.json'), 'utf8'));
const out = join(root, 'demo', 'build', 'audio');
mkdirSync(out, { recursive: true });
let sent = 0;
for (const s of spec.scenes) {
  const hash = createHash('sha256').update(`${spec.voice}|${spec.model}|${s.text}`).digest('hex').slice(0, 12);
  const file = join(out, `${s.id}-${hash}.mp3`);
  if (existsSync(file)) {
    console.log(`cached  ${s.id}`);
    writeFileSync(join(out, `${s.id}.mp3`), readFileSync(file));
    continue;
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${spec.voice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({
      text: s.text,
      model_id: spec.model,
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`${s.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  writeFileSync(join(out, `${s.id}.mp3`), buf);
  sent += s.text.length;
  console.log(`made    ${s.id} (${s.text.length} chars, ${buf.length} bytes)`);
}
console.log(`characters sent this run: ${sent}; narration total ${spec.scenes.reduce((n, s) => n + s.text.length, 0)}`);
