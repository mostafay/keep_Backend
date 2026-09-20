const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cloudinary = require('cloudinary').v2;
const cors = require('cors');
// Use puppeteer-core on Render, puppeteer on local
let puppeteer;
if (process.env.RENDER === 'true') {
  puppeteer = require('puppeteer-core');
} else {
  puppeteer = require('puppeteer');
}
const { google } = require('googleapis');
const crypto = require('crypto');
const { Dropbox } = require('dropbox');
const ytdl = require('ytdl-core');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  console.log('Body:', JSON.stringify(req.body, null, 2));
  next();
});

// Custom middleware to serve .p files as .jpg (for local fallback)
app.get('/img/:filename', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const filename = req.params.filename;

  // If the requested file has .mp4 extension, check for .v file
  if (filename.endsWith('.mp4')) {
    const mp4Path = path.join(__dirname, 'img', filename);
    const vFilename = filename.substring(0, filename.length - 4) + '.v';
    const vPath = path.join(__dirname, 'img', vFilename);

    // Check if .v file exists
    if (fs.existsSync(vPath)) {
      console.log(`Serving .v file as .mp4: ${vFilename}`);
      res.setHeader('Content-Type', 'video/mp4');
      res.sendFile(vPath);
      return;
    }

    // If .v file doesn't exist, check for .mp4 file
    if (fs.existsSync(mp4Path)) {
      console.log(`Serving .mp4 file: ${filename}`);
      res.setHeader('Content-Type', 'video/mp4');
      res.sendFile(mp4Path);
      return;
    }

    // File not found
    res.status(404).send('Video file not found');
  }
  // If the requested file has .jpg extension, check for .p file
  else if (filename.endsWith('.jpg')) {
    const jpgPath = path.join(__dirname, 'img', filename);
    const pFilename = filename.substring(0, filename.length - 4) + '.p';
    const pPath = path.join(__dirname, 'img', pFilename);

    // Check if .p file exists
    if (fs.existsSync(pPath)) {
      console.log(`Serving .p file as .jpg: ${pFilename}`);
      res.sendFile(pPath);
      return;
    }

    // If .p file doesn't exist, check for .jpg file
    if (fs.existsSync(jpgPath)) {
      console.log(`Serving .jpg file: ${filename}`);
      res.sendFile(jpgPath);
      return;
    }

    // File not found
    res.status(404).send('File not found');
  } else {
    // For other file types, use default static serving
    const filePath = path.join(__dirname, 'img', filename);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send('File not found');
    }
  }
});

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Initialize Dropbox
// Dropbox instance (lazy initialized from Google Sheets A2 in 'read' sheet)
let dropbox = null;
let dropboxTokenCache = null;
let dropboxTokenFetchedAt = 0;
const DROPBOX_TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Read Dropbox access token from cell A2 in the 'read' sheet
 * @param {Object} sheets - Google Sheets API instance (optional)
 * @returns {Promise<string|null>} - Dropbox access token or null
 */
async function getDropboxTokenFromSheets(sheetsInstance = null) {
  // Check cache first
  const now = Date.now();
  if (dropboxTokenCache && (now - dropboxTokenFetchedAt) < DROPBOX_TOKEN_CACHE_TTL) {
    return dropboxTokenCache;
  }

  try {
    const sheets = sheetsInstance || await initGoogleSheets();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'read!A2',
    });

    const token = response.data.values?.[0]?.[0];
    if (!token || token.trim() === '') {
      console.warn('⚠️  Dropbox token is empty in read!A2');
      return null;
    }

    // Update cache
    dropboxTokenCache = token.trim();
    dropboxTokenFetchedAt = now;
    console.log('✅ Dropbox token loaded from read!A2');
    return dropboxTokenCache;
  } catch (error) {
    console.error('❌ Failed to read Dropbox token from read!A2:', error.message);
    return null;
  }
}

/**
 * Get or create a Dropbox instance using token from Google Sheets
 * @returns {Promise<Object>} - Dropbox client instance
 */
async function getDropboxClient() {
  const token = await getDropboxTokenFromSheets();
  
  if (!token) {
    throw new Error('Dropbox access token is not available (read!A2 is empty or unreachable)');
  }

  // Recreate client if token changed
  if (!dropbox || dropbox._accessToken !== token) {
    dropbox = new Dropbox({ accessToken: token });
    // Store token reference for comparison
    dropbox._accessToken = token;
  }

  return dropbox;
}

/**
 * Force refresh the Dropbox token (call this if you get 401 errors)
 */
async function refreshDropboxToken() {
  dropboxTokenCache = null;
  dropboxTokenFetchedAt = 0;
  return await getDropboxTokenFromSheets();
}

// Google Sheets API Configuration
const SPREADSHEET_ID = '1VxRAUEZL66XCnh05pi3y1627R8hqQ2hx6mZpMJ7HJ2I';
const SHEET_NAME = 'keep';

// Function to generate random group ID (8 characters: letters and numbers)
function generateGroupId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Initialize Google Sheets API
async function initGoogleSheets() {
  // Try to use ky.json file if it exists, otherwise use environment variable
  let auth;
  console.log('Checking for ky.json file...');
  console.log('GOOGLE_SHEETS_CREDENTIALS exists:', !!process.env.GOOGLE_SHEETS_CREDENTIALS);
  
  if (fs.existsSync('./ky.json')) {
    console.log('Using ky.json file for Google Sheets authentication');
    auth = new google.auth.GoogleAuth({
      keyFile: './ky.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else if (process.env.GOOGLE_SHEETS_CREDENTIALS) {
    console.log('Using GOOGLE_SHEETS_CREDENTIALS environment variable');
    try {
      const decoded = Buffer.from(process.env.GOOGLE_SHEETS_CREDENTIALS, 'base64').toString('utf-8');
      const credentials = JSON.parse(decoded);
      auth = new google.auth.GoogleAuth({
        credentials: credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
    } catch (error) {
      console.error('Error decoding GOOGLE_SHEETS_CREDENTIALS:', error.message);
      throw error;
    }
  } else {
    throw new Error('Neither ky.json file nor GOOGLE_SHEETS_CREDENTIALS environment variable is set');
  }

  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

/**
 * Read data from Google Sheets
 * @param {Object} sheets - Google Sheets API instance
 * @returns {Promise<Array>} - Array of rows from the sheet
 */
async function readGoogleSheets(sheets) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`, // Read all columns
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('No data found in the sheet.');
      return [];
    }

    console.log(`\n=== Google Sheets Data (${SHEET_NAME}) ===`);
    console.log(`Total rows: ${rows.length}`);
    console.log(`Total columns: ${rows[0].length}`);
    console.log('\nHeaders:', rows[0]);
    console.log('\nData:');
    rows.forEach((row, index) => {
      if (index === 0) return; // Skip header row
      console.log(`Row ${index}:`, row);
    });
    console.log('=====================================\n');

    return rows;
  } catch (error) {
    console.error('Error reading Google Sheets:', error.message);
    return [];
  }
}

/**
 * Write data to Google Sheets
 * @param {Object} sheets - Google Sheets API instance
 * @param {Array} rowData - Array of values to write
 * @returns {Promise<boolean>} - Success status
 */
async function writeToGoogleSheets(sheets, rowData) {
  try {
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:F`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [rowData]
      }
    });

    console.log('Data written to Google Sheets successfully');
    console.log('Updated range:', response.data.updates.updatedRange);
    return true;
  } catch (error) {
    console.error('Error writing to Google Sheets:', error.message);
    return false;
  }
}
async function updateGoogleSheetRow(sheets, rowIndex, rowData) {
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A${rowIndex}:Z${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });
    return true;
  } catch (error) {
    console.error(`❌ [Sheets] Row ${rowIndex} update FAILED: ${error.message}`);
    return false;
  }
}


