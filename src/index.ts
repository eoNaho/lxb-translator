import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { translate as googleUnofficialTranslate } from "@vitalets/google-translate-api";
import { TranslationServiceClient } from "@google-cloud/translate";
import OpenAI from "openai";
import * as dotenv from "dotenv";
import { join } from "path";
import axios from "axios";
dotenv.config();

// Configuration with detailed comments
const CONFIG = {
  inputDir: "src/input", // Input directory containing source files
  outputDir: "src/output", // Output directory for translated files
  cacheFile: "src/cache.json", // Cache file to store translations
  encoding: "utf-8" as const, // File encoding (UTF-8 recommended)
  minStringLength: 3, // Minimum string length to consider for translation
  requestLimit: 50, // Maximum number of API requests before cooldown
  cooldownTime: 600000, // 10 minutes cooldown after hitting request limit
  translationService: "openrouter", // Translation service to use: "google", "google-unofficial", "openai", "deepseek", or "openrouter"
  openAIModel: "gpt-4o", // OpenAI model (e.g., gpt-4, gpt-3.5-turbo)
  deepseekModel: "deepseek-translator", // DeepSeek model
  openRouterModel: "meta-llama/llama-3-70b-instruct:nitro", // OpenRouter model
  // Alternative models to try:
  // "google/palm-2"
  // "anthropic/claude-3-opus"
  // "microsoft/wizardlm-2-8x22b"
  translateOptions: {
    to: "pt", // Target language code (e.g., "pt" for Portuguese)
    from: "en", // Source language code (e.g., "en" for English)
  },
};

// Global variables for tracking translation state
const translationCache: Record<string, Record<string, string>> = {};
let requestCount = 0;
let translatedCount = 0;
let errorCount = 0;

