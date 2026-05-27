const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const OpenAI = require("openai");

// 父目录（工具所在位置）
const ROOT_DIR = path.join(__dirname, "..");
const YTDLP = path.join(ROOT_DIR, "bin", "yt-dlp.exe");
const FFMPEG = path.join(ROOT_DIR, "bin", "ffmpeg.exe");
const PYTHON_SCRIPT = path.join(ROOT_DIR, "main.py");
const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    title: "视频字幕工具",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile("index.html");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});

// ── 下载视频 ───────────────────────────────────────────
function downloadVideo(url) {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  sendLog("═══════════════════════════════════");
  sendLog("▶ 步骤 1/3：下载视频");
  sendLog(`  命令: yt-dlp -f "bestvideo+bestaudio/best" "${url}"`);
  sendLog("═══════════════════════════════════");

  // 记录下载前的文件列表，用于之后识别新文件
  const beforeFiles = new Set();
  if (fs.existsSync(DOWNLOADS_DIR)) {
    fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => /\.(mp4|mkv|webm|mov|avi)$/i.test(f))
      .forEach(f => beforeFiles.add(f));
  }

  const args = [
    "-f", "bestvideo+bestaudio/best",
    "-o", path.join(DOWNLOADS_DIR, "%(title)s.%(ext)s"),
    "--no-part", // 不生成 .part 文件，直接输出最终文件名
    url,
  ];

  // 编码：Windows 下强制 yt-dlp 使用 UTF-8
  const ytdlpEnv = { ...process.env, PYTHONUTF8: "1" };

  const ytdlp = spawn(YTDLP, args, {
    cwd: ROOT_DIR,
    windowsHide: true,
    env: ytdlpEnv,
  });

  ytdlp.stdout.on("data", (data) => {
    sendLog(`  ${data.toString().trim()}`);
  });

  ytdlp.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) {
      const pct = text.match(/(\d+\.\d+)%/);
      if (pct) {
        sendProgress("download", parseFloat(pct[1]));
      }
      sendLog(`  ${text}`);
    }
  });

  return new Promise((resolve, reject) => {
    ytdlp.on("close", (code) => {
      // 扫描目录找新文件（避免 stdout 编码问题）
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter(f => /\.(mp4|mkv|webm|mov|avi)$/i.test(f));

      // 优先找新出现的文件，否则取最新修改的
      const newFiles = files.filter(f => !beforeFiles.has(f));

      if (newFiles.length > 0) {
        newFiles.sort((a, b) =>
          fs.statSync(path.join(DOWNLOADS_DIR, b)).mtimeMs -
          fs.statSync(path.join(DOWNLOADS_DIR, a)).mtimeMs
        );
        const filePath = path.join(DOWNLOADS_DIR, newFiles[0]);
        sendLog(`  ✓ 下载完成: ${path.basename(filePath)}`);
        resolve(filePath);
      } else if (files.length > 0) {
        files.sort((a, b) =>
          fs.statSync(path.join(DOWNLOADS_DIR, b)).mtimeMs -
          fs.statSync(path.join(DOWNLOADS_DIR, a)).mtimeMs
        );
        const filePath = path.join(DOWNLOADS_DIR, files[0]);
        sendLog(`  ✓ 使用已下载文件: ${path.basename(filePath)}`);
        resolve(filePath);
      } else if (code !== 0) {
        reject(new Error(`下载失败，退出码: ${code}`));
      } else {
        reject(new Error("下载完成但未找到视频文件"));
      }
    });

    ytdlp.on("error", (err) => {
      reject(new Error(`启动 yt-dlp 失败: ${err.message}`));
    });
  });
}

