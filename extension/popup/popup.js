// popup/popup.js
// All popup logic: transcription, saved phrases, messaging content script.

const API_BASE = "http://localhost:8000";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const healthDot        = document.getElementById("healthDot");
const videoThumb       = document.getElementById("videoThumb");
const videoTitle       = document.getElementById("videoTitle");
const videoUrl         = document.getElementById("videoUrl");
const langSelect       = document.getElementById("langSelect");
const transcribeBtn    = document.getElementById("transcribeBtn");
const statusBox        = document.getElementById("statusBox");
const statusText       = document.getElementById("statusText");
const errorBox         = document.getElementById("errorBox");
const errorText        = document.getElementById("errorText");
const transcriptSection= document.getElementById("transcriptSection");
const transcriptMeta   = document.getElementById("transcriptMeta");
const transcriptList   = document.getElementById("transcriptList");
const clearTranscriptBtn = document.getElementById("clearTranscriptBtn");

const savedBadge       = document.getElementById("savedBadge");
const savedCount       = document.getElementById("savedCount");
const savedEmpty       = document.getElementById("savedEmpty");
const savedList        = document.getElementById("savedList");
const clearAllSavedBtn = document.getElementById("clearAllSavedBtn");

// Tab buttons
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// ── State ─────────────────────────────────────────────────────────────────────
let currentVideoInfo = null;

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  checkHealth();
  await loadVideoInfo();
  await refreshSavedBadge();
})();

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.style.display = p.id === `tab-${tab}` ? "" : "none";
    p.classList.toggle("active", p.id === `tab-${tab}`);
  });
  if (tab === "saved") renderSavedPhrases();
}

// ── Health check ──────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.status === "ok") {
      healthDot.className = "header-status ok";
      healthDot.title = `Backend running · ${data.whisper_backend}`;
    } else {
      healthDot.className = "header-status warn";
      healthDot.title = "Backend degraded: " + (data.issues || []).join(", ");
    }
  } catch {
    healthDot.className = "header-status error";
    healthDot.title = "Backend not reachable — is it running? (python -m uvicorn main:app)";
  }
}

// ── Load current video info ───────────────────────────────────────────────────
async function loadVideoInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes("youtube.com/watch")) {
      videoTitle.textContent = "Open a YouTube video to begin";
      videoUrl.textContent   = "";
      transcribeBtn.disabled  = true;
      return;
    }

    const info = await chrome.tabs.sendMessage(tab.id, { type: "GET_VIDEO_INFO" });
    currentVideoInfo = info;

    videoTitle.textContent = info.title || "Unknown title";
    videoUrl.textContent   = shortenUrl(info.url);

    // Thumbnail
    if (info.videoId) {
      const img = document.createElement("img");
      img.src = `https://img.youtube.com/vi/${info.videoId}/mqdefault.jpg`;
      img.alt = info.title;
      videoThumb.appendChild(img);
    }

    transcribeBtn.disabled = false;
  } catch (err) {
    videoTitle.textContent = "Could not read video info";
    videoUrl.textContent   = "Make sure the page is fully loaded";
    transcribeBtn.disabled  = true;
  }
}

// ── Transcribe ────────────────────────────────────────────────────────────────
transcribeBtn.addEventListener("click", async () => {
  if (!currentVideoInfo) return;

  hideError();
  showStatus("Contacting backend…");
  transcribeBtn.disabled = true;
  transcriptSection.style.display = "none";

  const steps = [
    "Downloading audio (this may take a moment)…",
    "Transcribing with Whisper (be patient for long videos)…",
    "Almost done…",
  ];
  let stepIdx = 0;
  const stepInterval = setInterval(() => {
    stepIdx = Math.min(stepIdx + 1, steps.length - 1);
    statusText.textContent = steps[stepIdx];
  }, 6000);

  try {
    const res = await fetch(`${API_BASE}/transcribe`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        url:      currentVideoInfo.url,
        language: langSelect.value,
      }),
    });

    clearInterval(stepInterval);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Unknown error" }));
      throw new Error(err.detail || `Server error ${res.status}`);
    }

    const data = await res.json();
    hideStatus();
    renderTranscript(data);

  } catch (err) {
    clearInterval(stepInterval);
    hideStatus();

    let msg = err.message || "Unknown error";
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
      msg = "Cannot reach backend. Make sure it's running:\n  cd backend\n  uvicorn main:app --reload";
    }
    showError(msg);
  } finally {
    transcribeBtn.disabled = false;
  }
});

// ── Render transcript ─────────────────────────────────────────────────────────
function renderTranscript(data) {
  const { title, segments, language, cached } = data;

  transcriptMeta.textContent =
    `${segments.length} segments · lang: ${language}${cached ? " · cached" : ""}`;

  transcriptList.innerHTML = "";

  if (!segments.length) {
    transcriptList.innerHTML = `<div class="empty-state"><p>No speech detected in this video.</p></div>`;
  } else {
    segments.forEach((seg, i) => {
      const el = buildSegmentEl(seg, title, i);
      transcriptList.appendChild(el);
    });
  }

  transcriptSection.style.display = "";
}

