// content/content.js
// Injected into every youtube.com/watch page.
// Handles messages from the popup.

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
});

function getVideoInfo() {
  const url   = window.location.href;
  const video = document.querySelector("video");

  // Extract video ID from URL
  const match = url.match(/[?&]v=([^&]+)/);
  const videoId = match ? match[1] : null;

  // Title: prefer the <title> tag text, strip " - YouTube" suffix
  let title = document.title.replace(/\s*[-–]\s*YouTube\s*$/, "").trim();
  if (!title) {
    const h1 = document.querySelector("h1.ytd-watch-metadata yt-formatted-string");
    title = h1 ? h1.textContent.trim() : "Unknown Video";
  }

  const currentTime = video ? video.currentTime : 0;

  return { url, videoId, title, currentTime };
}

function seekTo(seconds) {
  const video = document.querySelector("video");
  if (video) {
    video.currentTime = seconds;
    video.play().catch(() => {}); // Some browsers block autoplay; ignore error
  }
}
