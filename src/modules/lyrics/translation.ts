import { TRANSLATE_IN_ROMAJI, TRANSLATION_ERROR_LOG } from "@constants";
import { log } from "@utils";

export const GEMINI_TRANSLATION_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_TRANSLATION_DEFAULT_MODEL = "gemini-3.5-flash";
export const GEMINI_TRANSLATION_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type GeminiTranslationThinkingLevel = (typeof GEMINI_TRANSLATION_THINKING_LEVELS)[number];
export const GEMINI_TRANSLATION_DEFAULT_THINKING_LEVEL: GeminiTranslationThinkingLevel = "medium";

export interface TranslationNote {
  term: string;
  explanation: string;
}

export interface TranslationResult {
  originalLanguage: string;
  translatedText: string;
  notes?: TranslationNote[];
}

interface TranslationCache {
  romanization: Map<string, string>;
  songTranslation: Map<string, BatchTranslationResponse>;
}

const cache: TranslationCache = {
  romanization: new Map(),
  songTranslation: new Map(),
};

interface BatchRequest {
  lines: string[];
  targetLanguage?: string; // For translations
  sourceLanguage?: string; // For romanizations
  signal?: AbortSignal;
}

interface GeminiTranslationRequest extends BatchRequest {
  song?: string;
  artist?: string;
  album?: string;
  model?: string;
  baseUrl?: string;
  thinkingLevel?: GeminiTranslationThinkingLevel;
}

export interface BatchTranslationResponse {
  results: (TranslationResult | null)[];
  detectedLanguage: string;
}

interface BatchRomanizationResponse {
  results: (string | null)[];
  detectedLanguage: string;
}

interface GeminiTranslationMessage {
  action: "translateLyricsWithGemini";
  requestId: string;
  payload: {
    lines: { id: number; text: string }[];
    targetLanguage: string;
    sourceLanguage?: string;
    song?: string;
    artist?: string;
    album?: string;
    model: string;
    baseUrl: string;
    thinkingLevel: GeminiTranslationThinkingLevel;
  };
}

interface GeminiTranslationResponse {
  success: boolean;
  detectedLanguage?: string;
  lines?: {
    id: number;
    translation: string;
    notes?: TranslationNote[];
  }[];
  error?: string;
}

const BATCH_SEPARATOR = "\n\n;\n\n";
const MAX_URL_LENGTH = 15000;
const SONG_TRANSLATION_CACHE_VERSION = 1;
const SONG_TRANSLATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface PersistedSongTranslationCache {
  version: typeof SONG_TRANSLATION_CACHE_VERSION;
  fingerprint: string;
  expiresAt: number;
  response: BatchTranslationResponse;
}

function normalizeTranslationNote(note: Partial<TranslationNote> | null | undefined): TranslationNote | null {
  const term = typeof note?.term === "string" ? note.term.trim() : "";
  const explanation = typeof note?.explanation === "string" ? note.explanation.trim() : "";
  if (!term || !explanation) return null;
  return { term, explanation };
}

export function normalizeGeminiTranslationThinkingLevel(value: unknown): GeminiTranslationThinkingLevel {
  if (typeof value !== "string") return GEMINI_TRANSLATION_DEFAULT_THINKING_LEVEL;
  return (GEMINI_TRANSLATION_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as GeminiTranslationThinkingLevel)
    : GEMINI_TRANSLATION_DEFAULT_THINKING_LEVEL;
}

function buildSongTranslationCacheKey(request: Required<Pick<GeminiTranslationRequest, "targetLanguage">> &
  Pick<
    GeminiTranslationRequest,
    "sourceLanguage" | "song" | "artist" | "album" | "model" | "baseUrl" | "thinkingLevel"
  > & {
    lines: string[];
  }): string {
  return JSON.stringify({
    targetLanguage: request.targetLanguage,
    sourceLanguage: request.sourceLanguage || "auto",
    model: request.model || GEMINI_TRANSLATION_DEFAULT_MODEL,
    baseUrl: request.baseUrl || GEMINI_TRANSLATION_DEFAULT_BASE_URL,
    thinkingLevel: normalizeGeminiTranslationThinkingLevel(request.thinkingLevel),
    song: request.song || "",
    artist: request.artist || "",
    album: request.album || "",
    lines: request.lines,
  });
}

function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

function getPersistentSongTranslationCacheKey(fingerprint: string): string {
  return `blyrics_translation_${hashString(fingerprint)}`;
}

