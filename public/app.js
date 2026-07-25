// SSE Connection and Global UI State
let eventSource = null;
let currentTab = 'list';
let currentReportTab = 'visual';
let playlistVideos = []; // Cache scanned playlist items

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  checkServerStatus();
  initSSE();
  refreshHistory();
  refreshReport();
  loadSettings();
});

// Check system online status and count files
function checkServerStatus() {
  fetch('/api/status')
    .then(res => res.json())
    .then(data => {
      const indicator = document.getElementById('status-indicator');
      const label = document.getElementById('status-label');
      const count = document.getElementById('download-count');
      
      if (data.status === 'ready') {
        indicator.className = 'status-indicator status-online';
        label.innerText = 'Server Ready';
        count.innerText = data.downloadedCount;
      } else {
        indicator.className = 'status-indicator status-offline';
        label.innerText = 'Server Error';
      }
    })
    .catch(err => {
      console.error(err);
      const indicator = document.getElementById('status-indicator');
      const label = document.getElementById('status-label');
      indicator.className = 'status-indicator status-offline';
      label.innerText = 'Server Disconnected';
    });
}

// Initialize Server-Sent Events
function initSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/events');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSSEMessage(data);
    } catch (e) {
      console.error('Failed to parse SSE event data:', e);
    }
  };

  eventSource.onerror = (err) => {
    console.error('SSE Error:', err);
    eventSource.close();
    // Retry connection after 5 seconds
    setTimeout(initSSE, 5000);
  };
}

// Handle Server-Sent Events data
function handleSSEMessage(data) {
  switch (data.type) {
    case 'connected':
      console.log('SSE Stream established.');
      break;

    case 'init':
      renderQueue(data.queue || []);
      updateActiveDownload(data.active);
      updateControlsUI(data.isPaused, data.isDownloading);
      break;

    case 'status-updated':
      updateControlsUI(data.isPaused, data.isDownloading);
      break;

    case 'active-change':
      updateActiveDownload(data.active);
      break;

    case 'item-updated':
      // Updates an item in the queue view or handles updates
      checkServerStatus();
      break;

    case 'progress':
      updateProgressUI(data.progress, data.speed, data.eta);
      break;

    case 'log':
      showToast(data.message, 'info');
      break;

    case 'report-ready':
      showToast(data.message, 'success');
      refreshHistory();
      refreshReport();
      checkServerStatus();
      // Reset queue lists
      renderQueue([]);
      break;

    default:
      console.log('Unhandled SSE event:', data);
  }
}

// Switch UI tabs
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tab-list-btn').classList.toggle('active', tab === 'list');
  document.getElementById('tab-playlist-btn').classList.toggle('active', tab === 'playlist');
  
  document.getElementById('pane-list').classList.toggle('active', tab === 'list');
  document.getElementById('pane-playlist').classList.toggle('active', tab === 'playlist');
}

// Switch report format tab
function switchReportTab(tab) {
  currentReportTab = tab;
  const buttons = document.querySelectorAll('.report-tab-btn');
  buttons[0].classList.toggle('active', tab === 'visual');
  buttons[1].classList.toggle('active', tab === 'raw');

  document.getElementById('report-visual-pane').classList.toggle('hidden', tab !== 'visual');
  document.getElementById('report-raw-pane').classList.toggle('hidden', tab !== 'raw');
}

// Submit a custom list of URLs to the download queue
function submitUrlList() {
  const textarea = document.getElementById('url-list-textarea');
  const text = textarea.value.trim();
  if (!text) {
    showToast('Please enter at least one URL.', 'error');
    return;
  }

  // Split by newlines/spaces, filter out empty lines
  const rawUrls = text.split(/[\n\s]+/).filter(url => url.trim().length > 0);
  if (rawUrls.length === 0) {
    showToast('Please enter at least one valid URL.', 'error');
    return;
  }

  // Format payload
  const videos = rawUrls.map(url => ({ url: url.trim() }));
  const downloadButton = document.getElementById('download-list-btn');
  downloadButton.disabled = true;
  downloadButton.innerHTML = `<i data-lucide="loader" class="rotating"></i> Queuing...`;
  lucide.createIcons();

  fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos })
  })
    .then(res => res.json())
    .then(data => {
      showToast(data.message, 'success');
      textarea.value = ''; // Clear textarea
      // Refresh status
      checkServerStatus();
      // Re-initialize queue layout
      initSSE();
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to queue downloads.', 'error');
    })
    .finally(() => {
      downloadButton.disabled = false;
      downloadButton.innerHTML = `<i data-lucide="download"></i> Start Downloading List`;
      lucide.createIcons();
    });
}

