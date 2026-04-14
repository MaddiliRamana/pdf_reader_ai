// ── CONFIG ──────────────────────────────────────────────────────────────────
const BACKEND = (window.location.port === '3000' || window.location.port === '3001')
  ? window.location.origin
  : window.location.port === '3443'
    ? window.location.origin
    : 'https://localhost:3443';
const API = BACKEND + '/api';
pdfjsLib.GlobalWorkerOptions.workerSrc = BACKEND + '/pdf.worker.min.js';

// ── AUTH CHECK ────────────────────────────────────────────────────────────────
const token = localStorage.getItem('cc_token');
const ccUser = localStorage.getItem('cc_user');
if (!token) { window.location.href = '/login.html'; }

// Attach token to every fetch automatically
const _origFetch = window.fetch;
window.fetch = (url, opts = {}) => {
  if (typeof url === 'string' && url.includes('/api/')) {
    opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + token };
  }
  return _origFetch(url, opts).then(res => {
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login.html'; }
    return res;
  });
};

function logout() {
  localStorage.clear();
  window.location.href = '/login.html';
}

// ── STATE ───────────────────────────────────────────────────────────────────
let pdfDoc = null;
let currentPage = 1;
let extractedText = '';
let aiNotes = '';
let wordSpans = [];
let wordIndex = 0;
let speechUtterance = null;
let isSpeaking = false;
let isPaused = false;
let voices = [];
let zoomScale = 1.5; // base scale — DPR handles sharpness
let zoomLevel = 1.0; // display zoom multiplier

// ── EYE COMFORT MODE ──────────────────────────────────────────────────────────
let eyeComfortOn = localStorage.getItem('cc_eye_comfort') === 'true';
let currentFontSize = parseInt(localStorage.getItem('cc_font_size') || '16');

function applyEyeComfort() {
  document.body.classList.toggle('eye-comfort', eyeComfortOn);
  document.getElementById('btnEyeComfort').classList.toggle('active', eyeComfortOn);
  document.getElementById('btnEyeComfort').textContent = eyeComfortOn ? '☀️ Normal Mode' : '🌙 Eye Comfort';
  document.getElementById('readingTextBox').style.fontSize = currentFontSize + 'px';
  document.getElementById('fontSizeLabel').textContent = currentFontSize + 'px';
}

function toggleEyeComfort() {
  eyeComfortOn = !eyeComfortOn;
  localStorage.setItem('cc_eye_comfort', eyeComfortOn);
  applyEyeComfort();
}

function changeFontSize(delta) {
  currentFontSize = Math.min(28, Math.max(12, currentFontSize + delta));
  localStorage.setItem('cc_font_size', currentFontSize);
  document.getElementById('readingTextBox').style.fontSize = currentFontSize + 'px';
  document.getElementById('fontSizeLabel').textContent = currentFontSize + 'px';
}

// ── FOCUS MODE ────────────────────────────────────────────────────────────────
let focusModeOn = false;

function toggleFocusMode() {
  focusModeOn = !focusModeOn;
  document.body.classList.toggle('focus-mode', focusModeOn);
  document.getElementById('btnFocusMode').classList.toggle('active', focusModeOn);
  document.getElementById('btnFocusMode').textContent = focusModeOn ? '🎯 Focus: ON' : '🎯 Focus Mode';
  document.getElementById('btnExitFocus').classList.toggle('hidden', !focusModeOn);

  if (focusModeOn) {
    // Scroll to top so PDF is visible
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// Restore settings on load
window.addEventListener('load', () => {
  applyEyeComfort();
});

// ── WELCOME VOICE GREETINGS ───────────────────────────────────────────────────
function speak(text, rate = 0.95, pitch = 1.05) {
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate  = rate;
  u.pitch = pitch;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v =>
    v.name.includes('Google') || v.name.includes('Microsoft') || v.lang === 'en-US'
  );
  if (preferred) u.voice = preferred;
  window.speechSynthesis.speak(u);
}

let welcomeSpoken = false;
function speakWelcome() { /* handled on login page */ }

// No auto-trigger needed — welcome plays on login page before redirect

// ── INIT ─────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const user = localStorage.getItem('cc_user');
  const greet = document.getElementById('userGreeting');
  if (greet && user) greet.textContent = '👤 ' + user;

  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;

  document.getElementById('speedRange').addEventListener('input', e => {
    document.getElementById('speedVal').textContent = parseFloat(e.target.value).toFixed(1) + 'x';
  });

  // Drag & drop
  const uploadArea = document.getElementById('uploadArea');
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.style.background = 'rgba(108,99,255,0.15)'; });
  uploadArea.addEventListener('dragleave', () => { uploadArea.style.background = ''; });
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.style.background = '';
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') handlePDFFile(file);
  });

  document.getElementById('pdfInput').addEventListener('change', e => {
    if (e.target.files[0]) handlePDFFile(e.target.files[0]);
  });

  document.getElementById('prevPage').addEventListener('click', () => {
    if (currentPage > pageRangeFrom) { currentPage--; clearHighlights(); renderPage(currentPage); saveProgress(); }
  });
  document.getElementById('nextPage').addEventListener('click', () => {
    const maxP = pageRangeTo || (pdfDoc ? pdfDoc.numPages : 1);
    if (pdfDoc && currentPage < maxP) { currentPage++; clearHighlights(); renderPage(currentPage); saveProgress(); }
  });

  // Zoom controls
  document.getElementById('zoomIn').addEventListener('click', () => changeZoom(0.5));
  document.getElementById('zoomOut').addEventListener('click', () => changeZoom(-0.5));
  document.getElementById('zoomReset').addEventListener('click', () => { zoomLevel = 1.0; applyZoom(); });

  // Ctrl+scroll to zoom
  document.getElementById('pdfViewerWrap').addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      changeZoom(e.deltaY < 0 ? 0.25 : -0.25);
    }
  }, { passive: false });
});

function loadVoices() {
  voices = window.speechSynthesis.getVoices();
  const sel = document.getElementById('voiceSelect');
  sel.innerHTML = '';
  voices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(opt);
  });
  // Prefer English voices
  const engIdx = voices.findIndex(v => v.lang.startsWith('en'));
  if (engIdx >= 0) sel.value = engIdx;
}

// ── PDF HANDLING ─────────────────────────────────────────────────────────────
let selectedFile   = null;
let pageRangeFrom  = 1;
let pageRangeTo    = null;

async function handlePDFFile(file) {
  selectedFile = file;

  // Load PDF to get total pages first
  const fileURL = URL.createObjectURL(file);
  let tempDoc;
  try {
    tempDoc = await pdfjsLib.getDocument(fileURL).promise;
  } catch (e) {
    showStatus('Could not read PDF. Make sure it is a valid PDF file.', 'error');
    return;
  }

  const total = tempDoc.numPages;

  // Show page range selector
  document.getElementById('pageRangeInfo').textContent =
    `📄 "${file.name}" has ${total} page${total > 1 ? 's' : ''}. Select which pages to load:`;
  const pageToEl = document.getElementById('pageTo');
  document.getElementById('pageFrom').value = 1;
  document.getElementById('pageFrom').max   = total;
  pageToEl.value = total;
  pageToEl.max   = total;
  document.getElementById('pageRangeBox').classList.remove('hidden');
}

async function loadSelectedPages() {
  if (!selectedFile) return;
  const from = parseInt(document.getElementById('pageFrom').value) || 1;
  const to   = parseInt(document.getElementById('pageTo').value)   || 1;
  pageRangeFrom = Math.max(1, from);
  pageRangeTo   = to;
  document.getElementById('pageRangeBox').classList.add('hidden');
  await processPDF(selectedFile, pageRangeFrom, pageRangeTo);
}

async function loadAllPages() {
  if (!selectedFile) return;
  pageRangeFrom = 1;
  pageRangeTo   = null;
  document.getElementById('pageRangeBox').classList.add('hidden');
  await processPDF(selectedFile, 1, null);
}

async function processPDF(file, fromPage, toPage) {
  showLoading('Loading PDF pages...');
  currentPDFName = file.name;

  const fileURL = URL.createObjectURL(file);
  try {
    pdfDoc = await pdfjsLib.getDocument(fileURL).promise;
    const maxPage = toPage ? Math.min(toPage, pdfDoc.numPages) : pdfDoc.numPages;
    pageRangeTo   = maxPage;
    currentPage   = fromPage;
    await renderPage(currentPage);
    document.getElementById('mainLayout').style.display = 'grid';
    document.getElementById('pageInfo').textContent =
      `Pages ${fromPage}–${maxPage} of ${pdfDoc.numPages}`;
  } catch (e) {
    hideLoading();
    showStatus('Could not render PDF.', 'error');
    return;
  }

  showLoading('Extracting text from selected pages...');
  try {
    const end = toPage ? Math.min(toPage, pdfDoc.numPages) : pdfDoc.numPages;
    let allText = '';
    for (let p = fromPage; p <= end; p++) {
      const page    = await pdfDoc.getPage(p);
      const content = await page.getTextContent();
      allText += content.items.map(i => i.str).join(' ') + '\n\n';
    }

    if (allText.trim().length > 10) {
      extractedText = allText.trim();
      setupReadingText(extractedText);
      showStatus(`Loaded pages ${fromPage}–${end} of "${file.name}"`, 'success');
      hideLoading();
      savePDFToLibrary(file);
      updateProgressBar();
      setTimeout(() => checkResume(file.name), 600);
      showAudioPlayer();
      setTimeout(() => speak(`Loaded ${end - fromPage + 1} pages from your PDF. You can now start reading.`), 500);
    } else {
      showLoading('No text found, trying server extraction...');
      await uploadForExtraction(file);
    }
  } catch (e) {
    console.error('Text extraction error:', e);
    await uploadForExtraction(file);
  }
}

// Extract text from ALL pages using pdf.js getTextContent
async function extractTextFromPDF(doc) {
  let fullText = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(' ');
    fullText += pageText + '\n\n';
  }
  return fullText;
}

// Fallback: send to backend if pdf.js found no text
async function uploadForExtraction(file) {
  const formData = new FormData();
  formData.append('pdf', file);
  try {
    const res = await fetch(`${API}/upload`, { method: 'POST', body: formData });
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    extractedText = data.text || '';
    setupReadingText(extractedText);
    showStatus('PDF loaded via server extraction.', 'success');
    savePDFToLibrary(file);
  } catch (err) {
    showStatus('Text extraction failed: ' + err.message, 'error');
    // Still allow PDF viewing even if text extraction fails
    extractedText = '';
  } finally {
    hideLoading();
  }
}