async function getPersistentSongTranslation(
  fingerprint: string,
  expectedLineCount: number
): Promise<BatchTranslationResponse | null> {
  try {
    const storageKey = getPersistentSongTranslationCacheKey(fingerprint);
    const stored = (await chrome.storage.local.get({ [storageKey]: null }))[storageKey] as
      | PersistedSongTranslationCache
      | null;
    if (
      stored?.version !== SONG_TRANSLATION_CACHE_VERSION ||
      stored.fingerprint !== fingerprint ||
      stored.expiresAt < Date.now() ||
      stored.response?.results?.length !== expectedLineCount
    ) {
      if (stored) {
        chrome.storage.local.remove(storageKey).catch(error => {
          log(TRANSLATION_ERROR_LOG, "Failed to remove stale song translation cache", error);
        });
      }
      return null;
    }

    return stored.response;
  } catch (error) {
    log(TRANSLATION_ERROR_LOG, "Failed to read song translation cache", error);
    return null;
  }
}

async function setPersistentSongTranslation(
  fingerprint: string,
  response: BatchTranslationResponse
): Promise<void> {
  try {
    const storageKey = getPersistentSongTranslationCacheKey(fingerprint);
    const stored: PersistedSongTranslationCache = {
      version: SONG_TRANSLATION_CACHE_VERSION,
      fingerprint,
      expiresAt: Date.now() + SONG_TRANSLATION_CACHE_TTL_MS,
      response,
    };
    await chrome.storage.local.set({ [storageKey]: stored });
  } catch (error) {
    log(TRANSLATION_ERROR_LOG, "Failed to write song translation cache", error);
  }
}

