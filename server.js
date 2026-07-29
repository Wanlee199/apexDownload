const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn, execFile } = require('child_process');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup directories
const BIN_DIR = path.join(__dirname, 'bin');
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const LOG_DIR = path.join(__dirname, 'logs');
const PUBLIC_DIR = path.join(__dirname, 'public');

const LOG_FILE = path.join(LOG_DIR, 'download-log.txt');
const REPORT_TXT_FILE = path.join(LOG_DIR, 'download-report.txt');
const REPORT_JSON_FILE = path.join(LOG_DIR, 'report.json');
const NODE_PATH = `node:${process.execPath.replace(/\\/g, '/')}`;

// Ensure directories exist
[BIN_DIR, DOWNLOAD_DIR, LOG_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Prepend bin directory and Node's directory to environment PATH so spawned processes can find local binaries and node.js
const nodeDir = path.dirname(process.execPath);
process.env.PATH = `${BIN_DIR}${path.delimiter}${nodeDir}${path.delimiter}${process.env.PATH}`;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(PUBLIC_DIR));

// SSE Client list
let sseClients = [];

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let settings = { downloadDir: '', maxResolution: 'best' };

function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse settings file:', e);
    }
  }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

loadSettings();

function getDownloadDir() {
  if (settings.downloadDir && settings.downloadDir.trim().length > 0) {
    const customPath = path.resolve(settings.downloadDir.trim());
    if (!fs.existsSync(customPath)) {
      try {
        fs.mkdirSync(customPath, { recursive: true });
      } catch (e) {
        console.error('Failed to create custom download directory, falling back to default:', e);
        return DOWNLOAD_DIR;
      }
    }
    return customPath;
  }
  return DOWNLOAD_DIR;
}

// Global State Queue
let downloadQueue = [];
let activeDownload = null;
let isDownloading = false;
let isPaused = false;
let activeProcess = null;

// Helper to broadcast state to clients
function broadcast(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  sseClients.forEach(client => client.write(payload));
}

let hasFfmpeg = false;

// Check if FFmpeg is available in the system (either in system PATH or local bin)
function checkFfmpeg() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (error) => {
      hasFfmpeg = !error;
      console.log(`FFmpeg status: ${hasFfmpeg ? 'Found' : 'Not Found (downloads will fall back to best pre-merged format)'}`);
      resolve(hasFfmpeg);
    });
  });
}

const FFMPEG_ZIP_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const FFMPEG_EXE_PATH = path.join(BIN_DIR, 'ffmpeg.exe');

// Check and download portable FFmpeg zip and extract it using PowerShell
function ensureFfmpeg() {
  return new Promise((resolve) => {
    if (fs.existsSync(FFMPEG_EXE_PATH)) {
      hasFfmpeg = true;
      console.log(`FFmpeg binary found at: ${FFMPEG_EXE_PATH}`);
      return resolve(true);
    }

    if (os.platform() !== 'win32') {
      console.log('FFmpeg check skipped. Please install FFmpeg on your system.');
      return resolve(false);
    }

    console.log('FFmpeg binary not found. Starting download of portable FFmpeg in background...');
    const zipPath = path.join(BIN_DIR, 'ffmpeg.zip');
    const tempExtractDir = path.join(BIN_DIR, 'ffmpeg_temp');

    downloadFileWithRedirects(FFMPEG_ZIP_URL, zipPath)
      .then(() => {
        console.log('FFmpeg zip successfully downloaded. Extracting...');
        const { exec } = require('child_process');
        const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempExtractDir}' -Force"`;
        
        exec(cmd, (err) => {
          if (err) {
            console.error('Failed to extract FFmpeg:', err);
            fs.unlink(zipPath, () => {});
            return resolve(false);
          }
          
          try {
            // Find ffmpeg.exe and ffprobe.exe recursively inside the extracted folders
            const findFiles = (dir) => {
              let results = [];
              const list = fs.readdirSync(dir);
              list.forEach(file => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                  results = results.concat(findFiles(fullPath));
                } else if (file === 'ffmpeg.exe' || file === 'ffprobe.exe') {
                  results.push(fullPath);
                }
              });
              return results;
            };

            const found = findFiles(tempExtractDir);
            found.forEach(filePath => {
              const dest = path.join(BIN_DIR, path.basename(filePath));
              fs.renameSync(filePath, dest);
            });

            console.log('==================================================');
            console.log('FFmpeg binaries extracted to bin/ successfully.');
            console.log('==================================================');
            hasFfmpeg = true;
          } catch (e) {
            console.error('Error post-processing FFmpeg extraction:', e);
          } finally {
            // Clean up zip and temp folder
            fs.unlink(zipPath, () => {});
            try {
              fs.rmSync(tempExtractDir, { recursive: true, force: true });
            } catch (rmErr) {
              console.error('Failed to clean up temp extraction folder:', rmErr);
            }
          }
          resolve(true);
        });
      })
      .catch(err => {
        console.error('Failed to download FFmpeg:', err);
        resolve(false);
      });
  });
}

