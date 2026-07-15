const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const {
  ROOT_DIR,
  DOWNLOADS_DIR,
  YTDLP,
  isMac,
  getIsCancelled,
  setCurrentProcess,
  isFinalVideo,
  sendLog,
  sendProgress,
} = require("./shared");

function downloadVideo(url, cookiesFile, downloadSeries = false) {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  sendLog("═══════════════════════════════════");
  sendLog("▶ 步骤 1：下载视频");
  sendLog(`  命令: yt-dlp -f "bestvideo+bestaudio/best" "${url}"`);
  if (cookiesFile) sendLog(`  Cookies: ${cookiesFile}`);
  if (downloadSeries) {
    sendLog(`  模式: 下载整个系列`);
  } else {
    sendLog(`  模式: 单集下载`);
  }
  sendLog("═══════════════════════════════════");

  const outputTemplate = downloadSeries
    ? path.join(DOWNLOADS_DIR, "%(playlist_title).150s/%(title).150s.%(ext)s")
    : path.join(DOWNLOADS_DIR, "%(title).150s.%(ext)s");

  const args = [
    "-f", "bestvideo+bestaudio/best",
    "-o", outputTemplate,
    "--no-part",
    "--js-runtimes", "node",
  ];

  if (!downloadSeries) args.push("--no-playlist");

  if (cookiesFile && fs.existsSync(cookiesFile)) {
    args.push("--cookies", cookiesFile);
  }

  args.push(url);

  const ytdlpEnv = { ...process.env, PYTHONUTF8: "1" };
  if (isMac) {
    const brewCert = "/opt/homebrew/opt/ca-certificates/share/ca-certificates/cacert.pem";
    if (fs.existsSync(brewCert)) ytdlpEnv.SSL_CERT_FILE = brewCert;
  }

  if (getIsCancelled()) throw new Error("任务已取消");

  const ytdlp = spawn(YTDLP, args, {
    cwd: ROOT_DIR,
    windowsHide: true,
    env: ytdlpEnv,
  });
  setCurrentProcess(ytdlp);

  const stderrLines = [];
  const stdoutLines = [];
  const downloadedFiles = [];

  ytdlp.stdout.on("data", (data) => {
    const text = data.toString().trim();
    if (text) stdoutLines.push(text);
    sendLog(`  ${text}`);
  });

  ytdlp.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) {
      stderrLines.push(text);
      const pct = text.match(/(\d+\.\d+)%/);
      if (pct) sendProgress("download", parseFloat(pct[1]));
      sendLog(`  ${text}`);
    }
  });

  return new Promise((resolve, reject) => {
    ytdlp.on("close", (code) => {
      setCurrentProcess(null);

      if (getIsCancelled()) {
        reject(new Error("任务已取消"));
        return;
      }

      const fullOutput = [...stdoutLines, ...stderrLines].join("\n");

      if (downloadSeries) {
        const patterns = [
          /\[download\] Destination:\s*(.+?)$/gm,
          /\[download\]\s+(.+?)\s+has already been downloaded/g,
          /\[download\]\s+(.+?)\s+100% of/g,
          /\[Merger\] Merging formats into "(.+?)"/g,
        ];
        for (const regex of patterns) {
          let m;
          while ((m = regex.exec(fullOutput)) !== null) {
            const p = m[1].trim().replace(/([^:])\/\//g, "$1/");
            if (fs.existsSync(p) && isFinalVideo(p)) downloadedFiles.push(p);
          }
        }

        if (downloadedFiles.length === 0) {
          const now = Date.now();
          const walk = (dir) => {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir)) {
              const full = path.join(dir, entry);
              let st;
              try { st = fs.statSync(full); } catch { continue; }
              if (st.isDirectory()) { walk(full); continue; }
              if (!isFinalVideo(entry)) continue;
              if (now - st.mtimeMs > 5 * 60 * 1000) continue;
              downloadedFiles.push(full);
            }
          };
          walk(DOWNLOADS_DIR);
        }

        const uniqueFiles = [...new Set(downloadedFiles)];
        if (uniqueFiles.length > 0) {
          uniqueFiles.sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
          );
          sendLog(`  ✓ 系列下载完成，共 ${uniqueFiles.length} 个视频`);
          resolve(uniqueFiles);
          return;
        }

        reject(new Error("系列下载完成但未找到任何视频文件"));
        return;
      }

      const alreadyMsg = stderrLines.join("\n");
      const alreadyMatch = alreadyMsg.match(
        /\[download\]\s+(.+?)\s+has already been downloaded/,
      );
      if (alreadyMatch) {
        const cachedPath = alreadyMatch[1].trim();
        const normalized = cachedPath.replace(/([^:])\/\//g, "$1/");
        if (fs.existsSync(normalized)) {
          sendLog(`  ✓ 使用已下载文件: ${path.basename(normalized)}`);
          resolve(normalized);
          return;
        }
      }

      const mergeMatch = alreadyMsg.match(/\[Merger\] Merging formats into "(.+?)"/);
      if (mergeMatch) {
        const mergedPath = mergeMatch[1].trim();
        if (fs.existsSync(mergedPath)) {
          sendLog(`  ✓ 下载完成: ${path.basename(mergedPath)}`);
          resolve(mergedPath);
          return;
        }
      }

      if (code !== 0) {
        reject(new Error(`下载失败，退出码: ${code}`));
        return;
      }

      const now = Date.now();
      let latest = null;
      let latestMtime = 0;
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          if (st.isDirectory()) { walk(full); continue; }
          if (!isFinalVideo(entry)) continue;
          if (now - st.mtimeMs > 5 * 60 * 1000) continue;
          if (st.mtimeMs > latestMtime) { latestMtime = st.mtimeMs; latest = full; }
        }
      };
      walk(DOWNLOADS_DIR);

      if (latest) {
        const naDir = path.join(DOWNLOADS_DIR, "NA");
        if (latest.startsWith(naDir + path.sep)) {
          const dest = path.join(DOWNLOADS_DIR, path.basename(latest));
          fs.renameSync(latest, dest);
          try { fs.rmdirSync(naDir); } catch {}
          latest = dest;
        }
        sendLog(`  ✓ 下载完成: ${path.relative(DOWNLOADS_DIR, latest)}`);
        resolve(latest);
      } else {
        reject(new Error("下载完成但未找到视频文件"));
      }
    });

    ytdlp.on("error", (err) => {
      setCurrentProcess(null);
      reject(new Error(`启动 yt-dlp 失败: ${err.message}`));
    });
  });
}

