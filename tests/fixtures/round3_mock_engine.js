'use strict';

const http = require('http');

const payload = {
  jobId: 'round3mock',
  status: 'done',
  phase: 'done',
  progress: 1,
  transcript: 'Pierwszy segment o dialogu. Drugi segment o konsultacjach społecznych.',
  segments: [
    { start: 0, end: 5.4, text: 'Pierwszy segment o dialogu.' },
    { start: 5.4, end: 11, text: 'Drugi segment o konsultacjach społecznych.' },
  ],
  durationSec: 11,
  language: 'pl',
  model: 'round3-mock',
  processingProfile: 'archive',
  beamSize: 4,
  batchSize: 4,
};

http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin || 'null');
  response.setHeader('Access-Control-Allow-Headers', 'content-type,x-skryptorium-token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.method === 'OPTIONS') return response.end('{}');
  if (request.url === '/api/health') return response.end(JSON.stringify({ ok: true, engine: 'round3-mock', model: 'round3-mock' }));
  if (request.method === 'POST' && request.url === '/api/transcribe') {
    request.on('data', () => {});
    request.on('end', () => response.end(JSON.stringify({ jobId: payload.jobId, status: 'queued', queuePosition: 1 })));
    return;
  }
  if (request.method === 'GET' && request.url === '/api/transcribe/round3mock') return response.end(JSON.stringify(payload));
  if (request.method === 'DELETE' && request.url === '/api/transcribe/round3mock') return response.end(JSON.stringify({ ok: true }));
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not found' }));
}).listen(8765, '127.0.0.1');