// Get the path of yt-dlp executable based on OS
function getYtDlpPath() {
  const platform = os.platform();
  if (platform === 'win32') {
    return path.join(BIN_DIR, 'yt-dlp.exe');
  } else if (platform === 'darwin') {
    return path.join(BIN_DIR, 'yt-dlp_macos');
  } else {
    return path.join(BIN_DIR, 'yt-dlp');
  }
}

// Check and download yt-dlp binary if missing
function ensureYtDlp() {
  return new Promise((resolve, reject) => {
    const binPath = getYtDlpPath();
    if (fs.existsSync(binPath)) {
      console.log(`yt-dlp binary found at: ${binPath}`);
      return resolve(binPath);
    }

    console.log('yt-dlp binary not found. Downloading...');
    const platform = os.platform();
    let downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    
    if (platform === 'win32') {
      downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
    } else if (platform === 'darwin') {
      downloadUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
    }

    downloadFileWithRedirects(downloadUrl, binPath)
      .then(() => {
        // Set permissions to executable on unix systems
        if (platform !== 'win32') {
          fs.chmodSync(binPath, 0o755);
        }
        console.log(`yt-dlp successfully downloaded to ${binPath}`);
        resolve(binPath);
      })
      .catch(err => {
        console.error('Failed to download yt-dlp binary:', err);
        reject(err);
      });
  });
}