function createRequestId(): string {
  return `gemini-translation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function sendGeminiTranslationMessage(
  message: GeminiTranslationMessage,
  signal?: AbortSignal
): Promise<GeminiTranslationResponse> {
  if (signal?.aborted) {
    throw new DOMException("Translation aborted", "AbortError");
  }

  const abortHandler = () => {
    chrome.runtime.sendMessage({ action: "cancelGeminiTranslation", requestId: message.requestId }).catch(() => {});
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    return (await chrome.runtime.sendMessage(message)) as GeminiTranslationResponse;
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

/**
 * Translates a full song with Gemini in one request so lyric context is preserved.
 */
export async function translateBatch(request: GeminiTranslationRequest): Promise<BatchTranslationResponse> {
  const {
    lines,
    targetLanguage,
    sourceLanguage,
    song,
    artist,
    album,
    signal,
    model = GEMINI_TRANSLATION_DEFAULT_MODEL,
    baseUrl = GEMINI_TRANSLATION_DEFAULT_BASE_URL,
    thinkingLevel: requestedThinkingLevel = GEMINI_TRANSLATION_DEFAULT_THINKING_LEVEL,
  } = request;
  const thinkingLevel = normalizeGeminiTranslationThinkingLevel(requestedThinkingLevel);

  if (!targetLanguage || lines.length === 0) {
    return { results: lines.map(() => null), detectedLanguage: "" };
  }

  const results: (TranslationResult | null)[] = new Array(lines.length).fill(null);
  const toTranslate = lines
    .map((line, index) => ({ id: index, text: line.trim() }))
    .filter(line => line.text && line.text !== "♪");

  if (toTranslate.length === 0) {
    return { results, detectedLanguage: sourceLanguage || "" };
  }

  const cacheKey = buildSongTranslationCacheKey({
    lines,
    targetLanguage,
    sourceLanguage,
    song,
    artist,
    album,
    model,
    baseUrl,
    thinkingLevel,
  });
  const cached = cache.songTranslation.get(cacheKey);
  if (cached) {
    return cached;
  }

  const persistentCached = await getPersistentSongTranslation(cacheKey, lines.length);
  if (persistentCached) {
    cache.songTranslation.set(cacheKey, persistentCached);
    return persistentCached;
  }

  try {
    const response = await sendGeminiTranslationMessage(
      {
        action: "translateLyricsWithGemini",
        requestId: createRequestId(),
        payload: {
          lines: toTranslate,
          targetLanguage,
          sourceLanguage,
          song,
          artist,
          album,
          model,
          baseUrl,
          thinkingLevel,
        },
      },
      signal
    );

    if (!response.success) {
      log(TRANSLATION_ERROR_LOG, response.error || "Gemini translation failed");
      return { results, detectedLanguage: sourceLanguage || "" };
    }

    const detectedLanguage = response.detectedLanguage || sourceLanguage || "";
    response.lines?.forEach(line => {
      const original = toTranslate.find(item => item.id === line.id);
      const translatedText = typeof line.translation === "string" ? line.translation.trim() : "";
      if (!original || !translatedText || translatedText.toLowerCase() === original.text.toLowerCase()) {
        return;
      }

      const notes = (line.notes || []).map(normalizeTranslationNote).filter((note): note is TranslationNote => !!note);
      const result: TranslationResult = {
        originalLanguage: detectedLanguage,
        translatedText,
        notes,
      };
      results[line.id] = result;
    });

    const batchResponse = { results, detectedLanguage };
    cache.songTranslation.set(cacheKey, batchResponse);
    await setPersistentSongTranslation(cacheKey, batchResponse);
    return batchResponse;
  } catch (error) {
    if ((error as Error).name !== "AbortError") {
      log(TRANSLATION_ERROR_LOG, error);
    }
  }

  return { results, detectedLanguage: sourceLanguage || "" };
}

/**
 * Romanizes a batch of lyric lines in a single request, chunked if necessary.
 */
export async function romanizeBatch(request: BatchRequest): Promise<BatchRomanizationResponse> {
  const { lines, sourceLanguage, signal } = request;
  if (lines.length === 0) {
    return { results: lines.map(() => null), detectedLanguage: "" };
  }

  const results: (string | null)[] = new Array(lines.length).fill(null);
  const toRomanize: { index: number; text: string }[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "♪") return;

    if (cache.romanization.has(trimmed)) {
      results[index] = cache.romanization.get(trimmed)!;
    } else {
      toRomanize.push({ index, text: trimmed });
    }
  });

  if (toRomanize.length === 0) {
    return { results, detectedLanguage: sourceLanguage || "auto" };
  }

  let detectedLanguage = sourceLanguage || "auto";

  const chunks: { index: number; text: string }[][] = [];
  let currentChunk: { index: number; text: string }[] = [];
  let currentEncodedLength = 0;

  const lang = sourceLanguage || "auto";
  const baseUrl = TRANSLATE_IN_ROMAJI(lang, "");
  const separatorEncoded = encodeURIComponent(BATCH_SEPARATOR);

  for (const item of toRomanize) {
    const itemEncoded = encodeURIComponent(item.text);
    const addedLength = (currentChunk.length > 0 ? separatorEncoded.length : 0) + itemEncoded.length;

    if (currentChunk.length > 0 && baseUrl.length + currentEncodedLength + addedLength > MAX_URL_LENGTH) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentEncodedLength = 0;
    }

    currentChunk.push(item);
    currentEncodedLength += (currentChunk.length > 1 ? separatorEncoded.length : 0) + itemEncoded.length;
  }
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  for (const chunk of chunks) {
    try {
      const combinedText = chunk.map(item => item.text).join(BATCH_SEPARATOR);
      const url = TRANSLATE_IN_ROMAJI(lang, combinedText);

      const response = await fetch(url, { cache: "force-cache", signal });
      const data = await response.json();

      detectedLanguage = data[2] || detectedLanguage;

      let fullRomanizedText = "";
      for (const part of data[0]) {
        if (!part) continue;
        const romanized = part[3] || part[2];
        if (romanized) {
          fullRomanizedText += romanized;
        }
      }

      let romanizedLines = fullRomanizedText.split(BATCH_SEPARATOR);

      if (romanizedLines.length < chunk.length) {
        const semicolonSplit = fullRomanizedText.split(";").filter(l => l.trim().length > 0);
        if (semicolonSplit.length === chunk.length) {
          romanizedLines = semicolonSplit;
        } else {
          const singleNewlineSplit = fullRomanizedText.split(/\r?\n/).filter(l => l.trim().length > 0);
          if (singleNewlineSplit.length === chunk.length) {
            romanizedLines = singleNewlineSplit;
          } else if (romanizedLines.length === 1 && chunk.length > 1) {
            log(TRANSLATION_ERROR_LOG, `Batch romanization failed to split: expected ${chunk.length} lines, got 1.`);
            romanizedLines = [];
          }
        }
      }

      chunk.forEach((item, i) => {
        const romanizedText = romanizedLines[i]?.trim();
        if (romanizedText && romanizedText.toLowerCase() !== item.text.toLowerCase()) {
          cache.romanization.set(item.text, romanizedText);
          results[item.index] = romanizedText;
        }
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        log(TRANSLATION_ERROR_LOG, error);
      }
    }
  }

  return { results, detectedLanguage };
}

export function clearCache(): void {
  cache.romanization.clear();
  cache.songTranslation.clear();
}

export function getRomanizationFromCache(text: string): string | null {
  return cache.romanization.get(text.trim()) || null;
}