async function renderPage(num) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(num);
  const canvas = document.getElementById('pdfCanvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 2;
  const renderScale = zoomScale * zoomLevel * dpr;
  const viewport = page.getViewport({ scale: renderScale });

  canvas.width  = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width  = (viewport.width  / dpr) + 'px';
  canvas.style.height = (viewport.height / dpr) + 'px';

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Draw search highlights on canvas after render
  if (searchQuery) {
    const content = await page.getTextContent();
    const activeMatch = searchMatches[currentMatchIndex];
    ctx.save();

    content.items.forEach(item => {
      if (!item.str || !item.width) return;
      const lower = item.str.toLowerCase();
      if (!lower.includes(searchQuery)) return;

      const tx = item.transform;
      const [vx, vy] = viewport.convertToViewportPoint(tx[4], tx[5]);
      const fontH = Math.abs(tx[3]) * renderScale;

      // Set the EXACT font from the PDF item so measureText is accurate
      const fontSize = Math.sqrt(tx[0]*tx[0] + tx[1]*tx[1]) * renderScale;
      ctx.font = `${fontSize}px ${item.fontName || 'sans-serif'}`;

      // Scale factor: ratio of canvas width to pdf-reported width
      // This corrects for font substitution differences
      const pdfW    = item.width * renderScale;
      const canvasW = ctx.measureText(item.str).width;
      const scale   = canvasW > 0 ? pdfW / canvasW : 1;

      let s = 0;
      while (true) {
        const f = lower.indexOf(searchQuery, s);
        if (f === -1) break;

        const before  = item.str.slice(0, f);
        const matched = item.str.slice(f, f + searchQuery.length);

        // Measure with scale correction
        const bw = ctx.measureText(before).width  * scale;
        const mw = ctx.measureText(matched).width * scale;

        const isActive = activeMatch &&
          activeMatch.page === num &&
          activeMatch.itemStr === item.str &&
          activeMatch.matchStart === f;

        const hx = vx + bw;
        const hy = vy - fontH * 0.9;
        const hh = fontH * 0.95;

        ctx.fillStyle = isActive
          ? 'rgba(255, 140, 0, 0.55)'
          : 'rgba(255, 230, 0, 0.5)';

        // Clip to exact bounds — no overflow
        ctx.save();
        ctx.beginPath();
        ctx.rect(hx, hy, mw, hh);
        ctx.clip();
        ctx.fillRect(hx, hy, mw, hh);
        ctx.restore();

        s = f + 1;
      }
    });

    ctx.restore();
  }

  // Clear text layer — not needed anymore
  const textLayer = document.getElementById('pdfTextLayer');
  if (textLayer) textLayer.innerHTML = '';

  const displayTotal = pageRangeTo || pdfDoc.numPages;
  const displayCurrent = num - pageRangeFrom + 1;
  document.getElementById('pageNum').textContent = `Page ${displayCurrent} / ${displayTotal - pageRangeFrom + 1}`;
  document.getElementById('pageInfo').textContent = `Pages ${pageRangeFrom}–${displayTotal} of ${pdfDoc.numPages}`;

  try {
    const content2 = await page.getTextContent();
    const pageText = content2.items.map(i => i.str).join(' ').trim();
    if (pageText.length > 10 && !isSpeaking) {
      extractedText = pageText;
      setupReadingText(extractedText);
    }
  } catch (_) {}
}

// ── ZOOM ─────────────────────────────────────────────────────────────────────
function changeZoom(delta) {
  zoomLevel = Math.min(8.0, Math.max(0.3, parseFloat((zoomLevel + delta).toFixed(2))));
  applyZoom();
}

function applyZoom() {
  document.getElementById('zoomLevel').textContent = Math.round(zoomLevel * 100) + '%';
  renderPage(currentPage);
}

