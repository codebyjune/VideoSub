const $ = (sel) => document.querySelector(sel);

const startBtn = $("#startBtn");
const clearBtn = $("#clearBtn");
const logBox = $("#logBox");
const progressBar = $("#progressBar");
const statusBadge = $("#statusBadge");

// Inline progress-step labels (below bar)
const steps = {
  download: document.querySelectorAll(".step")[0],
  transcribe: document.querySelectorAll(".step")[1],
  translate: document.querySelectorAll(".step")[2],
};

// Sidebar step items
const sidebarSteps = {
  download: $("#stepDownload"),
  transcribe: $("#stepTranscribe"),
  translate: $("#stepTranslate"),
};

let isRunning = false;

// ── Theme Toggle ────────────────────────────────────────
const themeToggle = $("#themeToggle");
const themeLabel = $("#themeLabel");
const themeIcon = $("#themeIcon");

const MOON_ICON = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;
const SUN_ICON = `<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>`;

function getTheme() {
  const stored = localStorage.getItem("theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  if (theme === "dark") {
    themeIcon.innerHTML = `<circle cx="12" cy="12" r="4"/><path d="M12 3a1 1 0 010 2 7 7 0 00-7 7 1 1 0 01-2 0 9 9 0 019-9z"/>`;
    themeLabel.textContent = "Light";
  } else {
    themeIcon.innerHTML = MOON_ICON;
    themeLabel.textContent = "Dark";
  }
}

applyTheme(getTheme());

themeToggle.addEventListener("click", () => {
  const next = getTheme() === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
});

// ── Log Output ──────────────────────────────────────────
function appendLog(msg) {
  logBox.textContent += msg + "\n";
  logBox.scrollTop = logBox.scrollHeight;
}

// ── Highlight active step (both inline + sidebar) ───────
function setStepState(key, state) {
  // Inline progress labels
  if (steps[key]) {
    steps[key].classList.remove("active", "done");
    if (state) steps[key].classList.add(state);
  }
  // Sidebar items
  if (sidebarSteps[key]) {
    sidebarSteps[key].classList.remove("active", "done");
    if (state) sidebarSteps[key].classList.add(state);
  }
}

// ── IPC Listeners ───────────────────────────────────────
window.api.onLog((msg) => {
  appendLog(msg);
});

window.api.onProgress(({ step, percent }) => {
  const weights = { download: 0.3, transcribe: 0.3, translate: 0.4 };
  const offsets = { download: 0, transcribe: 30, translate: 60 };
  const overall = offsets[step] + (percent * weights[step]) / 100;
  progressBar.style.width = Math.min(overall, 100) + "%";

  // Highlight current step
  Object.keys(steps).forEach((k) => setStepState(k, null));
  setStepState(step, "active");
});

window.api.onStatus((status) => {
  statusBadge.className = "badge";
  switch (status) {
    case "running":
      statusBadge.textContent = "Running…";
      statusBadge.classList.add("running");
      startBtn.disabled = true;
      break;
    case "done":
      statusBadge.textContent = "Done";
      statusBadge.classList.add("done");
      startBtn.disabled = false;
      isRunning = false;
      progressBar.style.width = "100%";
      Object.keys(steps).forEach((k) => setStepState(k, "done"));
      break;
    case "error":
      statusBadge.textContent = "Error";
      statusBadge.classList.add("error");
      startBtn.disabled = false;
      isRunning = false;
      break;
    default:
      statusBadge.textContent = "Ready";
      statusBadge.classList.add("idle");
      break;
  }
});

// ── Start Workflow ──────────────────────────────────────
startBtn.addEventListener("click", async () => {
  if (isRunning) return;

  const url = $("#url").value.trim();
  const modelSize = $("#modelSize").value;
  const apiKey = $("#apiKey").value.trim();
  const baseUrl = $("#baseUrl").value.trim();
  const burnSubtitles = $("#burnSubtitles").checked;

  if (!url) {
    appendLog("Please enter a video URL");
    return;
  }
  if (!apiKey) {
    appendLog("Please enter a DeepSeek API Key");
    return;
  }

  isRunning = true;
  logBox.textContent = "";
  progressBar.style.width = "0%";
  Object.keys(steps).forEach((k) => setStepState(k, null));

  appendLog("═══════════════════════════════════");
  appendLog("  VideoSub - Start");
  appendLog(`  URL: ${url}`);
  appendLog(`  Model: ${modelSize}`);
  appendLog("═══════════════════════════════════");

  const result = await window.api.startWorkflow({
    url,
    modelSize,
    apiKey,
    baseUrl: baseUrl || "https://api.deepseek.com",
    burnSubtitles,
  });

  if (!result.success) {
    appendLog("");
    appendLog(`Failed: ${result.error}`);
  }
});

// ── Clear Log ───────────────────────────────────────────
clearBtn.addEventListener("click", () => {
  logBox.textContent = "";
  progressBar.style.width = "0%";
  Object.keys(steps).forEach((k) => {
    setStepState(k, null);
    if (steps[k]) {
      steps[k].classList.remove("active", "done");
    }
  });
  statusBadge.className = "badge idle";
  statusBadge.textContent = "Ready";
});
