const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const {
  extractResponseText,
  getIsCancelled,
  sendLog,
  sendProgress,
} = require("./shared");
const { parseSrt, buildBilingualSrt, buildMonolingualSrt } = require("./subtitles");

const LANG_CONFIG = {
  zh: {
    label: "中文",
    suffix: ".zh.srt",
    target: "Simplified Chinese",
    style: "(适合中文字幕风格)",
    langName: "Chinese",
    logStep: "LLM 翻译中文字幕",
  },
  tr: {
    label: "Türkçe",
    suffix: ".tr.srt",
    target: "Turkish",
    style: "(Türkçe altyazı stili)",
    langName: "Turkish",
    logStep: "LLM 翻译土耳其语字幕",
  },
};

function buildTranslationSystemPrompt(targetLang) {
  const lang = LANG_CONFIG[targetLang] || LANG_CONFIG.zh;

  const basePrompt = `You are an expert subtitle translator specializing in natural, fluent ${lang.target} translations.

SUBTITLE TRANSLATION PRINCIPLES:
1. Read ALL input lines first to understand the overall topic and domain before translating.
2. Each translated subtitle must read as natural, conversational ${lang.langName} — avoid stiff, word-for-word translationese.
3. Each subtitle should feel like a self-contained, semantically complete phrase that flows naturally.

CRITICAL — CONTEXT-DEPENDENT WORD CHOICE (多义词辨析):
The same English word can have very different meanings. Always determine the correct meaning from context.

PRESERVATION RULES:
- Keep proper names accurately
- Preserve ALL non-English letters, special characters, and notations exactly as-is
- Keep technical terminology accurate throughout`;

  if (targetLang === "tr") {
    return `${basePrompt}

TURKISH TRANSLATION GUIDELINES:
- Use natural, conversational Turkish ("sen" / "siz" form appropriate to context)
- Prefer shorter Turkish expressions to match subtitle timing — Turkish often requires more characters than English
- For technical/linguistics terms: "letter" → harf, "alphabet" → alfabe, "consonant" → ünsüz, "vowel" → ünlü, "pronunciation" → telaffuz, "syllable" → hece, "suffix" → ek
- Proper names should use Turkish phonetic conventions (e.g., "John" → "Con" if historically used, otherwise keep as-is)
- Maintain Turkish word order (SOV) naturally — rephrase English (SVO) sentences completely`;
  }

  return `${basePrompt}
- "letter" in language/alphabet context → 字母 (NEVER translate as 信/信件 in this context)
- "letter" in postal/correspondence context → 信件
- "pose" in speech/pronunciation context → 停顿 (NEVER translate as 姿势/姿态 in this context)
- "writing" referring to script/characters → 书写/写法 (NOT 文笔)
- "sound" in phonetics/linguistics → 发音/音 (NOT 声音)
- "character" in text/script context → 字符/字母 (NOT 角色/性格)
- "soft sign" / "hard sign" → 软音符号 / 硬音符号 (Russian linguistic terms)
- "consonant" → 辅音, "vowel" → 元音
- "pronounce" / "pronunciation" → 发音
- "alphabet" → 字母表
- Preserve ALL Cyrillic letters (А, Б, В, Г, Д, Е, Ё, Ж, З, И, Й, К, Л, М, Н, О, П, Р, С, Т, У, Ф, Х, Ц, Ч, Ш, Щ, Ъ, Ы, Ь, Э, Ю, Я) and phonetic notations exactly as-is — do not replace them with Latin equivalents`;
}

function parseTranslationResponse(raw, expectedCount) {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  let lines;
  try {
    lines = JSON.parse(cleaned);
    if (!Array.isArray(lines)) return null;
  } catch {
    lines = raw.split("\n").filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("```");
    });
  }
  if (lines.length !== expectedCount) return null;
  return lines.map((l) => l.replace(/^\d+[\.\、\)]\s*/, "").trim());
}

const TRANSLATE_CONCURRENCY = 4;

