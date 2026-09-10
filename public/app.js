const uploadCard = document.querySelector('#uploadCard');
const fileInput = document.querySelector('#fileInput');
const resultPanel = document.querySelector('#resultPanel');
const resultTitle = document.querySelector('#resultTitle');
const player = document.querySelector('#player');
const hlsUrlEl = document.querySelector('#hlsUrl');
const dashUrlEl = document.querySelector('#dashUrl');
const hlsButton = document.querySelector('#hlsButton');
const dashButton = document.querySelector('#dashButton');
const watchButton = document.querySelector('#watchButton');
const copyHls = document.querySelector('#copyHls');
const copyDash = document.querySelector('#copyDash');
const downloadLink = document.querySelector('#downloadLink');
const clearButton = document.querySelector('#clearButton');

const modal = document.querySelector('#modal');
const modalIcon = document.querySelector('#modalIcon');
const modalTitle = document.querySelector('#modalTitle');
const modalText = document.querySelector('#modalText');
const modalClose = document.querySelector('#modalClose');
const modalActions = document.querySelector('#modalActions');
const progressWrap = document.querySelector('#progressWrap');
const progressLabel = document.querySelector('#progressLabel');
const progressPercent = document.querySelector('#progressPercent');
const progressBar = document.querySelector('#progressBar');
const toast = document.querySelector('#toast');

let activeJobId = null;
let pollTimer = null;
let currentHls = '';
let currentDash = '';
let hlsInstance = null;
let dashInstance = null;

const icons = {
  upload: '<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 16V4m0 0-4 4m4-4 4 4M5 13v4.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V13" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  spin: '<div class="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-cyan-300"></div>',
  success: '<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  error: '<svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.3 4.7 2.6 18a2 2 0 0 0 1.73 3h15.34A2 2 0 0 0 21.4 18L13.7 4.7a2 2 0 0 0-3.4 0Z" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function openModal({ title, text, icon, progress = false, closeable = true }) {
  modalTitle.textContent = title;
  modalText.textContent = text;
  modalIcon.innerHTML = icon;
  progressWrap.classList.toggle('hidden', !progress);
  modalClose.classList.toggle('hidden', !closeable);
  modalActions.classList.add('hidden');
  modalActions.innerHTML = '';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeModal() {
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function setProgress(value, label = 'Processing') {
  const safe = Math.max(0, Math.min(100, Math.round(value)));
  progressLabel.textContent = label;
  progressPercent.textContent = `${safe}%`;
  progressBar.style.width = `${safe}%`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 2200);
}

function resetPlayer() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
  if (dashInstance) {
    try { dashInstance.reset(); } catch (_) { /* no-op */ }
    dashInstance = null;
  }
  player.removeAttribute('src');
  player.load();
}

function playHls() {
  if (!currentHls) return;
  resetPlayer();
  if (window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
    hlsInstance.loadSource(currentHls);
    hlsInstance.attachMedia(player);
    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (data?.fatal) showToast('HLS playback error. Try DASH.');
    });
  } else if (player.canPlayType('application/vnd.apple.mpegurl')) {
    player.src = currentHls;
  } else {
    showToast('This browser cannot play HLS here. Try DASH.');
    return;
  }
  watchButton.textContent = 'Playing HLS';
  void player.play().catch(() => {});
}

function playDash() {
  if (!currentDash || !window.dashjs) return;
  resetPlayer();
  dashInstance = window.dashjs.MediaPlayer().create();
  dashInstance.initialize(player, currentDash, true);
  watchButton.textContent = 'Playing DASH';
}

function copyText(text, label) {
  const absolute = new URL(text, window.location.origin).href;
  if (!navigator.clipboard) {
    showToast('Clipboard unavailable in this browser');
    return;
  }
  navigator.clipboard.writeText(absolute)
    .then(() => showToast(`${label} copied`))
    .catch(() => showToast('Copy failed.'));
}

async function deleteActiveJob() {
  if (!activeJobId) return;
  try {
    await fetch(`/api/videos/${activeJobId}`, { method: 'DELETE', keepalive: true });
  } catch (_) {
    // Server TTL cleanup is the fallback.
  }
  activeJobId = null;
}

