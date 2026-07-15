const path = require("path");
const fs = require("fs");

let electronApp;
try {
  electronApp = require("electron").app;
} catch {}

const isPackaged = electronApp ? electronApp.isPackaged : false;
const ROOT_DIR = isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "..");
const isMac = process.platform === "darwin";
const YTDLP = isMac ? "yt-dlp" : path.join(ROOT_DIR, "bin", "yt-dlp.exe");
const FFMPEG_FULL = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFMPEG =
  isMac && fs.existsSync(FFMPEG_FULL)
    ? FFMPEG_FULL
    : isMac
    ? "ffmpeg"
    : path.join(ROOT_DIR, "bin", "ffmpeg.exe");
const PYTHON_SCRIPT = path.join(ROOT_DIR, "main.py");
const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");
const VENV_DIR = path.join(ROOT_DIR, ".venv");

let mainWindow = null;
let currentProcess = null;
let isCancelled = false;
let isSeriesMode = false;

function setMainWindow(win) {
  mainWindow = win;
}

function setIsCancelled(v) {
  isCancelled = v;
}

function getIsCancelled() {
  return isCancelled;
}

function setIsSeriesMode(v) {
  isSeriesMode = v;
}

function setCurrentProcess(p) {
  currentProcess = p;
}

function getCurrentProcess() {
  return currentProcess;
}

function extractResponseText(response) {
  if (!response.content || !Array.isArray(response.content) || response.content.length === 0) {
    throw new Error(`Unexpected response structure: ${JSON.stringify(response).slice(0, 200)}`);
  }
  let textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) {
    textBlock = response.content.find((b) => b.type === "thinking");
  }
  if (!textBlock || !(textBlock.text || textBlock.thinking)) {
    const types = response.content.map((b) => b.type).join(", ");
    throw new Error(`No text/thinking block found, block types: ${types}`);
  }
  return textBlock.text || textBlock.thinking;
}

function isFinalVideo(filename) {
  return (
    /\.(mp4|mkv|webm|mov|avi)$/i.test(filename) &&
    !/\.f\d+\.(mp4|mkv|webm|mov|avi)$/i.test(filename)
  );
}

function collectMediaFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (/\.(mp4|mkv|webm|mov|avi|srt)$/i.test(entry) && !/\.f\d+\.(mp4|mkv|webm|mov|avi)$/i.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function cleanEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      cleanEmptyDirs(full);
      try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch {}
    }
  }
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function sendLog(message) {
  send("log", message);
}

function sendProgress(step, percent) {
  if (isSeriesMode && step !== "series") return;
  send("progress", { step, percent });
}

function sendStatus(status) {
  send("status", status);
}

module.exports = {
  ROOT_DIR,
  DOWNLOADS_DIR,
  VENV_DIR,
  PYTHON_SCRIPT,
  FFMPEG,
  YTDLP,
  isMac,
  isPackaged,
  setMainWindow,
  setIsCancelled,
  getIsCancelled,
  setIsSeriesMode,
  setCurrentProcess,
  getCurrentProcess,
  extractResponseText,
  isFinalVideo,
  collectMediaFiles,
  cleanEmptyDirs,
  sendLog,
  sendProgress,
  sendStatus,
};
