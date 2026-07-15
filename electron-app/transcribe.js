const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const {
  ROOT_DIR,
  DOWNLOADS_DIR,
  VENV_DIR,
  PYTHON_SCRIPT,
  isMac,
  getIsCancelled,
  setCurrentProcess,
  sendLog,
  sendProgress,
} = require("./shared");

function transcribe(videoPath, modelSize) {
  return new Promise((resolve, reject) => {
    sendLog("");
    sendLog("═══════════════════════════════════");
    sendLog("▶ 步骤 2：mlx-whisper 转录英文字幕");
    sendLog(`  模型: ${modelSize}`);
    sendLog(`  文件: ${path.basename(videoPath)}`);
    sendLog("═══════════════════════════════════");

    const venvScripts = isMac
      ? path.join(VENV_DIR, "bin")
      : path.join(VENV_DIR, "Scripts");
    const pythonExe = isMac
      ? path.join(venvScripts, "python")
      : path.join(venvScripts, "python.exe");
    const env = {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      PATH: [venvScripts, process.env.PATH].join(path.delimiter),
      VIRTUAL_ENV: VENV_DIR,
    };

    if (getIsCancelled()) throw new Error("任务已取消");

    const proc = spawn(pythonExe, ["-u", PYTHON_SCRIPT, videoPath, modelSize], {
      cwd: ROOT_DIR,
      windowsHide: true,
      env,
    });
    setCurrentProcess(proc);

    let lastLog = "";

    proc.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text) {
        lastLog = text;
        sendLog(`  ${text}`);
        if (/加载模型|使用本地模型/.test(text)) sendProgress("transcribe", 30);
      }
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) sendLog(`  ${text}`);
    });

    proc.on("close", (code) => {
      setCurrentProcess(null);

      if (getIsCancelled()) {
        reject(new Error("任务已取消"));
        return;
      }

      const srtMatch = lastLog.match(/SRT_OUTPUT:(.+)/);
      let srtPath;

      if (srtMatch) {
        srtPath = srtMatch[1].trim();
      } else {
        srtPath = videoPath.replace(/\.[^.]+$/, ".srt");
      }

      if (fs.existsSync(srtPath)) {
        sendProgress("transcribe", 100);
        sendLog(`  ✓ 字幕文件: ${path.basename(srtPath)}`);
        resolve(srtPath);
      } else if (code === 0) {
        const altPath = path.join(
          DOWNLOADS_DIR,
          path.basename(videoPath).replace(/\.[^.]+$/, ".srt"),
        );
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
      setCurrentProcess(null);
      reject(new Error(`启动失败: ${err.message}\n请确认已安装 uv 和 mlx-whisper`));
    });
  });
}

module.exports = { transcribe };