function buildSegmentEl(seg, videoTitle, index) {
  const div = document.createElement("div");
  div.className = "segment";
  div.style.animationDelay = `${Math.min(index * 20, 300)}ms`;

  const timeStr = formatTime(seg.start);
  const text    = seg.text || "";

  div.innerHTML = `
    <div class="segment-top">
      <span class="segment-time">${timeStr}</span>
      <div class="segment-actions">
        <!-- Jump to time -->
        <button class="btn-icon-only" title="Jump to ${timeStr}" data-action="jump" data-time="${seg.start}">
          <svg viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="8" stroke="currentColor" stroke-width="1.4"/>
            <path d="M8 7l5 3-5 3V7z" fill="currentColor"/>
          </svg>
        </button>
        <!-- Copy text -->
        <button class="btn-icon-only" title="Copy text" data-action="copy">
          <svg viewBox="0 0 20 20" fill="none">
            <rect x="7" y="3" width="10" height="13" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M4 6H3a1 1 0 00-1 1v10a1 1 0 001 1h9a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </button>
        <!-- Save phrase -->
        <button class="btn-icon-only" title="Save phrase" data-action="save">
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M4 3h12a1 1 0 011 1v13l-7-3-7 3V4a1 1 0 011-1z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="segment-text${text ? "" : " empty"}">${escHtml(text) || "(no speech)"}</div>
  `;

  // Action handlers
  div.querySelector('[data-action="jump"]').addEventListener("click", () => {
    jumpToTime(seg.start);
  });

  div.querySelector('[data-action="copy"]').addEventListener("click", async (e) => {
    await navigator.clipboard.writeText(text);
    const btn = e.currentTarget;
    btn.style.color = "var(--accent)";
    setTimeout(() => btn.style.color = "", 800);
  });

  div.querySelector('[data-action="save"]').addEventListener("click", async () => {
    await savePhrase({ text, time: seg.start, videoTitle, videoUrl: currentVideoInfo?.url || "" });
    div.classList.add("saved", "flash-saved");
    setTimeout(() => div.classList.remove("flash-saved"), 400);
    await refreshSavedBadge();
  });

  return div;
}

// ── Jump to time ──────────────────────────────────────────────────────────────
async function jumpToTime(seconds) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, { type: "SEEK_TO", time: seconds });
    }
  } catch (err) {
    console.warn("Could not seek:", err);
  }
}

// ── Saved phrases ─────────────────────────────────────────────────────────────
async function savePhrase(phrase) {
  const { savedPhrases = [] } = await chrome.storage.local.get("savedPhrases");
  // Avoid exact duplicates
  if (!savedPhrases.some(p => p.text === phrase.text)) {
    savedPhrases.unshift({ ...phrase, savedAt: Date.now() });
    await chrome.storage.local.set({ savedPhrases });
  }
}

async function loadSavedPhrases() {
  const { savedPhrases = [] } = await chrome.storage.local.get("savedPhrases");
  return savedPhrases;
}

async function refreshSavedBadge() {
  const phrases = await loadSavedPhrases();
  if (phrases.length > 0) {
    savedBadge.textContent = phrases.length;
    savedBadge.style.display = "";
  } else {
    savedBadge.style.display = "none";
  }
}

async function renderSavedPhrases() {
  const phrases = await loadSavedPhrases();

  savedCount.textContent = `${phrases.length} phrase${phrases.length !== 1 ? "s" : ""} saved`;
  savedList.innerHTML = "";

  if (!phrases.length) {
    savedEmpty.style.display = "";
    savedList.style.display  = "none";
    return;
  }

  savedEmpty.style.display = "none";
  savedList.style.display  = "";

  phrases.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "saved-item";
    div.style.animationDelay = `${i * 18}ms`;
    div.innerHTML = `
      <div class="saved-item-text">${escHtml(p.text)}</div>
      <div class="saved-item-meta">
        <span class="saved-item-video">${escHtml(p.videoTitle || "Unknown video")} · ${formatTime(p.time)}</span>
        <button class="btn-icon-only" title="Copy" data-copy="${escHtml(p.text)}">
          <svg viewBox="0 0 20 20" fill="none">
            <rect x="7" y="3" width="10" height="13" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
            <path d="M4 6H3a1 1 0 00-1 1v10a1 1 0 001 1h9a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.4"/>
          </svg>
        </button>
        <button class="saved-item-delete" data-index="${i}" title="Delete">✕</button>
      </div>
    `;

    div.querySelector("[data-copy]").addEventListener("click", async (e) => {
      await navigator.clipboard.writeText(p.text);
      const btn = e.currentTarget;
      btn.style.color = "var(--accent)";
      setTimeout(() => btn.style.color = "", 800);
    });

    div.querySelector("[data-index]").addEventListener("click", async () => {
      const { savedPhrases = [] } = await chrome.storage.local.get("savedPhrases");
      savedPhrases.splice(i, 1);
      await chrome.storage.local.set({ savedPhrases });
      renderSavedPhrases();
      refreshSavedBadge();
    });

    savedList.appendChild(div);
  });
}

clearAllSavedBtn.addEventListener("click", async () => {
  if (confirm("Clear all saved phrases?")) {
    await chrome.storage.local.set({ savedPhrases: [] });
    renderSavedPhrases();
    refreshSavedBadge();
  }
});

// ── Clear transcript ──────────────────────────────────────────────────────────
clearTranscriptBtn.addEventListener("click", () => {
  transcriptSection.style.display = "none";
  transcriptList.innerHTML = "";
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(msg) {
  statusText.textContent = msg;
  statusBox.style.display = "";
}
function hideStatus() { statusBox.style.display = "none"; }

function showError(msg) {
  errorText.textContent = msg;
  errorBox.style.display = "";
}
function hideError() { errorBox.style.display = "none"; }

function formatTime(secs) {
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${pad(m % 60)}:${pad(s % 60)}`;
  return `${m}:${pad(s % 60)}`;
}

function pad(n) { return String(n).padStart(2, "0"); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname + u.search.slice(0, 30);
  } catch {
    return url.slice(0, 50);
  }
}