// Scan a channel or playlist URL to retrieve video info
function scanPlaylist() {
  const input = document.getElementById('playlist-url-input');
  const url = input.value.trim();
  if (!url) {
    showToast('Please enter a channel or playlist URL.', 'error');
    return;
  }

  const scanButton = document.getElementById('scan-playlist-btn');
  const resultsBox = document.getElementById('playlist-results-box');
  
  scanButton.disabled = true;
  scanButton.innerHTML = `<i data-lucide="loader" class="rotating"></i> Scanning...`;
  resultsBox.classList.remove('hidden');
  
  const titleEl = document.getElementById('playlist-title');
  const countEl = document.getElementById('playlist-count');
  const itemsListEl = document.getElementById('playlist-items-list');
  
  titleEl.innerText = 'Scanning YouTube...';
  countEl.innerText = 'This may take a moment depending on the playlist size';
  itemsListEl.innerHTML = `
    <div class="empty-state">
      <i data-lucide="loader" class="rotating"></i>
      <p>Reading playlist metadata...</p>
    </div>
  `;
  lucide.createIcons();

  fetch('/api/extract', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  })
    .then(res => {
      if (!res.ok) {
        return res.json().then(d => { throw new Error(d.error || 'Failed to scan'); });
      }
      return res.json();
    })
    .then(data => {
      playlistVideos = data.videos || [];
      
      titleEl.innerText = data.title || 'Extracted Videos';
      countEl.innerText = `${playlistVideos.length} videos resolved`;
      
      renderPlaylistItems();
      updateSelectedCount();
    })
    .catch(err => {
      console.error(err);
      showToast(err.message, 'error');
      resultsBox.classList.add('hidden');
    })
    .finally(() => {
      scanButton.disabled = false;
      scanButton.innerHTML = `<i data-lucide="search"></i> Scan`;
      lucide.createIcons();
    });
}

