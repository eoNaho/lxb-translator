import { readFileSync, writeFileSync, existsSync } from "fs";
import { translate as unofficialTranslate } from "@vitalets/google-translate-api";
import { TranslationServiceClient } from "@google-cloud/translate";
import * as dotenv from "dotenv";

dotenv.config();

// Configuration
const CONFIG = {
  inputFile: "1stplaya.lxb",
  outputFile: "1stplaya_pt.lxb",
  cacheFile: "cache.json",
  encoding: "utf-8" as const,
  minStringLength: 3,
  requestLimit: 50,
  cooldownTime: 600000, // 10 minutes
  useGoogleApi: false, // true = API oficial, false = @vitalets/google-translate-api
  translateOptions: {
    to: "pt",
    from: "en",
  },
};

// Global state
const translationCache: Record<string, string> = {};
let requestCount = 0;
let translatedCount = 0;
let errorCount = 0;

// Initialize Google Cloud Translation client
const googleTranslateClient = new TranslationServiceClient({
  keyFilename: process.env.GOOGLE_API_KEY_FILE, // Caminho para o arquivo de credenciais
});

// Cache functions
function loadCache(): void {
  try {
    if (existsSync(CONFIG.cacheFile)) {
      const data = readFileSync(CONFIG.cacheFile, "utf-8");
      const parsed = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) {
        Object.assign(translationCache, parsed);
        console.log(
          `📦 Cache loaded: ${
            Object.keys(translationCache).length
          } translations`
        );
        return;
      }
    }
  } catch (error) {
    console.error(
      "⚠️ Error loading cache:",
      error instanceof Error ? error.message : error
    );
  }
  console.log("ℹ️ No valid cache found, starting from scratch...");
}

function saveCache(): void {
  try {
    writeFileSync(CONFIG.cacheFile, JSON.stringify(translationCache, null, 2));
    console.log("💾 Cache saved successfully!");
  } catch (error) {
    console.error(
      "⚠️ Error saving cache:",
      error instanceof Error ? error.message : error
    );
  }
}

// Buffer replacement function
function replaceInBuffer(
  source: Buffer,
  search: string,
  replace: string
): Buffer {
  const searchBuffer = Buffer.from(search, CONFIG.encoding);
  const replaceBuffer = Buffer.from(replace, CONFIG.encoding);

  let position = 0;
  const chunks: Buffer[] = [];

  while (position < source.length) {
    const index = source.indexOf(searchBuffer, position);

    if (index === -1) {
      chunks.push(source.subarray(position));
      break;
    }

    chunks.push(source.subarray(position, index));
    chunks.push(replaceBuffer);
    position = index + searchBuffer.length;
  }

  return Buffer.concat(chunks);
}

// String extraction function
function extractStrings(buffer: Buffer): string[] {
  const strings = new Set<string>();
  let current: number[] = [];
  let inDollarBlock = false;

  for (const byte of buffer) {
    if (byte === 0x24) {
      // Caractere '$'
      if (inDollarBlock) {
        // Fim do bloco $, adiciona a string completa
        const str = Buffer.from(current).toString(CONFIG.encoding);
        strings.add(`$${str}$`);
        current = [];
      }
      inDollarBlock = !inDollarBlock;
      continue;
    }

    if (inDollarBlock) {
      current.push(byte);
    } else if (byte >= 0x20 && byte <= 0x7e) {
      // ASCII imprimível
      current.push(byte);
    } else if (current.length >= CONFIG.minStringLength) {
      const str = Buffer.from(current).toString(CONFIG.encoding);
      if (/[a-zA-ZÀ-ÿ]/.test(str)) strings.add(str);
      current = [];
    } else {
      current = [];
    }
  }
  return Array.from(strings);
}

// Translation function with Google API
async function translateWithGoogleApi(text: string): Promise<string> {
  try {
    const [response] = await googleTranslateClient.translateText({
      parent: `projects/${process.env.GOOGLE_PROJECT_ID}/locations/global`,
      contents: [text],
      mimeType: "text/plain",
      sourceLanguageCode: CONFIG.translateOptions.from,
      targetLanguageCode: CONFIG.translateOptions.to,
    });

    return response.translations?.[0]?.translatedText || text;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`⚠️ Google API error: ${errorMessage}`);
    throw error;
  }
}

// Translation function with unofficial API
async function translateWithUnofficialApi(text: string): Promise<string> {
  try {
    const result = await unofficialTranslate(text, {
      to: CONFIG.translateOptions.to,
      from: CONFIG.translateOptions.from,
    });
    return result.text;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`⚠️ Unofficial API error: ${errorMessage}`);
    throw error;
  }
}

// Unified translation function
async function translateText(text: string): Promise<string> {
  // Ignora textos entre $$
  if (text.startsWith("$") && text.endsWith("$")) {
    return text;
  }

  if (translationCache[text]) return translationCache[text];
  if (text.length < CONFIG.minStringLength) return text;

  if (requestCount >= CONFIG.requestLimit) {
    console.log(
      `⏸️ Request limit of ${CONFIG.requestLimit} reached. Pausing...`
    );
    saveCache(); // Save before pausing
    await new Promise((resolve) => setTimeout(resolve, CONFIG.cooldownTime));
    requestCount = 0;
  }

  try {
    const translated = CONFIG.useGoogleApi
      ? await translateWithGoogleApi(text)
      : await translateWithUnofficialApi(text);

    translationCache[text] = translated;
    requestCount++;
    translatedCount++;

    // Save periodically
    if (translatedCount % 10 === 0) saveCache();

    return translated;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`⚠️ Translation error: ${errorMessage}`);
    errorCount++;
    return text;
  }
}

// Main function
async function main() {
  try {
    console.log("🚀 Starting translation with cache...");
    loadCache();

    if (!existsSync(CONFIG.inputFile)) {
      throw new Error(`File not found: ${CONFIG.inputFile}`);
    }

    const buffer = readFileSync(CONFIG.inputFile);
    const strings = extractStrings(buffer);
    console.log(`📊 Strings detected: ${strings.length}`);

    let newBuffer = buffer;
    for (const [index, str] of strings.entries()) {
      const translated = await translateText(str);
      newBuffer = replaceInBuffer(newBuffer, str, translated);

      // Update progress
      if ((index + 1) % 5 === 0) {
        console.log(
          `↻ ${index + 1}/${strings.length}`,
          `✓:${translatedCount}`,
          `✗:${errorCount}`,
          `Req:${requestCount}/${CONFIG.requestLimit}`
        );
      }
    }

    writeFileSync(CONFIG.outputFile, newBuffer);
    saveCache();

    console.log("\n✅ Translation completed!");
    console.log(`📝 Statistics:`);
    console.log(`- Translated strings: ${translatedCount}`);
    console.log(`- Errors: ${errorCount}`);
    console.log(`- Requests made: ${requestCount}`);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("\n🔥 Critical error:", errorMessage);
    process.exit(1);
  }
}

// Execute
main();