// ── SMART READING ─────────────────────────────────────────────────────────────
function setupReadingText(text) {
  const box = document.getElementById('readingTextBox');
  box.innerHTML = '';
  wordSpans = [];
  wordIndex = 0;

  const words = text.split(/\s+/).filter(w => w.length > 0);
  words.forEach((word, i) => {
    const span = document.createElement('span');
    span.className = 'word-span';
    span.textContent = word + ' ';
    span.dataset.index = i;
    // Double-click to look up word
    span.addEventListener('dblclick', () => {
      const clean = word.replace(/[^a-zA-Z'-]/g, '');
      if (clean.length > 1) lookupWord(clean);
    });
    box.appendChild(span);
    wordSpans.push(span);
  });
}

function startReading() {
  if (!extractedText) { alert('Please upload a PDF first.'); return; }
  if (isPaused) {
    window.speechSynthesis.resume();
    isPaused = false;
    document.getElementById('btnPause').textContent = '⏸ Pause';
    isSpeaking = true;
    return;
  }

  stopReading();
  wordIndex = 0;
  speakFromIndex(wordIndex);
}

function speakFromIndex(startIdx) {
  const words = wordSpans.map(s => s.textContent.trim());
  const textToSpeak = words.slice(startIdx).join(' ');

  speechUtterance = new SpeechSynthesisUtterance(textToSpeak);

  const voiceIdx = parseInt(document.getElementById('voiceSelect').value);
  if (voices[voiceIdx]) speechUtterance.voice = voices[voiceIdx];
  speechUtterance.rate = parseFloat(document.getElementById('speedRange').value);
  speechUtterance.pitch = 1.05;

  let currentWordIdx = startIdx;

  speechUtterance.onboundary = (e) => {
    if (e.name === 'word') {
      // Highlight current word
      wordSpans.forEach(s => s.classList.remove('word-highlight'));
      if (wordSpans[currentWordIdx]) {
        wordSpans[currentWordIdx].classList.add('word-highlight');
        wordSpans[currentWordIdx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      currentWordIdx++;
    }
  };

  speechUtterance.onend = () => {
    wordSpans.forEach(s => s.classList.remove('word-highlight'));
    isSpeaking = false;
    isPaused = false;
    document.getElementById('btnStart').disabled = false;
    document.getElementById('btnPause').disabled = true;
    document.getElementById('btnStop').disabled = true;
    document.getElementById('btnPause').textContent = '⏸ Pause';
  };

  window.speechSynthesis.speak(speechUtterance);
  isSpeaking = true;
  document.getElementById('btnStart').disabled = false;
  document.getElementById('btnPause').disabled = false;
  document.getElementById('btnStop').disabled = false;
}

function pauseReading() {
  if (isSpeaking && !isPaused) {
    window.speechSynthesis.pause();
    isPaused = true;
    document.getElementById('btnPause').textContent = '▶ Resume';
  } else if (isPaused) {
    window.speechSynthesis.resume();
    isPaused = false;
    document.getElementById('btnPause').textContent = '⏸ Pause';
  }
}

function stopReading() {
  window.speechSynthesis.cancel();
  isSpeaking = false;
  isPaused = false;
  wordSpans.forEach(s => s.classList.remove('word-highlight'));
  document.getElementById('btnPause').disabled = true;
  document.getElementById('btnStop').disabled = true;
  document.getElementById('btnPause').textContent = '⏸ Pause';
}

// ── AI NOTES ──────────────────────────────────────────────────────────────────
function clearNotes() {
  aiNotes = '';
  document.getElementById('notesOutput').textContent = '';
  document.getElementById('downloadRow').style.display = 'none';
  document.getElementById('translationOutput').textContent = '';
  document.getElementById('translationOutput').classList.add('hidden');
  document.getElementById('translationClearRow').style.display = 'none';
  document.getElementById('langSelect').value = '';
}

async function generateNotes() {
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const loader = document.getElementById('notesLoader');
  const output = document.getElementById('notesOutput');
  loader.classList.remove('hidden');
  output.textContent = '';
  document.getElementById('downloadRow').style.display = 'none';

  try {
    const res = await fetch(`${API}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: extractedText })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    aiNotes = data.notes;
    output.textContent = aiNotes;
    document.getElementById('downloadRow').style.display = 'flex';
  } catch (err) {
    output.textContent = 'Error: ' + err.message;
  } finally {
    loader.classList.add('hidden');
  }
}

// ── TRANSLATE ─────────────────────────────────────────────────────────────────
function clearTranslation() {
  const output = document.getElementById('translationOutput');
  output.textContent = '';
  output.classList.add('hidden');
  document.getElementById('translationClearRow').style.display = 'none';
  document.getElementById('langSelect').value = '';
}

async function translateText() {
  const lang = document.getElementById('langSelect').value;
  if (!lang) { alert('Please select a language.'); return; }
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const output = document.getElementById('translationOutput');
  output.classList.remove('hidden');
  output.textContent = 'Translating...';

  try {
    const res = await fetch(`${API}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: extractedText, language: lang })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    output.textContent = `[${lang} Translation]\n\n` + data.translated;
    document.getElementById('translationClearRow').style.display = 'block';
  } catch (err) {
    output.textContent = 'Translation error: ' + err.message;
  }
}

// ── TOPIC SEARCH ──────────────────────────────────────────────────────────────
async function searchTopic() {
  const topic = document.getElementById('topicSearchInput').value.trim();
  if (!topic) { alert('Please enter a topic.'); return; }
  if (!aiNotes && !extractedText) { alert('Please upload a PDF and generate notes first.'); return; }

  const loader = document.getElementById('topicSearchLoader');
  const result = document.getElementById('topicSearchResult');
  loader.classList.remove('hidden');
  result.classList.add('hidden');
  result.textContent = '';
  document.getElementById('btnClearTopic').style.display = 'inline-flex';

  try {
    const res = await fetch(`${API}/search-topic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, notes: aiNotes || extractedText })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    result.textContent = data.result;
    result.classList.remove('hidden');
    document.getElementById('btnClearTopic').style.display = 'inline-flex';
  } catch (err) {
    result.textContent = 'Error: ' + err.message;
    result.classList.remove('hidden');
  } finally {
    loader.classList.add('hidden');
  }
}

function clearTopicSearch() {
  document.getElementById('topicSearchInput').value = '';
  document.getElementById('topicSearchResult').textContent = '';
  document.getElementById('topicSearchResult').classList.add('hidden');
  document.getElementById('btnClearTopic').style.display = 'none';
}

// ── YOUTUBE VIDEOS ────────────────────────────────────────────────────────────
async function searchVideos() {
  const topic = document.getElementById('videoTopicInput').value.trim();
  if (!topic) { alert('Please enter a topic.'); return; }

  const loader = document.getElementById('videoLoader');
  const grid   = document.getElementById('videoGrid');
  loader.classList.remove('hidden');

  // Stop any playing iframes before clearing
  grid.querySelectorAll('iframe').forEach(f => { f.src = ''; });
  grid.innerHTML = '';

  try {
    const res = await fetch(`${API}/videos?topic=${encodeURIComponent(topic)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Show what was searched
    const header = document.createElement('p');
    header.style.cssText = 'color:#a78bfa;font-size:0.85rem;margin-bottom:10px;font-weight:600;';
    header.textContent = `🔎 Results for: "${topic}"`;
    grid.appendChild(header);

    const videoWrap = document.createElement('div');
    videoWrap.className = 'video-grid-inner';
    videoWrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;';

    data.videos.forEach(v => {
      const card = document.createElement('div');
      card.className = 'video-card';
      card.innerHTML = `
        <iframe src="https://www.youtube.com/embed/${v.id}"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen loading="lazy"></iframe>
        <div class="video-title">${v.title}</div>`;
      videoWrap.appendChild(card);
    });
    grid.appendChild(videoWrap);

    if (data.demo) {
      const note = document.createElement('p');
      note.style.cssText = 'color:#94a3b8;font-size:0.8rem;margin-top:8px;text-align:center;';
      note.textContent = '⚠️ Demo mode — add YouTube API key in .env for real search results';
      grid.appendChild(note);
    }

    document.getElementById('videoTopicInput').value = '';
    document.getElementById('btnClearVideos').style.display = 'inline-flex';
  } catch (err) {
    grid.innerHTML = `<p style="color:#f87171">Error: ${err.message}</p>`;
  } finally {
    loader.classList.add('hidden');
  }
}

function clearVideos() {
  const grid = document.getElementById('videoGrid');
  grid.querySelectorAll('iframe').forEach(f => { f.src = ''; });
  grid.innerHTML = '';
  document.getElementById('videoTopicInput').value = '';
  document.getElementById('btnClearVideos').style.display = 'none';
}

// ── DOWNLOAD NOTES AS PDF ─────────────────────────────────────────────────────
function downloadNotesPDF() {
  if (!aiNotes) { alert('Generate notes first.'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const margin = 15;
  const pageWidth = doc.internal.pageSize.getWidth();
  const maxWidth = pageWidth - margin * 2;
  let y = 20;

  // Title
  doc.setFontSize(20);
  doc.setTextColor(108, 99, 255);
  doc.text('Cognitive Curator - AI Study Notes', margin, y);
  y += 8;

  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text(`Generated on ${new Date().toLocaleDateString()}`, margin, y);
  y += 10;

  // Divider
  doc.setDrawColor(108, 99, 255);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  // Notes content
  doc.setFontSize(11);
  doc.setTextColor(30, 30, 30);

  const lines = doc.splitTextToSize(aiNotes, maxWidth);
  lines.forEach(line => {
    if (y > 275) {
      doc.addPage();
      y = 20;
    }
    doc.text(line, margin, y);
    y += 6;
  });

  doc.save('cognitive-curator-notes.pdf');
}

// ── SHARE NOTES VIA EMAIL ─────────────────────────────────────────────────────
function showShareModal() {
  if (!aiNotes) { alert('Generate notes first.'); return; }
  document.getElementById('shareModal').classList.remove('hidden');
  document.getElementById('shareOverlay').classList.remove('hidden');
  document.getElementById('shareStatus').className = 'share-status hidden';
  document.getElementById('shareEmail').value = '';
}

function closeShareModal() {
  document.getElementById('shareModal').classList.add('hidden');
  document.getElementById('shareOverlay').classList.add('hidden');
}

async function sendNotesEmail() {
  const toEmail   = document.getElementById('shareEmail').value.trim();
  const senderName = document.getElementById('shareName').value.trim();
  const status    = document.getElementById('shareStatus');
  const btn       = document.getElementById('btnSendShare');

  if (!toEmail || !toEmail.includes('@')) {
    status.textContent = 'Please enter a valid email address.';
    status.className = 'share-status error';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending...';
  status.className = 'share-status hidden';

  try {
    const res = await fetch(`${API}/share-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toEmail, notes: aiNotes, senderName })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    status.textContent = `✅ ${data.message}`;
    status.className = 'share-status success';
    setTimeout(() => closeShareModal(), 2000);
  } catch (err) {
    status.textContent = '❌ ' + err.message;
    status.className = 'share-status error';
  } finally {
    btn.disabled = false;
    btn.textContent = '📧 Send Notes';
  }
}

// ── STUDY ALARM ───────────────────────────────────────────────────────────────
let alarms = JSON.parse(localStorage.getItem('cc_alarms') || '[]');
let alarmInterval = null;
let alarmAudio = null;

function saveAlarms() {
  localStorage.setItem('cc_alarms', JSON.stringify(alarms));
}

function setAlarm() {
  const timeInput = document.getElementById('alarmTime').value;
  if (!timeInput) { alert('Please select a time.'); return; }

  // Request notification permission
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }

  const alarm = { id: Date.now(), time: timeInput, active: true };
  alarms.push(alarm);
  saveAlarms();
  renderAlarms();

  const status = document.getElementById('alarmStatus');
  status.textContent = `✅ Alarm set for ${formatTime(timeInput)}`;
  status.className = 'alarm-status active';
  document.getElementById('btnCancelAlarm').style.display = 'inline-flex';

  startAlarmChecker();
}

function cancelAlarm() {
  alarms = [];
  saveAlarms();
  renderAlarms();
  stopAlarmSound();
  const status = document.getElementById('alarmStatus');
  status.textContent = '';
  status.className = 'alarm-status hidden';
  document.getElementById('btnCancelAlarm').style.display = 'none';
}

function deleteAlarm(id) {
  alarms = alarms.filter(a => a.id !== id);
  saveAlarms();
  renderAlarms();
  if (!alarms.length) {
    document.getElementById('alarmStatus').className = 'alarm-status hidden';
    document.getElementById('btnCancelAlarm').style.display = 'none';
  }
}

function renderAlarms() {
  const list = document.getElementById('alarmList');
  if (!list) return;
  list.innerHTML = alarms.map(a => `
    <div class="alarm-item ${a.active ? 'active-alarm' : ''}">
      <span>🔔</span>
      <span class="alarm-item-time">${formatTime(a.time)}</span>
      <span style="color:var(--text-muted);font-size:0.8rem">${a.active ? 'Active' : 'Done'}</span>
      <button class="alarm-item-del" onclick="deleteAlarm(${a.id})">🗑</button>
    </div>`).join('');
}

function formatTime(t) {
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  const ampm = hr >= 12 ? 'PM' : 'AM';
  const h12 = hr % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

function startAlarmChecker() {
  if (alarmInterval) return;
  alarmInterval = setInterval(() => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hh}:${mm}`;

    alarms.forEach(alarm => {
      if (alarm.active && alarm.time === currentTime) {
        alarm.active = false;
        saveAlarms();
        renderAlarms();
        triggerAlarm(alarm.time);
      }
    });
  }, 10000); // check every 10 seconds
}

function triggerAlarm(time) {
  // Play alarm sound
  playAlarmSound();

  // Show browser notification
  if (Notification.permission === 'granted') {
    new Notification('⏰ Study Time!', {
      body: `Your study alarm for ${formatTime(time)} is ringing! Time to open your PDF and study.`,
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🧠</text></svg>',
      requireInteraction: true
    });
  }

  // Update status
  const status = document.getElementById('alarmStatus');
  if (status) {
    status.textContent = `🔔 ALARM RINGING! Time to study! — ${formatTime(time)}`;
    status.className = 'alarm-status ringing';
  }

  // Speak alarm
  speak(`Wake up! It is study time. Your alarm for ${formatTime(time)} is ringing. Open your PDF and start studying!`);

  // Stop after 30 seconds
  setTimeout(() => {
    stopAlarmSound();
    if (status) {
      status.textContent = `Alarm rang at ${formatTime(time)}`;
      status.className = 'alarm-status active';
    }
  }, 30000);
}

function playAlarmSound() {
  stopAlarmSound();
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let startTime = ctx.currentTime;
    const duration = 30;

    function beepPattern(t) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.4, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start(t);
      osc.stop(t + 0.3);
    }

    for (let i = 0; i < duration * 2; i++) {
      beepPattern(startTime + i * 0.5);
    }
    alarmAudio = ctx;
  } catch (_) {}
}

function stopAlarmSound() {
  if (alarmAudio) {
    try { alarmAudio.close(); } catch (_) {}
    alarmAudio = null;
  }
}

// Init alarms on load
window.addEventListener('load', () => {
  renderAlarms();
  if (alarms.some(a => a.active)) {
    startAlarmChecker();
    document.getElementById('btnCancelAlarm').style.display = 'inline-flex';
  }
});

// ── PDF AUDIO PLAYER ──────────────────────────────────────────────────────────
let audioBlob = null;
let audioObjectUrl = null;

function showAudioPlayer() {
  document.getElementById('audioPlayerWrap').style.display = 'block';
}

async function generateAudio() {
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const mode    = document.getElementById('audioPageMode').value;
  const text    = mode === 'page' ? extractedText : extractedText;
  const loader  = document.getElementById('audioGenLoader');
  const controls = document.getElementById('audioControls');
  const btn     = document.getElementById('btnGenerateAudio');

  loader.classList.remove('hidden');
  controls.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = '⏳ Generating...';

  try {
    // Use Web Speech API + MediaRecorder to generate audio in browser
    await generateAudioFromSpeech(text.slice(0, 8000));
  } catch (err) {
    alert('Audio generation failed: ' + err.message);
  } finally {
    loader.classList.add('hidden');
    btn.disabled = false;
    btn.textContent = '▶ Generate Audio';
  }
}

async function generateAudioFromSpeech(text) {
  return new Promise((resolve, reject) => {
    // Check if MediaRecorder + AudioContext available
    if (!window.speechSynthesis) return reject(new Error('Speech not supported'));

    const audio = document.getElementById('pdfAudio');
    const controls = document.getElementById('audioControls');

    // Use speech synthesis to speak and capture via AudioContext destination
    // Since direct recording of speechSynthesis isn't possible in all browsers,
    // we create the audio element with a blob URL using a workaround:
    // Split text into sentences, use utterances, track progress

    // Store text for playback
    audio.dataset.text = text;
    audio.dataset.pos  = '0';

    // Setup speech-based player (uses SpeechSynthesis directly)
    setupSpeechPlayer(text);
    controls.classList.remove('hidden');
    resolve();
  });
}

// Speech-based audio player using SpeechSynthesis
let speechWords = [];
let speechWordIndex = 0;
let speechUtteranceAudio = null;
let speechPlaying = false;
let speechPaused  = false;
let speechTotalWords = 0;

function setupSpeechPlayer(text) {
  speechWords = text.split(/\s+/).filter(w => w.length > 0);
  speechTotalWords = speechWords.length;
  speechWordIndex = 0;
  speechPlaying = false;
  speechPaused  = false;

  // Setup seek bar as word position
  const seek = document.getElementById('audioSeek');
  seek.max = speechTotalWords;
  seek.value = 0;
  document.getElementById('audioCurrentTime').textContent = '0:00';
  document.getElementById('audioDuration').textContent = formatAudioTime(speechTotalWords / 2.5);

  seek.addEventListener('input', () => {
    speechWordIndex = parseInt(seek.value);
    if (speechPlaying) {
      window.speechSynthesis.cancel();
      startSpeechFrom(speechWordIndex);
    }
  });

  document.getElementById('audioVolume').addEventListener('input', e => {
    if (speechUtteranceAudio) speechUtteranceAudio.volume = parseFloat(e.target.value);
  });

  // Enable download button — generates a text file as fallback
  audioBlob = new Blob([speechWords.join(' ')], { type: 'text/plain' });
  audioObjectUrl = URL.createObjectURL(audioBlob);
}

function toggleAudioPlay() {
  if (!speechPlaying && !speechPaused) {
    startSpeechFrom(speechWordIndex);
  } else if (speechPlaying && !speechPaused) {
    window.speechSynthesis.pause();
    speechPaused = true;
    speechPlaying = false;
    document.getElementById('btnAudioPlay').textContent = '▶';
  } else if (speechPaused) {
    window.speechSynthesis.resume();
    speechPaused = false;
    speechPlaying = true;
    document.getElementById('btnAudioPlay').textContent = '⏸';
  }
}

function startSpeechFrom(idx) {
  window.speechSynthesis.cancel();
  const text = speechWords.slice(idx).join(' ');
  speechUtteranceAudio = new SpeechSynthesisUtterance(text);

  const speed = parseFloat(document.getElementById('audioSpeed').value);
  const vol   = parseFloat(document.getElementById('audioVolume').value);
  speechUtteranceAudio.rate   = speed;
  speechUtteranceAudio.volume = vol;
  speechUtteranceAudio.pitch  = 1.0;

  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.includes('Google') || v.lang === 'en-US');
  if (preferred) speechUtteranceAudio.voice = preferred;

  let wordCount = idx;
  speechUtteranceAudio.onboundary = (e) => {
    if (e.name === 'word') {
      wordCount++;
      speechWordIndex = wordCount;
      const seek = document.getElementById('audioSeek');
      seek.value = wordCount;
      document.getElementById('audioCurrentTime').textContent = formatAudioTime(wordCount / 2.5);
    }
  };

  speechUtteranceAudio.onend = () => {
    speechPlaying = false;
    speechWordIndex = 0;
    document.getElementById('btnAudioPlay').textContent = '▶';
    document.getElementById('audioSeek').value = 0;
    document.getElementById('audioCurrentTime').textContent = '0:00';
  };

  window.speechSynthesis.speak(speechUtteranceAudio);
  speechPlaying = true;
  speechPaused  = false;
  document.getElementById('btnAudioPlay').textContent = '⏸';
}

function audioStop() {
  window.speechSynthesis.cancel();
  speechPlaying = false;
  speechPaused  = false;
  speechWordIndex = 0;
  document.getElementById('btnAudioPlay').textContent = '▶';
  document.getElementById('audioSeek').value = 0;
  document.getElementById('audioCurrentTime').textContent = '0:00';
}

function audioForward() {
  speechWordIndex = Math.min(speechWordIndex + 25, speechTotalWords - 1);
  if (speechPlaying) { window.speechSynthesis.cancel(); startSpeechFrom(speechWordIndex); }
  else document.getElementById('audioSeek').value = speechWordIndex;
}

function audioBackward() {
  speechWordIndex = Math.max(speechWordIndex - 25, 0);
  if (speechPlaying) { window.speechSynthesis.cancel(); startSpeechFrom(speechWordIndex); }
  else document.getElementById('audioSeek').value = speechWordIndex;
}

function changeAudioSpeed() {
  const speed = parseFloat(document.getElementById('audioSpeed').value);
  if (speechUtteranceAudio) speechUtteranceAudio.rate = speed;
  if (speechPlaying) { window.speechSynthesis.cancel(); startSpeechFrom(speechWordIndex); }
}

function downloadAudio() {
  if (!extractedText) { alert('Generate audio first.'); return; }

  const btn = document.getElementById('btnDownloadAudio');
  btn.textContent = '⏳ Recording...';
  btn.disabled = true;

  const text = speechWords.join(' ') || extractedText.slice(0, 8000);
  const utterance = new SpeechSynthesisUtterance(text);
  const speed = parseFloat(document.getElementById('audioSpeed').value);
  utterance.rate = speed;
  utterance.pitch = 1.0;

  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => v.name.includes('Google') || v.lang === 'en-US');
  if (preferred) utterance.voice = preferred;

  // Create AudioContext to capture system audio
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = audioCtx.createMediaStreamDestination();
  const mediaRecorder = new MediaRecorder(dest.stream);
  const chunks = [];

  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'cognitive-curator-audio.webm';
    a.click();
    URL.revokeObjectURL(url);
    btn.textContent = '⬇ MP3';
    btn.disabled = false;
  };

  // Unfortunately browsers don't allow capturing speechSynthesis directly.
  // Best free alternative: use ResponsiveVoice or record via oscillator trick.
  // Practical solution: use fetch to Google TTS for short texts, else use blob of text.

  // For actual downloadable audio, use the backend TTS approach:
  fetchAndDownloadAudio(text, btn);
}

async function fetchAndDownloadAudio(text, btn) {
  try {
    btn.textContent = '⏳ Downloading...';
    const res = await fetch(`${API}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 6000) })
    });

    if (!res.ok) throw new Error('Server error ' + res.status);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'cognitive-curator-audio.mp3';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('Audio download error:', err);
    alert('Audio download failed: ' + err.message);
  } finally {
    btn.textContent = '⬇ MP3';
    btn.disabled = false;
  }
}

function formatAudioTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}

// ── READING PROGRESS TRACKER ──────────────────────────────────────────────────
let currentPDFName = '';
let savedResumePage = null;

function getProgressKey(name) {
  return 'cc_progress_' + name.replace(/\s+/g, '_');
}

function saveProgress() {
  if (!pdfDoc || !currentPDFName) return;
  const data = { page: currentPage, total: pdfDoc.numPages, ts: Date.now() };
  localStorage.setItem(getProgressKey(currentPDFName), JSON.stringify(data));
  updateProgressBar();
}

function updateProgressBar() {
  if (!pdfDoc) return;
  const pct = Math.round((currentPage / pdfDoc.numPages) * 100);
  const fill = document.getElementById('progressFill');
  const text = document.getElementById('progressText');
  const wrap = document.getElementById('progressWrap');
  if (!fill) return;
  wrap.style.display = 'block';
  fill.style.width = pct + '%';
  text.textContent = `Progress: ${pct}% completed  (Page ${currentPage} of ${pdfDoc.numPages})`;
}

function checkResume(fileName) {
  const saved = localStorage.getItem(getProgressKey(fileName));
  if (!saved) return;
  const data = JSON.parse(saved);
  if (!data.page || data.page <= 1) return;
  savedResumePage = data.page;
  document.getElementById('resumeMsg').textContent =
    `You were on page ${data.page} of ${data.total}. Continue from where you left off?`;
  document.getElementById('resumeModal').classList.remove('hidden');
}

function resumeReading() {
  document.getElementById('resumeModal').classList.add('hidden');
  if (savedResumePage && pdfDoc) {
    currentPage = savedResumePage;
    renderPage(currentPage);
  }
  savedResumePage = null;
}

function startOver() {
  document.getElementById('resumeModal').classList.add('hidden');
  currentPage = 1;
  renderPage(1);
  if (currentPDFName) localStorage.removeItem(getProgressKey(currentPDFName));
  savedResumePage = null;
}

function resetProgress() {
  if (currentPDFName) localStorage.removeItem(getProgressKey(currentPDFName));
  currentPage = 1;
  renderPage(1);
  updateProgressBar();
}

// ── DISTRACTION ALERT ─────────────────────────────────────────────────────────
let focusAlertEnabled = true;
let distractionShowing = false;

// Soft beep using Web Audio API
function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 520;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.6);
  } catch (_) {}
}

document.addEventListener('visibilitychange', () => {
  if (!focusAlertEnabled) return;
  if (document.hidden && !distractionShowing) {
    // User left — mark it, play beep
    distractionShowing = true;
    playBeep();
  } else if (!document.hidden && distractionShowing) {
    // User returned — NOW show the popup (they can see it)
    showDistractionAlert();
  }
});

function showDistractionAlert() {
  const modal = document.getElementById('distractionModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  playBeep();
}

function resumeFocus() {
  document.getElementById('distractionModal').classList.add('hidden');
  distractionShowing = false;
}

function toggleFocusAlert() {
  focusAlertEnabled = !focusAlertEnabled;
  const btn = document.getElementById('btnFocusToggle');
  if (focusAlertEnabled) {
    btn.textContent = '🎯 Focus: ON';
    btn.classList.remove('off');
  } else {
    btn.textContent = '🎯 Focus: OFF';
    btn.classList.add('off');
    // Hide modal if showing
    document.getElementById('distractionModal').classList.add('hidden');
    distractionShowing = false;
  }
}

// ── LIBRARY ───────────────────────────────────────────────────────────────────
let currentPDFLibraryId = null;

async function savePDFToLibrary(file) {
  try {
    const formData = new FormData();
    formData.append('pdf', file);
    const res = await fetch(`${API}/library/save-pdf`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('cc_token') },
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      currentPDFLibraryId = data.pdf.id;
      console.log('✅ PDF saved to library, id:', data.pdf.id);
    } else {
      console.error('Library save error:', data.error);
    }
  } catch (e) {
    console.error('Library save failed:', e.message);
  }
}

async function saveNotesToLibrary() {
  if (!aiNotes) { alert('Generate notes first.'); return; }
  const title = prompt('Enter a title for these notes:', 'AI Notes - ' + new Date().toLocaleDateString());
  if (!title) return;
  try {
    const res = await fetch(`${API}/library/save-notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content: aiNotes, pdfId: currentPDFLibraryId })
    });
    const data = await res.json();
    if (data.success) showStatus('Notes saved to your library!', 'success');
    else showStatus('Failed to save notes', 'error');
  } catch (e) { showStatus('Save failed: ' + e.message, 'error'); }
}