// Render scanned items list with checkboxes
function renderPlaylistItems() {
  const itemsListEl = document.getElementById('playlist-items-list');
  itemsListEl.innerHTML = '';
  
  if (playlistVideos.length === 0) {
    itemsListEl.innerHTML = `
      <div class="empty-state">
        <i data-lucide="slash"></i>
        <p>No videos found or failed to extract</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  playlistVideos.forEach((video, idx) => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    
    // Checked by default if not downloaded
    const isChecked = !video.isDownloaded;
    const isDisabled = video.isDownloaded ? 'disabled' : '';
    
    item.innerHTML = `
      <input type="checkbox" id="chk-vid-${idx}" data-index="${idx}" ${isChecked ? 'checked' : ''} ${isDisabled} onclick="handleCheckboxClick(event, ${idx})">
      <span class="playlist-item-title" title="${video.title}">${video.title}</span>
      <span class="playlist-item-status ${video.isDownloaded ? 'status-badge-ok' : 'status-badge-pending'}">
        ${video.isDownloaded ? 'Downloaded' : 'Ready'}
      </span>
    `;
    itemsListEl.appendChild(item);
  });
}

// Toggle Select All / Clear Checkboxes
function toggleSelectAllPlaylist(select) {
  const checkboxes = document.querySelectorAll('.playlist-items-list input[type="checkbox"]');
  checkboxes.forEach(cb => cb.checked = select);
  updateSelectedCount();
}

let lastCheckedIdx = null;

// Handle checkbox clicking with Shift key range checking
function handleCheckboxClick(event, idx) {
  const currentCheckbox = event.target;
  
  if (event.shiftKey && lastCheckedIdx !== null) {
    let start = Math.min(idx, lastCheckedIdx);
    let end = Math.max(idx, lastCheckedIdx);
    
    for (let i = start; i <= end; i++) {
      const cb = document.getElementById(`chk-vid-${i}`);
      if (cb) {
        cb.checked = currentCheckbox.checked;
      }
    }
  }
  
  lastCheckedIdx = idx;
  updateSelectedCount();
}

// Update the checkbox counter UI
function updateSelectedCount() {
  const checkboxes = document.querySelectorAll('.playlist-items-list input[type="checkbox"]:checked');
  const total = playlistVideos.length;
  document.getElementById('selected-count').innerText = `${checkboxes.length}/${total} selected`;
  
  // Reset last checked index if selection changes completely
  if (checkboxes.length === 0 || checkboxes.length === total) {
    lastCheckedIdx = null;
  }
}

// Send selected playlist videos to queue
function downloadSelectedPlaylist() {
  const checkedBoxes = document.querySelectorAll('.playlist-items-list input[type="checkbox"]:checked');
  if (checkedBoxes.length === 0) {
    showToast('Please select at least one video to download.', 'error');
    return;
  }

  const selectedVideos = Array.from(checkedBoxes).map(cb => {
    const idx = parseInt(cb.dataset.index, 10);
    return playlistVideos[idx];
  });

  const downloadButton = document.getElementById('download-selected-btn');
  downloadButton.disabled = true;
  downloadButton.innerHTML = `<i data-lucide="loader" class="rotating"></i> Queuing...`;
  lucide.createIcons();

  fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videos: selectedVideos })
  })
    .then(res => res.json())
    .then(data => {
      showToast(data.message, 'success');
      
      // Update local state: mark selected videos as downloaded so they check/disable correctly
      selectedVideos.forEach(selectedVid => {
        const localVid = playlistVideos.find(v => v.id === selectedVid.id);
        if (localVid) {
          localVid.isDownloaded = true;
        }
      });
      
      // Re-render items and update counts
      renderPlaylistItems();
      updateSelectedCount();
      
      checkServerStatus();
      initSSE();
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to queue playlist downloads.', 'error');
    })
    .finally(() => {
      downloadButton.disabled = false;
      downloadButton.innerHTML = `<i data-lucide="download"></i> Download Selected`;
      lucide.createIcons();
    });
}

// Render active queue list
function renderQueue(queue) {
  const container = document.getElementById('queue-container');
  const listEl = document.getElementById('queue-items-list');
  const countEl = document.getElementById('queue-count');
  
  // Filter out completed or failed items that are already processed in active run
  const pendingItems = queue.filter(item => item.status === 'pending');
  countEl.innerText = pendingItems.length;

  if (pendingItems.length > 0) {
    container.classList.remove('hidden');
    listEl.innerHTML = '';
    
    pendingItems.forEach(item => {
      const el = document.createElement('div');
      el.className = 'queue-item';
      el.innerHTML = `
        <div class="queue-item-left">
          <i data-lucide="clock"></i>
          <span class="queue-item-title" title="${item.title || item.url}">${item.title || item.url}</span>
        </div>
        <span class="queue-item-badge queue-badge-pending">Pending</span>
      `;
      listEl.appendChild(el);
    });
    lucide.createIcons();
  } else {
    container.classList.add('hidden');
  }
}

// Update Active Download card UI details
function updateActiveDownload(active) {
  const container = document.getElementById('active-download-container');
  if (!active) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  
  const titleEl = document.getElementById('active-video-title');
  const urlEl = document.getElementById('active-video-url');
  const sttEl = document.getElementById('active-stt');
  const thumbEl = document.getElementById('active-video-thumb');
  const progressFill = document.getElementById('active-progress-fill');
  const progressText = document.getElementById('active-progress-text');
  
  titleEl.innerText = active.title || 'Downloading...';
  urlEl.innerText = active.url;
  urlEl.href = active.url;
  sttEl.innerText = active.stt || 'Pending';
  
  if (active.thumbnail) {
    thumbEl.innerHTML = `<img src="${active.thumbnail}" alt="Thumbnail">`;
  } else {
    thumbEl.innerHTML = `<div class="thumb-placeholder"><i data-lucide="video"></i></div>`;
    lucide.createIcons();
  }

  updateProgressUI(active.progress || 0, active.speed || '0 KB/s', active.eta || '00:00');
}

// Update active download speed/eta metrics
function updateProgressUI(progress, speed, eta) {
  const progressFill = document.getElementById('active-progress-fill');
  const progressText = document.getElementById('active-progress-text');
  const speedEl = document.getElementById('active-speed');
  const etaEl = document.getElementById('active-eta');
  
  if (progressFill) progressFill.style.width = `${progress}%`;
  if (progressText) progressText.innerText = `${Math.round(progress)}%`;
  if (speedEl) speedEl.innerText = speed || '0 KB/s';
  if (etaEl) etaEl.innerText = eta || '00:00';
}

// Pull logs from server history
function refreshHistory() {
  const icon = document.getElementById('history-refresh-icon');
  if (icon) icon.classList.add('rotating');
  
  fetch('/api/history')
    .then(res => res.json())
    .then(data => {
      const listEl = document.getElementById('history-items-list');
      listEl.innerHTML = '';
      
      if (!data.logs || data.logs.length === 0) {
        listEl.innerHTML = `
          <div class="empty-state">
            <i data-lucide="history"></i>
            <p>No downloads logged yet</p>
          </div>
        `;
        lucide.createIcons();
        return;
      }

      data.logs.forEach(log => {
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
          <div class="history-item-top">
            <span class="history-title" title="${log.title}">${log.title}</span>
            <span class="history-date">${log.date.split(' ')[1] || log.date}</span>
          </div>
          <a href="${log.url}" target="_blank" class="history-link">${log.url}</a>
        `;
        listEl.appendChild(item);
      });
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to refresh history logs.', 'error');
    })
    .finally(() => {
      if (icon) {
        setTimeout(() => icon.classList.remove('rotating'), 500);
      }
    });
}