async function translateOneBatch(batch, batchIndex, batchCount, client, llmModel, targetLang) {
  const lang = LANG_CONFIG[targetLang] || LANG_CONFIG.zh;
  const batchJson = JSON.stringify(batch.map((e) => e.text));
  const n = batch.length;
  const systemPrompt = buildTranslationSystemPrompt(targetLang);
  const userPrompt = `Translate the following ${n} English subtitle lines (batch ${batchIndex + 1}/${batchCount}) into natural, fluent ${lang.langName}.

CRITICAL:
- Output EXACTLY ${n} ${lang.langName} strings — same count as input, no exceptions.
- Each line is a SEPARATE subtitle with its own timestamp. Do NOT merge adjacent lines.
- Preserve EXACT order.
- Apply the polysemy and domain rules from the system instructions carefully.

Output ONLY a JSON array of ${n} ${lang.langName} strings. No explanations, no markdown.

${batchJson}`;

  const response = await client.messages.create({
    model: llmModel,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0.3,
    max_tokens: 16000,
  });

  const raw = extractResponseText(response).trim();
  let arr = parseTranslationResponse(raw, n);

  if (!arr) {
    sendLog(`    ⚠ 第 ${batchIndex + 1} 批数量不匹配，重试中...`);
    const retryPrompt = `COUNT CHECK FAILED. You returned the wrong number of translations for batch ${batchIndex + 1}/${batchCount}. This is a CRITICAL error.

You MUST output EXACTLY ${n} ${lang.langName} strings — not ${n - 1}, not ${n + 1}. EXACTLY ${n}.
Each line below is a SEPARATE subtitle. NEVER merge adjacent lines.
Apply the same quality rules (polysemy, natural flow) as before.

${batchJson}`;
    const retryResp = await client.messages.create({
      model: llmModel,
      system: systemPrompt,
      messages: [{ role: "user", content: retryPrompt }],
      temperature: 0.1,
      max_tokens: 16000,
    });
    const retryRaw = extractResponseText(retryResp).trim();
    arr = parseTranslationResponse(retryRaw, n);
  }

  if (!arr) {
    sendLog(`    ⚠ 第 ${batchIndex + 1} 批降级为逐条翻译...`);
    arr = await translateOneByOne(batch, client, llmModel, targetLang);
  }

  return arr;
}