// Helper to download files handling HTTP redirects
function downloadFileWithRedirects(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    const request = https.get(url, (response) => {
      // Handle Redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlinkSync(dest); // Delete partially downloaded file
        downloadFileWithRedirects(response.headers.location, dest)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Failed to download binary: HTTP Status ${response.statusCode}`));
        return;
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(err);
    });
  });
}

// Helper to extract video ID from YouTube URL
function extractVideoId(url) {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/)([^#\&\?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// Clean and sanitize filename and truncate to prevent long path issues on Windows
function sanitizeFilename(title) {
  if (!title) return 'video';
  // Replace invalid Windows filename characters with underscores
  let clean = title.replace(/[\\/:\*\?"<>\|]/g, '_').trim();
  // Limit to 40 characters to prevent Windows path-too-long lock errors
  if (clean.length > 40) {
    clean = clean.substring(0, 40).trim();
  }
  return clean;
}

// Check if video is already downloaded (by ID or URL) in the log-date file
function isVideoDownloaded(videoId, url) {
  if (!fs.existsSync(LOG_FILE)) {
    return false;
  }
  const logs = fs.readFileSync(LOG_FILE, 'utf-8');
  if (videoId && logs.includes(videoId)) {
    return true;
  }
  if (url && logs.includes(url)) {
    return true;
  }
  return false;
}

// Log a video to the log-date file
function logDownloadedVideo(videoId, title, url) {
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const logEntry = `${dateStr} | ${videoId || 'UNKNOWN'} | ${url} | ${title}\n`;
  fs.appendFileSync(LOG_FILE, logEntry, 'utf-8');
}

// Calculate the next STT sequence number by reading the downloads folder
function getNextStt() {
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    return '001';
  }
  const files = fs.readdirSync(DOWNLOAD_DIR);
  let max = 0;
  files.forEach(file => {
    try {
      const stat = fs.statSync(path.join(DOWNLOAD_DIR, file));
      if (stat.isDirectory()) {
        const match = file.match(/^(\d+)\./);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > max) {
            max = num;
          }
        }
      }
    } catch (e) {
      // Ignore reading errors
    }
  });
  return String(max + 1).padStart(3, '0');
}

// Helper to download a thumbnail directly
function downloadThumbnail(url, destPath) {
  return new Promise((resolve) => {
    if (!url) {
      return resolve(false);
    }
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        downloadThumbnail(response.headers.location, destPath).then(resolve);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return resolve(false);
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(true);
      });
    });
    
    request.on('error', () => {
      file.close();
      fs.unlink(destPath, () => {});
      resolve(false);
    });
  });
}

// Write the report file
function generateReport(processedItems) {
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const successes = processedItems.filter(item => item.status === 'completed');
  const failures = processedItems.filter(item => item.status === 'failed');
  const skipped = processedItems.filter(item => item.status === 'skipped');

  // Text Report
  let textReport = `==================================================
DOWNLOAD REPORT - ${dateStr}
==================================================
Total processed: ${processedItems.length}
Succeeded: ${successes.length}
Failed: ${failures.length}
Skipped (Already downloaded): ${skipped.length}

`;

  if (successes.length > 0) {
    textReport += `SUCCESSFUL DOWNLOADS:\n--------------------------------------------------\n`;
    successes.forEach(item => {
      textReport += `[${item.stt}] Title: ${item.title}\n`;
      textReport += `      URL: ${item.url}\n`;
      textReport += `      Saved to: ${item.videoFile}\n`;
      if (item.thumbnailFile) {
        textReport += `      Thumbnail: ${item.thumbnailFile}\n`;
      }
      textReport += `\n`;
    });
  }

  if (failures.length > 0) {
    textReport += `FAILED DOWNLOADS:\n--------------------------------------------------\n`;
    failures.forEach(item => {
      textReport += `- URL: ${item.url}\n`;
      if (item.title) textReport += `  Title: ${item.title}\n`;
      textReport += `  Error: ${item.error}\n\n`;
    });
  }

  if (skipped.length > 0) {
    textReport += `SKIPPED DOWNLOADS (Already in log-date):\n--------------------------------------------------\n`;
    skipped.forEach(item => {
      textReport += `- Title: ${item.title || 'Unknown Title'}\n`;
      textReport += `  URL: ${item.url}\n\n`;
    });
  }

  textReport += `==================================================\n`;

  // Write to text report
  fs.writeFileSync(REPORT_TXT_FILE, textReport, 'utf-8');

  // Append to historical JSON report
  let history = [];
  if (fs.existsSync(REPORT_JSON_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(REPORT_JSON_FILE, 'utf-8'));
    } catch (e) {
      history = [];
    }
  }
  history.unshift({
    timestamp: dateStr,
    total: processedItems.length,
    success: successes.length,
    failed: failures.length,
    skipped: skipped.length,
    items: processedItems
  });
  fs.writeFileSync(REPORT_JSON_FILE, JSON.stringify(history, null, 2), 'utf-8');
}

// Core loop to run downloads sequentially
async function runDownloadQueue() {
  if (isDownloading || downloadQueue.length === 0) {
    return;
  }

  isDownloading = true;
  const processedBatch = [];

  while (downloadQueue.length > 0) {
    if (isPaused) {
      isDownloading = false;
      activeDownload = null;
      broadcast('active-change', { active: null });
      break;
    }

    activeDownload = downloadQueue.shift();
    broadcast('active-change', { active: activeDownload });

    const videoId = extractVideoId(activeDownload.url);

    // Double-check if video is already downloaded
    if (isVideoDownloaded(videoId, activeDownload.url)) {
      activeDownload.status = 'skipped';
      broadcast('item-updated', { item: activeDownload });
      processedBatch.push(activeDownload);
      continue;
    }

    activeDownload.status = 'downloading';
    activeDownload.progress = 0;
    broadcast('item-updated', { item: activeDownload });

    try {
      // 1. Get detailed info (title, thumbnail URL) if missing
      let title = activeDownload.title;
      let thumbUrl = activeDownload.thumbnail;
      let vidId = videoId;

      const binPath = getYtDlpPath();

      if (!title || !thumbUrl) {
        broadcast('log', { message: `Extracting info for ${activeDownload.url}...` });
        const info = await new Promise((resolve, reject) => {
          const extractArgs = ['--js-runtimes', NODE_PATH, '-j', '--no-playlist', activeDownload.url];
          execFile(binPath, extractArgs, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
            if (error) {
              return reject(new Error(stderr || error.message));
            }
            try {
              resolve(JSON.parse(stdout));
            } catch (e) {
              reject(new Error("Failed to parse JSON metadata"));
            }
          });
        });
        title = info.title;
        vidId = info.id || videoId;
        thumbUrl = info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null);
        
        activeDownload.title = title;
        activeDownload.thumbnail = thumbUrl;
        broadcast('item-updated', { item: activeDownload });
      }

      // Retrieve the stt and session folder assigned at queue time
      const stt = activeDownload.stt || '001';
      const sessionFolder = activeDownload.sessionFolder || 'Download_Default';

      const sanitizedTitle = sanitizeFilename(title);
      const sessionDir = path.join(getDownloadDir(), sessionFolder);
      const videoDir = path.join(sessionDir, 'video');
      const thumbDir = path.join(sessionDir, 'thumb');

      // Ensure specific directories exist
      [sessionDir, videoDir, thumbDir].forEach(dir => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      });
      
      const videoFilenameTemplate = `${stt}.${sanitizedTitle}.%(ext)s`;
      
      broadcast('log', { message: `[${stt}] Starting download of video: "${title}"` });

      // 2. Spawn yt-dlp to download video
      // Check if ffmpeg is available and resolve resolution settings
      const resLimit = settings.maxResolution || 'best';
      let format = '';
      
      if (resLimit === 'best') {
        format = hasFfmpeg 
          ? 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best' 
          : 'b[ext=mp4]/best';
      } else {
        const height = resLimit.replace('p', '');
        format = hasFfmpeg
          ? `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/b[height<=${height}][ext=mp4]/best`
          : `b[height<=${height}][ext=mp4]/best`;
      }

      const args = [
        '--js-runtimes', NODE_PATH,
        '-o', path.join(videoDir, videoFilenameTemplate),
        '--no-playlist',
        '-f', format,
        activeDownload.url
      ];

      const ytProcess = spawn(binPath, args);
      activeProcess = ytProcess;

      await new Promise((resolve, reject) => {
        let stderrOutput = '';

        ytProcess.stdout.on('data', (data) => {
          const text = data.toString();
          // Extract percentage, speed, ETA
          const percentMatch = text.match(/(\d+(?:\.\d+)?)%/);
          const speedMatch = text.match(/at\s+([^\s]+)/);
          const etaMatch = text.match(/ETA\s+([^\s]+)/);

          if (percentMatch && activeDownload) {
            const progress = parseFloat(percentMatch[1]);
            const speed = speedMatch ? speedMatch[1] : '';
            const eta = etaMatch ? etaMatch[1] : '';

            activeDownload.progress = progress;
            activeDownload.speed = speed;
            activeDownload.eta = eta;

            broadcast('progress', {
              id: activeDownload.id,
              progress,
              speed,
              eta
            });
          }
        });

        ytProcess.stderr.on('data', (data) => {
          const text = data.toString();
          stderrOutput += text;
          console.error(`yt-dlp stderr: ${text}`);
        });

        ytProcess.on('close', (code) => {
          activeProcess = null;
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(stderrOutput.trim() || `yt-dlp process exited with code ${code}`));
          }
        });
      });

      // Find the actual file downloaded to check extension
      const files = fs.readdirSync(videoDir);
      const videoFile = files.find(f => f.startsWith(`${stt}.${sanitizedTitle}.`));
      
      if (!videoFile) {
        throw new Error("Video file downloaded but could not be located in directory.");
      }

      // Store relative path in metadata (e.g. "Download_25_07_26_09_28_47/video/001.Me at the zoo.mp4")
      activeDownload.videoFile = `${sessionFolder}/video/${videoFile}`;

      // 3. Download the thumbnail
      if (thumbUrl) {
        broadcast('log', { message: `[${stt}] Downloading thumbnail...` });
        const cleanUrl = thumbUrl.split('?')[0];
        const extMatch = cleanUrl.match(/\.(jpg|jpeg|png|webp)$/i);
        const thumbExt = extMatch ? extMatch[1].toLowerCase() : 'jpg';
        const thumbFilename = `${stt}.${thumbExt}`;
        const thumbPath = path.join(thumbDir, thumbFilename);

        const thumbSuccess = await downloadThumbnail(thumbUrl, thumbPath);
        if (thumbSuccess) {
          activeDownload.thumbnailFile = `${sessionFolder}/thumb/${thumbFilename}`;
          broadcast('log', { message: `[${stt}] Thumbnail saved in thumb/${thumbFilename}` });
        } else {
          broadcast('log', { message: `[${stt}] Warning: Thumbnail download failed.` });
        }
      }

      // 4. Update log and item status
      logDownloadedVideo(vidId, title, activeDownload.url);
      activeDownload.status = 'completed';
      activeDownload.progress = 100;
      broadcast('log', { message: `[${stt}] Successfully downloaded: "${title}"` });
      broadcast('item-updated', { item: activeDownload });

    } catch (err) {
      console.error(err);
      activeDownload.status = 'failed';
      
      let friendlyError = err.message;
      if (err.message.includes("Sign in to confirm you're not a bot") || err.message.includes("confirm you're not a bot")) {
        friendlyError = "Lỗi chặn Bot của YouTube (Sign in to confirm you're not a bot). Vui lòng cấu hình nguồn Cookie trong Cài đặt (ví dụ: Chọn 'Use Chrome Cookies' hoặc nạp tệp 'cookies.txt') rồi bấm tải lại.";
      } else if (err.message.includes("No supported JavaScript runtime could be found")) {
        friendlyError = "Lỗi môi trường: yt-dlp không tìm thấy runtime JavaScript. Vui lòng kiểm tra lại cấu hình.";
      }
      
      activeDownload.error = friendlyError;
      broadcast('log', { message: `Failed to download ${activeDownload.url}: ${friendlyError}` });
      broadcast('item-updated', { item: activeDownload });
    }

    processedBatch.push({ ...activeDownload });
  }

  isDownloading = false;
  activeDownload = null;
  broadcast('active-change', { active: null });

  if (processedBatch.length > 0) {
    generateReport(processedBatch);
    broadcast('report-ready', { message: 'Batch downloads complete. Report generated.' });
  }
}

// API Routes

// 1. Stream events to frontend (SSE)
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.push(res);

  // Send current queue to newly connected client
  res.write(`data: ${JSON.stringify({ 
    type: 'init', 
    queue: downloadQueue, 
    active: activeDownload,
    isPaused,
    isDownloading 
  })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// 2. App Status Check
app.get('/api/status', async (req, res) => {
  try {
    const binPath = await ensureYtDlp();
    let fileCount = 0;
    const currentDownloadDir = getDownloadDir();
    if (fs.existsSync(currentDownloadDir)) {
      const items = fs.readdirSync(currentDownloadDir);
      items.forEach(item => {
        try {
          const itemPath = path.join(currentDownloadDir, item);
          if (fs.statSync(itemPath).isDirectory() && item.startsWith('Download_')) {
            const videoDir = path.join(itemPath, 'video');
            if (fs.existsSync(videoDir)) {
              fileCount += fs.readdirSync(videoDir).length;
            }
          }
        } catch (e) {
          // Ignore stats errors
        }
      });
    }
    res.json({
      status: 'ready',
      binaryPath: binPath,
      downloadedCount: fileCount,
      isDownloading,
      isPaused,
      queueLength: downloadQueue.length
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to initialize yt-dlp binary: ' + error.message
    });
  }
});

// 3. Extract metadata from a playlist / channel / single URL
app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const binPath = await ensureYtDlp();
    
    // Check if it's a single video to extract quickly
    const singleId = extractVideoId(url);

    if (singleId) {
      // It's a single video, extract metadata directly
      const extractArgs = ['--js-runtimes', NODE_PATH, '-j', '--no-playlist', url];
      execFile(binPath, extractArgs, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({ error: stderr || error.message });
        }
        try {
          const info = JSON.parse(stdout);
          const isDownloaded = isVideoDownloaded(info.id, url);
          res.json({
            type: 'single',
            videos: [{
              id: info.id,
              title: info.title,
              url: info.webpage_url || url,
              thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails.length ? info.thumbnails[info.thumbnails.length - 1].url : null),
              isDownloaded
            }]
          });
        } catch (e) {
          res.status(500).json({ error: 'Failed to parse video metadata.' });
        }
      });
    } else {
      // It might be a channel or playlist. Use flat-playlist to load quickly
      const playlistArgs = ['--js-runtimes', NODE_PATH, '--flat-playlist', '--dump-single-json', url];
      execFile(binPath, playlistArgs, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({ error: stderr || error.message });
        }
        try {
          const playlistInfo = JSON.parse(stdout);
          if (playlistInfo._type === 'playlist' || Array.isArray(playlistInfo.entries)) {
            const videos = playlistInfo.entries.map((entry, index) => {
              const videoId = entry.id;
              const videoUrl = entry.url || `https://www.youtube.com/watch?v=${videoId}`;
              const isDownloaded = isVideoDownloaded(videoId, videoUrl);
              return {
                id: videoId,
                title: entry.title || `Video #${index + 1}`,
                url: videoUrl,
                thumbnail: entry.thumbnail || (entry.thumbnails && entry.thumbnails.length ? entry.thumbnails[entry.thumbnails.length - 1].url : null),
                isDownloaded
              };
            });
            res.json({
              type: 'playlist',
              title: playlistInfo.title || 'YouTube Playlist/Channel',
              videos
            });
          } else {
            // Fallback for single video returned in alternative formats
            const isDownloaded = isVideoDownloaded(playlistInfo.id, url);
            res.json({
              type: 'single',
              videos: [{
                id: playlistInfo.id,
                title: playlistInfo.title,
                url: playlistInfo.webpage_url || url,
                thumbnail: playlistInfo.thumbnail,
                isDownloaded
              }]
            });
          }
        } catch (e) {
          console.error(e);
          res.status(500).json({ error: 'Failed to parse playlist structure.' });
        }
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Download endpoint - Accepts a list of videos to download
app.post('/api/download', (req, res) => {
  const { videos } = req.body; // Array of { url, title, thumbnail }
  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'Invalid or empty videos list' });
  }

  // Normalize URLs and deduplicate inputs (remove URL duplicates, keeping the first occurrence)
  const uniqueVideos = [];
  const seenIds = new Set();
  
  videos.forEach(vid => {
    const videoId = extractVideoId(vid.url);
    if (videoId) {
      if (!seenIds.has(videoId)) {
        seenIds.add(videoId);
        uniqueVideos.push(vid);
      }
    } else {
      // For playlist or fallback urls
      const cleanUrl = vid.url.trim();
      if (cleanUrl && !uniqueVideos.some(v => v.url.trim() === cleanUrl)) {
        uniqueVideos.push(vid);
      }
    }
  });

  // Helper to generate unique session folder names
  function getSessionFolderName() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dd = pad(now.getDate());
    const mm = pad(now.getMonth() + 1);
    const yy = String(now.getFullYear()).substring(2);
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    return `Download_${dd}_${mm}_${yy}_${hh}_${min}_${ss}`;
  }

  const sessionFolder = getSessionFolderName();
  let batchStt = 1;
  const queuedItems = [];
  const skippedItems = [];

  uniqueVideos.forEach(vid => {
    const videoId = extractVideoId(vid.url);
    const isDownloaded = isVideoDownloaded(videoId, vid.url);

    const item = {
      id: videoId || Math.random().toString(36).substring(7),
      url: vid.url,
      title: vid.title || null,
      thumbnail: vid.thumbnail || null,
      status: isDownloaded ? 'skipped' : 'pending',
      progress: 0,
      speed: '',
      eta: '',
      error: '',
      sessionFolder: sessionFolder,
      stt: isDownloaded ? null : String(batchStt++).padStart(3, '0')
    };

    if (isDownloaded) {
      skippedItems.push(item);
    } else {
      downloadQueue.push(item);
      queuedItems.push(item);
    }
  });

  // Start background process
  runDownloadQueue();

  res.json({
    message: `Added ${queuedItems.length} videos to download queue. ${skippedItems.length} videos skipped (already downloaded).`,
    queued: queuedItems,
    skipped: skippedItems
  });
});