/**
 * Find row by URL in Google Sheets
 * @param {Object} sheets - Google Sheets API instance
 * @param {string} url - URL to search for (in column C)
 * @returns {Promise<Object|null>} - Row data with index or null if not found
 */
async function findRowByUrl(sheets, url) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return null;
    }

    // Search for URL in column C (index 2, 0-based)
    for (let i = 1; i < rows.length; i++) { // Skip header row (index 0)
      const rowUrl = rows[i][2]; // Column C
      if (rowUrl === url) {
        return {
          index: i + 1, // Convert to 1-based index
          data: rows[i],
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Error finding row by URL:', error.message);
    return null;
  }
}

/**
 * Extract the largest image from a webpage using Puppeteer for accurate sizing
 * @param {string} url - The URL to scrape
 * @returns {Promise<Object>} - Object containing image URL and page title
 */
async function extractLargestImage(url) {
  let browser = null;
  try {
    const proxyServer = process.env.PROXY_SERVER; // e.g., 'http://proxy.example.com:8080'

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ];

    if (proxyServer) {
      launchArgs.push(`--proxy-server=${proxyServer}`);
      console.log(`Using proxy server: ${proxyServer}`);
    }

    // Use @sparticuz/chromium on Render, puppeteer bundled Chrome on local
    let executablePath;
    if (process.env.RENDER === 'true') {
      const chromium = require('@sparticuz/chromium');
      executablePath = await chromium.executablePath();
      launchArgs.push(...chromium.args);
    } else {
      // Local: puppeteer will use bundled Chrome, no need for executablePath
      executablePath = undefined;
    }

    browser = await puppeteer.launch({
      headless: 'new',
      args: launchArgs,
      executablePath: executablePath
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Set realistic User-Agent and headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });
    
    console.log('Loading page with Puppeteer (stealth mode)...');
    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 45000,
      referer: 'https://www.google.com/'
    });
    
    // Simulate human behavior - scroll down slowly
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    
    // Scroll back to top
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    
    // Extract page title with error handling
    let boldText = '';
    try {
      boldText = await page.evaluate(() => {
        // Try meta tags first
        let title = document.querySelector('meta[property="og:title"]')?.content ||
                    document.querySelector('meta[name="twitter:title"]')?.content ||
                    document.title?.trim();
        
        // Fallback to bold/strong tags
        if (!title) {
          const boldElement = document.querySelector('b, strong');
          if (boldElement) title = boldElement.textContent?.trim();
        }
        
        // Fallback to h1, h2, h3
        if (!title) {
          const headingElement = document.querySelector('h1, h2, h3');
          if (headingElement) title = headingElement.textContent?.trim();
        }
        
        return title || '';
      });
    } catch (e) {
      console.log('Error extracting title, using fallback:', e.message);
      boldText = 'Untitled';
    }
    
    // Get all images with their actual rendered dimensions with error handling
    let images = [];
    try {
      images = await page.evaluate(() => {
        const imgElements = document.querySelectorAll('img');
        const imageData = [];
        
        imgElements.forEach((img) => {
          const src = img.src || img.getAttribute('data-src');
          if (!src || (!src.startsWith('http') && !src.startsWith('//'))) return;
          
          // Skip PNG images
          if (src.toLowerCase().includes('.png')) return;
          
          const rect = img.getBoundingClientRect();
          const width = Math.round(rect.width);
          const height = Math.round(rect.height);
          const area = width * height;
        
          // Only consider images with visible area
          if (width > 50 && height > 50) {
            imageData.push({
              url: src.startsWith('//') ? 'https:' + src : src,
              width,
              height,
              area
            });
          }
        });
        
        return imageData;
      });
    } catch (e) {
      console.log('Error extracting images:', e.message);
      images = [];
    }
    
    console.log(`Found ${images.length} visible images with Puppeteer`);
    images.forEach((img, idx) => {
      console.log(`  ${idx + 1}. ${img.width}x${img.height} (${img.area}px) - ${img.url.substring(0, 60)}...`);
    });
    
    // Sort by area (largest first)
    if (images.length > 0) {
      images.sort((a, b) => b.area - a.area);
      console.log(`Selected largest image: ${images[0].width}x${images[0].height} (${images[0].area}px)`);
      
      return {
        imageUrl: images[0].url,
        boldText: boldText
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error extracting image with Puppeteer:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Return original image URL directly (no cloud upload)
 * @param {string} imageUrl - The URL of the image
 * @returns {Promise<Object>} - Object with original URL
 */
async function uploadToCloud(imageUrl) {
  try {
    console.log('Using original image URL:', imageUrl);
    
    return {
      secure_url: imageUrl,
      public_id: null,
      exists: false
    };
  } catch (error) {
    console.error('Error processing image URL:', error.message);
    throw error;
  }
}

/**
 * Upload custom image to local /img folder with dynamic URL
 * @param {Buffer} imageBuffer - The image buffer
 * @param {string} fileName - The filename to save
 * @param {Object} req - Express request object for dynamic URL
 * @returns {Promise<Object>} - Upload result with dynamic URL
 */
async function uploadCustomImage(imageBuffer, fileName, req) {
  const fs = require('fs');
  const path = require('path');

  const baseName = path.basename(fileName, path.extname(fileName));
  const newFileName = `${baseName}.p`;
  const dropboxPath = `/keep-images/${newFileName}`;

  try {
    // Upload to Dropbox
    const dropboxClient = await getDropboxClient();
await dropboxClient.filesUpload({
      path: dropboxPath,
      contents: imageBuffer,
      mode: 'overwrite',
      autorename: false,
    });

    // Create or fetch shared link
    let sharedLink;
    try {
        const sharedLinkResponse = await dropboxClient.sharingCreateSharedLink({
        path: dropboxPath,
        settings: { requested_visibility: 'public' },
      });
      sharedLink = sharedLinkResponse.result.url;
    } catch (linkError) {
      const existingLinks = await dropboxClient.sharingListSharedLinks({
        path: dropboxPath,
        direct_only: true,
      });
      if (existingLinks.result.links && existingLinks.result.links.length > 0) {
        sharedLink = existingLinks.result.links[0].url;
      } else {
        throw new Error('Could not create or fetch shared link');
      }
    }

    // Convert to direct download link
    const directLink = sharedLink
      .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
      .replace('?dl=0', '')
      .replace('&dl=0', '');

    return {
      secure_url: directLink,
      public_id: newFileName,
      dropbox_url: directLink,
      exists: false,
    };

  } catch (dropboxError) {
    // ────────────────────────────────────────────────────────────
    // ✅ التقرير الوحيد المطلوب: انتهاء صلاحية التوكن
    // ────────────────────────────────────────────────────────────
    const errorTag =
      dropboxError?.error?.error?.['.tag'] ||
      dropboxError?.error?.error;

    if (
      dropboxError.status === 401 ||
      errorTag === 'expired_access_token' ||
      errorTag === 'invalid_access_token'
    ) {
      console.error('');
      console.error('╔════════════════════════════════════════════════════════════╗');
      console.error('║  ⚠️  DROPBOX TOKEN EXPIRED / INVALID                       ║');
      console.error('╚════════════════════════════════════════════════════════════╝');
      console.error(`   ├─ Tag     : ${errorTag}`);
      console.error(`   ├─ Status  : ${dropboxError.status}`);
      console.error(`   └─ Message : ${dropboxError.message}`);
      console.error('   👉 أعد توليد DROPBOX_ACCESS_TOKEN وحدّثه في .env و Render');
      console.error('');
    }

    // Fallback to local storage
    try {
      const imgDir = path.join(__dirname, 'img');
      if (!fs.existsSync(imgDir)) {
        fs.mkdirSync(imgDir, { recursive: true });
      }

      const filePath = path.join(imgDir, newFileName);
      fs.writeFileSync(filePath, imageBuffer);

      const serverUrl = `${req.protocol}://${req.get('host')}`;
      const localUrl = `${serverUrl}/img/${newFileName}`;

      return {
        secure_url: localUrl,
        public_id: newFileName,
        exists: false,
      };

    } catch (localError) {
      throw localError;
    }
  }
}
// ═══════════════════════════════════════════════════════════
// Route to process missing images using SCREENSHOT
// ═══════════════════════════════════════════════════════════
app.post('/process-missing-images-screenshot', async (req, res) => {
  const startTime = Date.now();
  const results = {
    processed: 0,
    updated: 0,
    failed: 0,
    details: []
  };

  try {
    // [1] Initialize Google Sheets
    const sheets = await initGoogleSheets();

    // [2] Read all data from Google Sheets
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return res.json({
        success: true,
        message: 'No data found in the sheet',
        ...results
      });
    }

    console.log(`\n=== Processing ${rows.length - 1} rows for missing images (SCREENSHOT MODE) ===\n`);

    // [3] Collect rows with empty img
    const rowsToProcess = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const img = row[3];

      // Check if img is missing or empty
      if (!img || img.trim() === '') {
        rowsToProcess.push({
          rowIndex: i + 1,  // 1-based index in sheet
          id: row[0],
          name: row[1] || '',
          sit: row[2],
          datetime: row[4] || '',
          info: row[5] || '',
          group: row[6] || ''
        });
      }
    }

    if (rowsToProcess.length === 0) {
      return res.json({
        success: true,
        message: 'No rows with missing images found',
        ...results
      });
    }

    console.log(`Found ${rowsToProcess.length} rows with missing images\n`);

    // [4] Process each row
    for (const item of rowsToProcess) {
      results.processed++;

      if (!item.sit || item.sit.trim() === '') {
        results.failed++;
        results.details.push({
          rowIndex: item.rowIndex,
          id: item.id,
          sit: item.sit,
          status: 'failed',
          error: 'Empty sit URL'
        });
        continue;
      }

      let browser = null;
      try {
        console.log(`\n[${results.processed}/${rowsToProcess.length}] Processing row ${item.rowIndex}: ${item.sit}`);

        // ─────────────────────────────────────────────
        // 4.1 Take Screenshot
        // ─────────────────────────────────────────────
        const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

        let executablePath;
        if (process.env.RENDER === 'true') {
          const chromium = require('@sparticuz/chromium');
          executablePath = await chromium.executablePath();
          launchArgs.push(...chromium.args);
        } else {
          executablePath = undefined;
        }

        browser = await puppeteer.launch({
          headless: 'new',
          args: launchArgs,
          executablePath: executablePath
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // Handle dialogs automatically
        page.on('dialog', async (dialog) => {
          try { await dialog.accept(); } catch (e) { /* ignore */ }
        });

        console.log(`   → Navigating to ${item.sit}...`);
        await page.goto(item.sit, {
          waitUntil: 'networkidle2',
          timeout: 60000,
          referer: 'https://www.google.com/'
        });

        // Brief wait for final rendering
        await new Promise(r => setTimeout(r, 1500));

        // Try to close common popups
        try {
          await page.evaluate(() => {
            const selectors = [
              '.cookie-banner', '.cookie-consent', '#cookie-banner',
              '.modal-backdrop', '.modal-overlay', '.popup-overlay',
              '[role="dialog"]', '[aria-modal="true"]'
            ];
            selectors.forEach(sel => {
              document.querySelectorAll(sel).forEach(el => {
                try { el.remove(); } catch (e) { /* ignore */ }
              });
            });
            window.scrollTo(0, 0);
          });
        } catch (e) { /* ignore popup errors */ }

        console.log('   → Taking screenshot...');
        const screenshotBuffer = await page.screenshot({
          type: 'jpeg',
          quality: 80,
          fullPage: false
        });

        await browser.close();
        browser = null;

        console.log(`   ✓ Screenshot taken: ${screenshotBuffer.length} bytes`);

        // ─────────────────────────────────────────────
        // 4.2 Upload Screenshot to Dropbox
        // ─────────────────────────────────────────────
        // Generate a stable filename based on sit URL
        const hash = crypto.createHash('md5').update(item.sit).digest('hex');
        const fileName = `screenshot_${hash}.jpg`;

        // Use uploadCustomImage (it already handles Dropbox + fallback to local)
        // We need to simulate req-like usage — uploadCustomImage accepts (buffer, fileName, req)
        const uploadResult = await uploadCustomImage(screenshotBuffer, fileName, req);
        const storedUrl = uploadResult.secure_url;

        console.log(`   ✓ Uploaded: ${storedUrl.substring(0, 80)}...`);

        // ─────────────────────────────────────────────
        // 4.3 Update Google Sheets row
        // ─────────────────────────────────────────────
        // Preserve all original columns, only replace column D (img, index 3)
        const updatedRowData = [
          item.id,        // A - id
          item.name,      // B - name
          item.sit,       // C - sit
          storedUrl,      // D - img  ← updated
          item.datetime,  // E - datetime
          item.info,      // F - info
          item.group      // G - group
        ];

        const updateSuccess = await updateGoogleSheetRow(
          sheets,
          item.rowIndex,
          updatedRowData
        );

        if (updateSuccess) {
          results.updated++;
          results.details.push({
            rowIndex: item.rowIndex,
            id: item.id,
            sit: item.sit,
            status: 'updated',
            imageUrl: storedUrl
          });
          console.log(`   ✓ Row ${item.rowIndex} updated successfully`);
        } else {
          results.failed++;
          results.details.push({
            rowIndex: item.rowIndex,
            id: item.id,
            sit: item.sit,
            status: 'failed',
            error: 'Failed to update Google Sheets row'
          });
          console.log(`   ✗ Row ${item.rowIndex} update failed`);
        }

      } catch (rowError) {
        // Close browser if still open
        if (browser) {
          try { await browser.close(); } catch (e) { /* ignore */ }
        }

        results.failed++;
        results.details.push({
          rowIndex: item.rowIndex,
          id: item.id,
          sit: item.sit,
          status: 'failed',
          error: rowError.message
        });

        console.error(`   ✗ Error processing row ${item.rowIndex}:`, rowError.message);
      }
    }

    // [5] Final response
    const duration = Date.now() - startTime;
    console.log(`\n=== Screenshot Processing Complete ===`);
    console.log(`   Processed: ${results.processed}`);
    console.log(`   Updated:   ${results.updated}`);
    console.log(`   Failed:    ${results.failed}`);
    console.log(`   Duration:  ${(duration / 1000).toFixed(2)}s\n`);

    res.json({
      success: true,
      message: `Processed ${results.processed} rows, updated ${results.updated}, failed ${results.failed}`,
      duration: `${(duration / 1000).toFixed(2)}s`,
      ...results
    });

  } catch (error) {
    console.error('Error processing missing images via screenshot:', error.message);
    res.status(500).json({
      error: 'Failed to process missing images via screenshot',
      details: error.message,
      ...results
    });
  }
});
// Route to extract and upload image from a URL
app.post('/extract-image', async (req, res) => {
  try {
    console.log('Request body:', req.body);
    const { url } = req.body;

    if (!url) {
      console.log('URL is missing from request body');
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Extracting image from: ${url}`);

    // Extract the largest image and bold text
    const result = await extractLargestImage(url);

    if (!result) {
      return res.status(404).json({ error: 'No image found on the page' });
    }

    console.log(`Found image: ${result.imageUrl}`);
    console.log(`Bold text (title): ${result.boldText}`);

    // Use original image URL directly
    const uploadResult = await uploadToCloud(result.imageUrl);

    console.log(`Using original URL: ${uploadResult.secure_url}`);
    console.log(`Image already existed: ${uploadResult.exists}`);

    // Update Google Sheets with the extracted image URL
    try {
      const sheets = await initGoogleSheets();
      const row = await findRowByUrl(sheets, url);
      if (row) {
        console.log('Found row in Google Sheets:', row.index);
        // Update the image URL in column D (index 3, 0-based)
        const rowData = row.data;
        rowData[3] = uploadResult.secure_url; // Column D
        // Update bold text (title) if available
        if (result.boldText) {
          rowData[1] = result.boldText; // Column B
          console.log('Updated title:', result.boldText);
        }
        const updateSuccess = await updateGoogleSheetRow(sheets, row.index, rowData);
        if (updateSuccess) {
          console.log('Google Sheets updated successfully');
        } else {
          console.log('Failed to update Google Sheets');
        }
      } else {
        console.log('Row not found in Google Sheets for URL:', url);
      }
    } catch (sheetsError) {
      console.error('Error updating Google Sheets:', sheetsError.message);
      // Continue with response even if Google Sheets update fails
    }

    res.json({
      success: true,
      originalImageUrl: result.imageUrl,
      boldText: result.boldText,
      cloudinaryUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      width: uploadResult.width,
      height: uploadResult.height,
      exists: uploadResult.exists
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      error: 'Failed to extract and upload image',
      details: error.message
    });
  }
});

// Route to save data to Google Sheets
app.post('/save-to-sheets', async (req, res) => {
  try {
    const { name, sit, img, info, group } = req.body;

    console.log('=== Save to Sheets Request ===');
    console.log('Name:', name);
    console.log('Sit:', sit);
    console.log('Img:', img);
    console.log('Info:', info);
    console.log('Group:', group);

    if (!name || !sit || !img) {
      console.log('Missing required fields');
      return res.status(400).json({ error: 'name, sit, and img are required' });
    }

    // Generate or use provided group ID (ensure it's not empty)
    const groupId = (group && group.trim() !== '') ? group : generateGroupId();
    console.log('Group ID:', groupId);
    console.log('Group provided:', group);
    console.log('Group generated:', groupId !== group);

    // Initialize Google Sheets
    const sheets = await initGoogleSheets();

    // Check if URL already exists
    const existingRow = await findRowByUrl(sheets, sit);

    if (existingRow) {
      // URL already exists, return error to prevent duplicates
      console.log('URL already exists in the sheet, preventing duplicate');
      return res.status(409).json({
        error: 'URL already exists',
        message: 'This URL is already saved in the database',
        existingData: {
          id: existingRow.data[0],
          name: existingRow.data[1],
          sit: existingRow.data[2],
          img: existingRow.data[3],
        }
      });
    }

    // Get current datetime
    const datetime = new Date().toISOString();

    // Add new row
    console.log('URL not found, adding new row...');
    const id = Math.floor(Math.random() * 1000000000).toString();
    const rowData = [id, name, sit, img, datetime, info || '', groupId];
    const success = await writeToGoogleSheets(sheets, rowData);
    const responseData = {
      id,
      name,
      sit,
      img,
      datetime,
      info,
      group: groupId,
      updated: false
    };

    if (success) {
      console.log('Save to sheets successful');
      res.json({
        success: true,
        message: existingRow ? 'Data updated in Google Sheets successfully' : 'Data saved to Google Sheets successfully',
        data: responseData
      });
    } else {
      console.log('Save to sheets failed');
      res.status(500).json({ error: 'Failed to save/update data to Google Sheets' });
    }

  } catch (error) {
    console.error('=== Error saving to Google Sheets ===');
    console.error('Error message:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      error: 'Failed to save data to Google Sheets',
      details: error.message
    });
  }
});

// Route to save only URL to Google Sheets (without image extraction)
app.post('/save-url-only', async (req, res) => {
  try {
    const { sit, group } = req.body;

    if (!sit) {
      return res.status(400).json({ error: 'sit (URL) is required' });
    }

    // Generate or use provided group ID (ensure it's not empty)
    const groupId = (group && group.trim() !== '') ? group : generateGroupId();
    console.log('Group ID:', groupId);
    console.log('Group provided:', group);
    console.log('Group generated:', groupId !== group);

    // Initialize Google Sheets
    const sheets = await initGoogleSheets();

    // Check if URL already exists
    const existingRow = await findRowByUrl(sheets, sit);

    if (existingRow) {
      // URL already exists, return error to prevent duplicates
      console.log('URL already exists in the sheet, preventing duplicate');
      return res.status(409).json({
        error: 'URL already exists',
        message: 'This URL is already saved in the database',
        existingData: {
          id: existingRow.data[0],
          name: existingRow.data[1],
          sit: existingRow.data[2],
          img: existingRow.data[3],
        }
      });
    }

    // Generate random ID
    const id = Math.floor(Math.random() * 1000000000).toString();

    // Get current datetime
    const datetime = new Date().toISOString();

    // Prepare row data (only id, sit, datetime - other fields empty)
    const rowData = [id, '', sit, '', datetime, '', groupId];

    // Write to Google Sheets
    const success = await writeToGoogleSheets(sheets, rowData);

    if (success) {
      res.json({
        success: true,
        message: 'URL saved to Google Sheets successfully',
        data: {
          id,
          sit,
          datetime,
          group: groupId
        }
      });
    } else {
      res.status(500).json({ error: 'Failed to save URL to Google Sheets' });
    }

  } catch (error) {
    console.error('Error saving URL to Google Sheets:', error.message);
    res.status(500).json({
      error: 'Failed to save URL to Google Sheets',
      details: error.message
    });
  }
});

// Route to process missing images in Google Sheets
app.post('/process-missing-images', async (req, res) => {
  try {
    // Initialize Google Sheets
    const sheets = await initGoogleSheets();

    // Read all data from Google Sheets
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return res.json({
        success: true,
        message: 'No data found in the sheet',
        processed: 0,
        updated: 0
      });
    }

    console.log(`Processing ${rows.length - 1} rows for missing images...`);

    let processed = 0;
    let updated = 0;
    const errors = [];

    // Process each row (skip header)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const id = row[0];
      const name = row[1];
      const sit = row[2];
      const img = row[3];
      const datetime = row[4];
      const info = row[5] || '';

      // Check if image is missing or empty
      if (!img || img.trim() === '') {
        if (sit && sit.trim() !== '') {
          processed++;
          console.log(`Processing row ${i + 1}: ${sit}`);

          try {
            // Extract image from URL
            const result = await extractLargestImage(sit);

            if (result && result.imageUrl) {
              // Use original image URL directly
              const uploadResult = await uploadToCloud(result.imageUrl);

              // Update row with new image
              const rowData = [id, result.boldText || name, sit, uploadResult.secure_url, datetime, info];
              const success = await updateGoogleSheetRow(sheets, i + 1, rowData);

              if (success) {
                updated++;
                console.log(`✓ Updated row ${i + 1} with image`);
              } else {
                errors.push(`Row ${i + 1}: Failed to update`);
              }
            } else {
              errors.push(`Row ${i + 1}: No image found on page`);
            }
          } catch (error) {
            console.error(`✗ Error processing row ${i + 1}:`, error.message);
            errors.push(`Row ${i + 1}: ${error.message}`);
          }
        }
      }
    }

    res.json({
      success: true,
      message: `Processed ${processed} rows, updated ${updated} rows`,
      processed,
      updated,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('Error processing missing images:', error.message);
    res.status(500).json({
      error: 'Failed to process missing images',
      details: error.message
    });
  }
});

// Route to process data to JSON and store in 'read' sheet
app.post('/process-data-to-json', async (req, res) => {
  try {
    // Initialize Google Sheets
    const sheets = await initGoogleSheets();

    const spreadsheetId = SPREADSHEET_ID;
    const sourceSheetName = 'keep';
    const targetSheetName = 'read';

    // Read all data from source sheet to get total rows
    const totalResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: `${sourceSheetName}!A:G`,
    });

    const totalRows = totalResponse.data.values ? totalResponse.data.values.length : 0;
    console.log(`Total rows in sheet: ${totalRows}`);

    // Process data in batches of 100 rows (0-99, 100-199, etc.)
    const batchSize = 100;
    let totalProcessed = 0;
    let totalUpdated = 0;

    // Calculate actual number of batches needed based on total rows
    const actualMaxRows = Math.min(totalRows, 600); // Cap at 600 rows max

    for (let startRow = 0; startRow < actualMaxRows; startRow += batchSize) {
      const endRow = Math.min(startRow + batchSize, totalRows);
      const range = `${sourceSheetName}!A${startRow + 1}:G${endRow}`;

      console.log(`Processing range: ${range} (rows ${startRow + 1}-${endRow})`);

      // Read data from source sheet
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: range,
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        console.log(`No data in range ${range}`);
        break; // Stop processing if no data found
      }

      // Convert to JSON
      const jsonData = JSON.stringify(rows);
      console.log(`Converted ${rows.length} rows to JSON (${jsonData.length} characters)`);
      
      // Print first element for debugging
      if (rows.length > 0) {
        console.log('First row from source:', JSON.stringify(rows[0]));
      }

      // Calculate which column to update (0-99 -> column A, 100-199 -> column B, etc.)
      const columnIndex = Math.floor(startRow / batchSize);
      const columnLetter = String.fromCharCode(65 + columnIndex); // A=0, B=1, C=2, etc.

      // Update target sheet (read) in the first row
      const updateRange = `${targetSheetName}!${columnLetter}1`;
      console.log(`Updating ${updateRange} with JSON data`);

      await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId,
        range: updateRange,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[jsonData]]
        }
      });

      totalProcessed += rows.length;
      totalUpdated++;

      console.log(`Updated ${updateRange} successfully`);
    }

    // Collect all JSON data from processed columns
    const allJsonData = {};
    for (let i = 0; i < totalUpdated; i++) {
      const columnLetter = String.fromCharCode(65 + i);
      const range = `${targetSheetName}!${columnLetter}1:${columnLetter}1`;
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: range
      });
      if (response.data.values && response.data.values.length > 0) {
        allJsonData[columnLetter] = response.data.values[0][0];
      }
    }

    res.json({
      success: true,
      message: 'Data processed and converted to JSON successfully',
      processed: totalProcessed,
      updated: totalUpdated,
      jsonData: allJsonData
    });

  } catch (error) {
    console.error('Error processing data to JSON:', error.message);
    res.status(500).json({
      error: 'Failed to process data to JSON',
      details: error.message
    });
  }
});
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    endpoints: [
      '/health',
      '/extract-image',
      '/save-to-sheets',
      '/save-url-only',
      '/process-missing-images',
      '/process-missing-images-screenshot',  // ← جديد
      '/process-data-to-json',
      '/get-json-data',
      '/replace-image',
      '/image-url/:filename',
      '/download-video',
      '/take-screenshot',
      '/delete-image',
      '/delete-item',
    ]
  });
});
// Route to get JSON data from Google Sheets (for client-side caching)
app.get('/get-json-data', async (req, res) => {
  try {
    const sheets = await initGoogleSheets();
    const spreadsheetId = SPREADSHEET_ID;
    const targetSheetName = 'read';

    const jsonData = {};

    // Read all columns A-J
    for (let i = 0; i < 10; i++) {
      const columnLetter = String.fromCharCode(65 + i);
      const range = `${targetSheetName}!${columnLetter}1:${columnLetter}1`;

      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId,
          range: range
        });

        if (response.data.values && response.data.values.length > 0 && response.data.values[0][0]) {
          jsonData[columnLetter] = response.data.values[0][0];
        }
      } catch (e) {
        // Column might not exist or be empty, skip it
        console.log(`Column ${columnLetter} is empty or doesn't exist`);
      }
    }

    res.json({
      success: true,
      jsonData: jsonData
    });
  } catch (error) {
    console.error('Error getting JSON data:', error.message);
    res.status(500).json({
      error: 'Failed to get JSON data',
      details: error.message
    });
  }
});

// Route to replace image with custom image (local storage)
// Route to replace image with custom image
app.post('/replace-image', async (req, res) => {
  const startTime = Date.now();

  try {
    const { oldImageUrl, newImageData, url } = req.body;

    if (!oldImageUrl || !newImageData) {
      return res.status(400).json({
        error: 'oldImageUrl and newImageData are required',
      });
    }

    let uploadResult;

    // ────────────────────────────────────────────────────────────
    // Determine data type & prepare buffer
    // ────────────────────────────────────────────────────────────
    if (
      newImageData.startsWith('http://') ||
      newImageData.startsWith('https://')
    ) {
      // It's a URL
      try {
        const response = await axios.get(newImageData, {
          responseType: 'arraybuffer',
        });
        const buffer = Buffer.from(response.data, 'binary');

        const hash = crypto
          .createHash('md5')
          .update(newImageData)
          .digest('hex');
        const fileName = `${hash}.jpg`;

        uploadResult = await uploadCustomImage(buffer, fileName, req);
      } catch (downloadError) {
        throw downloadError;
      }

    } else if (newImageData.startsWith('data:image')) {
      // It's base64
      try {
        const base64Data = newImageData.split(',')[1];
        if (!base64Data) {
          throw new Error('Base64 payload is empty');
        }

        const buffer = Buffer.from(base64Data, 'base64');
        const hash = crypto
          .createHash('md5')
          .update(base64Data)
          .digest('hex');
        const fileName = `${hash}.jpg`;

        uploadResult = await uploadCustomImage(buffer, fileName, req);
      } catch (uploadError) {
        throw uploadError;
      }

    } else {
      return res.status(400).json({
        error:
          'Invalid image data format. Please provide a URL (http/https) or base64 data (data:image/...)',
      });
    }

    const storedUrl = uploadResult.secure_url;

    // ────────────────────────────────────────────────────────────
    // Update Google Sheets
    // ────────────────────────────────────────────────────────────
    if (url) {
      try {
        const sheets = await initGoogleSheets();
        const row = await findRowByUrl(sheets, url);
        if (row) {
          const rowData = row.data;
          rowData[3] = storedUrl;
          await updateGoogleSheetRow(sheets, row.index, rowData);
        }
      } catch (sheetsError) {
        // Continue with response even if Sheets update fails
      }
    }

    // ────────────────────────────────────────────────────────────
    // ✅ Final success log
    // ────────────────────────────────────────────────────────────
    const duration = Date.now() - startTime;
    const isLocal =
      storedUrl.includes('192.168.') || storedUrl.includes('localhost');
    console.log(`   ├─ new image : ${storedUrl.substring(0, 80)}${storedUrl.length > 80 ? '...' : ''}`);

    return res.json({
      success: true,
      message: 'Image replaced successfully',
      newImageUrl: storedUrl,
      filename: uploadResult.public_id,
      publicId: uploadResult.public_id,
    });

  } catch (error) {
    // ────────────────────────────────────────────────────────────
    // ✅ Final failure log
    // ────────────────────────────────────────────────────────────
    const duration = Date.now() - startTime;
    console.log(`   ├─ Message  : ${error.message}`);


    return res.status(500).json({
      error: 'Failed to replace image',
      details: error.message,
    });
  }
});

// Route to get image URL from filename
app.get('/image-url/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    const serverUrl = `${req.protocol}://${req.get('host')}`;
    const imageUrl = `${serverUrl}/img/${filename}`;
    res.json({ imageUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/delete-item', async (req, res) => {
  const { id } = req.body;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'id is required and must be a non-empty string'
    });
  }

  const errors = [];
  let imagesDeleted = 0;
  let imagesFailed = 0;
  let rowIndex = -1;
  let imageUrls = [];

  try {
    // [1] Initialize Google Sheets
    const sheets = await initGoogleSheets();

    // [2] Read all rows from the "keep" sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:G`,
    });

    const rows = response.data.values;
    if (!rows || rows.length <= 1) {
      return res.status(404).json({
        success: false,
        error: 'Sheet is empty or contains only the header'
      });
    }

    // [3] Find the row where column G (index 6) matches the group
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowGroup = row[6]?.toString().trim();

      if (row.length >= 7 && rowGroup === id.trim()) {
        rowIndex = i + 1;

        if (row.length > 3 && row[3]) {
          imageUrls = row[3]
            .toString()
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
        break;
      }
    }

    if (rowIndex === -1) {
      return res.status(404).json({
        success: false,
        error: `No row found with id: ${id}`
      });
    }

    // [4] Delete each image from Dropbox (fallback: local storage)
    for (const imageUrl of imageUrls) {
      if (!imageUrl) continue;

      try {
        const fileId = extractFileIdFromUrl(imageUrl);
        if (!fileId) {
          errors.push(`Could not extract fileId from: ${imageUrl}`);
          imagesFailed++;
          continue;
        }

        const deleted = await deleteFileById(fileId);
        if (deleted) {
          imagesDeleted++;
        } else {
          imagesFailed++;
          errors.push(`Image not found: ${fileId}`);
        }
      } catch (imgErr) {
        imagesFailed++;
        errors.push(`Failed to delete image ${imageUrl}: ${imgErr.message}`);
      }
    }

    // [5] Delete the row from Google Sheets
    const batchUpdateRequest = {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: 0,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        },
      ],
    };

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: batchUpdateRequest,
    });

    // [6] Final success response
    return res.json({
      success: true,
      message: 'Item deleted successfully',
      deletedRow: {
        id,
        rowIndex,
        imageUrls,
      },
      imagesDeleted,
      imagesFailed,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    // [7] Final failure response
    return res.status(500).json({
      success: false,
      error: 'Failed to delete item',
      details: error.message,
      errors: errors.length > 0 ? errors : undefined,
    });
  }
});