async function pollStatus() {
  if (!activeJobId) return;
  try {
    const response = await fetch(`/api/videos/${activeJobId}/status`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Status request failed');
    const job = await response.json();

    if (job.status === 'processing') {
      const serverProgress = Number(job.progress ?? 0);
      setProgress(Math.max(30, serverProgress), 'Encoding HLS + DASH');
      return;
    }

    if (job.status === 'queued') {
      setProgress(25, 'Queued for encoding');
      return;
    }

    if (job.status === 'ready') {
      window.clearInterval(pollTimer);
      setProgress(100, 'Complete');
      currentHls = job.hlsUrl;
      currentDash = job.dashUrl;
      resultTitle.textContent = job.filename;
      hlsUrlEl.textContent = new URL(currentHls, window.location.origin).href;
      dashUrlEl.textContent = new URL(currentDash, window.location.origin).href;
      downloadLink.href = currentDash;
      resultPanel.classList.remove('hidden');
      openModal({ title: 'Video ready', text: 'HLS and MPEG-DASH outputs are ready to play.', icon: icons.success, progress: true, closeable: true });
      setProgress(100, 'Ready');
      modalActions.classList.remove('hidden');
      modalActions.classList.add('flex');
      const button = document.createElement('button');
      button.className = 'rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-100';
      button.textContent = 'Watch HLS';
      button.onclick = () => { closeModal(); playHls(); resultPanel.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
      modalActions.appendChild(button);
      return;
    }

    if (job.status === 'error') {
      window.clearInterval(pollTimer);
      openModal({ title: 'Encoding failed', text: job.error || 'The server could not encode this video.', icon: icons.error, progress: false });
    }
  } catch (_) {
    // Brief network hiccups should not interrupt encoding.
  }
}

function beginPolling() {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(pollStatus, 1200);
  void pollStatus();
}

function uploadFile(file) {
  const form = new FormData();
  form.append('video', file);

  openModal({ title: 'Uploading video', text: 'Sending your video to the transcoder…', icon: icons.upload, progress: true, closeable: false });
  setProgress(0, 'Uploading');
  resultPanel.classList.add('hidden');

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/videos/upload');
  xhr.responseType = 'json';

  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    setProgress((event.loaded / event.total) * 25, 'Uploading');
  };

  xhr.onerror = () => {
    openModal({ title: 'Upload failed', text: 'The upload connection was interrupted.', icon: icons.error, progress: false });
  };

  xhr.onload = () => {
    if (xhr.status < 200 || xhr.status >= 300 || !xhr.response?.id) {
      const message = xhr.response?.message || 'Upload rejected. Check the file type and size.';
      openModal({ title: 'Upload failed', text: Array.isArray(message) ? message.join(', ') : message, icon: icons.error, progress: false });
      return;
    }

    activeJobId = xhr.response.id;
    setProgress(25, 'Queued for encoding');
    modalTitle.textContent = 'Encoding video';
    modalText.textContent = 'FFmpeg is creating streaming-ready HLS and DASH output…';
    modalIcon.innerHTML = icons.spin;
    beginPolling();
  };

  xhr.send(form);
}

uploadCard.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  uploadFile(file);
});

hlsButton.addEventListener('click', () => copyText(currentHls, 'HLS URL'));

dashButton.addEventListener('click', () => copyText(currentDash, 'DASH URL'));
copyHls.addEventListener('click', () => copyText(currentHls, 'HLS URL'));
copyDash.addEventListener('click', () => copyText(currentDash, 'DASH URL'));
watchButton.addEventListener('click', playHls);

dashButton.addEventListener('dblclick', playDash);

downloadLink.addEventListener('click', () => showToast('Opening DASH manifest'));

clearButton.addEventListener('click', () => {
  openModal({ title: 'Clear this video?', text: 'The temporary files will be removed from the server.', icon: icons.error, progress: false, closeable: true });
  modalActions.classList.remove('hidden');
  modalActions.classList.add('flex');

  const cancel = document.createElement('button');
  cancel.className = 'rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-slate-300 hover:bg-white/[0.08]';
  cancel.textContent = 'Cancel';
  cancel.onclick = closeModal;

  const confirm = document.createElement('button');
  confirm.className = 'rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-red-100';
  confirm.textContent = 'Clear video';
  confirm.onclick = async () => {
    closeModal();
    window.clearInterval(pollTimer);
    resetPlayer();
    await deleteActiveJob();
    currentHls = '';
    currentDash = '';
    resultPanel.classList.add('hidden');
    showToast('Video cleared');
  };

  modalActions.append(cancel, confirm);
});

modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (event) => {
  if (event.target === modal && !modalClose.classList.contains('hidden')) closeModal();
});

window.addEventListener('pagehide', () => {
  if (activeJobId) {
    navigator.sendBeacon(`/api/videos/${activeJobId}/cleanup`, new Blob([], { type: 'application/octet-stream' }));
  }
});