// 4.1 Pause queue
app.post('/api/pause', (req, res) => {
  isPaused = true;
  broadcast('status-updated', { isPaused, isDownloading });
  res.json({ success: true, message: 'Downloads paused after the current video finishes.' });
});

// 4.2 Resume queue
app.post('/api/resume', (req, res) => {
  isPaused = false;
  broadcast('status-updated', { isPaused, isDownloading });
  runDownloadQueue();
  res.json({ success: true, message: 'Downloads resumed.' });
});

// 4.3 Cancel active download and empty queue
app.post('/api/cancel', (req, res) => {
  downloadQueue = [];
  isPaused = false;
  if (activeProcess) {
    activeProcess.kill('SIGKILL');
    activeProcess = null;
  }
  if (activeDownload) {
    activeDownload.status = 'failed';
    activeDownload.error = 'Download cancelled by user';
  }
  isDownloading = false;
  activeDownload = null;
  broadcast('active-change', { active: null });
  broadcast('report-ready', { message: 'Downloads cancelled.' });
  res.json({ success: true, message: 'Downloads cancelled successfully.' });
});

// 4.4 GET Save Path config
app.get('/api/settings', (req, res) => {
  res.json({
    downloadDir: settings.downloadDir || '',
    defaultDir: DOWNLOAD_DIR,
    maxResolution: settings.maxResolution || 'best'
  });
});