// Load PDF from library if redirected from library page
window.addEventListener('load', () => {
  const libText = localStorage.getItem('cc_load_pdf_text');
  const libName = localStorage.getItem('cc_load_pdf_name');
  const libId   = localStorage.getItem('cc_load_pdf_id');
  if (libText && libName) {
    extractedText = libText;
    currentPDFLibraryId = libId ? parseInt(libId) : null;
    document.getElementById('mainLayout').style.display = 'flex';
    setupReadingText(extractedText);
    showStatus(`Loaded "${libName}" from your library`, 'success');
    localStorage.removeItem('cc_load_pdf_text');
    localStorage.removeItem('cc_load_pdf_name');
    localStorage.removeItem('cc_load_pdf_id');
  }
});

// ── Q&A GENERATOR ─────────────────────────────────────────────────────────────
let qaContent = '';

async function generateQA(marks) {
  if (!extractedText) { alert('Please upload a PDF first.'); return; }
  const loader = document.getElementById('qaLoader');
  const output = document.getElementById('qaOutput');
  document.getElementById('qaLoaderMsg').textContent = `Generating ${marks}-mark Q&A with Groq...`;
  loader.classList.remove('hidden');
  output.style.display = 'none';

  try {
    const res = await fetch(`${API}/qa-generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: extractedText, marks })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    qaContent = data.result;
    output.textContent = data.result;
    output.style.display = 'block';
    document.getElementById('btnClearQA').style.display = 'inline-flex';
    document.getElementById('btnDlQA').style.display = 'inline-flex';
  } catch (err) {
    output.textContent = 'Error: ' + err.message;
    output.style.display = 'block';
  } finally {
    loader.classList.add('hidden');
  }
}

function clearQA() {
  document.getElementById('qaOutput').style.display = 'none';
  document.getElementById('qaOutput').textContent = '';
  document.getElementById('btnClearQA').style.display = 'none';
  document.getElementById('btnDlQA').style.display = 'none';
  qaContent = '';
}

function downloadQA() {
  if (!qaContent) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFontSize(14); doc.setTextColor(108, 99, 255);
  doc.text('Q&A — Cognitive Curator', 15, 15);
  doc.setFontSize(10); doc.setTextColor(30, 30, 30);
  const lines = doc.splitTextToSize(qaContent, 180);
  let y = 25;
  lines.forEach(l => { if (y > 275) { doc.addPage(); y = 15; } doc.text(l, 15, y); y += 6; });
  doc.save('qa-questions.pdf');
}

// ── PDF PROOFREADER ───────────────────────────────────────────────────────────
function clearProofread() {
  document.getElementById('proofreadResults').innerHTML = '';
  document.getElementById('proofreadResults').classList.add('hidden');
  document.getElementById('btnClearProof').style.display = 'none';
  document.getElementById('btnDownloadCorrected').style.display = 'none';
  window._proofMistakes = null;
}

async function proofreadPDF() {
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const loader  = document.getElementById('proofreadLoader');
  const results = document.getElementById('proofreadResults');
  const btn     = document.getElementById('btnProofread');

  loader.classList.remove('hidden');
  results.classList.add('hidden');
  results.innerHTML = '';
  btn.disabled = true;

  try {
    const res = await fetch(`${API}/proofread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: extractedText })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const mistakes = data.mistakes;
    results.classList.remove('hidden');

    if (!mistakes || mistakes.length === 0) {
      results.innerHTML = `<div class="proof-no-mistakes">✅ No mistakes found! Your PDF looks clean.</div>`;
      document.getElementById('btnClearProof').style.display = 'inline-flex';
      return;
    }

    // Count by type
    const counts = { spelling: 0, grammar: 0, punctuation: 0, content: 0 };
    mistakes.forEach(m => { if (counts[m.type] !== undefined) counts[m.type]++; });

    // Summary badges
    const icons = { spelling: '🔤', grammar: '📝', punctuation: '❗', content: '💡' };
    let html = `<div class="proofread-summary">`;
    Object.entries(counts).forEach(([type, count]) => {
      if (count > 0) html += `<span class="proof-badge ${type}">${icons[type]} ${count} ${type}</span>`;
    });
    html += `<span class="proof-badge" style="background:rgba(148,163,184,0.1);color:#94a3b8;border:1px solid #2d2d5e">
      Total: ${mistakes.length} issue${mistakes.length > 1 ? 's' : ''}
    </span></div>`;

    // Each mistake card
    mistakes.forEach((m, i) => {
      const type = m.type || 'grammar';
      html += `
        <div class="proof-item ${type}">
          <div class="proof-item-header">
            <span class="proof-type-tag">${type}</span>
            <span style="font-size:0.8rem;color:var(--text-muted)">#${i + 1}</span>
          </div>
          <div class="proof-original">❌ "${m.original}"</div>
          <div class="proof-suggestion">✅ "${m.suggestion}"</div>
          <div class="proof-explanation">💬 ${m.explanation}</div>
        </div>`;
    });

    results.innerHTML = html;
    document.getElementById('btnClearProof').style.display = 'inline-flex';
    document.getElementById('btnDownloadCorrected').style.display = 'inline-flex';
    // Store mistakes for download
    window._proofMistakes = mistakes;
  } catch (err) {
    results.classList.remove('hidden');
    results.innerHTML = `<p style="color:#f87171">Error: ${err.message}</p>`;
  } finally {
    loader.classList.add('hidden');
    btn.disabled = false;
  }
}

