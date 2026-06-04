/**
 * Handles runtime messages from extension components.
 * Processes style updates for YouTube Music tabs and settings updates.
 *
 * @param {Object} request - The message request object
 * @param {string} request.action - The action type ('applyStyles' or 'updateSettings')
 * @param {string} [request.ricsSource] - RICS source code for applyStyles action
 * @param {Object} [request.settings] - Settings object for updateSettings action
 * @returns {boolean} Returns true to indicate asynchronous response
 */
import { LOG_PREFIX_BACKGROUND } from "@constants";
import { getLocalStorage, getSyncStorage } from "@core/storage";
import { initBackgroundAuth } from "@modules/auth/backgroundAuth";
import {
  getInstalledStoreThemes,
  installSymlinkedThemeFromMarketplace,
  performSilentUpdates,
  performUrlThemeUpdates,
  setActiveStoreTheme,
} from "./store/themeStoreManager";
import { fetchAllStoreThemes } from "./store/themeStoreService";

const THEME_UPDATE_ALARM = "theme-update-check";
const UPDATE_INTERVAL_MINUTES = 360; // 6 hours
const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiTranslationLine {
  id: number;
  text: string;
}

interface GeminiTranslationRequest {
  action: "translateLyricsWithGemini";
  requestId: string;
  payload: {
    lines: GeminiTranslationLine[];
    targetLanguage: string;
    sourceLanguage?: string;
    song?: string;
    artist?: string;
    album?: string;
    model: string;
    baseUrl: string;
    thinkingLevel: "high";
  };
}

interface GeminiTranslationResponseLine {
  id: number;
  translation: string;
  notes: {
    term: string;
    explanation: string;
  }[];
}

interface GeminiTranslationResponsePayload {
  sourceLanguage: string;
  lines: GeminiTranslationResponseLine[];
}

const geminiTranslationControllers = new Map<string, AbortController>();

function normalizeGeminiBaseUrl(baseUrl: string | undefined): string {
  const normalized = (baseUrl || GEMINI_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return normalized || GEMINI_DEFAULT_BASE_URL;
}

function buildGeminiTranslationSchema(lineCount: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sourceLanguage: {
        type: "string",
        description: "Detected source language BCP-47 code, such as en, ja, ko, or zh-CN.",
      },
      lines: {
        type: "array",
        minItems: lineCount,
        maxItems: lineCount,
        items: {
          type: "object",
          properties: {
            id: {
              type: "integer",
              description: "The original lyric line id. Must match one input id exactly.",
            },
            translation: {
              type: "string",
              description: "The translated lyric line in the target language.",
            },
            notes: {
              type: "array",
              description: "Short cultural, slang, allusion, proper noun, or wordplay notes for this line.",
              items: {
                type: "object",
                properties: {
                  term: {
                    type: "string",
                    description: "The source lyric term or phrase being explained.",
                  },
                  explanation: {
                    type: "string",
                    description: "A concise explanation in the target language.",
                  },
                },
                required: ["term", "explanation"],
              },
            },
          },
          required: ["id", "translation", "notes"],
        },
      },
    },
    required: ["sourceLanguage", "lines"],
  };
}

function buildGeminiTranslationPrompt(payload: GeminiTranslationRequest["payload"]): string {
  return [
    "Translate the following song lyrics as one complete work.",
    "",
    `Song: ${payload.song || "Unknown"}`,
    `Artist: ${payload.artist || "Unknown"}`,
    `Album: ${payload.album || "Unknown"}`,
    `Source language: ${payload.sourceLanguage || "auto"}`,
    `Target language: ${payload.targetLanguage}`,
    "",
    "Rules:",
    "1. Preserve the one-to-one mapping between each input id and each output line.",
    "2. Translate the lyric meaning, tone, imagery, subtext, and musical phrasing. Do not translate mechanically word-by-word.",
    "3. Keep repeated lines naturally repeated unless context requires a small variation.",
    "4. Only add notes for culture-specific terms, slang, allusions, proper nouns, or wordplay. If a line needs no note, return an empty notes array.",
    "5. Keep notes concise and write them in the target language.",
    "6. Return only JSON that matches the schema.",
    "",
    "Lyrics JSON:",
    JSON.stringify(payload.lines),
  ].join("\n");
}

function parseGeminiJsonText(text: string): GeminiTranslationResponsePayload {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(withoutFence) as GeminiTranslationResponsePayload;
}

async function handleGeminiTranslation(request: GeminiTranslationRequest) {
  const { payload, requestId } = request;
  const { geminiTranslationApiKey } = await chrome.storage.local.get({ geminiTranslationApiKey: "" });
  const apiKey = typeof geminiTranslationApiKey === "string" ? geminiTranslationApiKey.trim() : "";
  if (!apiKey) {
    return { success: false, error: "Gemini API key is not configured" };
  }

  const model = payload.model.trim() || "gemini-3.5-flash";
  const baseUrl = normalizeGeminiBaseUrl(payload.baseUrl);
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const abortController = new AbortController();
  geminiTranslationControllers.set(requestId, abortController);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text:
                "You are a professional song lyric translator and cultural annotator. " +
                "You must return valid JSON only, preserve line ids exactly, and never add commentary outside JSON.",
            },
          ],
        },
        contents: [
          {
            role: "user",
            parts: [{ text: buildGeminiTranslationPrompt(payload) }],
          },
        ],
        generationConfig: {
          temperature: 0.45,
          responseMimeType: "application/json",
          responseJsonSchema: buildGeminiTranslationSchema(payload.lines.length),
          thinkingConfig: {
            thinkingLevel: payload.thinkingLevel,
          },
        },
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      return { success: false, error: `Gemini API returned ${response.status}: ${await response.text()}` };
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("");
    if (!text) {
      return { success: false, error: "Gemini response did not include text" };
    }

    const parsed = parseGeminiJsonText(text);
    return {
      success: true,
      detectedLanguage: parsed.sourceLanguage || "",
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
    };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      return { success: false, error: "Gemini translation was aborted" };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    geminiTranslationControllers.delete(requestId);
  }
}