// 4.5 POST Save Path config
app.post('/api/settings', (req, res) => {
  const { downloadDir, maxResolution } = req.body;
  
  if (downloadDir && downloadDir.trim().length > 0) {
    const resolvedPath = path.resolve(downloadDir.trim());
    try {
      if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      }
      settings.downloadDir = resolvedPath;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid or unwritable directory path: ' + e.message });
    }
  } else {
    settings.downloadDir = '';
  }
  
  if (maxResolution) {
    settings.maxResolution = maxResolution;
  }
  
  saveSettings();
  res.json({ success: true, message: 'Application configuration updated.', settings });
});

// 4.6 Browse local directory (Windows only)
app.post('/api/browse-directory', (req, res) => {
  if (os.platform() !== 'win32') {
    return res.status(400).json({ error: 'Directory browsing is only supported on Windows.' });
  }

  const { exec } = require('child_process');
  // Run PowerShell with -STA (Single Threaded Apartment) to allow displaying WinForms GUI
  const psCommand = `powershell -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select ApexTube Save Directory'; $f.ShowNewFolderButton = $true; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"`;

  exec(psCommand, (err, stdout, stderr) => {
    if (err) {
      console.error('FolderBrowserDialog error:', err);
      return res.status(500).json({ error: 'Failed to open directory browser: ' + err.message });
    }
    const selectedPath = stdout.trim();
    if (selectedPath) {
      res.json({ selectedPath });
    } else {
      res.json({ selectedPath: null, message: 'Selection cancelled.' });
    }
  });
});

