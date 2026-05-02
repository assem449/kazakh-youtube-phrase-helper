// content/content.js

var subtitleOverlay = null;
var subtitleSegments = [];
var subtitleInterval = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_VIDEO_INFO") {
    sendResponse(getVideoInfo());
    return true;
  }
  if (message.type === "SEEK_TO") {
    seekTo(message.time);
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "SHOW_SUBTITLES") {
    showSubtitles(message.segments);
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "HIDE_SUBTITLES") {
    hideSubtitles();
    sendResponse({ ok: true });
    return true;
  }
});

window.__kzPhraseHelperLoaded = true;
console.log("[KZ Helper] Content script loaded ✓");

function getVideoInfo() {
  const url = window.location.href;
  const video = document.querySelector("video");
  const match = url.match(/[?&]v=([^&]+)/);
  const videoId = match ? match[1] : null;
  const title = document.title.replace(/\s*[-–]\s*YouTube\s*$/, "").trim();
  const currentTime = video ? video.currentTime : 0;
  return { url, videoId, title, currentTime };
}

function seekTo(seconds) {
  const video = document.querySelector("video");
  if (video) {
    video.currentTime = seconds;
    video.play().catch(() => {});
  }
}

function showSubtitles(segments) {
  subtitleSegments = segments;
  hideSubtitles();

  subtitleOverlay = document.createElement("div");
  subtitleOverlay.id = "kz-subtitle-overlay";
  subtitleOverlay.style.cssText = `
    position: fixed !important;
    bottom: 120px !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    z-index: 2147483647 !important;
    pointer-events: none !important;
    text-align: center !important;
    width: 70% !important;
  `;

  const subtitleText = document.createElement("div");
  subtitleText.id = "kz-subtitle-text";
  subtitleText.style.cssText = `
    display: inline-block;
    background: rgba(0, 0, 0, 0.82);
    color: #ffffff;
    font-size: 20px;
    font-family: 'Segoe UI', Arial, sans-serif;
    padding: 7px 18px;
    border-radius: 5px;
    line-height: 1.5;
    max-width: 100%;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9);
    min-height: 10px;
  `;

  subtitleOverlay.appendChild(subtitleText);
  document.body.appendChild(subtitleOverlay);

  const video = document.querySelector("video");
  if (video) {
    subtitleInterval = setInterval(() => {
      const current = video.currentTime;
      const seg = subtitleSegments.find(
        s => current >= s.start && current <= s.end
      );
      subtitleText.textContent = seg ? seg.text : "";
    }, 100);
  }
}

function hideSubtitles() {
  if (subtitleOverlay) {
    subtitleOverlay.remove();
    subtitleOverlay = null;
  }
  if (subtitleInterval) {
    clearInterval(subtitleInterval);
    subtitleInterval = null;
  }
}
