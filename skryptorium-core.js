(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SkryptoriumCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function deterministicCleanTranscript(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function countSentences(text) {
    const matches = String(text || '').match(/[.!?…]+(?:\s|$)/g);
    return matches ? matches.length : 0;
  }

  function validateCleanup(input, output, minRatio = 0.75) {
    const source = deterministicCleanTranscript(input);
    const cleaned = deterministicCleanTranscript(output);
    const inputLength = source.length;
    const outputLength = cleaned.length;
    const ratio = inputLength ? outputLength / inputLength : (outputLength ? 1 : 0);
    const inputSentences = countSentences(source);
    const outputSentences = countSentences(cleaned);
    const reasons = [];
    if (!cleaned) reasons.push('empty_output');
    if (inputLength >= 80 && ratio < minRatio) reasons.push('length_ratio');
    if (inputSentences >= 6 && outputSentences < Math.floor(inputSentences * 0.4)) {
      reasons.push('sentence_loss');
    }
    const sourceNumbers = new Set(source.match(/\b\d[\d.,:%-]*\b/g) || []);
    const cleanedNumbers = new Set(cleaned.match(/\b\d[\d.,:%-]*\b/g) || []);
    if ([...sourceNumbers].some(value => !cleanedNumbers.has(value))) reasons.push('number_loss');
    if (/^(?:oto\s+)?(?:streszczenie|podsumowanie|w\s+skr[oó]cie|jako\s+model)\b/i.test(cleaned)) {
      reasons.push('meta_commentary');
    }
    return {
      accepted: reasons.length === 0,
      reasons,
      inputLength,
      outputLength,
      ratio,
      inputSentences,
      outputSentences,
      sourceNumbers: [...sourceNumbers],
      cleanedNumbers: [...cleanedNumbers],
      cleaned,
    };
  }

  function findBoundary(text, start, tentativeEnd, minimumEnd) {
    if (tentativeEnd >= text.length) return text.length;
    const window = text.slice(start, tentativeEnd);
    const candidates = [
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    ];
    const cut = Math.max(...candidates);
    return cut >= minimumEnd - start ? start + cut + 1 : tentativeEnd;
  }

  function chunkText(text, maxLen = 9000, overlap = 400) {
    const source = String(text || '').trim();
    if (!source) return [];
    maxLen = Math.max(200, Number(maxLen) || 9000);
    overlap = Math.max(0, Math.min(Number(overlap) || 0, Math.floor(maxLen / 3)));
    const chunks = [];
    let start = 0;
    while (start < source.length) {
      const tentativeEnd = Math.min(source.length, start + maxLen);
      const end = findBoundary(source, start, tentativeEnd, start + Math.floor(maxLen * 0.55));
      const value = source.slice(start, end).trim();
      if (value) chunks.push({ text: value, startOffset: start, endOffset: end });
      if (end >= source.length) break;
      start = Math.max(start + 1, end - overlap);
    }
    return chunks;
  }

  function normalizeSegment(segment, index) {
    return {
      ...clone(segment || {}),
      _index: index,
      start: Number(segment?.start) || 0,
      end: Number(segment?.end) || 0,
      text: String(segment?.text || '').trim(),
    };
  }

  function chunkSegments(segments, maxLen = 9000, overlapSegments = 1) {
    const source = (Array.isArray(segments) ? segments : [])
      .map(normalizeSegment)
      .filter(segment => segment.text);
    if (!source.length) return [];
    maxLen = Math.max(200, Number(maxLen) || 9000);
    overlapSegments = Math.max(0, Math.min(Number(overlapSegments) || 0, 3));
    const chunks = [];
    let cursor = 0;
    while (cursor < source.length) {
      const selected = [];
      let chars = 0;
      let next = cursor;
      while (next < source.length) {
        const segment = source[next];
        const addition = segment.text.length + (selected.length ? 1 : 0);
        if (selected.length && chars + addition > maxLen) break;
        selected.push(segment);
        chars += addition;
        next += 1;
        if (chars >= maxLen) break;
      }
      if (!selected.length) {
        const longSegment = source[cursor];
        for (const part of chunkText(longSegment.text, maxLen, 0)) {
          chunks.push({
            text: part.text,
            startTime: longSegment.start,
            endTime: longSegment.end,
            segmentIndexes: [longSegment._index],
            segments: [clone(longSegment)],
          });
        }
        cursor += 1;
        continue;
      }
      chunks.push({
        text: selected.map(segment => segment.text).join(' '),
        startTime: selected[0].start,
        endTime: selected[selected.length - 1].end,
        segmentIndexes: selected.map(segment => segment._index),
        segments: selected.map(segment => {
          const copy = clone(segment);
          delete copy._index;
          return copy;
        }),
      });
      if (next >= source.length) break;
      cursor = Math.max(cursor + 1, next - overlapSegments);
    }
    return chunks.map((chunk, index) => ({
      ...chunk,
      chunkNumber: index + 1,
      start: chunk.startTime,
      end: chunk.endTime,
    }));
  }

  function chunkEntry(entry, maxLen = 9000, overlap = 400, overlapSegments = 1) {
    const working = String(entry?.transcript || entry?.transcriptRaw || '').trim();
    const source = String(entry?.transcriptRaw || entry?.transcript || '').trim();
    const segmentChunks = working === source ? chunkSegments(entry?.segments, maxLen, overlapSegments) : [];
    if (segmentChunks.length) return segmentChunks;
    return chunkText(working, maxLen, overlap).map((chunk, index) => ({
      ...chunk,
      chunkNumber: index + 1,
      start: null,
      end: null,
      startTime: null,
      endTime: null,
      segmentIndexes: [],
      segments: [],
    }));
  }

  function stripMarkdownFence(raw) {
    const value = String(raw || '').trim().replace(/^\uFEFF/, '');
    const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : value;
  }

  function extractBalancedObject(text) {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        if (depth === 0) start = index;
        depth += 1;
      } else if (char === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) return text.slice(start, index + 1);
      }
    }
    return null;
  }

  function parseAIJSON(raw) {
    const plain = String(raw || '').trim().replace(/^\uFEFF/, '');
    const unfenced = stripMarkdownFence(plain);
    const balanced = extractBalancedObject(unfenced);
    const candidates = [plain, unfenced, balanced].filter((value, index, all) => value && all.indexOf(value) === index);
    const errors = [];
    for (const candidate of candidates) {
      for (const variant of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
        try {
          const parsed = JSON.parse(variant);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Korzeń odpowiedzi nie jest obiektem JSON.');
          }
          return parsed;
        } catch (error) {
          errors.push(error.message);
        }
      }
    }
    throw new Error('Odpowiedź AI nie zawiera poprawnego obiektu JSON. ' + (errors[0] || ''));
  }

  function validateJSONSchema(value, schema, path = '$') {
    const errors = [];
    const visit = (current, rule, currentPath) => {
      if (!rule || typeof rule !== 'object') return;
      const allowedTypes = Array.isArray(rule.type) ? rule.type : (rule.type ? [rule.type] : []);
      const actualType = current === null ? 'null'
        : Array.isArray(current) ? 'array'
        : typeof current;
      if (allowedTypes.length && !allowedTypes.includes(actualType)) {
        errors.push(`${currentPath}: oczekiwano ${allowedTypes.join('|')}, otrzymano ${actualType}`);
        return;
      }
      if (actualType === 'object') {
        const properties = rule.properties || {};
        for (const required of (rule.required || [])) {
          if (!Object.prototype.hasOwnProperty.call(current, required)) {
            errors.push(`${currentPath}.${required}: brak wymaganego pola`);
          }
        }
        if (rule.additionalProperties === false) {
          for (const key of Object.keys(current)) {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
              errors.push(`${currentPath}.${key}: niedozwolone pole`);
            }
          }
        }
        for (const [key, childRule] of Object.entries(properties)) {
          if (Object.prototype.hasOwnProperty.call(current, key)) {
            visit(current[key], childRule, `${currentPath}.${key}`);
          }
        }
      } else if (actualType === 'array') {
        current.forEach((item, index) => visit(item, rule.items, `${currentPath}[${index}]`));
      }
    };
    visit(value, schema, path);
    return { ok: errors.length === 0, errors };
  }

  function parseStructuredJSON(raw, schema) {
    const parsed = parseAIJSON(raw);
    const validation = validateJSONSchema(parsed, schema);
    if (!validation.ok) {
      throw new Error('Odpowiedź JSON ma niepoprawny schemat: ' + validation.errors.slice(0, 5).join('; '));
    }
    return parsed;
  }

  function normalizeKey(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/ł/g, 'l')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function rankedStrings(partials, field, cap) {
    const items = new Map();
    (partials || []).forEach((partial, partialIndex) => {
      const seenInPartial = new Set();
      for (const raw of (Array.isArray(partial?.[field]) ? partial[field] : [])) {
        const value = String(raw || '').trim();
        const key = normalizeKey(value);
        if (!key) continue;
        if (!items.has(key)) items.set(key, { value, confirmations: 0, first: partialIndex });
        const item = items.get(key);
        if (value.length > item.value.length) item.value = value;
        if (!seenInPartial.has(key)) {
          item.confirmations += 1;
          seenInPartial.add(key);
        }
      }
    });
    return [...items.values()]
      .sort((a, b) => b.confirmations - a.confirmations || a.first - b.first || b.value.length - a.value.length)
      .slice(0, cap)
      .map(item => item.value);
  }

  function rankedPairs(partials, field, keyA, keyB, cap) {
    const items = new Map();
    (partials || []).forEach((partial, partialIndex) => {
      const seenInPartial = new Set();
      for (const raw of (Array.isArray(partial?.[field]) ? partial[field] : [])) {
        const name = String(raw?.[keyA] || '').trim();
        const description = String(raw?.[keyB] || '').trim();
        const key = normalizeKey(name);
        if (!key) continue;
        if (!items.has(key)) {
          items.set(key, { [keyA]: name, [keyB]: description, confirmations: 0, first: partialIndex });
        }
        const item = items.get(key);
        if (description.length > String(item[keyB] || '').length) item[keyB] = description;
        if (!seenInPartial.has(key)) {
          item.confirmations += 1;
          seenInPartial.add(key);
        }
      }
    });
    return [...items.values()]
      .sort((a, b) => b.confirmations - a.confirmations || a.first - b.first)
      .slice(0, cap)
      .map(item => ({ [keyA]: item[keyA], [keyB]: item[keyB] }));
  }

  function mergeAnalyses(partials) {
    const listFields = ['theses', 'examples', 'problems', 'recommendations', 'quotesWorthSaving', 'questionsForFurtherAnalysis'];
    const merged = {
      summary: '',
      outline: '',
      concepts: rankedPairs(partials, 'concepts', 'term', 'definition', 40),
      methods: rankedPairs(partials, 'methods', 'name', 'description', 40),
      keywords: rankedStrings(partials, 'keywords', 10),
      graphicSummary: { centralTopic: '', topicMap: [], processFlow: [], knowledgeCards: [] },
      visualPrompt: '',
    };
    for (const field of listFields) merged[field] = rankedStrings(partials, field, 40);

    const topics = new Map();
    (partials || []).forEach((partial, partialIndex) => {
      const seen = new Set();
      for (const raw of (partial?.graphicSummary?.topicMap || [])) {
        const topic = String(raw?.topic || '').trim();
        const key = normalizeKey(topic);
        if (!key) continue;
        if (!topics.has(key)) topics.set(key, { topic, subtopics: [], confirmations: 0, first: partialIndex });
        const item = topics.get(key);
        item.subtopics = rankedStrings([{ values: item.subtopics }, { values: raw?.subtopics || [] }], 'values', 12);
        if (!seen.has(key)) { item.confirmations += 1; seen.add(key); }
      }
    });
    merged.graphicSummary.topicMap = [...topics.values()]
      .sort((a, b) => b.confirmations - a.confirmations || a.first - b.first)
      .slice(0, 20)
      .map(({ topic, subtopics }) => ({ topic, subtopics }));
    merged.graphicSummary.processFlow = rankedPairs(
      (partials || []).map(partial => ({ items: partial?.graphicSummary?.processFlow || [] })),
      'items', 'step', 'description', 24
    );
    const cardTypes = new Map();
    for (const partial of (partials || [])) for (const card of (partial?.graphicSummary?.knowledgeCards || [])) {
      const key = normalizeKey(card?.title);
      if (key && !cardTypes.has(key)) cardTypes.set(key, String(card?.type || ''));
    }
    merged.graphicSummary.knowledgeCards = rankedPairs(
      (partials || []).map(partial => ({ items: partial?.graphicSummary?.knowledgeCards || [] })),
      'items', 'title', 'content', 30
    ).map(card => ({ title: card.title, type: cardTypes.get(normalizeKey(card.title)) || '', content: card.content }));
    return merged;
  }

  function sessionProfile(sessionType) {
    const value = normalizeKey(sessionType);
    if (/panel/.test(value)) return 'Panel: wyodrębnij stanowiska mówców, punkty sporu, konsensus i kontrargumenty.';
    if (/warsztat/.test(value)) return 'Warsztat: wyodrębnij ćwiczenia, przebieg, rezultat grupy i ustalenia.';
    if (/dyskus|debata/.test(value)) return 'Dyskusja: wyodrębnij stanowiska, argumenty, kontrargumenty i nierozstrzygnięte pytania.';
    if (/wyklad|prelek|wystap/.test(value)) return 'Wykład: wyodrębnij tezy, argumentację, definicje i przykłady.';
    return 'Dopasuj strukturę analizy do faktycznego charakteru materiału; nie wymyślaj brakującego kontekstu.';
  }

  function buildChunkContext(entry, chunk, index, total) {
    const timeRange = chunk?.startTime == null
      ? 'brak dokładnego zakresu czasu'
      : `${Number(chunk.startTime).toFixed(1)}–${Number(chunk.endTime).toFixed(1)} s`;
    return [
      `Tytuł: ${entry?.title || '(brak)'}`,
      `Prelegent: ${entry?.speaker || '(brak)'}`,
      `Wydarzenie: ${entry?.event || '(brak)'}`,
      `Typ sesji: ${entry?.sessionType || '(nieokreślony)'}`,
      `Język: ${entry?.language || '(nieokreślony)'}`,
      `Fragment: ${index + 1}/${total}`,
      `Zakres czasu: ${timeRange}`,
      sessionProfile(entry?.sessionType),
    ].join('\n');
  }

  function isAbortError(error) {
    return error?.name === 'AbortError' || /anulowan|aborted/i.test(String(error?.message || ''));
  }

  function isTransientError(error) {
    if (isAbortError(error)) return false;
    const status = Number(error?.status || error?.statusCode || 0);
    if ([429, 502, 503, 504].includes(status)) return true;
    return /timeout|timed out|network|fetch|sieci|chwilowo|connection reset|econnreset/i.test(String(error?.message || error || ''));
  }

  async function withRetry(operation, options = {}) {
    const attempts = Math.max(1, options.attempts || 4);
    const baseDelayMs = Math.max(0, options.baseDelayMs == null ? 2000 : options.baseDelayMs);
    const jitterMs = Math.max(0, options.jitterMs == null ? 400 : options.jitterMs);
    const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const random = options.random || Math.random;
    const retryable = options.isRetryable || isTransientError;
    const signal = options.signal || null;
    const abortError = () => {
      if (typeof DOMException === 'function') return new DOMException('Anulowano', 'AbortError');
      const error = new Error('Anulowano');
      error.name = 'AbortError';
      return error;
    };
    const abortableSleep = async delayMs => {
      if (!signal) return sleep(delayMs);
      if (signal.aborted) throw abortError();
      let abortListener;
      try {
        await Promise.race([
          Promise.resolve().then(() => sleep(delayMs)),
          new Promise((resolve, reject) => {
            abortListener = () => reject(abortError());
            signal.addEventListener('abort', abortListener, { once: true });
          }),
        ]);
      } finally {
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
    };
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw abortError();
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || !retryable(error)) throw error;
        const delayMs = baseDelayMs * (2 ** (attempt - 1)) + Math.floor(random() * jitterMs);
        if (options.onRetry) options.onRetry({ attempt, nextAttempt: attempt + 1, delayMs, error });
        await abortableSleep(delayMs);
      }
    }
    throw lastError;
  }

  function verifyMigratedEntries(expected, actual) {
    const actualById = new Map((actual || []).map(entry => [entry?.id, entry]));
    const missing = [];
    const mismatched = [];
    for (const entry of (expected || [])) {
      if (!entry?.id || !actualById.has(entry.id)) {
        missing.push(entry?.id || '(brak id)');
        continue;
      }
      if (JSON.stringify(entry) !== JSON.stringify(actualById.get(entry.id))) mismatched.push(entry.id);
    }
    return {
      ok: missing.length === 0 && mismatched.length === 0,
      missing,
      mismatched,
      expectedCount: (expected || []).length,
      actualCount: actualById.size,
    };
  }

  async function migrateLegacyEntries(options) {
    const marker = await options.getMarker();
    if (marker?.completed) return { ...marker, source: 'indexeddb' };
    const legacyEntries = await options.readLegacy();
    const entries = Array.isArray(legacyEntries) ? legacyEntries : [];
    if (entries.length) {
      await options.writeEntries(entries);
      const verification = verifyMigratedEntries(entries, await options.readEntries());
      if (!verification.ok) {
        throw new Error('Migracja archiwum nie przeszła weryfikacji. Stara kopia pozostaje nietknięta. Braki: '
          + verification.missing.join(', ') + '; różnice: ' + verification.mismatched.join(', '));
      }
    }
    const completed = {
      completed: true,
      completedAt: (options.now ? options.now() : new Date()).toISOString(),
      migratedCount: entries.length,
    };
    await options.writeMarker(completed);
    return { ...completed, source: entries.length ? 'migration' : 'indexeddb' };
  }

  function stableChunkId(chunk, index) {
    let hash = 2166136261;
    const value = `${index}|${chunk?.startTime}|${chunk?.endTime}|${chunk?.text || ''}`;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function stableSerialize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}';
  }

  function stableHash(value) {
    const source = typeof value === 'string' ? value : stableSerialize(value);
    let first = 2166136261;
    let second = 2246822507;
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489909);
    }
    return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
  }

  function analysisFingerprint(entry, chunks, config = {}) {
    return stableHash({
      entryId: String(entry?.id || ''),
      source: String(entry?.transcript || entry?.transcriptRaw || ''),
      sourceRaw: String(entry?.transcriptRaw || ''),
      context: {
        title: String(entry?.title || ''),
        speaker: String(entry?.speaker || ''),
        event: String(entry?.event || ''),
        sessionType: String(entry?.sessionType || ''),
        language: String(entry?.language || ''),
      },
      chunks: (chunks || []).map((chunk, index) => ({ id: stableChunkId(chunk, index), index })),
      config,
    });
  }

  function rawTranscriptUnchanged(before, after) {
    if (!before || !String(before.transcriptRaw || '')) return true;
    return String(before.transcriptRaw) === String(after?.transcriptRaw || '');
  }

  // ============ ROUND 3: TIMELINE, SEARCH, IMPORTS, EXPORTS AND ANALYTICS ============
  function escapeXml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function stableSegmentId(segment, index = 0) {
    return `seg-${stableHash({
      index,
      start: Number(segment?.start) || 0,
      end: Number(segment?.end) || 0,
      text: String(segment?.text || ''),
      speakerId: String(segment?.speakerId || ''),
    }).slice(0, 12)}`;
  }

  function activeSegmentIndex(segments, currentTime) {
    const list = Array.isArray(segments) ? segments : [];
    const time = Number(currentTime);
    if (!list.length || !Number.isFinite(time)) return -1;
    let low = 0;
    let high = list.length - 1;
    let candidate = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if ((Number(list[middle]?.start) || 0) <= time) {
        candidate = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (candidate < 0) return -1;
    const segment = list[candidate];
    const end = Number(segment?.end);
    return !Number.isFinite(end) || time <= end + 0.05 ? candidate : -1;
  }

  function findSourceForText(entry, value) {
    const wanted = normalizeKey(value);
    if (!wanted) return null;
    const wantedTokens = new Set(wanted.split(' ').filter(token => token.length > 2));
    let best = null;
    (entry?.segments || []).forEach((segment, index) => {
      const segmentKey = normalizeKey(segment?.text);
      if (!segmentKey) return;
      let score = segmentKey.includes(wanted) || wanted.includes(segmentKey) ? 1 : 0;
      if (!score && wantedTokens.size) {
        const segmentTokens = new Set(segmentKey.split(' '));
        const overlap = [...wantedTokens].filter(token => segmentTokens.has(token)).length;
        score = overlap / wantedTokens.size;
      }
      if (score >= 0.55 && (!best || score > best.score)) {
        best = {
          score,
          index,
          segmentId: stableSegmentId(segment, index),
          start: Number(segment?.start) || 0,
          end: Number(segment?.end) || 0,
          text: String(segment?.text || ''),
          speakerId: segment?.speakerId || '',
          speakerLabel: segment?.speakerLabel || '',
        };
      }
    });
    return best;
  }

  function normalizeDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
  }

  function buildSearchIndex(entries) {
    const fields = ['title', 'speaker', 'event', 'sessionType', 'transcriptRaw', 'transcript', 'summary', 'outline'];
    return (entries || []).map(entry => {
      const analysisText = [
        ...(entry?.theses || []), ...(entry?.recommendations || []), ...(entry?.quotesWorthSaving || []),
        ...(entry?.concepts || []).flatMap(item => [item?.term, item?.definition]),
        ...(entry?.methods || []).flatMap(item => [item?.name, item?.description]),
      ].join('\n');
      const text = [...fields.map(field => entry?.[field]), analysisText, ...(entry?.tags || [])].join('\n');
      return {
        id: entry?.id,
        entry,
        normalized: normalizeKey(text),
        fields: Object.fromEntries(fields.map(field => [field, normalizeKey(entry?.[field])])),
        analysis: normalizeKey(analysisText),
        tags: (entry?.tags || []).map(normalizeKey).filter(Boolean),
        date: normalizeDate(entry?.createdAt),
      };
    });
  }

  function searchArchive(index, query = '', filters = {}) {
    const needle = normalizeKey(query);
    const tags = (Array.isArray(filters.tags) ? filters.tags : String(filters.tags || '').split(','))
      .map(normalizeKey).filter(Boolean);
    const includes = (value, expected) => !normalizeKey(expected) || normalizeKey(value).includes(normalizeKey(expected));
    const results = [];
    for (const doc of (index || [])) {
      const entry = doc.entry || {};
      if (needle && !doc.normalized.includes(needle)) continue;
      if (!includes(entry.speaker, filters.speaker)) continue;
      if (!includes(entry.event, filters.event)) continue;
      if (!includes(entry.sessionType, filters.sessionType)) continue;
      if (filters.status && entry.analysisStatus !== filters.status) continue;
      if (filters.model && !includes(entry.model, filters.model)) continue;
      if (filters.hasAudio === true && !entry.hasAudio) continue;
      if (filters.hasAudio === false && entry.hasAudio) continue;
      if (filters.hasAnalysis === true && entry.analysisStatus !== 'done') continue;
      if (filters.hasAnalysis === false && entry.analysisStatus === 'done') continue;
      if (filters.dateFrom && (!doc.date || doc.date < filters.dateFrom)) continue;
      if (filters.dateTo && (!doc.date || doc.date > filters.dateTo)) continue;
      if (tags.length && !tags.every(tag => doc.tags.includes(tag))) continue;
      let source = null;
      if (needle) {
        source = findSourceForText(entry, query);
        if (!source) {
          const raw = String(entry.transcript || entry.transcriptRaw || '');
          const offset = normalizeKey(raw).indexOf(needle);
          source = { start: null, index: -1, text: offset >= 0 ? raw.slice(Math.max(0, offset - 80), offset + query.length + 160) : '' };
        }
      }
      results.push({ id: doc.id, entry, source });
    }
    return results;
  }

  function parseCueTime(value) {
    const parts = String(value || '').trim().replace(',', '.').split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }

  function parseTimedText(text, kind = 'srt') {
    const source = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const blocks = source.split(/\n{2,}/);
    const segments = [];
    for (const block of blocks) {
      const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
      if (!lines.length) continue;
      if (/^(WEBVTT|NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;
      const timingIndex = lines.findIndex(line => /\s-->\s/.test(line));
      if (timingIndex < 0) continue;
      const timing = lines[timingIndex].split(/\s-->\s/);
      const start = parseCueTime(timing[0]);
      const end = parseCueTime(String(timing[1] || '').split(/\s+/)[0]);
      if (start == null || end == null || end < start) continue;
      const rawCueText = lines.slice(timingIndex + 1).join(' ');
      const voiceMatch = rawCueText.match(/<v\s+([^>]+)>/i);
      const speakerLabel = voiceMatch?.[1]?.trim() || '';
      const cueText = rawCueText
        .replace(/<v\s+[^>]+>/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim();
      if (cueText) segments.push({
        start,
        end,
        text: cueText,
        ...(speakerLabel ? { speakerLabel, speakerId: `speaker-${stableHash(normalizeKey(speakerLabel)).slice(0, 8)}` } : {})
      });
    }
    return segments.map((segment, index) => ({ ...segment, segmentId: stableSegmentId(segment, index), sourceFormat: kind }));
  }

  function parseDocxXml(xml) {
    return String(xml || '')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  function parseImportedDocument(name, text, options = {}) {
    const filename = String(name || 'import');
    const extension = (filename.split('.').pop() || '').toLowerCase();
    const sourceType = ['srt', 'vtt'].includes(extension) ? 'subtitles' : extension === 'docx' ? 'document' : 'text';
    const segments = ['srt', 'vtt'].includes(extension) ? parseTimedText(text, extension) : [];
    const transcript = segments.length ? segments.map(segment => segment.text).join(' ') : deterministicCleanTranscript(text);
    const title = filename.replace(/\.[^.]+$/, '') || filename;
    return {
      id: options.id || `import_${stableHash(`${filename}|${transcript}|${options.importedAt || ''}`).slice(0, 16)}`,
      title,
      sourceType,
      transcriptRaw: transcript,
      transcript,
      segments,
      durationSec: segments.length ? segments[segments.length - 1].end : 0,
      hasAudio: false,
      model: `import:${extension || 'txt'}`,
      language: options.language || 'pl',
      tags: Array.isArray(options.tags) ? options.tags : [],
      processingProfile: 'import',
      importMeta: {
        filename,
        extension,
        importedAt: options.importedAt || new Date().toISOString(),
        preserveTimestamps: segments.length > 0,
      },
    };
  }

  const PROCESSING_PROFILES = Object.freeze({
    fast: { key: 'fast', label: 'Szybki', beamSize: 1, batchSize: 8, bestOf: 1, description: 'Szybki szkic; mniejszy koszt obliczeń.' },
    balanced: { key: 'balanced', label: 'Zrównoważony', beamSize: 2, batchSize: 8, bestOf: 2, description: 'Domyślny balans jakości i czasu.' },
    archive: { key: 'archive', label: 'Archiwalny', beamSize: 4, batchSize: 4, bestOf: 4, description: 'Wyższa jakość, wolniejszy przebieg.' },
  });

  function resolveProcessingProfile(durationSec, override = 'auto', sourceType = 'audio') {
    if (sourceType !== 'audio') return { key: 'import', label: 'Import', reason: 'Materiał tekstowy nie wymaga Whispera.' };
    const selected = String(override || 'auto').toLowerCase();
    if (PROCESSING_PROFILES[selected]) return { ...PROCESSING_PROFILES[selected], reason: 'Profil wybrany ręcznie.' };
    const duration = Math.max(0, Number(durationSec) || 0);
    if (duration >= 5400) return { ...PROCESSING_PROFILES.fast, reason: 'Auto: nagranie co najmniej 90 minut.' };
    if (duration >= 1800) return { ...PROCESSING_PROFILES.balanced, reason: 'Auto: długie nagranie.' };
    return { ...PROCESSING_PROFILES.archive, reason: 'Auto: krótszy materiał pozwala użyć jakości archiwalnej.' };
  }

  function estimateProcessing(durationSec, profileKey, learnedSpeedX = null) {
    const duration = Math.max(0, Number(durationSec) || 0);
    const speed = Number(learnedSpeedX);
    if (Number.isFinite(speed) && speed > 0.05) {
      // Zmierzona prędkość tej maszyny (× czasu rzeczywistego) jest lepsza niż stała tabela.
      const seconds = Math.max(5, Math.round(duration / speed));
      return { seconds, minSeconds: Math.max(3, Math.round(seconds * 0.8)), maxSeconds: Math.round(seconds * 1.3), learned: true };
    }
    const factor = { fast: 0.18, balanced: 0.32, archive: 0.65 }[profileKey] || 0.32;
    const seconds = Math.max(5, Math.round(duration * factor));
    return { seconds, minSeconds: Math.max(3, Math.round(seconds * 0.65)), maxSeconds: Math.round(seconds * 1.65), learned: false };
  }

  function csvCell(value) {
    let text = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function toCSV(rows, columns) {
    const list = Array.isArray(rows) ? rows : [];
    const keys = columns || [...new Set(list.flatMap(row => Object.keys(row || {})))];
    return '\uFEFF' + [keys.map(csvCell).join(','), ...list.map(row => keys.map(key => csvCell(row?.[key])).join(','))].join('\r\n');
  }

  function formatSubtitleTimestamp(seconds, separator = ',') {
    const millis = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const h = Math.floor(millis / 3600000);
    const m = Math.floor((millis % 3600000) / 60000);
    const s = Math.floor((millis % 60000) / 1000);
    const ms = millis % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
  }

  function formatSRT(segments) {
    return (segments || []).filter(segment => String(segment?.text || '').trim()).map((segment, index) =>
      `${index + 1}\n${formatSubtitleTimestamp(segment.start)} --> ${formatSubtitleTimestamp(segment.end)}\n${String(segment.text).trim()}`
    ).join('\n\n') + ((segments || []).length ? '\n' : '');
  }

  function formatVTT(segments) {
    const cues = (segments || []).filter(segment => String(segment?.text || '').trim()).map(segment =>
      `${formatSubtitleTimestamp(segment.start, '.')} --> ${formatSubtitleTimestamp(segment.end, '.')}\n${String(segment.text).trim()}`
    ).join('\n\n');
    return `WEBVTT\n\n${cues}${cues ? '\n' : ''}`;
  }

  function archiveTables(entries) {
    const entryRows = [];
    const conceptRows = [];
    const methodRows = [];
    const segmentRows = [];
    for (const entry of (entries || [])) {
      entryRows.push({
        id: entry.id, title: entry.title, speaker: entry.speaker, event: entry.event,
        sessionType: entry.sessionType, createdAt: entry.createdAt, durationSec: entry.durationSec,
        language: entry.language, model: entry.model, sourceType: entry.sourceType,
        processingProfile: entry.processingProfile, analysisStatus: entry.analysisStatus,
        tags: (entry.tags || []).join('; '), summary: entry.summary || '', transcriptRaw: entry.transcriptRaw || '',
        transcriptClean: entry.cleanTranscript || entry.transcript || '',
      });
      (entry.concepts || []).forEach(item => conceptRows.push({ entryId: entry.id, title: entry.title, term: item.term, definition: item.definition }));
      (entry.methods || []).forEach(item => methodRows.push({ entryId: entry.id, title: entry.title, name: item.name, description: item.description }));
      (entry.segments || []).forEach((segment, index) => segmentRows.push({
        entryId: entry.id, title: entry.title, segmentIndex: index + 1, start: segment.start, end: segment.end,
        speakerId: segment.speakerId || '', speakerLabel: segment.speakerLabel || '', text: segment.text,
      }));
    }
    return { entries: entryRows, concepts: conceptRows, methods: methodRows, segments: segmentRows };
  }

  const ARCHIVE_COLUMNS = Object.freeze({
    entries: ['id','title','speaker','event','sessionType','createdAt','durationSec','language','model','sourceType','processingProfile','analysisStatus','tags','summary','transcriptRaw','transcriptClean'],
    concepts: ['entryId','title','term','definition'],
    methods: ['entryId','title','name','description'],
    segments: ['entryId','title','segmentIndex','start','end','speakerId','speakerLabel','text'],
  });

  function buildCsvExports(entries) {
    const tables = archiveTables(entries);
    return {
      'wpisy.csv': toCSV(tables.entries, ARCHIVE_COLUMNS.entries),
      'pojecia.csv': toCSV(tables.concepts, ARCHIVE_COLUMNS.concepts),
      'metody.csv': toCSV(tables.methods, ARCHIVE_COLUMNS.methods),
      'segmenty.csv': toCSV(tables.segments, ARCHIVE_COLUMNS.segments),
    };
  }

  function docxParagraph(text, style = 'Normal') {
    const paragraphs = String(text || '').split(/\n/);
    return paragraphs.map(line => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(line || ' ')}</w:t></w:r></w:p>`).join('');
  }

  function buildDocxPackage(entry, options = {}) {
    const includeRaw = options.includeRaw !== false;
    const includeClean = options.includeClean !== false;
    const includeTimestamps = options.includeTimestamps !== false;
    const body = [];
    body.push(docxParagraph(entry?.title || 'Transkrypt', 'Title'));
    body.push(docxParagraph(`Autor / mówca: ${entry?.speaker || '—'}`));
    body.push(docxParagraph(`Wydarzenie: ${entry?.event || '—'} | Data: ${normalizeDate(entry?.createdAt) || '—'}`));
    body.push(docxParagraph('Materiał wygenerowany na podstawie transkrypcji. Cytaty i dane należy zweryfikować przed publikacją.', 'Subtitle'));
    if (includeClean && String(entry?.cleanTranscript || entry?.transcript || '').trim()) {
      body.push(docxParagraph('Transkrypt opracowany', 'Heading1'));
      body.push(docxParagraph(entry.cleanTranscript || entry.transcript));
    }
    if (includeRaw && String(entry?.transcriptRaw || '').trim()) {
      body.push(docxParagraph('Transkrypt źródłowy', 'Heading1'));
      if (includeTimestamps && (entry?.segments || []).length) {
        (entry.segments || []).forEach(segment => {
          const speaker = segment.speakerLabel ? `${segment.speakerLabel} · ` : '';
          body.push(docxParagraph(`${speaker}${formatSubtitleTimestamp(segment.start, '.').slice(0, -4)}–${formatSubtitleTimestamp(segment.end, '.').slice(0, -4)}`, 'Heading2'));
          body.push(docxParagraph(segment.text));
        });
      } else {
        body.push(docxParagraph(entry.transcriptRaw));
      }
    }
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`;
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:before="0" w:after="80"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:color w:val="000000"/><w:sz w:val="46"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:i/><w:color w:val="666666"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`;
    return {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
      'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      'word/document.xml': documentXml,
      'word/styles.xml': stylesXml,
      'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(entry?.title || 'Transkrypt')}</dc:title><dc:creator>Skryptorium Głosów</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
      'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Skryptorium Głosów</Application></Properties>`,
    };
  }

  function columnLetter(index) {
    let value = index + 1;
    let result = '';
    while (value) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
    return result;
  }

  function xlsxSheetXml(rows, explicitColumns = null) {
    const list = Array.isArray(rows) ? rows : [];
    const columns = explicitColumns || [...new Set(list.flatMap(row => Object.keys(row || {})))];
    const data = [Object.fromEntries(columns.map(column => [column, column])), ...list];
    const sheetRows = data.map((row, rowIndex) => {
      const cells = columns.map((column, columnIndex) => {
        const ref = `${columnLetter(columnIndex)}${rowIndex + 1}`;
        const value = row?.[column];
        if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}" s="${rowIndex ? 3 : 1}"><v>${value}</v></c>`;
        const stringValue = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value == null ? '' : value);
        return `<c r="${ref}" t="inlineStr" s="${rowIndex ? 2 : 1}"><is><t xml:space="preserve">${escapeXml(stringValue)}</t></is></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="24" customHeight="1"' : ''}>${cells}</row>`;
    }).join('');
    const last = `${columnLetter(Math.max(0, columns.length - 1))}${Math.max(1, data.length)}`;
    const cols = columns.map((column, index) => {
      const sampleWidth = Math.max(column.length, ...list.slice(0, 100).map(row => String(row?.[column] == null ? '' : row[column]).length));
      const width = Math.min(46, Math.max(12, sampleWidth + 3));
      return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData>${columns.length ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`;
  }

  function buildXlsxPackage(entries) {
    const tables = archiveTables(entries);
    const sheets = [
      ['Wpisy', tables.entries, ARCHIVE_COLUMNS.entries],
      ['Pojecia', tables.concepts, ARCHIVE_COLUMNS.concepts],
      ['Metody', tables.methods, ARCHIVE_COLUMNS.methods],
      ['Segmenty', tables.segments, ARCHIVE_COLUMNS.segments],
    ];
    const workbookSheets = sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet[0])}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
    const rels = sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
    const overrides = sheets.map((sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
    const files = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF215A6D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFD9E2E6"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
      'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Eksport archiwum Skryptorium</dc:title><dc:creator>Skryptorium Głosów</dc:creator></cp:coreProperties>`,
      'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Skryptorium Głosów</Application></Properties>`,
    };
    sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = xlsxSheetXml(sheet[1], sheet[2]); });
    return files;
  }

  function tokenizePolish(text) {
    const stopwords = new Set(['oraz','jest','sie','się','dla','jak','ale','nie','tak','ten','ta','to','na','do','od','po','za','ze','że','we','w','z','i','a','o','u','co','czy','by','być','są','był','była','który','która','które','przez','jako','tego','tym','ich','jego','jej']);
    return normalizeKey(text).split(' ').filter(token => token.length >= 3 && !stopwords.has(token));
  }

  function computeTfIdf(entries, maxTerms = 12) {
    const docs = (entries || []).map(entry => ({ entry, tokens: tokenizePolish(entry?.transcript || entry?.transcriptRaw || '') }));
    const df = new Map();
    docs.forEach(doc => new Set(doc.tokens).forEach(token => df.set(token, (df.get(token) || 0) + 1)));
    return docs.map(doc => {
      const counts = new Map();
      doc.tokens.forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
      const terms = [...counts].map(([term, count]) => ({ term, score: (count / Math.max(1, doc.tokens.length)) * (Math.log((docs.length + 1) / ((df.get(term) || 0) + 1)) + 1), count }))
        .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term, 'pl')).slice(0, maxTerms);
      return { entryId: doc.entry?.id, title: doc.entry?.title, terms };
    });
  }

  function archiveTrends(entries, maxTerms = 8) {
    const groups = new Map();
    for (const entry of (entries || [])) {
      const period = normalizeDate(entry?.createdAt).slice(0, 7) || 'bez-daty';
      if (!groups.has(period)) groups.set(period, []);
      groups.get(period).push(entry);
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([period, grouped]) => {
      const counts = new Map();
      grouped.flatMap(entry => tokenizePolish(entry?.transcript || entry?.transcriptRaw || '')).forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
      return { period, entries: grouped.length, terms: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pl')).slice(0, maxTerms).map(([term, count]) => ({ term, count })) };
    });
  }

  function cooccurrence(entries, options = {}) {
    const windowSize = Math.max(2, Number(options.windowSize) || 8);
    const maxEdges = Math.max(1, Number(options.maxEdges) || 40);
    const pairs = new Map();
    for (const entry of (entries || [])) {
      const tokens = tokenizePolish(entry?.transcript || entry?.transcriptRaw || '');
      for (let index = 0; index < tokens.length; index += 1) {
        for (let other = index + 1; other < Math.min(tokens.length, index + windowSize); other += 1) {
          if (tokens[index] === tokens[other]) continue;
          const key = [tokens[index], tokens[other]].sort().join('|');
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      }
    }
    return [...pairs].map(([key, weight]) => { const [source, target] = key.split('|'); return { source, target, weight }; })
      .sort((a, b) => b.weight - a.weight || `${a.source}|${a.target}`.localeCompare(`${b.source}|${b.target}`, 'pl')).slice(0, maxEdges);
  }

  function speechStats(entry) {
    const segments = entry?.segments || [];
    const duration = Math.max(Number(entry?.durationSec) || 0, ...segments.map(segment => Number(segment?.end) || 0));
    const words = String(entry?.transcript || entry?.transcriptRaw || '').trim().split(/\s+/).filter(Boolean).length;
    const speakers = new Map();
    let turns = 0;
    let previousSpeaker = null;
    segments.forEach(segment => {
      const speaker = String(segment?.speakerLabel || segment?.speakerId || 'Nieoznaczony');
      if (speaker !== previousSpeaker) turns += 1;
      previousSpeaker = speaker;
      const stat = speakers.get(speaker) || { speaker, seconds: 0, words: 0, segments: 0 };
      stat.seconds += Math.max(0, (Number(segment?.end) || 0) - (Number(segment?.start) || 0));
      stat.words += String(segment?.text || '').split(/\s+/).filter(Boolean).length;
      stat.segments += 1;
      speakers.set(speaker, stat);
    });
    return {
      durationSec: duration,
      words,
      wordsPerMinute: duration ? Number((words / (duration / 60)).toFixed(1)) : 0,
      averageSegmentSec: segments.length ? Number((segments.reduce((sum, segment) => sum + Math.max(0, (Number(segment.end) || 0) - (Number(segment.start) || 0)), 0) / segments.length).toFixed(1)) : 0,
      speakerTurns: turns,
      speakers: [...speakers.values()].map(stat => ({ ...stat, share: duration ? Number((stat.seconds / duration).toFixed(3)) : 0 })),
    };
  }

  function buildSourceChapters(entry, targetSeconds = 300) {
    const segments = (entry?.segments || [])
      .map((segment, index) => ({ ...segment, _sourceIndex: index }))
      .filter(segment => String(segment?.text || '').trim() && Number.isFinite(Number(segment?.start)));
    if (!segments.length) return [];
    const chapters = [];
    let bucket = [];
    const flush = () => {
      if (!bucket.length) return;
      const text = bucket.map(segment => segment.text).join(' ');
      const counts = new Map();
      tokenizePolish(text).forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
      const keywords = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pl')).slice(0, 4).map(([term]) => term);
      const chapterId = `chapter-${chapters.length + 1}-${stableHash(text).slice(0, 8)}`;
      const startTime = Number(bucket[0].start) || 0;
      const endTime = Number(bucket[bucket.length - 1].end) || Number(bucket[bucket.length - 1].start) || 0;
      chapters.push({
        id: chapterId,
        chapterId,
        title: keywords.length ? keywords.map(term => term[0].toUpperCase() + term.slice(1)).join(' · ') : `Rozdział ${chapters.length + 1}`,
        start: startTime,
        end: endTime,
        startTime,
        endTime,
        summary: text.length > 320 ? text.slice(0, 317).trimEnd() + '…' : text,
        keywords,
        segmentIds: bucket.map(segment => segment.segmentId || stableSegmentId(segment, segment._sourceIndex)),
        chunkIds: [],
        mode: 'structural',
        model: 'deterministic',
        promptVersion: 'structural-v1',
      });
      bucket = [];
    };
    for (const segment of segments) {
      if (bucket.length && Number(segment.start) - Number(bucket[0].start) >= targetSeconds) flush();
      bucket.push(segment);
    }
    flush();
    return chapters;
  }

  function buildSemanticChapterChunks(entry, targetSeconds = 180) {
    const source = (entry?.segments || [])
      .map((segment, index) => ({
        ...segment,
        _sourceIndex: index,
        start: Number(segment?.start),
        end: Number(segment?.end),
        text: String(segment?.text || '').trim(),
      }))
      .filter(segment => segment.text && Number.isFinite(segment.start));
    if (!source.length) return [];
    const chunks = [];
    let bucket = [];
    const flush = () => {
      if (!bucket.length) return;
      const segmentIds = bucket.map(segment => segment.segmentId || stableSegmentId(segment, segment._sourceIndex));
      const startTime = bucket[0].start;
      const endTime = Number.isFinite(bucket[bucket.length - 1].end) ? bucket[bucket.length - 1].end : bucket[bucket.length - 1].start;
      chunks.push({
        chunkId: `chapter-chunk-${chunks.length + 1}-${stableHash(`${entry?.id || ''}|${segmentIds.join('|')}`).slice(0, 10)}`,
        startTime,
        endTime,
        segmentIds,
        text: bucket.map(segment => segment.text).join(' '),
      });
      bucket = [];
    };
    for (const segment of source) {
      if (bucket.length && segment.start - bucket[0].start >= Math.max(30, Number(targetSeconds) || 180)) flush();
      bucket.push(segment);
    }
    flush();
    return chunks;
  }

  function validateSemanticChapterPlan(entry, chunks, plan, options = {}) {
    const fallback = () => buildSourceChapters(entry, options.structuralTargetSeconds || 300);
    const fail = error => ({ valid: false, error, chapters: fallback() });
    const sourceChunks = Array.isArray(chunks) ? chunks : [];
    const groups = Array.isArray(plan) ? plan : plan?.chapters;
    if (!sourceChunks.length) return fail('Brak źródłowych chunków.');
    if (!Array.isArray(groups) || !groups.length) return fail('Model nie zwrócił rozdziałów.');
    const expectedIds = sourceChunks.map(chunk => chunk.chunkId);
    const known = new Map(sourceChunks.map(chunk => [chunk.chunkId, chunk]));
    const flattened = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.chunkIds) || !group.chunkIds.length) return fail('Rozdział bez chunków.');
      for (const chunkId of group.chunkIds) {
        if (!known.has(chunkId)) return fail(`Nieznany chunk: ${chunkId}`);
        flattened.push(chunkId);
      }
    }
    if (flattened.length !== expectedIds.length) return fail('Niepełne albo zduplikowane pokrycie chunków.');
    if (flattened.some((chunkId, index) => chunkId !== expectedIds[index])) return fail('Nieprawidłowa kolejność lub nieciągłe grupy chunków.');

    const model = String(options.model || 'unknown');
    const promptVersion = String(options.promptVersion || 'semantic-chapters-v1');
    const chapters = groups.map((group, index) => {
      const selected = group.chunkIds.map(chunkId => known.get(chunkId));
      const segmentIds = [...new Set(selected.flatMap(chunk => chunk.segmentIds || []))];
      const startTime = selected[0].startTime;
      const endTime = selected[selected.length - 1].endTime;
      const chapterId = `semantic-chapter-${index + 1}-${stableHash(group.chunkIds.join('|')).slice(0, 10)}`;
      return {
        id: chapterId,
        chapterId,
        title: String(group.title || `Rozdział ${index + 1}`).trim() || `Rozdział ${index + 1}`,
        summary: String(group.summary || '').trim(),
        start: startTime,
        end: endTime,
        startTime,
        endTime,
        segmentIds,
        chunkIds: [...group.chunkIds],
        mode: 'semantic',
        model,
        promptVersion,
      };
    });
    return { valid: true, error: '', chapters };
  }


  // ============ ROUND 4: TRANSCRIPT QUALITY & CORRECTION ============
  /**
   * Ocena pewności segmentu na podstawie metryk Whispera.
   * 'low'   — model był wyraźnie niepewny albo segment się zapętlał,
   * 'check' — warto odsłuchać,
   * 'ok'    — brak sygnałów ostrzegawczych (albo brak metryk, np. import).
   */
  function segmentConfidence(segment) {
    const reasons = [];
    const logProb = Number(segment?.avgLogProb);
    const noSpeech = Number(segment?.noSpeechProb);
    const ratio = Number(segment?.compressionRatio);
    let level = 'ok';
    if (segment?.collapsedLoop) { reasons.push('zapętlenie'); level = 'low'; }
    if (Number.isFinite(ratio) && ratio > 2.4) { reasons.push('powtórzenia'); level = 'low'; }
    if (Number.isFinite(logProb) && logProb < -1.0) { reasons.push('niska pewność'); level = 'low'; }
    else if (Number.isFinite(logProb) && logProb < -0.7) { reasons.push('średnia pewność'); if (level === 'ok') level = 'check'; }
    if (Number.isFinite(noSpeech) && noSpeech > 0.6) { reasons.push('możliwa cisza/szum'); if (level === 'ok') level = 'check'; }
    if (segment?.edited) return { level: 'ok', reasons: ['poprawione ręcznie'] };
    return { level, reasons };
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Regex całego słowa/frazy odporny na polskie znaki (granice liter Unicode). */
  function wholeWordRegex(find, ignoreCase = true) {
    const term = String(find || '').trim();
    if (!term) return null;
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, ignoreCase ? 'giu' : 'gu');
  }

  function replaceInText(text, find, replacement, options = {}) {
    const regex = wholeWordRegex(find, options.ignoreCase !== false);
    const source = String(text || '');
    if (!regex) return { text: source, count: 0 };
    let count = 0;
    const out = source.replace(regex, () => { count += 1; return String(replacement); });
    return { text: out, count };
  }

  function countInEntry(entry, find, options = {}) {
    const regex = wholeWordRegex(find, options.ignoreCase !== false);
    if (!regex) return 0;
    const count = text => (String(text || '').match(regex) || []).length;
    const segmentCount = (entry?.segments || []).reduce((sum, segment) => sum + count(segment.text), 0);
    return Math.max(count(entry?.transcript), segmentCount) + count(entry?.cleanTranscript);
  }

  /**
   * Zamienia frazę w polach roboczych wpisu: transkrypt roboczy, oczyszczony,
   * segmenty (z zachowaniem originalText). transcriptRaw NIGDY nie jest ruszany.
   */
  function replaceInEntry(entry, find, replacement, options = {}) {
    const fields = { transcript: 0, cleanTranscript: 0, segments: 0 };
    if (!entry) return { count: 0, fields };
    for (const field of ['transcript', 'cleanTranscript']) {
      const result = replaceInText(entry[field], find, replacement, options);
      if (result.count) { entry[field] = result.text; fields[field] = result.count; }
    }
    (entry.segments || []).forEach(segment => {
      const result = replaceInText(segment.text, find, replacement, options);
      if (!result.count) return;
      if (segment.originalText === undefined) segment.originalText = segment.text;
      segment.text = result.text;
      segment.edited = true;
      fields.segments += result.count;
    });
    return { count: Math.max(fields.transcript, fields.segments) + fields.cleanTranscript, fields };
  }

  /**
   * Ręczna korekta jednego segmentu z osi czasu. Zmiana trafia też do
   * transkryptu roboczego, jeśli stary tekst występuje w nim dokładnie raz
   * (inaczej nie zgadujemy miejsca i zgłaszamy to wywołującemu).
   */
  function applySegmentEdit(entry, index, newText) {
    const segment = entry?.segments?.[index];
    const text = String(newText || '').replace(/\s+/g, ' ').trim();
    if (!segment || !text || text === segment.text) return { changed: false, propagated: false };
    const oldText = String(segment.text || '');
    if (segment.originalText === undefined) segment.originalText = oldText;
    segment.text = text;
    segment.edited = true;
    let propagated = false;
    const working = String(entry.transcript || '');
    const first = oldText ? working.indexOf(oldText) : -1;
    if (first !== -1 && working.indexOf(oldText, first + 1) === -1) {
      entry.transcript = working.slice(0, first) + text + working.slice(first + oldText.length);
      propagated = true;
    }
    return { changed: true, propagated };
  }

  /** Dopisuje termin do listy hotwords (po przecinku), bez duplikatów. */
  function mergeHotwords(existing, term) {
    const items = String(existing || '').split(',').map(item => item.trim()).filter(Boolean);
    const clean = String(term || '').trim();
    if (clean && !items.some(item => item.toLowerCase() === clean.toLowerCase())) items.push(clean);
    return items.join(', ');
  }

  /** Podsumowanie jakości transkrypcji do chipów na karcie wpisu. */
  function transcriptQualitySummary(entry) {
    const segments = entry?.segments || [];
    let low = 0; let check = 0; let edited = 0; let repaired = 0;
    for (const segment of segments) {
      const { level } = segmentConfidence(segment);
      if (level === 'low') low += 1; else if (level === 'check') check += 1;
      if (segment.edited) edited += 1;
      if (segment.repaired) repaired += 1;
    }
    const quality = entry?.transcriptionQuality || {};
    return {
      low, check, edited,
      repaired: Math.max(repaired, Number(quality.repaired) || 0),
      removed: Number(quality.removedCount) || 0,
      flagged: low + check,
    };
  }

  function aggregateArchive(entries) {
    const collectStrings = field => {
      const map = new Map();
      (entries || []).forEach(entry => (entry?.[field] || []).forEach(value => {
        const key = normalizeKey(value);
        if (!key) return;
        const source = findSourceForText(entry, value);
        const item = map.get(key) || { value: String(value), sources: [], _sourceIds: new Set() };
        if (String(value).length > item.value.length) item.value = String(value);
        if (!item._sourceIds.has(entry.id)) {
          item.sources.push({ entryId: entry.id, title: entry.title, start: source?.start ?? null, text: source?.text || String(value) });
          item._sourceIds.add(entry.id);
        }
        map.set(key, item);
      }));
      return [...map.values()].map(({ _sourceIds, ...item }) => item)
        .sort((a, b) => b.sources.length - a.sources.length || a.value.localeCompare(b.value, 'pl'));
    };
    const collectPairs = (field, keyA, keyB) => {
      const map = new Map();
      (entries || []).forEach(entry => (entry?.[field] || []).forEach(value => {
        const key = normalizeKey(value?.[keyA]);
        if (!key) return;
        const source = findSourceForText(entry, `${value?.[keyA] || ''} ${value?.[keyB] || ''}`)
          || findSourceForText(entry, value?.[keyA])
          || findSourceForText(entry, value?.[keyB]);
        const item = map.get(key) || { [keyA]: String(value?.[keyA] || ''), [keyB]: String(value?.[keyB] || ''), sources: [], _sourceIds: new Set() };
        if (String(value?.[keyB] || '').length > item[keyB].length) item[keyB] = String(value[keyB]);
        if (!item._sourceIds.has(entry.id)) {
          item.sources.push({ entryId: entry.id, title: entry.title, start: source?.start ?? null, text: source?.text || '' });
          item._sourceIds.add(entry.id);
        }
        map.set(key, item);
      }));
      return [...map.values()].map(({ _sourceIds, ...item }) => item)
        .sort((a, b) => b.sources.length - a.sources.length || a[keyA].localeCompare(b[keyA], 'pl'));
    };
    return {
      concepts: collectPairs('concepts', 'term', 'definition'),
      methods: collectPairs('methods', 'name', 'description'),
      theses: collectStrings('theses'),
      recommendations: collectStrings('recommendations'),
    };
  }

  return {
    PROCESSING_PROFILES,
    activeSegmentIndex,
    analysisFingerprint,
    aggregateArchive,
    applySegmentEdit,
    archiveTables,
    archiveTrends,
    buildChunkContext,
    buildCsvExports,
    buildDocxPackage,
    buildSearchIndex,
    buildSemanticChapterChunks,
    buildSourceChapters,
    buildXlsxPackage,
    chunkEntry,
    chunkSegments,
    chunkText,
    clone,
    cooccurrence,
    computeTfIdf,
    countInEntry,
    mergeHotwords,
    replaceInEntry,
    replaceInText,
    segmentConfidence,
    transcriptQualitySummary,
    wholeWordRegex,
    deterministicCleanTranscript,
    estimateProcessing,
    findSourceForText,
    formatSRT,
    formatSubtitleTimestamp,
    formatVTT,
    isAbortError,
    isTransientError,
    mergeAnalyses,
    migrateLegacyEntries,
    normalizeKey,
    parseDocxXml,
    parseAIJSON,
    parseImportedDocument,
    parseStructuredJSON,
    parseTimedText,
    rawTranscriptUnchanged,
    resolveProcessingProfile,
    searchArchive,
    sessionProfile,
    stableChunkId,
    stableHash,
    stableSegmentId,
    stripMarkdownFence,
    speechStats,
    toCSV,
    tokenizePolish,
    validateCleanup,
    validateSemanticChapterPlan,
    validateJSONSchema,
    verifyMigratedEntries,
    withRetry,
  };
});