// Initialize translation clients
const googleTranslateClient = new TranslationServiceClient({
  keyFilename: process.env.GOOGLE_API_KEY_FILE,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Create output directory if it doesn't exist
if (!existsSync(CONFIG.outputDir)) {
  mkdirSync(CONFIG.outputDir, { recursive: true });
  console.log(`📁 Output directory created: ${CONFIG.outputDir}`);
}

// Cache management functions
function loadCache(): void {
  try {
    if (existsSync(CONFIG.cacheFile)) {
      const data = readFileSync(CONFIG.cacheFile, "utf-8");
      const parsed = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) {
        Object.assign(translationCache, parsed);
        console.log(
          `📦 Cache loaded for ${Object.keys(translationCache).length} files`
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
    const cacheContent = JSON.stringify(translationCache, null, 2);
    writeFileSync(CONFIG.cacheFile, cacheContent);
    console.log("💾 Cache saved successfully!");
  } catch (error) {
    console.error(
      "⚠️ Error saving cache:",
      error instanceof Error ? error.message : error
    );
  }
}

function escapeQuotes(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function unescapeQuotes(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function replaceInBuffer(
  source: Buffer,
  search: string,
  replace: string
): Buffer {
  const searchBuffer = Buffer.from(search, CONFIG.encoding);
  const replaceBuffer = Buffer.from(unescapeQuotes(replace), CONFIG.encoding);

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

function extractStrings(buffer: Buffer): string[] {
  const strings = new Set<string>();
  let current: number[] = [];
  let inDollarBlock = false;

  const bufferText = buffer.toString(CONFIG.encoding);

  for (const char of bufferText) {
    const byte = char.charCodeAt(0);

    if (byte === 0x24) {
      if (inDollarBlock) {
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

function cleanTranslation(text: string): string {
  if (typeof text !== "string") return text;

  return text
    .replace(/\(.*?\)/g, "") // Remove parentheses
    .replace(/^"+|"+$/g, "") // Remove surrounding quotes
    .trim();
}

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
    console.error(
      `⚠️ Google API error: ${error instanceof Error ? error.message : error}`
    );
    throw error;
  }
}

async function translateWithGoogleUnofficialApi(text: string): Promise<string> {
  try {
    const result = await googleUnofficialTranslate(text, {
      to: CONFIG.translateOptions.to,
      from: CONFIG.translateOptions.from,
    });
    return cleanTranslation(result.text);
  } catch (error) {
    console.error(
      `⚠️ Unofficial Google API error: ${
        error instanceof Error ? error.message : error
      }`
    );
    throw error;
  }
}

async function translateWithOpenAI(text: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.openAIModel,
      messages: [
        {
          role: "user",
          content: `Translate to ${CONFIG.translateOptions.to} preserving quotes and formatting: "${text}"`,
        },
      ],
      max_tokens: 100,
      temperature: 0.7,
    });

    const translated = response.choices[0]?.message?.content?.trim() || text;
    return cleanTranslation(translated);
  } catch (error) {
    console.error(
      `⚠️ OpenAI API error: ${error instanceof Error ? error.message : error}`
    );
    throw error;
  }
}

async function translateWithDeepSeek(text: string): Promise<string> {
  try {
    const response = await axios.post(
      "https://api.deepseek.com/chat/completions",
      {
        model: "deepseek-chat",
        messages: [
          {
            role: "user",
            content: `Translate exactly to ${CONFIG.translateOptions.to}: "${text}"`,
          },
        ],
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const translated =
      response.data?.choices?.[0]?.message?.content?.trim() || text;
    return cleanTranslation(translated);
  } catch (error) {
    console.error(
      `⚠️ DeepSeek API error: ${error instanceof Error ? error.message : error}`
    );
    throw error;
  }
}

async function translateWithOpenRouter(text: string): Promise<string> {
  try {
    const completion = await openrouter.chat.completions.create({
      model: CONFIG.openRouterModel,
      messages: [
        {
          role: "system",
          content:
            "Translate with absolute accuracy, preserving all quotes, formatting, and context. Maintain game-specific terminology without alterations.",
        },
        {
          role: "user",
          content: `Translate to ${CONFIG.translateOptions.to} without explanations: "${text}"`,
        },
      ],
      temperature: 0.3,
      top_p: 0.95,
    });

    if (!completion?.choices?.[0]?.message?.content) {
      throw new Error("Invalid OpenRouter response structure");
    }

    const content = completion.choices[0].message.content;
    return cleanTranslation(content.replace(/^"+|"+$/g, "").trim());
  } catch (error) {
    console.error(
      `⚠️ OpenRouter API error: ${
        error instanceof Error ? error.message : error
      }`
    );

    if (error instanceof Error && error.message.includes("rate limit")) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return translateWithOpenRouter(text);
    }

    throw error;
  }
}

async function translateText(filename: string, text: string): Promise<string> {
  if (text.startsWith("$") && text.endsWith("$")) return text;

  if (!translationCache[filename]) translationCache[filename] = {};
  if (translationCache[filename][text]) return translationCache[filename][text];
  if (text.length < CONFIG.minStringLength) return text;

  if (requestCount >= CONFIG.requestLimit) {
    console.log(
      `⏸️ Request limit (${CONFIG.requestLimit}) reached. Pausing...`
    );
    saveCache();
    await new Promise((resolve) => setTimeout(resolve, CONFIG.cooldownTime));
    requestCount = 0;
  }

  try {
    let translated = text; // Inicializa a variável com um valor padrão
    let retries = 3;

    while (retries > 0) {
      try {
        switch (CONFIG.translationService) {
          case "google":
            translated = await translateWithGoogleApi(text);
            break;
          case "google-unofficial":
            translated = await translateWithGoogleUnofficialApi(text);
            break;
          case "openai":
            translated = await translateWithOpenAI(text);
            break;
          case "deepseek":
            translated = await translateWithDeepSeek(text);
            break;
          case "openrouter":
            translated = await translateWithOpenRouter(text);
            break;
          default:
            throw new Error("Invalid translation service");
        }
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        console.log(`Retrying... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    translationCache[filename][text] = translated;
    requestCount++;
    translatedCount++;

    if (translatedCount % 10 === 0) saveCache();

    return translated;
  } catch (error) {
    errorCount++;
    console.error(
      `⚠️ Translation error for "${text}": ${
        error instanceof Error ? error.message : error
      }`
    );
    return text;
  }
}

function isLxbFile(filename: string): boolean {
  return filename.endsWith(".lxb");
}

async function main() {
  try {
    console.log("🚀 Starting translation...");
    loadCache();

    if (!existsSync(CONFIG.inputDir)) {
      throw new Error(`Input directory not found: ${CONFIG.inputDir}`);
    }

    const files = readdirSync(CONFIG.inputDir)
      .filter(isLxbFile)
      .map((file) => join(CONFIG.inputDir, file));

    if (files.length === 0) {
      console.log("ℹ️ No .lxb files found");
      return;
    }

    for (const inputFile of files) {
      console.log(`⏳ Processing: ${inputFile}`);
      const startTime = Date.now();

      const buffer = readFileSync(inputFile);
      const strings = extractStrings(buffer);
      console.log(`📊 Found ${strings.length} strings`);

      let newBuffer = buffer;
      for (const [index, str] of strings.entries()) {
        const translated = await translateText(inputFile, str);
        newBuffer = replaceInBuffer(newBuffer, str, translated);

        if ((index + 1) % 5 === 0) {
          console.log(
            `↻ Progress: ${index + 1}/${strings.length}`,
            `Translated: ${translatedCount}`,
            `Errors: ${errorCount}`,
            `Requests: ${requestCount}/${CONFIG.requestLimit}`
          );
        }
      }

      const outputFile = join(
        CONFIG.outputDir,
        inputFile
          .replace(/^.*[\\/]/, "")
          .replace(/\.lxb$/, `_${CONFIG.translateOptions.to}.lxb`)
      );
      writeFileSync(outputFile, newBuffer);
      console.log(`💾 Saved: ${outputFile}`);
      console.log(
        `⏱️ Time: ${((Date.now() - startTime) / 60000).toFixed(2)} minutes`
      );
    }

    saveCache();
    console.log("\n✅ Translation completed!");
    console.log(`📊 Statistics:
    Translated: ${translatedCount}
    Errors: ${errorCount}
    Requests: ${requestCount}`);
  } catch (error) {
    console.error(
      "\n🔥 Critical error:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}

main();