// -- Symlinked Theme Migration --------------------------

const SYMLINKED_MIGRATION_KEY = "symlinkedMigrationVersion";
const SYMLINKED_MIGRATION_VERSION = 1;

const SYMLINKED_THEME_MAP: Record<string, string> = {
  Minimal: "minimal",
  "Dynamic Background": "dynamic-background",
  "Apple Music": "apple-music",
};

const SYNC_STORAGE_LIMIT = 7000;

async function saveThemeCSS(css: string, title: string, creators: string[]): Promise<void> {
  const themeContent = `/* ${title}, a marketplace theme by ${creators.join(", ")} */\n\n${css}\n`;
  const cssSize = new Blob([themeContent]).size;

  if (cssSize <= SYNC_STORAGE_LIMIT) {
    await chrome.storage.sync.set({ customCSS: themeContent, cssStorageType: "sync", cssCompressed: false });
  } else {
    await chrome.storage.local.set({ customCSS: themeContent, cssCompressed: false });
    await chrome.storage.sync.set({ cssStorageType: "local", cssCompressed: false });
    await chrome.storage.sync.remove("customCSS");
  }
}

async function migrateSymlinkedThemes(): Promise<void> {
  try {
    const result = await getLocalStorage<{ [SYMLINKED_MIGRATION_KEY]?: number }>([SYMLINKED_MIGRATION_KEY]);
    if ((result[SYMLINKED_MIGRATION_KEY] ?? 0) >= SYMLINKED_MIGRATION_VERSION) return;

    const syncData = await getSyncStorage<{ themeName?: string }>(["themeName"]);
    const themeName = syncData.themeName;

    if (themeName && !themeName.startsWith("store:")) {
      const storeId = SYMLINKED_THEME_MAP[themeName];
      if (storeId) {
        console.log(LOG_PREFIX_BACKGROUND, `Migrating symlinked theme: ${themeName} → store:${storeId}`);
        await chrome.storage.sync.set({ themeName: `store:${storeId}` });
        await setActiveStoreTheme(storeId);
        const installed = await installSymlinkedThemeFromMarketplace(storeId);
        if (!installed) {
          await chrome.storage.sync.set({ themeName });
          await chrome.storage.sync.remove("activeStoreTheme");
          return;
        }
        await saveThemeCSS(installed.css, installed.title, installed.creators);
        console.log(LOG_PREFIX_BACKGROUND, `Migrated active theme: ${themeName} → store:${storeId}`);
      }
    }

    await chrome.storage.local.set({ [SYMLINKED_MIGRATION_KEY]: SYMLINKED_MIGRATION_VERSION });
  } catch (err) {
    console.warn(LOG_PREFIX_BACKGROUND, "Symlinked themes migration failed:", err);
  }
}

async function checkAndApplyThemeUpdates(): Promise<void> {
  try {
    const installed = await getInstalledStoreThemes();
    if (installed.length === 0) return;

    console.log(LOG_PREFIX_BACKGROUND, "Checking for theme updates...");
    const storeThemes = await fetchAllStoreThemes();
    const marketplaceUpdatedIds = await performSilentUpdates(storeThemes);
    const urlUpdatedIds = await performUrlThemeUpdates();
    const updatedIds = [...marketplaceUpdatedIds, ...urlUpdatedIds];

    if (updatedIds.length > 0) {
      console.log(LOG_PREFIX_BACKGROUND, `Updated ${updatedIds.length} theme(s):`, updatedIds.join(", "));
    }
  } catch (err) {
    console.warn(LOG_PREFIX_BACKGROUND, "Theme update check failed:", err);
  }
}

function setupThemeUpdateAlarm(): void {
  chrome.alarms.get(THEME_UPDATE_ALARM, existingAlarm => {
    if (!existingAlarm) {
      chrome.alarms.create(THEME_UPDATE_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: UPDATE_INTERVAL_MINUTES,
      });
      console.log(LOG_PREFIX_BACKGROUND, "Theme update alarm created");
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  setupThemeUpdateAlarm();
  await migrateSymlinkedThemes();
  checkAndApplyThemeUpdates();
});

chrome.runtime.onStartup.addListener(async () => {
  setupThemeUpdateAlarm();
  await migrateSymlinkedThemes();
  checkAndApplyThemeUpdates();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === THEME_UPDATE_ALARM) {
    checkAndApplyThemeUpdates();
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "translateLyricsWithGemini") {
    handleGeminiTranslation(request as GeminiTranslationRequest).then(sendResponse);
    return true;
  }

  if (request.action === "cancelGeminiTranslation") {
    const requestId = typeof request.requestId === "string" ? request.requestId : "";
    geminiTranslationControllers.get(requestId)?.abort();
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "applyStyles") {
    chrome.tabs.query({ url: "*://music.youtube.com/*" }, tabs => {
      tabs.forEach(tab => {
        if (tab.id != null) {
          chrome.tabs.sendMessage(tab.id, { action: "applyStyles", ricsSource: request.ricsSource }).catch(err => {
            console.warn(LOG_PREFIX_BACKGROUND, `Failed to send message to tab ${tab.id}:`, err);
          });
        }
      });
    });
  }
  return true;
});

initBackgroundAuth();