// Pull latest report details
function refreshReport() {
  const icon = document.getElementById('report-refresh-icon');
  if (icon) icon.classList.add('rotating');

  fetch('/api/report')
    .then(res => res.json())
    .then(data => {
      // 1. Raw Pane Update
      const pre = document.getElementById('raw-report-text');
      pre.textContent = data.txt || 'No report content available. Run some downloads to generate report logs.';
      
      // 2. Summary Pane Update
      const listEl = document.getElementById('report-runs-list');
      const statsGrid = document.getElementById('report-stats-grid');
      
      if (!data.json || data.json.length === 0) {
        statsGrid.classList.add('hidden');
        listEl.innerHTML = `
          <div class="empty-state">
            <i data-lucide="clipboard-list"></i>
            <p>No reports generated yet</p>
          </div>
        `;
        lucide.createIcons();
        return;
      }
      
      // Load current stats for the latest run
      const latestRun = data.json[0];
      statsGrid.classList.remove('hidden');
      document.getElementById('report-stat-ok').innerText = latestRun.success || 0;
      document.getElementById('report-stat-fail').innerText = latestRun.failed || 0;
      document.getElementById('report-stat-skip').innerText = latestRun.skipped || 0;

      listEl.innerHTML = '';
      data.json.forEach(run => {
        const item = document.createElement('div');
        item.className = 'report-run-card';
        item.innerHTML = `
          <div class="report-run-card-top">
            <span class="report-run-meta">${run.timestamp}</span>
            <span class="text-success">${run.success} OK</span>
          </div>
          <div class="report-run-details">
            <span>Attempted: ${run.total}</span>
            <span class="text-danger">Failed: ${run.failed}</span>
            <span class="text-info">Skipped: ${run.skipped}</span>
          </div>
        `;
        listEl.appendChild(item);
      });
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to refresh report history.', 'error');
    })
    .finally(() => {
      if (icon) {
        setTimeout(() => icon.classList.remove('rotating'), 500);
      }
    });
}