function extractFileIdFromUrl(url) {
  if (!url) return null;

  if (!url.startsWith('http')) {
    return url.replace(/\.(p|jpg|jpeg|png|v|mp4)$/i, '');
  }

  try {
    const parsed = new URL(url);
    const fileName = parsed.pathname.split('/').filter(Boolean).pop();
    if (!fileName) return null;
    return fileName.replace(/\.(p|jpg|jpeg|png|v|mp4)$/i, '');
  } catch {
    return null;
  }
}


async function deleteFileById(fileId) {
  const extensions = ['.p', '.v', '.jpg', '.mp4', '.png', '.jpeg'];

  // Try Dropbox deletion
  try {
    const dropboxClient = await getDropboxClient();
    for (const ext of extensions) {
      const dropboxPath = `/keep-images/${fileId}${ext}`;
      try {
        await dropboxClient.filesDeleteV2({ path: dropboxPath });
        console.log(`✅ Deleted from Dropbox: ${dropboxPath}`);
        return true;
      } catch (err) {
        // silent — try next extension
      }
    }
  } catch (tokenError) {
    console.warn('⚠️  Dropbox unavailable for deletion:', tokenError.message);
  }

  // Fallback: local storage
  const localPath = path.join(__dirname, 'img', `${fileId}.p`);
  if (fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
    console.log(`✅ Deleted from local storage: ${localPath}`);
    return true;
  }

  console.log(`❌ File not found in Dropbox nor local storage: ${fileId}`);
  return false;
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Server is running',
    endpoints: [
      '/health',
      '/extract-image',
      '/save-to-sheets',
      '/save-url-only',
      '/process-missing-images',
      '/process-data-to-json',
      '/get-json-data',
      '/replace-image',
      '/image-url/:filename',
      '/download-video',
      '/take-screenshot',
      '/delete-image',
      '/delete-item',   // ← جديد
    ]
  });
});
// Route to download video from URL
app.post('/download-video', async (req, res) => {
  try {
    const { url, group } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`Downloading video from: ${url}`);

    let videoBuffer;
    let fileName;

    // Check if it's a YouTube URL
    if (ytdl.validateURL(url)) {
      try {
        const info = await ytdl.getInfo(url);
        const videoTitle = info.videoDetails.title.replace(/[^\w\s]/gi, '');
        fileName = `${videoTitle}.v`;

        // Download video to buffer
        const chunks = [];
        const videoStream = ytdl(url, { quality: 'highest' });

        await new Promise((resolve, reject) => {
          videoStream.on('data', chunk => chunks.push(chunk));
          videoStream.on('end', resolve);
          videoStream.on('error', reject);
        });

        videoBuffer = Buffer.concat(chunks);
        console.log(`YouTube video downloaded: ${fileName}, size: ${videoBuffer.length} bytes`);
      } catch (ytdlError) {
        console.error('Error downloading YouTube video:', ytdlError.message);
        return res.status(400).json({
          error: 'Failed to download YouTube video',
          details: ytdlError.message
        });
      }
    } else {
      // Try to download as direct video URL
      try {
        const proxyServer = process.env.PROXY_SERVER;
        const axiosConfig = {
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.facebook.com/',
          },
          timeout: 120000, // 120 seconds timeout
          // Force IPv4 only to avoid IPv6 connection issues
          family: 4,
        };

        if (proxyServer) {
          axiosConfig.proxy = {
            host: proxyServer.split(':')[1].replace('//', ''),
            port: parseInt(proxyServer.split(':')[2]),
          };
          console.log(`Using proxy for video download: ${proxyServer}`);
        }

        const response = await axios(axiosConfig);

        const contentType = response.headers['content-type'];
        if (!contentType || !contentType.startsWith('video/')) {
          return res.status(400).json({
            error: 'URL does not point to a video file',
            contentType: contentType || 'unknown'
          });
        }

        fileName = `vi_${Date.now()}.v`;
        videoBuffer = Buffer.from(response.data);
        console.log(`Direct video downloaded: ${fileName}, size: ${videoBuffer.length} bytes`);
      } catch (downloadError) {
        console.error('Error downloading video:', downloadError.message);
        console.error('Full error:', downloadError);
        return res.status(400).json({
          error: 'Failed to download video from URL',
          details: downloadError.message
        });
      }
    }

    // Upload to Dropbox
    let dropboxUrl;
    let useLocalFallback = false;

    try {
      // Upload with .v extension to Dropbox (same as images use .p)
      const dropboxPath = `/keep-images/${fileName}`;
      console.log('Uploading to Dropbox:', dropboxPath);

      const dropboxClient = await getDropboxClient();
await dropboxClient.filesUpload({
        path: dropboxPath,
        contents: videoBuffer,
        mode: 'overwrite',
        autorename: false,
        content_type: 'video/mp4'
      });
      console.log('Successfully uploaded to Dropbox:', dropboxPath);

      // Create a shared link for the file
      const sharedLinkResponse = await dropboxClient.sharingCreateSharedLink({
        path: dropboxPath,
        settings: {
          requested_visibility: 'public'
        }
      });

      const sharedLink = sharedLinkResponse.result.url;
      console.log('Dropbox shared link:', sharedLink);

      // Convert shared link to direct download link
      dropboxUrl = sharedLink.replace('www.dropbox.com', 'dl.dropboxusercontent.com').replace('?dl=0', '');
      console.log('Dropbox direct link:', dropboxUrl);
    } catch (dropboxError) {
      console.error('Error uploading to Dropbox:', dropboxError.message);
      console.error('Dropbox error details:', dropboxError);
      console.error('Dropbox error status:', dropboxError.status);
      console.error('Falling back to local storage');
      useLocalFallback = true;

      // Fallback to local storage if Dropbox fails
      const imgDir = path.join(__dirname, 'img');

      if (!fs.existsSync(imgDir)) {
        fs.mkdirSync(imgDir, { recursive: true });
        console.log('Created img directory:', imgDir);
      }

      const filePath = path.join(imgDir, fileName);
      fs.writeFileSync(filePath, videoBuffer);

      console.log('Saved video locally to:', filePath);

      // Use local server URL
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      dropboxUrl = `${serverUrl}/img/${fileName}`;
    }

    // Add to Google Sheets
    try {
      const sheets = await initGoogleSheets();
      const id = crypto.randomBytes(8).toString('hex');
      const videoGroup = group || crypto.randomBytes(8).toString('hex');

      const valueRange = {
        values: [
          [
            id,
            'Video', // Default title
            url, // Original video URL in sit column
            dropboxUrl, // Dropbox URL in img column
            new Date().toISOString(),
            '', // Empty column
            videoGroup
          ],
        ],
      };

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:G`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: valueRange
      });

      console.log('Video added to Google Sheets successfully');
    } catch (sheetsError) {
      console.error('Error adding to Google Sheets:', sheetsError.message);
      // Continue with response even if Google Sheets update fails
    }

    res.json({
      success: true,
      message: 'Video downloaded and uploaded successfully',
      filename: fileName,
      dropboxUrl: dropboxUrl
    });
  } catch (error) {
    console.error('Error in download-video endpoint:', error.message);
    res.status(500).json({
      error: 'Failed to download video',
      details: error.message
    });
  }
});

// Route to take screenshot of a website
app.post('/take-screenshot', async (req, res) => {
  try {
    const { url } = req.body;

    console.log('=== Take Screenshot Request ===');
    console.log('URL:', url);

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    let browser = null;
    try {
      const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];

      browser = await puppeteer.launch({
        headless: 'new',
        args: launchArgs,
      });

      const page = await browser.newPage();

      // Set viewport size
      await page.setViewport({ width: 1920, height: 1080 });

      // Disable JavaScript dialogs (alerts, confirms, prompts)
      page.on('dialog', async dialog => {
        console.log('Dialog detected:', dialog.type());
        await dialog.accept();
      });

      console.log('Navigating to URL...');
      
      // Track data transfer size
      let totalDataSize = 0;
      const TARGET_DATA_SIZE = 1.5 * 1024 * 1024; // 1.5 MB in bytes
      
      // Listen to response events to track data size
      page.on('response', async (response) => {
        try {
          const headers = response.headers();
          const contentLength = headers['content-length'];
          if (contentLength) {
            totalDataSize += parseInt(contentLength, 10);
            // Removed console.log to avoid excessive output
          }
        } catch (e) {
          // Ignore errors in tracking
        }
      });
      
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });

      // Wait until 1.5MB is loaded
      console.log('Waiting for data to load (target: 1.5MB)...');
      const startTime = Date.now();
      const maxWaitTime = 10000; // 10 seconds max as fallback
      
      while (totalDataSize < TARGET_DATA_SIZE && (Date.now() - startTime) < maxWaitTime) {
        await page.waitForTimeout(100); // Check every 100ms
      }
      
      console.log(`Data loading complete: ${(totalDataSize / 1024 / 1024).toFixed(2)} MB loaded in ${Date.now() - startTime}ms`);

      // Try to click age verification button (18+) - limited attempt
      console.log('Attempting to click age verification button...');
      try {
        await page.evaluate(() => {
          // Find buttons with text containing "18"
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || '';
            if (text.includes('18') || text.includes('18+') || text.includes('over 18') || text.includes('i am 18')) {
              try {
                btn.click();
                console.log('Clicked age verification button');
                return true; // Exit after first successful click
              } catch (e) {
                // Continue to next button
              }
            }
          }
          return false;
        });
        await page.waitForTimeout(500); // Brief wait after click
      } catch (e) {
        console.log('Error clicking age verification button:', e.message);
      }

      // Try to click Accept buttons - limited attempt
      console.log('Attempting to click Accept buttons...');
      try {
        await page.evaluate(() => {
          // Find buttons with text containing "accept"
          const buttons = document.querySelectorAll('button, [role="button"]');
          for (const btn of buttons) {
            const text = btn.textContent?.toLowerCase() || '';
            if (text.includes('accept') || text.includes('agree') || text.includes('i agree')) {
              try {
                btn.click();
                console.log('Clicked accept button');
                return true; // Exit after first successful click
              } catch (e) {
                // Continue to next button
              }
            }
          }
          return false;
        });
        await page.waitForTimeout(500); // Brief wait after click
      } catch (e) {
        console.log('Error clicking accept button:', e.message);
      }

      // Simple popup handling - just close common overlays without extensive clicking
      console.log('Closing common popups...');
      try {
        await page.evaluate(() => {
          // Remove common popup overlays
          const popupSelectors = [
            '.cookie-banner', '.cookie-consent', '.cookie-notice',
            '#cookie-banner', '#cookie-consent',
            '[class*="cookie"]', '[id*="cookie"]',
            '.cc-banner', '.cc-window',
            '.modal-backdrop', '.modal-overlay', '.popup-overlay',
            '.overlay', '.backdrop',
            '[role="dialog"]', '[aria-modal="true"]',
          ];
          
          popupSelectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(el => {
              el.style.display = 'none';
              el.remove();
            });
          });

          // Scroll to top
          window.scrollTo(0, 0);
        });
      } catch (e) {
        console.log('Error closing popups:', e.message);
      }

      // Brief wait for any animations
      await page.waitForTimeout(500);

      console.log('Taking screenshot...');
      const screenshot = await page.screenshot({
        type: 'png',
        fullPage: false,
      });

      await browser.close();
      browser = null;

      // Convert screenshot to base64 and return as data URL
      console.log('Converting screenshot to base64...');
      const buffer = Buffer.from(screenshot);
      const base64 = buffer.toString('base64');
      const dataUrl = `data:image/png;base64,${base64}`;

      console.log('Screenshot converted successfully');
      res.json({
        success: true,
        message: 'Screenshot taken successfully',
        screenshotUrl: dataUrl,
      });

    } catch (browserError) {
      if (browser) {
        await browser.close();
      }
      throw browserError;
    }

  } catch (error) {
    console.error('=== Error taking screenshot ===');
    console.error('Error message:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      error: 'Failed to take screenshot',
      details: error.message
    });
  }
});

// Route to delete image from Dropbox
app.post('/delete-image', async (req, res) => {
  try {
    const { fileId } = req.body;

    console.log('=== Delete Image Request ===');
    console.log('File ID:', fileId);
    console.log('Request body:', JSON.stringify(req.body));

    if (!fileId) {
      console.log('Error: fileId is missing');
      return res.status(400).json({ error: 'fileId is required' });
    }

    // Construct Dropbox path (fileId is the filename without extension)
    const dropboxPath = `/keep-images/${fileId}.p`;
    console.log('Dropbox path to delete:', dropboxPath);

    try {
      // Delete file from Dropbox
      console.log('Attempting to delete from Dropbox...');
      const dropboxClient = await getDropboxClient();
await dropboxClient.filesDeleteV2({ path: dropboxPath });
      console.log('Successfully deleted from Dropbox:', dropboxPath);

      res.json({
        success: true,
        message: 'Image deleted successfully from Dropbox'
      });
    } catch (dropboxError) {
      console.error('Error deleting from Dropbox:', dropboxError.message);
      console.error('Full Dropbox error:', JSON.stringify(dropboxError, null, 2));
      
      // If Dropbox deletion fails, try to delete from local storage as fallback
      const fs = require('fs');
      const path = require('path');
      const localPath = path.join(__dirname, 'img', `${fileId}.p`);
      
      console.log('Attempting fallback to local storage:', localPath);
      
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        console.log('Deleted from local storage:', localPath);
        
        res.json({
          success: true,
          message: 'Image deleted from local storage (Dropbox failed)'
        });
      } else {
        console.log('File not found in local storage either');
        throw new Error('File not found in Dropbox or local storage');
      }
    }
  } catch (error) {
    console.error('Error deleting image:', error.message);
    console.error('Full error:', error);
    res.status(500).json({
      error: 'Failed to delete image',
      details: error.message
    });
  }
});
// ═══════════════════════════════════════════════════════════
// Proxy images with proper headers (لحل مشكلة xhpingcdn)
// ═══════════════════════════════════════════════════════════
app.get('/proxy-image', async (req, res) => {
  const imageUrl = req.query.url;
  
  if (!imageUrl) {
    return res.status(400).send('url query parameter is required');
  }

  try {
    console.log('🖼️ Proxying:', imageUrl);

    // استخرج النطاق لاستخدامه كـ Referer
    let referer = 'https://www.google.com/';
    try {
      const parsed = new URL(imageUrl);
      referer = `${parsed.protocol}//${parsed.host}/`;
    } catch (e) {
      console.warn('Could not parse URL for referer');
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 20000,
      // ✅ مهم: لا تتحقق من صحة الرموز
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    
    // تحقق أن الاستجابة صورة وليست HTML
    if (contentType.includes('text/html')) {
      console.error('❌ Server returned HTML instead of image');
      return res.status(502).send('Upstream returned HTML');
    }

    console.log(`✅ Proxied successfully: ${contentType}, ${response.data.length} bytes`);

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // كاش يوم واحد
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(response.data));

  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    console.error('   URL:', imageUrl);
    
    // fallback: صورة رمادية
    res.status(502).send('Failed to fetch image');
  }
});
// Health check route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Root route
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running', endpoints: ['/health', '/extract-image', '/save-to-sheets', '/save-url-only', '/process-missing-images', '/process-data-to-json', '/get-json-data', '/replace-image', '/image-url/:filename', '/download-video', '/take-screenshot', '/delete-image'] });
});

// Start server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Cloudinary configured: ${!!cloudinary.config().cloud_name}`);

  // Initialize and read Google Sheets on startup
  try {
    console.log('\nConnecting to Google Sheets API...');
    const sheets = await initGoogleSheets();
    await readGoogleSheets(sheets);
  } catch (error) {
    console.error('Failed to connect to Google Sheets:', error.message);
  }
});
