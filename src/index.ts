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

// Configuration
const CONFIG = {
  inputDir: "src/input", // Input directory
  outputDir: "src/output", // Output directory
  cacheFile: "src/cache.json", // Cache file
  encoding: "utf-8" as const,
  minStringLength: 3,
  requestLimit: 50,
  cooldownTime: 600000, // 10 minutes
  translationService: "openrouter", // "google", "google-unofficial", "openai", "deepseek", or "openrouter"
  openAIModel: "gpt-4o", // OpenAI model (e.g., gpt-4, gpt-3.5-turbo)
  deepseekModel: "deepseek-translator", // DeepSeek model
  openRouterModel: "deepseek/deepseek-chat:free", // OpenRouter model
  translateOptions: {
    to: "pt", // Target language
    from: "en", // Source language
  },
};

const translationCache: Record<string, Record<string, string>> = {};
let requestCount = 0;
let translatedCount = 0;
let errorCount = 0;

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

if (!existsSync(CONFIG.outputDir)) {
  mkdirSync(CONFIG.outputDir, { recursive: true });
  console.log(`📁 Output directory created: ${CONFIG.outputDir}`);
}

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
    const cacheContent = JSON.stringify(translationCache, null, 2).replace(
      /\\"/g,
      '"'
    );
    writeFileSync(CONFIG.cacheFile, cacheContent);
    console.log("💾 Cache saved successfully!");
  } catch (error) {
    console.error(
      "⚠️ Error saving cache:",
      error instanceof Error ? error.message : error
    );
  }
}

function replaceQuotesInText(text: string): string {
  return text.replace(/"/g, "'");
}

function replaceInBuffer(
  source: Buffer,
  search: string,
  replace: string
): Buffer {
  const searchBuffer = Buffer.from(
    replaceQuotesInText(search),
    CONFIG.encoding
  );
  const replaceBuffer = Buffer.from(
    replaceQuotesInText(replace),
    CONFIG.encoding
  );

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

  const bufferText = replaceQuotesInText(buffer.toString(CONFIG.encoding));

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
  // Remove any text within parentheses
  text = text.replace(/\(.*?\)/g, "").trim();

  // Remove unwanted phrases
  const unwantedPhrases = [
    "Unfortunately",
    "does not seem to be a word",
    "is not a word",
    "is not a phrase",
    "is not translatable",
  ];
  unwantedPhrases.forEach((phrase) => {
    if (text.includes(phrase)) {
      text = text.replace(phrase, "").trim();
    }
  });

  return text;
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
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`⚠️ Google API error: ${errorMessage}`);
    throw error;
  }
}