// ── DOWNLOAD CORRECTED PDF ────────────────────────────────────────────────────
function downloadCorrectedPDF() {
  const mistakes = window._proofMistakes;
  if (!mistakes || !extractedText) { alert('Run proofreader first.'); return; }

  // Apply all corrections to the text
  let correctedText = extractedText;
  mistakes.forEach(m => {
    if (m.original && m.suggestion) {
      // Replace all occurrences (case-sensitive)
      correctedText = correctedText.split(m.original).join(m.suggestion);
    }
  });

  // Generate PDF using jsPDF
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const margin    = 15;
  const pageW     = doc.internal.pageSize.getWidth();
  const pageH     = doc.internal.pageSize.getHeight();
  const maxWidth  = pageW - margin * 2;
  let y = 20;

  // Header
  doc.setFontSize(16);
  doc.setTextColor(108, 99, 255);
  doc.text('Corrected Document', margin, y);
  y += 6;

  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  doc.text(`Corrected by Cognitive Curator AI — ${new Date().toLocaleDateString()} | ${mistakes.length} mistake(s) fixed`, margin, y);
  y += 4;

  doc.setDrawColor(108, 99, 255);
  doc.line(margin, y, pageW - margin, y);
  y += 8;

  // Corrected content
  doc.setFontSize(11);
  doc.setTextColor(30, 30, 30);

  const lines = doc.splitTextToSize(correctedText, maxWidth);
  lines.forEach(line => {
    if (y > pageH - 15) {
      doc.addPage();
      y = 15;
    }
    doc.text(line, margin, y);
    y += 5.5;
  });

  // Footer on last page
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text('Generated by Cognitive Curator — AI PDF Reader', margin, pageH - 8);

  doc.save('corrected-document.pdf');
}

// ── ASK FROM PDF CHATBOT ──────────────────────────────────────────────────────
async function askFromPDF() {
  const question = document.getElementById('chatInput').value.trim();
  if (!question) { alert('Please type a question first.'); return; }
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const messages = document.getElementById('chatMessages');
  const btn = document.getElementById('askBtn');

  // Show user message
  messages.innerHTML += `<div class="chat-msg user-msg">🧑 ${question}</div>`;
  document.getElementById('chatInput').value = '';
  btn.disabled = true;
  document.getElementById('btnResetChat').style.display = 'inline-flex';

  // Show thinking indicator
  const thinkId = 'think-' + Date.now();
  messages.innerHTML += `<div class="chat-msg bot-msg thinking" id="${thinkId}">🤖 Thinking...</div>`;
  messages.scrollTop = messages.scrollHeight;

  try {
    const res = await fetch(`${API}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, pdfText: extractedText })
    });
    const data = await res.json();
    const answer = data.error ? '❌ ' + data.error : data.answer;
    document.getElementById(thinkId).outerHTML =
      `<div class="chat-msg bot-msg">🤖 ${answer}</div>`;
  } catch {
    document.getElementById(thinkId).outerHTML =
      `<div class="chat-msg bot-msg error-msg">❌ Error occurred. Check server.</div>`;
  } finally {
    btn.disabled = false;
    messages.scrollTop = messages.scrollHeight;
  }
}

// Allow Enter key to send
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('chatInput');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') askFromPDF(); });
});

// ── VISUAL LEARNING MODE ──────────────────────────────────────────────────────
let currentVisualType = '';
let visualZoom = 1.0;

async function generateVisualization(type) {
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const topic      = document.getElementById('visualTopicInput').value.trim();
  currentVisualType = type;

  const loader     = document.getElementById('visualLoader');
  const loaderText = document.getElementById('visualLoaderText');
  const svg        = document.getElementById('visualSVG');
  const zoomRow    = document.getElementById('visualZoomRow');

  const label = topic ? `"${topic}"` : 'full PDF';
  loaderText.textContent = type === 'mindmap'
    ? `Generating Mind Map for ${label}...`
    : `Generating Flowchart for ${label}...`;

  loader.classList.remove('hidden');
  svg.innerHTML = '';
  zoomRow.style.display = 'none';
  document.getElementById('btnRegenerate').style.display = 'none';
  document.getElementById('btnDownloadVisual').style.display = 'none';
  document.getElementById('btnClearVisual').style.display = 'none';

  try {
    const res = await fetch(`${API}/visualize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: extractedText, type, topic })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    visualZoom = 1.0;
    document.getElementById('zoomPct').textContent = '100%';

    if (type === 'mindmap') renderMindMap(data.data);
    else renderFlowchart(data.data);

    zoomRow.style.display = 'flex';
    document.getElementById('btnRegenerate').style.display = 'inline-flex';
    document.getElementById('btnDownloadVisual').style.display = 'inline-flex';
    document.getElementById('btnClearVisual').style.display = 'inline-flex';
  } catch (err) {
    svg.innerHTML = `<text x="20" y="40" fill="#f87171" font-size="14">Error: ${err.message}</text>`;
  } finally {
    loader.classList.add('hidden');
  }
}

