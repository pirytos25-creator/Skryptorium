'use strict';
/**
 * Atrapa Local Engine v4 do testów UI: symuluje job, który przez ~6 s
 * oddaje segmenty przyrostowo (?since=N), raportuje prędkość, ETA,
 * zdarzenia GPU i raport jakości. Uruchomienie: node tests/fixtures/v4_mock_engine.js
 */
const http = require('http');

const SEGMENTS = [
  { start: 0, end: 4.2, text: 'Dzień dobry, witam na Forum Praktyków Partycypacji.', avgLogProb: -0.18, compressionRatio: 1.3, noSpeechProb: 0.01 },
  { start: 4.2, end: 9.8, text: 'Dziś porozmawiamy o konsultacjach społecznych w Toruniu.', avgLogProb: -0.21, compressionRatio: 1.4, noSpeechProb: 0.02 },
  { start: 9.8, end: 15.1, text: 'Narzędzie ConfUI pomaga przygotować materiały graficzne.', avgLogProb: -1.25, compressionRatio: 1.5, noSpeechProb: 0.04 },
  { start: 15.1, end: 21.7, text: 'Budżet obywatelski wymaga jasnych kryteriów i informacji zwrotnej.', avgLogProb: -0.3, compressionRatio: 1.4, noSpeechProb: 0.01 },
  { start: 21.7, end: 27.4, text: 'Przykład z Gdyni pokazuje, że panel obywatelski działa.', avgLogProb: -0.75, compressionRatio: 1.6, noSpeechProb: 0.1 },
  { start: 27.4, end: 33.0, text: 'ConfUI w praktyce skraca pracę nad infografiką o połowę.', avgLogProb: -0.25, compressionRatio: 1.4, noSpeechProb: 0.02 },
  { start: 33.0, end: 38.6, text: 'Dziękuję za uwagę.', avgLogProb: -0.2, compressionRatio: 1.1, noSpeechProb: 0.05 },
];
const DURATION = 40;
const RUN_MS = Number(process.env.MOCK_RUN_MS || 6000);
const jobs = new Map();

function view(job, since) {
  const elapsed = Date.now() - job.started;
  const fraction = Math.min(1, elapsed / RUN_MS);
  const done = fraction >= 1;
  const count = done ? SEGMENTS.length : Math.floor(fraction * SEGMENTS.length);
  const segments = SEGMENTS.slice(0, count);
  const processed = count ? segments[count - 1].end : 0;
  const from = since == null ? 0 : Math.min(Number(since) || 0, count);
  const events = [];
  if (fraction > 0.3) events.push({ at: 1, text: 'Brak VRAM — zwolniono pamięć Ollamy (qwen2.5:7b), ponawiam na GPU od 9 s.' });
  return {
    jobId: job.id,
    status: done ? 'done' : (elapsed < 400 ? 'queued' : 'running'),
    phase: done ? 'done' : (elapsed < 400 ? 'queued' : (fraction > 0.92 ? 'quality' : 'transcribing')),
    progress: done ? 1 : Math.min(0.99, processed / DURATION),
    queuePosition: elapsed < 400 ? 1 : null,
    durationSec: DURATION,
    language: 'pl',
    transcript: since == null || done ? segments.map(s => s.text).join(' ') : null,
    segments: segments.slice(from),
    segmentsFrom: from,
    segmentCount: count,
    processedSec: processed,
    speedX: count ? 6.4 : null,
    etaSec: count ? Math.round((DURATION - processed) / 6.4) : null,
    speechSec: 37.2,
    model: 'turbo',
    device: 'cuda',
    computeType: 'float16',
    processingProfile: 'archive',
    beamSize: 4,
    batchSize: 4,
    hotwordsUsed: true,
    initialPromptUsed: false,
    preprocess: false,
    events,
    quality: done ? { removed: [{ start: 39, text: 'Napisy stworzone przez społeczność Amara.org', reason: 'hallucination' }], removedCount: 1, collapsedLoops: 0, repaired: 0, unresolved: 0, fineSegments: true } : null,
    message: done ? 'Transkrypcja gotowa.' : 'Transkrybuję audio…',
  };
}

http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin || 'null');
  response.setHeader('Access-Control-Allow-Headers', 'content-type,x-skryptorium-token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'OPTIONS') return response.end('{}');
  if (url.pathname === '/api/health') {
    return response.end(JSON.stringify({
      ok: true, engine: 'faster-whisper', engineVersion: 4, model: 'turbo', defaultModel: 'turbo',
      allowedModels: ['turbo', 'large-v3', 'medium', 'small'], device: 'cuda', computeType: 'float16',
      devicePredicted: false, cudaDevices: 1, cpuFallbackRemainingSec: 0, modelLoaded: true, ffmpeg: true,
      features: { fineSegments: true, hallucinationFilter: true, repairPass: true, freeOllamaVram: true, incrementalSegments: true },
      jobs: { queued: 0, running: [...jobs.values()].filter(j => Date.now() - j.started < RUN_MS).length },
    }));
  }
  if (url.pathname === '/api/ollama/health') return response.end(JSON.stringify({ ok: true, models: ['qwen2.5:7b'] }));
  if (request.method === 'POST' && url.pathname === '/api/transcribe') {
    request.on('data', () => {});
    request.on('end', () => {
      const id = 'mock' + (jobs.size + 1);
      jobs.set(id, { id, started: Date.now() });
      response.end(JSON.stringify({ jobId: id, status: 'queued', queuePosition: 1 }));
    });
    return;
  }
  const match = url.pathname.match(/^\/api\/transcribe\/(\w+)$/);
  if (match && jobs.has(match[1])) {
    if (request.method === 'DELETE') { jobs.delete(match[1]); return response.end(JSON.stringify({ ok: true })); }
    return response.end(JSON.stringify(view(jobs.get(match[1]), url.searchParams.get('since'))));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not found' }));
}).listen(8765, '127.0.0.1', () => console.log('v4 mock engine on 8765'));
