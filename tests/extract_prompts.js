'use strict';
/**
 * Wyciąga PRODUKCYJNE prompty i schematy JSON wprost z pliku frontendu.
 *
 * Cel: testy E2E mają uderzać w dokładnie te artefakty, których używa aplikacja,
 * a nie w ich kopie. Jeżeli ktoś zmieni prompt w HTML, test automatycznie
 * testuje nową wersję. Jeżeli nazwa stałej zniknie — test głośno pada.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function findFrontend(rootDir) {
  const candidates = fs.readdirSync(rootDir).filter(name => name === 'index.html');
  if (!candidates.length) throw new Error('Nie znaleziono index.html w ' + rootDir);
  // Najnowszy modyfikowany wygrywa — w repo bywa kilka wersji.
  candidates.sort((a, b) =>
    fs.statSync(path.join(rootDir, b)).mtimeMs - fs.statSync(path.join(rootDir, a)).mtimeMs);
  return path.join(rootDir, candidates[0]);
}

/** Wycina literał szablonowy: const NAZWA = `...`; */
function extractTemplateLiteral(source, name) {
  const marker = `const ${name} = \``;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Nie znaleziono stałej ${name} w pliku frontendu.`);
  let i = start + marker.length;
  let out = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { out += source[i] + source[i + 1]; i += 2; continue; }
    if (ch === '`') break;
    out += ch;
    i += 1;
  }
  // Odtwarzamy sekwencje ucieczki tak, jak zrobiłby to silnik JS.
  return out.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\`/g, '`').replace(/\\\\/g, '\\');
}

/** Wycina literał obiektowy: const NAZWA = { ... }; — licząc klamry poza stringami. */
function extractObjectLiteral(source, name) {
  const marker = `const ${name} = {`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`Nie znaleziono stałej ${name} w pliku frontendu.`);
  let i = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  const begin = i;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literal = source.slice(begin, i + 1);
  return vm.runInNewContext(`(${literal})`);
}

function loadProductionArtifacts(rootDir) {
  const file = findFrontend(rootDir);
  const source = fs.readFileSync(file, 'utf8');
  return {
    frontendFile: path.basename(file),
    SEMANTIC_CHAPTERS_PROMPT: extractTemplateLiteral(source, 'SEMANTIC_CHAPTERS_PROMPT'),
    SEMANTIC_CHAPTERS_SCHEMA: extractObjectLiteral(source, 'SEMANTIC_CHAPTERS_SCHEMA'),
    SEMANTIC_CHAPTERS_PROMPT_VERSION: (source.match(/const SEMANTIC_CHAPTERS_PROMPT_VERSION = '([^']+)'/) || [])[1] || 'unknown',
    ANALYZE_PROMPT: extractTemplateLiteral(source, 'ANALYZE_PROMPT'),
    ANALYSIS_JSON_SCHEMA: extractObjectLiteral(source, 'ANALYSIS_JSON_SCHEMA'),
    REDUCE_PROMPT: extractTemplateLiteral(source, 'REDUCE_PROMPT'),
    REDUCE_JSON_SCHEMA: extractObjectLiteral(source, 'REDUCE_JSON_SCHEMA'),
    CLEAN_PROMPT: extractTemplateLiteral(source, 'CLEAN_PROMPT'),
  };
}

module.exports = { loadProductionArtifacts, findFrontend };
