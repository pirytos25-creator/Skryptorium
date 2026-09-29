'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const Core = require('../skryptorium-core.js');

const entry = {
  id: 'round3-package-fixture',
  title: 'Dialog i konsultacje — fixture Rundy 3',
  speaker: 'Anna Kowalska',
  event: 'Forum Praktyków',
  sessionType: 'panel',
  createdAt: '2026-08-12T12:00:00Z',
  durationSec: 11,
  language: 'pl',
  model: 'round3-mock',
  sourceType: 'audio',
  processingProfile: 'archive',
  analysisStatus: 'done',
  tags: ['dialog', 'konsultacje'],
  summary: 'Rozmowa o jakości dialogu i informacji zwrotnej.',
  transcriptRaw: 'Dialog zaczyna się od słuchania. Konsultacje wymagają informacji zwrotnej.',
  transcript: 'Dialog zaczyna się od słuchania. Konsultacje wymagają informacji zwrotnej.',
  cleanTranscript: 'Dialog zaczyna się od słuchania. Konsultacje wymagają informacji zwrotnej.',
  concepts: [{ term: 'Dialog', definition: 'Dwustronny proces komunikacji.' }],
  methods: [{ name: 'Warsztat', description: 'Wspólna praca nad rozwiązaniem.' }],
  segments: [
    { start: 0, end: 5.4, text: 'Dialog zaczyna się od słuchania.', speakerId: 'spk_0', speakerLabel: 'Anna' },
    { start: 5.4, end: 11, text: 'Konsultacje wymagają informacji zwrotnej.', speakerId: 'spk_1', speakerLabel: 'Piotr' },
  ],
};

async function writePackage(files, target) {
  const zip = new JSZip();
  Object.entries(files).forEach(([name, content]) => zip.file(name, content));
  await fs.writeFile(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

async function main() {
  const output = __dirname;
  await writePackage(Core.buildDocxPackage(entry, { includeRaw: true, includeClean: true, includeTimestamps: true }), path.join(output, 'round3-import.docx'));
  await writePackage(Core.buildXlsxPackage([entry]), path.join(output, 'round3-export.xlsx'));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
