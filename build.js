const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const DIST_DIR = path.join(__dirname, 'dist');

// Helper to copy directory recursively
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (let entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('==================================================');
console.log('       ApexTube Code Obfuscator & Builder');
console.log('==================================================');
console.log('[i] Cleaning previous build folder...');

// 1. Ensure dist folder exists (keeps directory handles to avoid EPERM locks on Windows)
if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}
if (!fs.existsSync(path.join(DIST_DIR, 'public'))) {
  fs.mkdirSync(path.join(DIST_DIR, 'public'), { recursive: true });
}

// 2. Copy static public files (excluding app.js which we will obfuscate)
console.log('[i] Copying static assets (HTML/CSS)...');
fs.copyFileSync(path.join(__dirname, 'public', 'index.html'), path.join(DIST_DIR, 'public', 'index.html'));
fs.copyFileSync(path.join(__dirname, 'public', 'style.css'), path.join(DIST_DIR, 'public', 'style.css'));

// 3. Obfuscate public/app.js
console.log('[i] Obfuscating frontend app.js...');
const appCode = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf-8');
const obfuscatedApp = JavaScriptObfuscator.obfuscate(appCode, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  numbersToExpressions: true,
  simplify: true,
  stringArrayThreshold: 0.75
}).getObfuscatedCode();
fs.writeFileSync(path.join(DIST_DIR, 'public', 'app.js'), obfuscatedApp, 'utf-8');

// 4. Obfuscate server.js
console.log('[i] Obfuscating backend server.js...');
const serverCode = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf-8');
const obfuscatedServer = JavaScriptObfuscator.obfuscate(serverCode, {
  compact: true,
  controlFlowFlattening: false, // Turn off flattening on server to avoid performance loss
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  stringArray: true,
  stringArrayThreshold: 0.75
}).getObfuscatedCode();
fs.writeFileSync(path.join(DIST_DIR, 'server.js'), obfuscatedServer, 'utf-8');

// 5. Copy package.json and Start.bat
console.log('[i] Copying package files & launchers...');
fs.copyFileSync(path.join(__dirname, 'package.json'), path.join(DIST_DIR, 'package.json'));
fs.copyFileSync(path.join(__dirname, 'Start.bat'), path.join(DIST_DIR, 'Start.bat'));

console.log('\n==================================================');
console.log('[V] Build completed successfully!');
console.log(`[i] Obfuscated project files ready in:\n    ${DIST_DIR}`);
console.log('==================================================');