function renderMindMap(data) {
  const svg      = document.getElementById('visualSVG');
  const children = data.children || [];

  // ── Fixed node sizes ──
  const NODE_W   = 160;  // fixed width for all nodes
  const NODE_H   = 44;   // fixed height
  const SUB_W    = 140;
  const SUB_H    = 36;
  const CENTER_W = 180;
  const CENTER_H = 52;

  // ── Vertical spacing ──
  const ROW_GAP  = 80;   // gap between rows of sub-children
  const COL_GAP  = 60;   // horizontal gap between columns

  // ── Calculate total height needed ──
  // Each child branch needs: max(1, subs.length) * (SUB_H + ROW_GAP)
  const branchHeights = children.map(c => {
    const subs = c.children || [];
    return Math.max(NODE_H + ROW_GAP, subs.length * (SUB_H + ROW_GAP));
  });
  const totalH = Math.max(600, branchHeights.reduce((a, b) => a + b, 0) + 100);

  // ── Column X positions ──
  const colCenter = 80 + CENTER_W / 2;
  const colChild  = colCenter + CENTER_W / 2 + COL_GAP + NODE_W / 2;
  const colSub    = colChild  + NODE_W / 2   + COL_GAP + SUB_W / 2;
  const W         = colSub + SUB_W / 2 + 40;

  svg.setAttribute('viewBox', `0 0 ${W} ${totalH}`);
  svg.setAttribute('width',  W);
  svg.setAttribute('height', totalH);
  svg.innerHTML = '';

  const lineLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.appendChild(lineLayer);

  // ── Center node Y = middle of total height ──
  const centerY = totalH / 2;
  let currentY  = 50;

  children.forEach((child, i) => {
    const subs      = child.children || [];
    const branchH   = branchHeights[i];
    const childY    = currentY + branchH / 2;

    // Draw child node
    drawMMRect(svg, colChild, childY, NODE_W, NODE_H, child.topic, child.color || '#a78bfa', 13);

    // Line: center → child
    drawHLine(lineLayer, colCenter + CENTER_W/2, centerY, colChild - NODE_W/2, childY, child.color || '#a78bfa');

    // Sub-children stacked vertically
    const subTotalH = subs.length * (SUB_H + ROW_GAP) - ROW_GAP;
    const subStartY = childY - subTotalH / 2;

    subs.forEach((sub, j) => {
      const subY = subStartY + j * (SUB_H + ROW_GAP);
      drawMMRect(svg, colSub, subY, SUB_W, SUB_H, sub.topic, sub.color || '#38bdf8', 11);
      drawHLine(lineLayer, colChild + NODE_W/2, childY, colSub - SUB_W/2, subY, sub.color || '#38bdf8');
    });

    currentY += branchH;
  });

  // Center node drawn last (on top)
  drawMMRect(svg, colCenter, centerY, CENTER_W, CENTER_H, data.topic, data.color || '#6c63ff', 15, true);
}

function drawMMRect(svg, cx, cy, w, h, label, color, fontSize, isCenter = false) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'mm-node');

  // Shadow
  const sh = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  sh.setAttribute('x', cx - w/2 + 3); sh.setAttribute('y', cy - h/2 + 3);
  sh.setAttribute('width', w); sh.setAttribute('height', h);
  sh.setAttribute('rx', 10); sh.setAttribute('fill', 'rgba(0,0,0,0.3)');
  g.appendChild(sh);

  // Box
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', cx - w/2); rect.setAttribute('y', cy - h/2);
  rect.setAttribute('width', w); rect.setAttribute('height', h);
  rect.setAttribute('rx', 10); rect.setAttribute('fill', color);
  if (isCenter) { rect.setAttribute('stroke', 'rgba(255,255,255,0.4)'); rect.setAttribute('stroke-width', '2'); }
  g.appendChild(rect);

  // Text — single line, truncated to fit
  const maxChars = Math.floor(w / (fontSize * 0.58));
  const display  = label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label;

  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', cx); t.setAttribute('y', cy + fontSize * 0.38);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('font-size', fontSize);
  t.setAttribute('fill', '#fff');
  t.setAttribute('font-weight', isCenter ? '800' : '600');
  t.setAttribute('font-family', 'Segoe UI, sans-serif');
  t.textContent = display;
  g.appendChild(t);

  svg.appendChild(g);
}

function drawHLine(parent, x1, y1, x2, y2, color) {
  const mx = (x1 + x2) / 2;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '2');
  path.setAttribute('opacity', '0.6');
  parent.appendChild(path);
}

function drawCurvedLine(parent, x1, y1, x2, y2, color) {
  drawHLine(parent, x1, y1, x2, y2, color);
}

function drawMMNode(svg, x, y, label, color, isCenter, isSmall) {
  const w = isCenter ? 180 : isSmall ? 140 : 160;
  const h = isCenter ? 52  : isSmall ? 36  : 44;
  drawMMRect(svg, x, y, w, h, label, color, isCenter ? 15 : isSmall ? 11 : 13, isCenter);
}

function drawMMLine(svg, x1, y1, x2, y2, color) {
  drawHLine(svg, x1, y1, x2, y2, color);
}

function renderFlowchart(steps) {
  const svg = document.getElementById('visualSVG');
  const W = 500;
  const boxH = 50, gap = 70, startY = 40;
  const totalH = steps.length * (boxH + gap) + 60;

  svg.setAttribute('viewBox', `0 0 ${W} ${totalH}`);
  svg.setAttribute('width', W);
  svg.setAttribute('height', totalH);

  svg.innerHTML = `<defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="#64748b"/>
    </marker>
  </defs>`;

  steps.forEach((s, i) => {
    const cx = W / 2;
    const cy = startY + i * (boxH + gap) + boxH / 2;
    const color = s.color || '#6c63ff';

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'fc-node');

    if (s.type === 'terminal') {
      // Oval
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      el.setAttribute('cx', cx); el.setAttribute('cy', cy);
      el.setAttribute('rx', 90); el.setAttribute('ry', 24);
      el.setAttribute('fill', color);
      g.appendChild(el);
    } else if (s.type === 'decision') {
      // Diamond
      const pts = `${cx},${cy-26} ${cx+100},${cy} ${cx},${cy+26} ${cx-100},${cy}`;
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      el.setAttribute('points', pts);
      el.setAttribute('fill', color);
      g.appendChild(el);
    } else {
      // Rectangle
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      el.setAttribute('x', cx - 110); el.setAttribute('y', cy - 24);
      el.setAttribute('width', 220); el.setAttribute('height', 48);
      el.setAttribute('rx', 8); el.setAttribute('fill', color);
      g.appendChild(el);
    }

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', cx); text.setAttribute('y', cy + 5);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '12');
    text.setAttribute('fill', '#fff');
    text.setAttribute('font-weight', '600');
    text.textContent = s.step.length > 28 ? s.step.slice(0, 28) + '…' : s.step;
    g.appendChild(text);
    svg.appendChild(g);

    // Arrow to next
    if (i < steps.length - 1) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', cx); line.setAttribute('y1', cy + 26);
      line.setAttribute('x2', cx); line.setAttribute('y2', cy + gap + 18);
      line.setAttribute('stroke', '#64748b');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('marker-end', 'url(#arrowhead)');
      svg.appendChild(line);
    }
  });
}

function zoomVisual(delta) {
  visualZoom = Math.min(3, Math.max(0.3, parseFloat((visualZoom + delta).toFixed(1))));
  document.getElementById('visualSVG').style.transform = `scale(${visualZoom})`;
  document.getElementById('zoomPct').textContent = Math.round(visualZoom * 100) + '%';
}

function resetZoomVisual() {
  visualZoom = 1.0;
  document.getElementById('visualSVG').style.transform = 'scale(1)';
  document.getElementById('zoomPct').textContent = '100%';
}

function regenerateVisual() { generateVisualization(currentVisualType); }

function clearVisual() {
  document.getElementById('visualSVG').innerHTML = '';
  document.getElementById('visualZoomRow').style.display = 'none';
  document.getElementById('btnRegenerate').style.display = 'none';
  document.getElementById('btnDownloadVisual').style.display = 'none';
  document.getElementById('btnClearVisual').style.display = 'none';
  currentVisualType = '';
}

function downloadVisual() {
  const svg = document.getElementById('visualSVG');
  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(svg);
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `cognitive-curator-${currentVisualType}.svg`;
  a.click();
}