// Toast Notifications System Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let iconName = 'info';
  if (type === 'success') iconName = 'check-circle';
  if (type === 'error') iconName = 'alert-triangle';

  toast.innerHTML = `
    <i data-lucide="${iconName}"></i>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  lucide.createIcons();

  // Self destroy after 4 seconds
  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// Pause download queue
function pauseDownloads() {
  fetch('/api/pause', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showToast(data.message, 'success');
      }
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to pause downloads.', 'error');
    });
}

// Resume download queue
function resumeDownloads() {
  fetch('/api/resume', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        showToast(data.message, 'success');
      }
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to resume downloads.', 'error');
    });
}

// Cancel all downloads
function cancelDownloads() {
  if (confirm('Are you sure you want to cancel the entire queue and terminate the active download?')) {
    fetch('/api/cancel', { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          showToast(data.message, 'success');
        }
      })
      .catch(err => {
        console.error(err);
        showToast('Failed to cancel downloads.', 'error');
      });
  }
}

// Helper to switch Pause / Resume buttons visually
function updateControlsUI(isPaused, isDownloading) {
  const pauseBtn = document.getElementById('pause-btn');
  const resumeBtn = document.getElementById('resume-btn');
  if (!pauseBtn || !resumeBtn) return;

  if (isPaused) {
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.remove('hidden');
  } else {
    pauseBtn.classList.remove('hidden');
    resumeBtn.classList.add('hidden');
  }
}

// Load current settings from server
function loadSettings() {
  fetch('/api/settings')
    .then(res => res.json())
    .then(data => {
      const dirInput = document.getElementById('custom-dir-input');
      const resSelect = document.getElementById('max-res-select');
      if (dirInput) dirInput.value = data.downloadDir || '';
      if (resSelect) resSelect.value = data.maxResolution || 'best';
    })
    .catch(err => console.error('Failed to load settings:', err));
}

// Save dynamic save settings (directory and resolution limit)
function saveAppSettings() {
  const dirVal = document.getElementById('custom-dir-input').value.trim();
  const resVal = document.getElementById('max-res-select').value;
  
  // Show saving visual feedback
  const saveBtn = document.querySelector('.settings-body button');
  const originalHtml = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = `<i data-lucide="loader" class="rotating"></i> Saving...`;
  lucide.createIcons();

  fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      downloadDir: dirVal,
      maxResolution: resVal 
    })
  })
    .then(res => res.json())
    .then(data => {
      if (data.error) {
        showToast(data.error, 'error');
      } else {
        showToast(data.message, 'success');
        // Refresh status file count
        checkServerStatus();
      }
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to save settings.', 'error');
    })
    .finally(() => {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalHtml;
      lucide.createIcons();
    });
}

// Open folder browser dialog (Windows only)
function browseDirectory() {
  const browseBtn = document.getElementById('browse-dir-btn');
  if (!browseBtn) return;
  const originalHtml = browseBtn.innerHTML;
  browseBtn.disabled = true;
  browseBtn.innerHTML = `<i data-lucide="loader" class="rotating"></i>`;
  lucide.createIcons();

  fetch('/api/browse-directory', { method: 'POST' })
    .then(res => res.json())
    .then(data => {
      if (data.error) {
        showToast(data.error, 'error');
      } else if (data.selectedPath) {
        document.getElementById('custom-dir-input').value = data.selectedPath;
        showToast('Save directory selected successfully.', 'success');
      }
    })
    .catch(err => {
      console.error(err);
      showToast('Failed to open folder browser.', 'error');
    })
    .finally(() => {
      browseBtn.disabled = false;
      browseBtn.innerHTML = originalHtml;
      lucide.createIcons();
    });
}