// ── 转录字幕 ───────────────────────────────────────────
function transcribe(videoPath, modelSize) {
  return new Promise((resolve, reject) => {
    sendLog("");
    sendLog("═══════════════════════════════════");
    sendLog("▶ 步骤 2/3：Whisper 转录英文字幕");
    sendLog(`  模型: ${modelSize}`);
    sendLog(`  文件: ${path.basename(videoPath)}`);
    sendLog("═══════════════════════════════════");

    // 构建 PATH：加入 NVIDIA DLL 路径，让 CUDA 可用
    const venvDir = path.join(ROOT_DIR, ".venv", "Lib", "site-packages");
    const nvidiaPaths = [
      path.join(venvDir, "nvidia", "cublas", "bin"),
      path.join(venvDir, "nvidia", "cudnn", "bin"),
    ];
    const env = {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PATH: [...nvidiaPaths, process.env.PATH].join(path.delimiter),
    };

    // 使用 uv run python（项目用 uv 管理依赖）-u 禁用 stdout 缓冲
    const proc = spawn("uv", ["run", "python", "-u", PYTHON_SCRIPT, videoPath, modelSize], {
      cwd: ROOT_DIR,
      windowsHide: true,
      env,
    });

    let lastLog = "";

    proc.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        lastLog = text;
        sendLog(`  ${text}`);
        // 解析进度（如果有的话）
        if (text.includes("转录")) {
          sendProgress("transcribe", 50);
        }
      }
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        sendLog(`  ${text}`);
      }
    });

    proc.on("close", (code) => {
      // 从输出中提取 SRT 路径
      const srtMatch = lastLog.match(/SRT_OUTPUT:(.+)/);
      let srtPath;

      if (srtMatch) {
        srtPath = srtMatch[1].trim();
      } else {
        // 推断 SRT 路径
        srtPath = videoPath.replace(/\.[^.]+$/, ".srt");
      }

      if (fs.existsSync(srtPath)) {
        sendProgress("transcribe", 100);
        sendLog(`  ✓ 字幕文件: ${path.basename(srtPath)}`);
        resolve(srtPath);
      } else if (code === 0) {
        // 可能在同目录下
        const altPath = path.join(DOWNLOADS_DIR, path.basename(videoPath).replace(/\.[^.]+$/, ".srt"));
        if (fs.existsSync(altPath)) {
          resolve(altPath);
        } else {
          reject(new Error("转录完成但未生成 SRT 文件"));
        }
      } else {
        reject(new Error(`转录失败，退出码: ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`启动失败: ${err.message}\n请确认已安装 uv 和 faster-whisper`));
    });
  });
}

// ── 解析 SRT 为条目数组 ─────────────────────────────────
function parseSrt(content) {
  // 统一换行符
  const normalized = content.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/).filter(b => b.trim());
  return blocks.map(block => {
    const lines = block.split("\n").filter(l => l.trim() !== "");
    if (lines.length >= 3 && /^\d+$/.test(lines[0].trim()) && /-->/.test(lines[1])) {
      return {
        seq: lines[0].trim(),
        timestamp: lines[1].trim(),
        text: lines.slice(2).join(" ").trim(),
      };
    }
    return null;
  }).filter(Boolean);
}

// ── DeepSeek 翻译 ───────────────────────────────────────
async function translate(srtPath, apiKey, baseUrl) {
  sendLog("");
  sendLog("═══════════════════════════════════");
  sendLog("▶ 步骤 3/3：DeepSeek 翻译中文字幕");
  sendLog("═══════════════════════════════════");

  const srtContent = fs.readFileSync(srtPath, "utf-8");
  const entries = parseSrt(srtContent);
  sendLog(`  解析到 ${entries.length} 条字幕`);

  if (entries.length === 0) {
    throw new Error("SRT 文件解析失败，无有效条目");
  }

  const jsonInput = JSON.stringify(entries.map(e => e.text));

  if (jsonInput.length > 50000) {
    return translateInBatches(entries, srtPath, apiKey, baseUrl);
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseUrl || "https://api.deepseek.com",
  });

  const prompt = `Translate these English subtitle lines into natural, conversational Simplified Chinese (适合中文字幕风格).

CRITICAL RULES:
- Each line is a SEPARATE subtitle with its own timestamp. Do NOT merge adjacent lines.
- Output EXACTLY ${entries.length} Chinese strings — same count as input, no exceptions.
- Preserve EXACT order. Even if two lines seem related, keep them as separate translations.

Input is a JSON array of ${entries.length} English strings. Output ONLY a JSON array of ${entries.length} Chinese strings.
No explanations, no markdown, just the JSON array.

${jsonInput}`;

  try {
    sendLog("  正在调用 DeepSeek API...");
    sendProgress("translate", 30);

    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 16000,
    });

    const raw = response.choices[0].message.content.trim();
    let chnLines = parseTranslationResponse(raw, entries.length);
    if (!chnLines) {
      // 数量不匹配，重试一次
      sendLog("  ⚠ 数量不匹配，正在用更严格的提示重试...");
      const retryPrompt = `You previously returned the wrong number of translations. This is a CRITICAL error.

CRITICAL: You MUST output EXACTLY ${entries.length} Chinese strings. Not ${entries.length - 1}, not ${entries.length + 1}. EXACTLY ${entries.length}.
Each line below is a SEPARATE subtitle timestamp entry. NEVER merge adjacent lines — even if they look like sentence fragments.

${jsonInput}`;

      const retryResp = await client.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "user", content: retryPrompt }],
        temperature: 0.1,
        max_tokens: 16000,
      });
      const retryRaw = retryResp.choices[0].message.content.trim();
      chnLines = parseTranslationResponse(retryRaw, entries.length);
    }

    if (!chnLines) {
      // 重试仍失败，降级为逐条翻译
      sendLog("  ⚠ 批量翻译失败，降级为逐条翻译...");
      chnLines = await translateOneByOne(entries, client);
    }

    // 构建双语字幕
    const outputPath = srtPath.replace(/\.srt$/, ".zh.srt");
    const bilingual = buildBilingualSrt(entries, chnLines);
    fs.writeFileSync(outputPath, bilingual, "utf-8");

    sendProgress("translate", 100);
    sendLog(`  ✓ 双语字幕已保存: ${path.basename(outputPath)} (${chnLines.length}/${entries.length} 条)`);
    return outputPath;
  } catch (err) {
    sendLog(`  ❌ 翻译失败: ${err.message}`);
    throw err;
  }
}

// ── 分批翻译 ───────────────────────────────────────────
async function translateInBatches(entries, srtPath, apiKey, baseUrl) {
  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseUrl || "https://api.deepseek.com",
  });

  const batchSize = 30;
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(entries.slice(i, i + batchSize));
  }

  sendLog(`  共 ${batches.length} 批，每批 ${batchSize} 条`);

  const allTranslations = [];
  for (let i = 0; i < batches.length; i++) {
    sendLog(`  翻译第 ${i + 1}/${batches.length} 批...`);
    sendProgress("translate", Math.round((i / batches.length) * 100));

    const batchJson = JSON.stringify(batches[i].map(e => e.text));
    const batchCount = batches[i].length;
    const prompt = `Translate these English subtitle lines into natural, conversational Simplified Chinese (适合中文字幕风格).

CRITICAL RULES:
- Each line is a SEPARATE subtitle with its own timestamp. Do NOT merge adjacent lines.
- Output EXACTLY ${batchCount} Chinese strings — same count as input, no exceptions.
- Preserve EXACT order. Even if two lines seem related, keep them as separate translations.

Input is a JSON array of ${batchCount} English strings. Output ONLY a JSON array of ${batchCount} Chinese strings.
No explanations, no markdown, just the JSON array.

${batchJson}`;

    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 16000,
    });

    const raw = response.choices[0].message.content.trim();
    let arr = parseTranslationResponse(raw, batchCount);

    if (!arr) {
      // 重试一次
      sendLog(`    ⚠ 第 ${i + 1} 批数量不匹配，重试中...`);
      const retryPrompt = `CRITICAL: You MUST output EXACTLY ${batchCount} Chinese translations. Each line is a separate subtitle.

${batchJson}`;
      const retryResp = await client.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "user", content: retryPrompt }],
        temperature: 0.1,
        max_tokens: 16000,
      });
      const retryRaw = retryResp.choices[0].message.content.trim();
      arr = parseTranslationResponse(retryRaw, batchCount);
    }

    if (!arr) {
      // 降级为该批逐条翻译
      sendLog(`    ⚠ 第 ${i + 1} 批降级为逐条翻译...`);
      arr = await translateOneByOne(batches[i], client);
    }

    allTranslations.push(...arr);
  }

  const bilingual = buildBilingualSrt(entries, allTranslations);
  const bilingualPath = srtPath.replace(/\.srt$/, ".zh.srt");
  fs.writeFileSync(bilingualPath, bilingual, "utf-8");

  sendProgress("translate", 100);
  sendLog(`  ✓ 双语字幕: ${path.basename(bilingualPath)}`);
  return bilingualPath;
}

// ── 解析翻译 API 响应，验证数量匹配 ───────────────────
// 返回 null 表示数量不匹配，调用方应重试或降级
function parseTranslationResponse(raw, expectedCount) {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  let lines;
  try {
    lines = JSON.parse(cleaned);
    if (!Array.isArray(lines)) {
      return null;
    }
  } catch {
    // JSON 解析失败时，回退到按行分割
    lines = raw.split("\n").filter(l => {
      const t = l.trim();
      return t !== "" && !t.startsWith("```");
    });
  }
  if (lines.length !== expectedCount) {
    return null;
  }
  return lines;
}

// ── 逐条翻译（降级方案，保证 1:1 映射）─────────────────
async function translateOneByOne(entries, client) {
  const translations = [];
  for (let i = 0; i < entries.length; i++) {
    const response = await client.chat.completions.create({
      model: "deepseek-chat",
      messages: [{
        role: "user",
        content: `Translate this English subtitle line into natural Simplified Chinese. Output ONLY the Chinese text, nothing else — no quotes, no prefixes, no explanations.\n\n${entries[i].text}`,
      }],
      temperature: 0.3,
      max_tokens: 500,
    });
    translations.push(response.choices[0].message.content.trim());
  }
  return translations;
}

// ── 构建双语字幕 ───────────────────────────────────────
function buildBilingualSrt(entries, chnLines) {
  const result = [];
  for (let j = 0; j < entries.length; j++) {
    const engText = entries[j].text;
    const chnText = j < chnLines.length ? chnLines[j] : "";
    result.push([
      entries[j].seq,
      entries[j].timestamp,
      engText,
      chnText,
    ].join("\n"));
  }
  return result.join("\n\n") + "\n";
}

// ── 硬嵌入字幕到视频 ───────────────────────────────────
function burnSubtitlesIntoVideo(videoPath, srtPath) {
  return new Promise((resolve, reject) => {
    sendLog("");
    sendLog("═══════════════════════════════════");
    sendLog("▶ 步骤 4/4：硬嵌入字幕到视频");
    sendLog(`  视频: ${path.basename(videoPath)}`);
    sendLog(`  字幕: ${path.basename(srtPath)}`);
    sendLog("═══════════════════════════════════");

    // FFmpeg subtitles 滤镜在 Windows 下需要特殊处理路径
    // 反斜杠转正斜杠，冒号需要转义 (C: → C\:)
    const srtForFfmpeg = srtPath.replace(/\\/g, "/").replace(/:/, "\\:");

    const ext = path.extname(videoPath);
    const outputPath = videoPath.replace(ext, `_subtitled${ext}`);

    const args = [
      "-i", videoPath,
      "-vf", `subtitles='${srtForFfmpeg}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=1,Shadow=1'`,
      "-c:a", "copy",
      "-y",
      outputPath,
    ];

    sendLog(`  ffmpeg ${args.join(" ")}`);

    const ffmpeg = spawn(FFMPEG, args, {
      cwd: ROOT_DIR,
      windowsHide: true,
    });

    ffmpeg.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        // FFmpeg 进度信息在 stderr 中
        const timeMatch = text.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (timeMatch) {
          sendLog(`  [FFmpeg] ${timeMatch[0]}`);
        }
      }
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        sendProgress("burn", 100);
        sendLog(`  ✓ 完成: ${path.basename(outputPath)}`);
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg 退出码: ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`启动 FFmpeg 失败: ${err.message}`));
    });
  });
}