// ── RAG DEEP CHAT ─────────────────────────────────────────────────────────────
async function askRAG() {
  const question = document.getElementById('ragInput').value.trim();
  if (!question) { alert('Please type a question.'); return; }
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const messages = document.getElementById('ragMessages');
  const btn      = document.getElementById('ragBtn');
  const info     = document.getElementById('ragInfo');

  messages.innerHTML += `<div class="chat-msg user-msg">🧑 ${question}</div>`;
  document.getElementById('ragInput').value = '';
  btn.disabled = true;
  document.getElementById('btnResetRag').style.display = 'inline-flex';

  const thinkId = 'rag-' + Date.now();
  messages.innerHTML += `<div class="chat-msg bot-msg thinking" id="${thinkId}">🔬 Searching all pages...</div>`;
  messages.scrollTop = messages.scrollHeight;

  try {
    const res = await fetch(`${API}/rag-ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, pdfText: extractedText })
    });
    const data = await res.json();

    const answer = data.error ? '❌ ' + data.error : data.answer;
    document.getElementById(thinkId).outerHTML =
      `<div class="chat-msg bot-msg">🔬 ${answer}</div>`;

    if (data.totalChunks) {
      info.textContent = `✅ Searched ${data.totalChunks} chunks • Used top ${data.chunksUsed} relevant sections • Model: ${data.model}`;
      info.classList.remove('hidden');
    }
  } catch (err) {
    document.getElementById(thinkId).outerHTML =
      `<div class="chat-msg bot-msg error-msg">❌ ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    messages.scrollTop = messages.scrollHeight;
  }
}

function resetRAG() {
  document.getElementById('ragMessages').innerHTML = '';
  document.getElementById('ragInput').value = '';
  document.getElementById('ragInfo').classList.add('hidden');
  document.getElementById('btnResetRag').style.display = 'none';
}

// ── VOICE INPUT (Web Speech API — free, no API key needed) ────────────────────
function startVoiceInput(inputId, btnId, onResult, barId) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showVoiceError(inputId, 'Voice not supported. Use Chrome or Edge.');
    return;
  }

  const btn      = document.getElementById(btnId);
  const stopBtn  = document.getElementById(btnId + 'Stop');
  const input    = document.getElementById(inputId);
  const statusEl = document.getElementById(barId ? barId.replace('vcb','vs') : null);
  const langSel  = document.getElementById(barId ? 'lang' + barId.replace('vcb','') : null);

  // If already listening, stop
  if (btn.classList.contains('listening')) {
    btn._recognition && btn._recognition.stop();
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = langSel ? langSel.value : 'en-US';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  btn._recognition = recognition;

  // UI: listening state
  btn.classList.add('listening');
  btn.textContent = '🔴 Listening...';
  if (stopBtn) stopBtn.classList.remove('hidden');
  if (statusEl) { statusEl.textContent = 'Listening...'; statusEl.className = 'voice-status active'; }
  input.placeholder = '🎤 Speak now...';
  input.value = '';

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    input.value = transcript;
    if (statusEl) statusEl.textContent = `"${transcript.slice(0, 30)}..."`;
  };

  recognition.onend = () => {
    btn.classList.remove('listening');
    btn.textContent = '🎤 Speak';
    if (stopBtn) stopBtn.classList.add('hidden');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'voice-status'; }
    input.placeholder = inputId === 'topicSearchInput'
      ? 'Enter topic or use 🎤 voice...'
      : 'Enter topic or use 🎤 voice...';
    if (input.value.trim().length > 1) setTimeout(() => onResult(), 300);
  };

  recognition.onerror = (e) => {
    btn.classList.remove('listening');
    btn.textContent = '🎤 Speak';
    if (stopBtn) stopBtn.classList.add('hidden');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'voice-status'; }
    if (e.error === 'not-allowed') {
      showVoiceError(inputId, '🚫 Microphone blocked. Allow mic in browser settings.');
    } else if (e.error === 'network') {
      showVoiceError(inputId, '⚠️ Network error. Open https://localhost:3443 for mic support.');
    } else if (e.error !== 'no-speech') {
      showVoiceError(inputId, 'Voice error: ' + e.error);
    }
  };

  try { recognition.start(); }
  catch (e) {
    btn.classList.remove('listening');
    btn.textContent = '🎤 Speak';
    showVoiceError(inputId, 'Could not start mic: ' + e.message);
  }
}

function stopVoiceInput(btnId, barId) {
  const btn = document.getElementById(btnId);
  if (btn && btn._recognition) {
    btn._recognition.stop();
  }
}

function showVoiceError(inputId, msg) {
  const input = document.getElementById(inputId);
  const existing = input.parentElement.parentElement.querySelector('.voice-error-msg');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'voice-error-msg';
  el.textContent = msg;
  input.parentElement.parentElement.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ── AI EXPLANATION MODE ───────────────────────────────────────────────────────
async function simplifyText(mode) {
  if (!extractedText || extractedText.length < 10) {
    alert('Please upload a PDF first.');
    return;
  }

  const loader = document.getElementById('simplifyLoader');
  const output = document.getElementById('simplifyOutput');

  loader.classList.remove('hidden');
  output.classList.add('hidden');

  try {
    const res = await fetch(`${API}/simplify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: extractedText, mode })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const badgeLabel = mode === 'easy' ? '🧒 Simple Explanation' : '🎓 Advanced Explanation';
    const badgeClass = mode === 'easy' ? 'easy' : 'advanced';

    output.innerHTML = `
      <span class="simplify-mode-badge ${badgeClass}">${badgeLabel}</span>
      <div>${data.result}</div>
    `;
    output.classList.remove('hidden');
    output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    document.getElementById('btnResetExplain').style.display = 'inline-flex';
  } catch (err) {
    output.innerHTML = `<span style="color:#f87171">Error: ${err.message}</span>`;
    output.classList.remove('hidden');
  } finally {
    loader.classList.add('hidden');
  }
}

// ── AI QUIZ ───────────────────────────────────────────────────────────────────
let quizQuestions = [];
let userAnswers = {};

async function generateQuiz() {
  if (!extractedText) { alert('Please upload a PDF first.'); return; }

  const count = document.getElementById('quizCount').value;
  const loader = document.getElementById('quizLoader');
  const container = document.getElementById('quizContainer');
  const result = document.getElementById('quizResult');

  loader.classList.remove('hidden');
  container.classList.add('hidden');
  result.classList.add('hidden');
  container.innerHTML = '';
  userAnswers = {};

  try {
    const res = await fetch(`${API}/quiz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: extractedText, count })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    quizQuestions = data.questions;
    renderQuiz(quizQuestions);
    container.classList.remove('hidden');
    document.getElementById('btnResetQuiz').style.display = 'inline-flex';
  } catch (err) {
    alert('Quiz generation failed: ' + err.message);
  } finally {
    loader.classList.add('hidden');
  }
}

function renderQuiz(questions) {
  const container = document.getElementById('quizContainer');
  container.innerHTML = '';

  questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'quiz-q-card';
    card.id = `q-card-${idx}`;

    const letters = ['A', 'B', 'C', 'D'];
    const optionsHTML = q.options.map((opt, oi) => {
      const letter = letters[oi];
      const text = opt.replace(/^[A-D]\)\s*/i, '');
      return `<button class="quiz-option" id="opt-${idx}-${letter}"
        onclick="selectAnswer(${idx}, '${letter}')">
        <span class="quiz-option-letter">${letter}</span>
        <span>${text}</span>
      </button>`;
    }).join('');

    card.innerHTML = `
      <div class="quiz-q-num">Question ${idx + 1} of ${questions.length}</div>
      <div class="quiz-q-text">${q.question}</div>
      <div class="quiz-options">${optionsHTML}</div>
      <div class="quiz-explanation" id="exp-${idx}">💡 ${q.explanation}</div>
    `;
    container.appendChild(card);
  });

  // Submit button
  const submitRow = document.createElement('div');
  submitRow.className = 'quiz-submit-row';
  submitRow.innerHTML = `<button class="btn-quiz-submit" onclick="submitQuiz()">📊 Submit & See Results</button>`;
  container.appendChild(submitRow);
}

function selectAnswer(qIdx, letter) {
  // If already answered, ignore
  if (userAnswers[qIdx] !== undefined) return;

  userAnswers[qIdx] = letter;
  const card = document.getElementById(`q-card-${qIdx}`);
  card.classList.add('answered');

  const letters = ['A', 'B', 'C', 'D'];
  letters.forEach(l => {
    const btn = document.getElementById(`opt-${qIdx}-${l}`);
    if (btn) btn.disabled = true;
  });

  const selectedBtn = document.getElementById(`opt-${qIdx}-${letter}`);
  if (selectedBtn) selectedBtn.classList.add('selected');
}

function submitQuiz() {
  const unanswered = quizQuestions.filter((_, i) => userAnswers[i] === undefined);
  if (unanswered.length > 0) {
    if (!confirm(`You have ${unanswered.length} unanswered question(s). Submit anyway?`)) return;
  }

  let correct = 0;
  let wrong = 0;
  let skipped = 0;

  quizQuestions.forEach((q, idx) => {
    const userAns = userAnswers[idx];
    const correctAns = q.answer.toUpperCase();

    if (userAns === undefined) {
      skipped++;
      // Show correct answer for skipped
      const correctBtn = document.getElementById(`opt-${idx}-${correctAns}`);
      if (correctBtn) correctBtn.classList.add('correct');
    } else if (userAns === correctAns) {
      correct++;
      const btn = document.getElementById(`opt-${idx}-${userAns}`);
      if (btn) { btn.classList.remove('selected'); btn.classList.add('correct'); }
    } else {
      wrong++;
      const wrongBtn = document.getElementById(`opt-${idx}-${userAns}`);
      if (wrongBtn) { wrongBtn.classList.remove('selected'); wrongBtn.classList.add('wrong'); }
      const correctBtn = document.getElementById(`opt-${idx}-${correctAns}`);
      if (correctBtn) correctBtn.classList.add('correct');
    }

    // Show explanation for all
    const exp = document.getElementById(`exp-${idx}`);
    if (exp) exp.classList.add('show');

    // Disable all remaining options
    ['A','B','C','D'].forEach(l => {
      const btn = document.getElementById(`opt-${idx}-${l}`);
      if (btn) btn.disabled = true;
    });
  });

  showQuizResult(correct, wrong, skipped);
}