async function translateWithGoogleUnofficialApi(text: string): Promise<string> {
  try {
    const result = await googleUnofficialTranslate(text, {
      to: CONFIG.translateOptions.to,
      from: CONFIG.translateOptions.from,
    });
    return result.text;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`⚠️ Unofficial Google API error: ${errorMessage}`);
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
          content: `Translate the following text from ${CONFIG.translateOptions.from} to ${CONFIG.translateOptions.to} without adding extra quotes. Preserve only the original context's quotes: ${text}`,
        },
      ],
      max_tokens: 100,
      temperature: 0.7,
    });

    const translatedText = response.choices[0].message.content?.trim() || text;
    return replaceQuotesInText(translatedText);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`⚠️ OpenAI API error: ${errorMessage}`);
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
            role: "system",
            content:
              "You are a helpful translation assistant. Translate the following text without adding extra quotes. Preserve only the original context's quotes.",
          },
          {
            role: "user",
            content: `Translate the following text from ${CONFIG.translateOptions.from} to ${CONFIG.translateOptions.to}: ${text}`,
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

    if (
      !response.data ||
      !response.data.choices ||
      !response.data.choices[0]?.message?.content
    ) {
      throw new Error("Invalid response from DeepSeek API");
    }

    const translatedText = response.data.choices[0].message.content;
    return replaceQuotesInText(translatedText);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 402) {
      console.error(
        "⚠️ DeepSeek API error: Insufficient balance. Please recharge your account."
      );
    } else {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(`⚠️ DeepSeek API error: ${errorMessage}`);
    }

    if (axios.isAxiosError(error)) {
      console.error("Response data:", error.response?.data);
      console.error("Status code:", error.response?.status);
      console.error("Headers:", error.response?.headers);
    }

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
            "You are a translation assistant. Your task is to translate the text exactly as provided, without adding any comments, explanations, or extra information. If the text is not translatable (e.g., acronyms, proper nouns), return it unchanged. Only provide the translated text or the original text if no translation is needed.",
        },
        {
          role: "user",
          content: `Translate the following text from ${CONFIG.translateOptions.from} to ${CONFIG.translateOptions.to}: ${text}`,
        },
      ],
    });

    /* console.log(
      "OpenRouter API Response:",
      JSON.stringify(completion, null, 2)
    );*/

    if (
      !completion.choices ||
      !Array.isArray(completion.choices) ||
      completion.choices.length === 0 ||
      !completion.choices[0].message ||
      !completion.choices[0].message.content
    ) {
      throw new Error("Invalid response format from OpenRouter API");
    }

    let translatedText = completion.choices[0].message.content.trim();
    translatedText = cleanTranslation(translatedText);
    return replaceQuotesInText(translatedText);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error(`⚠️ OpenRouter API error: ${errorMessage}`);

    // Detailed logging for debugging
    if (error instanceof Error && error.stack) {
      console.error("Stack trace:", error.stack);
    }

    throw error;
  }
}

async function translateText(filename: string, text: string): Promise<string> {
  if (text.startsWith("$") && text.endsWith("$")) {
    return text;
  }

  if (!translationCache[filename]) {
    translationCache[filename] = {};
  }

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
    let translated: string;

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
        throw new Error("Invalid translation service selected");
    }

    translated = replaceQuotesInText(translated);
    translationCache[filename][text] = translated;
    requestCount++;
    translatedCount++;

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

function isLxbFile(filename: string): boolean {
  return filename.endsWith(".lxb");
}

async function main() {
  try {
    console.log("🚀 Starting translation with cache...");
    loadCache();

    if (!existsSync(CONFIG.inputDir)) {
      throw new Error(`Input directory not found: ${CONFIG.inputDir}`);
    }

    const files = readdirSync(CONFIG.inputDir)
      .filter((file) => isLxbFile(file))
      .map((file) => join(CONFIG.inputDir, file));

    if (files.length === 0) {
      console.log("ℹ️ No .lxb files found in the input directory.");
      return;
    }

    for (const inputFile of files) {
      console.log(`⏳ Starting translation for: ${inputFile}`);
      const startTime = Date.now();

      const buffer = readFileSync(inputFile);
      const strings = extractStrings(buffer);
      console.log(`📊 Strings detected in ${inputFile}: ${strings.length}`);

      let newBuffer = buffer;
      for (const [index, str] of strings.entries()) {
        const translated = await translateText(inputFile, str);
        newBuffer = replaceInBuffer(newBuffer, str, translated);

        if ((index + 1) % 5 === 0) {
          console.log(
            `↻ ${inputFile}: ${index + 1}/${strings.length}`,
            `✓:${translatedCount}`,
            `✗:${errorCount}`,
            `Req:${requestCount}/${CONFIG.requestLimit}`
          );
        }
      }

      const outputFile = join(
        CONFIG.outputDir,
        inputFile
          .replace(/^.*[\\\/]/, "")
          .replace(/\.lxb$/, `_${CONFIG.translateOptions.to}.lxb`)
      );
      writeFileSync(outputFile, newBuffer);
      console.log(`💾 Translated file saved: ${outputFile}`);

      const endTime = Date.now();
      const timeTakenInMinutes = (endTime - startTime) / 60000;
      console.log(
        `⏱️ Time taken for ${inputFile}: ${timeTakenInMinutes.toFixed(
          2
        )} minutes`
      );
    }

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

main();