// ── IPC 处理 ───────────────────────────────────────────
ipcMain.handle("start-workflow", async (event, { url, modelSize, apiKey, baseUrl, burnSubtitles }) => {
  try {
    if (!url || !url.trim()) {
      throw new Error("请输入视频链接");
    }
    if (!apiKey || !apiKey.trim()) {
      throw new Error("请输入 DeepSeek API Key");
    }

    sendStatus("running");

    // 1. 下载
    const videoPath = await downloadVideo(url);

    // 2. 转录
    const srtPath = await transcribe(videoPath, modelSize);

    // 3. 翻译
    const resultPath = await translate(srtPath, apiKey, baseUrl);

    // 3.5 硬嵌入字幕（可选）
    if (burnSubtitles) {
      const burnedVideoPath = await burnSubtitlesIntoVideo(videoPath, resultPath);
      sendLog(`  ✓ 字幕已嵌入视频: ${path.basename(burnedVideoPath)}`);
    }

    sendStatus("done");
    sendLog("");
    sendLog("═══════════════════════════════════");
    sendLog("🎉 全部完成！");
    sendLog(`  输出文件: ${resultPath}`);
    sendLog("═══════════════════════════════════");

    return { success: true, output: resultPath };
  } catch (err) {
    sendStatus("error");
    sendLog("");
    sendLog(`❌ 错误: ${err.message}`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("select-output-dir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// ── 向渲染进程发送消息 ─────────────────────────────────
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function sendLog(message) {
  send("log", message);
}

function sendProgress(step, percent) {
  send("progress", { step, percent });
}

function sendStatus(status) {
  send("status", status);
}