// 5. Read log history
app.get('/api/history', (req, res) => {
  if (!fs.existsSync(LOG_FILE)) {
    return res.json({ logs: [] });
  }
  const logs = fs.readFileSync(LOG_FILE, 'utf-8');
  const lines = logs.trim().split('\n').filter(line => line.length > 0).map(line => {
    const parts = line.split(' | ');
    return {
      date: parts[0],
      id: parts[1],
      url: parts[2],
      title: parts[3] || 'Unknown Video'
    };
  });
  res.json({ logs: lines.reverse() }); // Return latest first
});

// 6. Get reports
app.get('/api/report', (req, res) => {
  const result = { txt: '', json: [] };
  if (fs.existsSync(REPORT_TXT_FILE)) {
    result.txt = fs.readFileSync(REPORT_TXT_FILE, 'utf-8');
  }
  if (fs.existsSync(REPORT_JSON_FILE)) {
    try {
      result.json = JSON.parse(fs.readFileSync(REPORT_JSON_FILE, 'utf-8'));
    } catch (e) {
      result.json = [];
    }
  }
  res.json(result);
});

// Trigger binary check on startup
ensureYtDlp()
  .then(() => checkFfmpeg())
  .then((ffmpegAvailable) => {
    if (!ffmpegAvailable && os.platform() === 'win32') {
      // Trigger background download and extraction of FFmpeg
      ensureFfmpeg().then((success) => {
        if (success) {
          console.log("Portable FFmpeg successfully configured. Re-checking status...");
          checkFfmpeg();
        }
      });
    }
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`==================================================`);
      console.log(`YouTube Downloader Server running on http://localhost:${PORT}`);
      console.log(`==================================================`);
    });
  })
  .catch(err => {
    console.error('CRITICAL: Server failed to start due to binary setup failure:', err);
    process.exit(1);
  });
