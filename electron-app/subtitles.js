const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const {
  ROOT_DIR,
  FFMPEG,
  getIsCancelled,
  setCurrentProcess,
  sendLog,
  sendProgress,
} = require("./shared");

function parseSrt(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/).filter((b) => b.trim());
  return blocks
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim() !== "");
      if (
        lines.length >= 3 &&
        /^\d+$/.test(lines[0].trim()) &&
        /-->/.test(lines[1])
      ) {
        return {
          seq: lines[0].trim(),
          timestamp: lines[1].trim(),
          text: lines.slice(2).join(" ").trim(),
        };
      }
      return null;
    })
    .filter(Boolean);
}

function isValidSrt(srtPath) {
  if (!fs.existsSync(srtPath)) return false;
  try {
    const content = fs.readFileSync(srtPath, "utf-8");
    return parseSrt(content).length > 0;
  } catch {
    return false;
  }
}

function buildBilingualSrt(entries, translatedLines) {
  const result = [];
  for (let j = 0; j < entries.length; j++) {
    const engText = entries[j].text;
    const tgtText = j < translatedLines.length ? translatedLines[j] : "";
    result.push(
      [entries[j].seq, entries[j].timestamp, engText, tgtText].join("\n"),
    );
  }
  return result.join("\n\n") + "\n";
}

function buildMonolingualSrt(entries, translatedLines) {
  const result = [];
  for (let j = 0; j < entries.length; j++) {
    const text = j < translatedLines.length ? translatedLines[j] : "";
    result.push([entries[j].seq, entries[j].timestamp, text].join("\n"));
  }
  return result.join("\n\n") + "\n";
}

function getBurnSubtitlePath(srtPath, mode) {
  const baseName = srtPath.replace(/\.srt$/, "");
  const suffixMap = {
    en: ".srt",
    zh: ".zh-only.srt",
    "en-zh": ".en-zh.srt",
    tr: ".tr-only.srt",
    "en-tr": ".en-tr.srt",
  };
  return baseName + (suffixMap[mode] || ".srt");
}

function burnSubtitlesIntoVideo(videoPath, srtPath) {
  return new Promise((resolve, reject) => {
    const tmpSrt = path.join(
      ROOT_DIR,
      "downloads",
      `_sub_tmp_${Date.now()}_${process.pid}.srt`,
    );
    try {
      fs.symlinkSync(srtPath, tmpSrt);
    } catch (e) {
      reject(new Error(`创建临时字幕链接失败: ${e.message}`));
      return;
    }

    const ext = path.extname(videoPath);
    let outputPath = videoPath.replace(ext, `_subtitled${ext}`);
    if (fs.existsSync(outputPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      outputPath = videoPath.replace(ext, `_subtitled_${stamp}${ext}`);
    }

    const args = [
      "-i",
      videoPath,
      "-vf",
      `subtitles=${tmpSrt}:force_style='FontSize=20,PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=1,Shadow=1'`,
      "-c:a",
      "copy",
      "-y",
      outputPath,
    ];

    sendLog(`  ffmpeg ${args.join(" ")}`);

    if (getIsCancelled()) throw new Error("任务已取消");

    const ffmpeg = spawn(FFMPEG, args, {
      cwd: ROOT_DIR,
      windowsHide: true,
    });
    setCurrentProcess(ffmpeg);

    ffmpeg.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) sendLog(`  [FFmpeg] ${text}`);
    });

    ffmpeg.on("close", (code) => {
      setCurrentProcess(null);
      try { fs.unlinkSync(tmpSrt); } catch {}

      if (getIsCancelled()) {
        reject(new Error("任务已取消"));
        return;
      }

      if (code === 0) {
        sendProgress("burn", 100);
        sendLog(`  ✓ 完成: ${path.basename(outputPath)}`);
        resolve(outputPath);
      } else {
        reject(new Error(`FFmpeg 退出码: ${code}`));
      }
    });

    ffmpeg.on("error", (err) => {
      setCurrentProcess(null);
      reject(new Error(`启动 FFmpeg 失败: ${err.message}`));
    });
  });
}

module.exports = {
  parseSrt,
  isValidSrt,
  buildBilingualSrt,
  buildMonolingualSrt,
  getBurnSubtitlePath,
  burnSubtitlesIntoVideo,
};