async function translateOneByOne(entries, client, llmModel, targetLang) {
  const lang = LANG_CONFIG[targetLang] || LANG_CONFIG.zh;
  const systemPrompt = buildTranslationSystemPrompt(targetLang);
  const translations = [];
  for (let i = 0; i < entries.length; i++) {
    if (getIsCancelled()) throw new Error("任务已取消");

    let contextBlock = "";
    if (i > 0) {
      const recentCount = Math.min(3, translations.length);
      const recent = [];
      for (let k = i - recentCount; k < i; k++) {
        recent.push(
          `EN: ${entries[k].text}\n${lang.langName}: ${translations[k]}`,
        );
      }
      contextBlock = `Previous subtitles for context:\n${recent.join("\n")}\n\n`;
    }

    const response = await client.messages.create({
      model: llmModel,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `${contextBlock}Translate this English subtitle line into natural, fluent ${lang.target}. Pay close attention to context — determine the correct domain-specific word meaning (e.g., in language lessons "letter" = 字母, not 信; "pose" in speech = 停顿, not 姿势). Output ONLY the ${lang.langName} text, nothing else — no quotes, no prefixes, no explanations.\n\n${entries[i].text}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });
    translations.push(
      extractResponseText(response)
        .trim()
        .replace(/^\d+[\.\、\)]\s*/, "")
        .trim(),
    );
  }
  return translations;
}

async function translateEntriesInBatchesCore(
  entries,
  client,
  llmModel,
  targetLang,
  progressBase,
  progressRange,
) {
  const batchSize = 30;
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(entries.slice(i, i + batchSize));
  }

  sendLog(`  共 ${batches.length} 批，每批 ${batchSize} 条（${TRANSLATE_CONCURRENCY} 路并发）`);

  const results = new Array(batches.length);
  let completed = 0;
  let cursor = 0;
  let aborted = false;
  let firstErr = null;

  const worker = async () => {
    while (cursor < batches.length && !aborted) {
      if (getIsCancelled()) {
        aborted = true;
        const err = new Error("任务已取消");
        if (!firstErr) firstErr = err;
        throw err;
      }
      const i = cursor++;
      try {
        results[i] = await translateOneBatch(
          batches[i], i, batches.length, client, llmModel, targetLang,
        );
        completed++;
        sendLog(`  ✓ 完成 ${completed}/${batches.length} 批`);
        const pct = progressBase + Math.round((completed / batches.length) * progressRange);
        sendProgress("translate", Math.min(pct, progressBase + progressRange));
      } catch (e) {
        if (!firstErr) firstErr = e;
        aborted = true;
        throw e;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(TRANSLATE_CONCURRENCY, batches.length) },
    () => worker(),
  );
  try {
    await Promise.all(workers);
  } catch (e) {
    if (firstErr && firstErr !== e) throw firstErr;
    throw e;
  }

  return results.flat();
}

async function translateEntriesCore(
  entries,
  client,
  llmModel,
  targetLang,
  progressBase = 0,
  progressRange = 100,
) {
  const lang = LANG_CONFIG[targetLang] || LANG_CONFIG.zh;
  const jsonInput = JSON.stringify(entries.map((e) => e.text));

  if (jsonInput.length > 50000) {
    return translateEntriesInBatchesCore(
      entries, client, llmModel, targetLang, progressBase, progressRange,
    );
  }

  const systemPrompt = buildTranslationSystemPrompt(targetLang);
  const userPrompt = `Translate the following ${entries.length} English subtitle lines into natural, fluent ${lang.langName}.

CRITICAL:
- Output EXACTLY ${entries.length} ${lang.langName} strings — same count as input, no exceptions.
- Each line is a SEPARATE subtitle with its own timestamp. Do NOT merge adjacent lines.
- Preserve EXACT order.
- Apply the polysemy and domain rules from the system instructions carefully.

Output ONLY a JSON array of ${entries.length} ${lang.langName} strings. No explanations, no markdown.

${jsonInput}`;

  try {
    const response = await client.messages.create({
      model: llmModel,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.3,
      max_tokens: 16000,
    });

    const raw = extractResponseText(response).trim();
    let translatedLines = parseTranslationResponse(raw, entries.length);
    if (!translatedLines) {
      sendLog("  ⚠ 数量不匹配，正在用更严格的提示重试...");
      const retryPrompt = `COUNT CHECK FAILED. You returned the wrong number of translations. This is a CRITICAL error.

You MUST output EXACTLY ${entries.length} ${lang.langName} strings — not ${entries.length - 1}, not ${entries.length + 1}. EXACTLY ${entries.length}.
Each line below is a SEPARATE subtitle timestamp entry. NEVER merge adjacent lines, even if they look like sentence fragments.
Apply the same quality rules (polysemy, natural flow) as before.

${jsonInput}`;

      const retryResp = await client.messages.create({
        model: llmModel,
        system: systemPrompt,
        messages: [{ role: "user", content: retryPrompt }],
        temperature: 0.1,
        max_tokens: 16000,
      });
      const retryRaw = extractResponseText(retryResp).trim();
      translatedLines = parseTranslationResponse(retryRaw, entries.length);
    }

    if (!translatedLines) {
      sendLog("  ⚠ 批量翻译失败，降级为逐条翻译...");
      translatedLines = await translateOneByOne(entries, client, llmModel, targetLang);
    }

    return translatedLines;
  } catch (err) {
    sendLog(`  ❌ 翻译失败: ${err.message}`);
    throw err;
  }
}

async function generateSubtitleForBurn(srtPath, apiKey, baseUrl, llmModel, mode) {
  const srtContent = fs.readFileSync(srtPath, "utf-8");
  const entries = parseSrt(srtContent);
  sendLog(`  解析到 ${entries.length} 条字幕`);

  if (entries.length === 0) {
    throw new Error("SRT 文件解析失败，无有效条目");
  }

  const client = new Anthropic({
    apiKey: apiKey,
    baseURL: baseUrl || "http://llm.cccloud.xin/anthropic",
  });

  if (mode === "en") {
    sendLog("  ✓ 使用原始英语字幕");
    sendProgress("translate", 100);
    return srtPath;
  }

  if (mode === "zh") {
    sendLog("  正在翻译为中文...");
    sendProgress("translate", 20);
    const zhLines = await translateEntriesCore(entries, client, llmModel, "zh", 20, 75);
    const outputPath = srtPath.replace(/\.srt$/, ".zh-only.srt");
    const monoZh = buildMonolingualSrt(entries, zhLines);
    fs.writeFileSync(outputPath, monoZh, "utf-8");
    sendProgress("translate", 100);
    sendLog(`  ✓ 中文字幕已保存: ${path.basename(outputPath)} (${zhLines.length}/${entries.length} 条)`);
    return outputPath;
  }

  if (mode === "en-zh") {
    sendLog("  正在翻译为中文（中英双语）...");
    sendProgress("translate", 20);
    const zhLines = await translateEntriesCore(entries, client, llmModel, "zh", 20, 75);
    const outputPath = srtPath.replace(/\.srt$/, ".en-zh.srt");
    const bilingual = buildBilingualSrt(entries, zhLines);
    fs.writeFileSync(outputPath, bilingual, "utf-8");
    sendProgress("translate", 100);
    sendLog(`  ✓ 中英双语字幕已保存: ${path.basename(outputPath)} (${zhLines.length}/${entries.length} 条)`);
    return outputPath;
  }

  if (mode === "tr") {
    sendLog("  正在翻译为土耳其语...");
    sendProgress("translate", 20);
    const trLines = await translateEntriesCore(entries, client, llmModel, "tr", 20, 75);
    const outputPath = srtPath.replace(/\.srt$/, ".tr-only.srt");
    const monoTr = buildMonolingualSrt(entries, trLines);
    fs.writeFileSync(outputPath, monoTr, "utf-8");
    sendProgress("translate", 100);
    sendLog(`  ✓ 土耳其语字幕已保存: ${path.basename(outputPath)} (${trLines.length}/${entries.length} 条)`);
    return outputPath;
  }

  if (mode === "en-tr") {
    sendLog("  正在翻译为土耳其语（英土双语）...");
    sendProgress("translate", 20);
    const trLines = await translateEntriesCore(entries, client, llmModel, "tr", 20, 75);
    const outputPath = srtPath.replace(/\.srt$/, ".en-tr.srt");
    const bilingual = buildBilingualSrt(entries, trLines);
    fs.writeFileSync(outputPath, bilingual, "utf-8");
    sendProgress("translate", 100);
    sendLog(`  ✓ 英土双语字幕已保存: ${path.basename(outputPath)} (${trLines.length}/${entries.length} 条)`);
    return outputPath;
  }

  throw new Error(`未知的烧录模式: ${mode}`);
}

module.exports = {
  LANG_CONFIG,
  buildTranslationSystemPrompt,
  translateEntriesCore,
  generateSubtitleForBurn,
};