function showQuizResult(correct, wrong, skipped) {
  const total = quizQuestions.length;
  const score = Math.round((correct / total) * 100);
  const result = document.getElementById('quizResult');

  let grade, gradeClass, emoji, message;
  if (score >= 80) {
    grade = 'Excellent!'; gradeClass = 'excellent'; emoji = '🏆';
    message = 'Outstanding performance! You have a strong grasp of this topic.';
  } else if (score >= 60) {
    grade = 'Good'; gradeClass = 'good'; emoji = '👍';
    message = 'Good job! Review the questions you missed to strengthen your knowledge.';
  } else if (score >= 40) {
    grade = 'Average'; gradeClass = 'average'; emoji = '📚';
    message = 'Keep studying! Re-read the PDF and try again.';
  } else {
    grade = 'Needs Work'; gradeClass = 'poor'; emoji = '💪';
    message = 'Don\'t give up! Go through the material again carefully.';
  }

  result.innerHTML = `
    <div class="quiz-score-circle ${gradeClass}">
      <span>${score}%</span>
      <span class="quiz-score-label">${grade}</span>
    </div>
    <div class="quiz-result-title">${emoji} ${grade}</div>
    <div class="quiz-result-sub">${message}</div>
    <div class="quiz-stats">
      <div class="quiz-stat correct-stat">
        <div class="quiz-stat-val">${correct}</div>
        <div class="quiz-stat-lbl">✅ Correct</div>
      </div>
      <div class="quiz-stat wrong-stat">
        <div class="quiz-stat-val">${wrong}</div>
        <div class="quiz-stat-lbl">❌ Wrong</div>
      </div>
      <div class="quiz-stat">
        <div class="quiz-stat-val">${skipped}</div>
        <div class="quiz-stat-lbl">⏭ Skipped</div>
      </div>
      <div class="quiz-stat score-stat">
        <div class="quiz-stat-val">${correct}/${total}</div>
        <div class="quiz-stat-lbl">📊 Score</div>
      </div>
    </div>
    <button class="btn-retake" onclick="retakeQuiz()">🔄 Retake Quiz</button>
  `;

  result.classList.remove('hidden');
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function retakeQuiz() {
  userAnswers = {};
  document.getElementById('quizResult').classList.add('hidden');
  generateQuiz();
}

function resetQuiz() {
  userAnswers = {};
  quizQuestions = [];
  document.getElementById('quizContainer').innerHTML = '';
  document.getElementById('quizContainer').classList.add('hidden');
  document.getElementById('quizResult').classList.add('hidden');
  document.getElementById('btnResetQuiz').style.display = 'none';
}

function resetExplain() {
  document.getElementById('simplifyOutput').innerHTML = '';
  document.getElementById('simplifyOutput').classList.add('hidden');
  document.getElementById('btnResetExplain').style.display = 'none';
}

function resetChat() {
  document.getElementById('chatMessages').innerHTML = '';
  document.getElementById('chatInput').value = '';
  document.getElementById('btnResetChat').style.display = 'none';
}

// ── PDF TEXT SEARCH & HIGHLIGHT ───────────────────────────────────────────────
let searchMatches = [];
let searchQuery = '';
let currentMatchIndex = 0;

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('pdfSearchInput');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') searchInPDF(); });
});

async function searchInPDF() {
  const query = document.getElementById('pdfSearchInput').value.trim();
  if (!query) return;
  if (!pdfDoc) { alert('Please upload a PDF first.'); return; }

  searchQuery = query.toLowerCase();
  searchMatches = [];
  currentMatchIndex = 0;

  const status = document.getElementById('pdfSearchStatus');
  const scanFrom = pageRangeFrom || 1;
  const scanTo   = pageRangeTo   || pdfDoc.numPages;
  const total    = scanTo - scanFrom + 1;

  status.textContent = `Searching page 1 of ${total}...`;
  status.className = 'pdf-search-status';

  for (let p = scanFrom; p <= scanTo; p++) {
    // Update progress for large PDFs
    if (p % 10 === 0 || p === scanFrom) {
      status.textContent = `Searching page ${p - scanFrom + 1} of ${total}...`;
      // Yield to browser so UI doesn't freeze
      await new Promise(r => setTimeout(r, 0));
    }

    const page   = await pdfDoc.getPage(p);
    const content = await page.getTextContent();
    const items  = content.items.filter(i => i.str);

    // ── Join all items into full page text with char→item map ──
    let fullText = '';
    const charMap = []; // charMap[charIndex] = { itemIdx, charInItem }

    for (let ii = 0; ii < items.length; ii++) {
      const str = items[ii].str;
      for (let ci = 0; ci < str.length; ci++) {
        charMap.push({ itemIdx: ii, charInItem: ci });
        fullText += str[ci];
      }
      // Add space between items if not already spaced
      if (str.length > 0 && !str.endsWith(' ') && ii < items.length - 1) {
        charMap.push({ itemIdx: ii, charInItem: str.length });
        fullText += ' ';
      }
    }

    const lowerFull = fullText.toLowerCase();
    let idx = 0;

    while (true) {
      const f = lowerFull.indexOf(searchQuery, idx);
      if (f === -1) break;

      // Map back to the item that contains the start of the match
      if (f < charMap.length) {
        const map      = charMap[f];
        const item     = items[map.itemIdx];
        const matchStart = map.charInItem;

        searchMatches.push({
          page: p,
          item,
          itemStr:    item.str,
          matchStart,
          matchLen:   searchQuery.length,
          fullText,   // store full page text for context
          fullOffset: f
        });
      }
      idx = f + 1;
    }
  }

  if (!searchMatches.length) {
    status.textContent = `"${query}" not found in ${total} page(s)`;
    status.className = 'pdf-search-status notfound';
    return;
  }

  const matchPages = [...new Set(searchMatches.map(m => m.page))].length;
  status.textContent = `${searchMatches.length} result(s) on ${matchPages} page(s)`;
  status.className = 'pdf-search-status found';
  document.getElementById('btnClearSearch').style.display = 'inline-flex';
  document.getElementById('btnPrevMatch').style.display = 'inline-flex';
  document.getElementById('btnNextMatch').style.display = 'inline-flex';

  currentMatchIndex = 0;
  await jumpToMatch(0);
}

async function jumpToMatch(idx) {
  if (!searchMatches.length) return;
  const match = searchMatches[idx];

  if (currentPage !== match.page) {
    currentPage = match.page;
    await renderPage(currentPage);
  } else {
    highlightTextLayer();
  }

  const status = document.getElementById('pdfSearchStatus');
  status.textContent = `Match ${idx + 1} / ${searchMatches.length} (page ${match.page})`;
  status.className = 'pdf-search-status found';
}

function highlightTextLayer() {
  renderPage(currentPage);
}

function clearHighlights() {
  renderPage(currentPage);
}

async function clearPDFSearch() {
  searchQuery = '';
  searchMatches = [];
  currentMatchIndex = 0;
  document.getElementById('pdfSearchInput').value = '';
  document.getElementById('pdfSearchStatus').textContent = '';
  document.getElementById('pdfSearchStatus').className = 'pdf-search-status';
  document.getElementById('btnClearSearch').style.display = 'none';
  document.getElementById('btnPrevMatch').style.display = 'none';
  document.getElementById('btnNextMatch').style.display = 'none';
  clearHighlights();
}

async function nextMatch() {
  if (!searchMatches.length) return;
  currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
  await jumpToMatch(currentMatchIndex);
}

async function prevMatch() {
  if (!searchMatches.length) return;
  currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
  await jumpToMatch(currentMatchIndex);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function showLoading(msg = 'Processing...') {
  document.getElementById('loadingMsg').textContent = msg;
  document.getElementById('loadingOverlay').classList.remove('hidden');
}
function hideLoading() {
  document.getElementById('loadingOverlay').classList.add('hidden');
}
function showStatus(msg, type) {
  const el = document.getElementById('uploadStatus');
  el.textContent = msg;
  el.className = `status-msg status-${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── WORD LOOKUP SIDEBAR ───────────────────────────────────────────────────────
async function lookupWord(word) {
  // Open sidebar immediately with loader
  const sidebar = document.getElementById('wordSidebar');
  const overlay = document.getElementById('sidebarOverlay');
  const body = document.getElementById('sidebarBody');
  const sidebarWord = document.getElementById('sidebarWord');
  const sidebarPron = document.getElementById('sidebarPronunciation');

  sidebarWord.textContent = word;
  sidebarPron.textContent = '';
  body.innerHTML = '<div class="sidebar-loader"><div class="spinner"></div><span>Looking up "' + word + '"...</span></div>';

  sidebar.classList.add('open');
  overlay.classList.add('show');

  // Speak button
  document.getElementById('btnSpeakWord').onclick = () => {
    const u = new SpeechSynthesisUtterance(word);
    u.rate = 0.85;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };

  try {
    const res = await fetch(`${API}/word-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Update pronunciation
    if (data.pronunciation) sidebarPron.textContent = data.pronunciation;

    // Build sidebar content
    let html = '';

    // Part of speech
    if (data.partOfSpeech) {
      html += `<div class="sb-section">
        <div class="sb-section-title">Part of Speech</div>
        <span class="sb-pos-badge">${data.partOfSpeech}</span>
      </div>`;
    }

    // Definitions
    if (data.definitions?.length) {
      html += `<div class="sb-section">
        <div class="sb-section-title">Definitions</div>
        <ul class="sb-def-list">`;
      data.definitions.forEach((def, i) => {
        html += `<li class="sb-def-item">
          <span class="sb-def-num">${i + 1}</span>
          <span>${def}</span>
        </li>`;
      });
      html += `</ul></div>`;
    }

    // Examples
    if (data.examples?.length) {
      html += `<div class="sb-section">
        <div class="sb-section-title">Examples</div>`;
      data.examples.forEach(ex => {
        html += `<div class="sb-example">"${ex}"</div>`;
      });
      html += `</div>`;
    }

    // AI Explanation
    if (data.aiExplanation) {
      html += `<div class="sb-ai-box">
        <div class="sb-ai-label">🤖 AI Explanation</div>
        <div class="sb-ai-text">${data.aiExplanation}</div>
      </div>`;
    }

    // Synonyms
    if (data.synonyms?.length) {
      html += `<div class="sb-section">
        <div class="sb-section-title">Synonyms</div>
        <div class="sb-synonyms">`;
      data.synonyms.forEach(s => {
        html += `<span class="sb-syn-tag" onclick="lookupWord('${s}')">${s}</span>`;
      });
      html += `</div></div>`;
    }

    body.innerHTML = html || '<p style="color:var(--text-muted);padding:12px">No results found for this word.</p>';

  } catch (err) {
    body.innerHTML = `<div style="color:#f87171;padding:12px">
      <p>Could not look up this word.</p>
      <p style="font-size:0.8rem;margin-top:6px;color:var(--text-muted)">${err.message}</p>
    </div>`;
  }
}

function closeSidebar() {
  document.getElementById('wordSidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
}