function organizeIntoSeriesDir(videoPath) {
  const name = path.basename(videoPath);
  const match = name.match(/^(.+?)\s+p(\d+)\s+(.+?)(\.[^.]+)$/i);
  if (!match) return videoPath;
  const seriesName = match[1].trim();
  const epNum = match[2];
  const epName = match[3].replace(/^\d+[\.\、\)]\s*/, "").trim();
  const ext = match[4];

  const seriesDir = path.join(DOWNLOADS_DIR, seriesName);
  const epDir = path.join(seriesDir, `${epNum.padStart(2, "0")}. ${epName}`);
  if (!fs.existsSync(epDir)) fs.mkdirSync(epDir, { recursive: true });

  const newPath = path.join(epDir, `video${ext}`);

  const oldDir = path.dirname(videoPath);
  const oldBase = name.replace(/\.[^.]+$/, "");
  const normalize = (s) =>
    s.replace(/^\d+[\.\s]+/, "").trim().toLowerCase();
  const normalizedTarget = normalize(oldBase);
  for (const f of fs.readdirSync(oldDir)) {
    if (f === name) continue;
    if (!/\.(srt|zh\.srt|zh-only\.srt|en-zh\.srt|tr-only\.srt|en-tr\.srt)$/i.test(f)) continue;
    const fBase = f.replace(/\.(srt|zh\.srt|zh-only\.srt|en-zh\.srt|tr-only\.srt|en-tr\.srt)$/i, "");
    if (normalize(fBase) === normalizedTarget) {
      const subExt = f.slice(fBase.length);
      try { fs.renameSync(path.join(oldDir, f), path.join(epDir, `video${subExt}`)); } catch {}
    }
  }

  if (videoPath !== newPath) {
    fs.renameSync(videoPath, newPath);
    sendLog(`  📁 归档: ${seriesName}/${epNum.padStart(2, "0")}. ${epName}/`);
  }
  return newPath;
}

module.exports = { downloadVideo, organizeIntoSeriesDir };
