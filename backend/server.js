require('dotenv').config();
const express    = require('express');
const multer     = require('multer');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const http       = require('http');
const pdfParse   = require('pdf-parse');
const OpenAI     = require('openai');
const axios      = require('axios');
const selfsigned = require('selfsigned');
const Groq       = require('groq-sdk');
const { registerUser, loginUser, sendOTP, verifyOTPAndReset, verifyOTPLogin, verifyToken, savePDF, getUserPDFs, getPDFById, deletePDF, saveNotes, getUserNotes, getNoteById, deleteNote, sendOTPByEmail, verifyOTPLoginByEmail } = require('./auth');

// Prevent server from crashing on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection (server kept alive):', reason);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Serve frontend statically ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, password, phone, email } = req.body;
  if (!username || !password || !phone)
    return res.status(400).json({ error: 'All fields required' });
  const result = registerUser(username.trim(), password, phone.trim(), email?.trim());
  res.json(result);
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });
  const result = loginUser(username.trim(), password);
  res.json(result);
});

app.post('/api/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });
  const result = await sendOTP(phone.trim());
  res.json(result);
});

app.post('/api/auth/reset-password', (req, res) => {
  const { phone, code, newPassword } = req.body;
  if (!phone || !code || !newPassword)
    return res.status(400).json({ error: 'All fields required' });
  const result = verifyOTPAndReset(phone.trim(), code.trim(), newPassword);
  res.json(result);
});

// OTP direct login — no password needed
app.post('/api/auth/otp-login', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and OTP required' });
  const result = verifyOTPLogin(phone.trim(), code.trim());
  res.json(result);
});

// ── EMAIL OTP LOGIN ───────────────────────────────────────────────────────────
app.post('/api/auth/send-otp-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const result = await sendOTPByEmail(email.trim().toLowerCase());
  res.json(result);
});

app.post('/api/auth/otp-login-email', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and OTP required' });
  const result = verifyOTPLoginByEmail(email.trim().toLowerCase(), code.trim());
  res.json(result);
});

// Auth middleware — verify JWT token
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Not authenticated' });
  const token = auth.split(' ')[1];
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

// Protect all /api routes except auth and library PDF download
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  requireAuth(req, res, next);
});

// Special: allow PDF download via query token
app.get('/api/library/pdf/:id', (req, res, next) => {
  const qToken = req.query.token;
  if (qToken) {
    const user = verifyToken(qToken);
    if (user) { req.user = user; return next(); }
  }
  requireAuth(req, res, next);
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── USER LIBRARY: PDF ROUTES ──────────────────────────────────────────────────

// Get all PDFs for logged-in user
app.get('/api/library/pdfs', (req, res) => {
  const pdfs = getUserPDFs(req.user.userId);
  res.json({ pdfs });
});

// Get a specific PDF file (stream it)
app.get('/api/library/pdf/:id', (req, res) => {
  const pdf = getPDFById(parseInt(req.params.id), req.user.userId);
  if (!pdf) return res.status(404).json({ error: 'PDF not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${pdf.original_name}"`);
  res.send(pdf.file_data);
});

// Get extracted text of a PDF
app.get('/api/library/pdf/:id/text', (req, res) => {
  const pdf = getPDFById(parseInt(req.params.id), req.user.userId);
  if (!pdf) return res.status(404).json({ error: 'PDF not found' });
  res.json({ text: pdf.extracted_text, name: pdf.original_name });
});

// Delete a PDF
app.delete('/api/library/pdf/:id', (req, res) => {
  const ok = deletePDF(parseInt(req.params.id), req.user.userId);
  res.json({ success: ok });
});

// ── USER LIBRARY: NOTES ROUTES ────────────────────────────────────────────────

// Save AI notes
app.post('/api/library/save-notes', (req, res) => {
  const { title, content, pdfId } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
  const result = saveNotes(req.user.userId, title, content, pdfId || null);
  res.json({ success: true, noteId: result.id });
});

// Get all notes for user
app.get('/api/library/notes', (req, res) => {
  const notes = getUserNotes(req.user.userId);
  res.json({ notes });
});

// Get single note content
app.get('/api/library/note/:id', (req, res) => {
  const note = getNoteById(parseInt(req.params.id), req.user.userId);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  res.json({ note });
});

// Delete a note
app.delete('/api/library/note/:id', (req, res) => {
  const ok = deleteNote(parseInt(req.params.id), req.user.userId);
  res.json({ success: ok });
});

// ── UPLOAD & EXTRACT TEXT ──────────────────────────────────────────────────
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const dataBuffer = fs.readFileSync(filePath);

    let text = '';
    let method = 'pdf-parse';

    try {
      const parsed = await pdfParse(dataBuffer);
      text = parsed.text ? parsed.text.trim() : '';
    } catch (e) {
      console.log('pdf-parse failed:', e.message);
      text = '';
    }

    // Clean up upload file
    try { fs.unlinkSync(filePath); } catch (_) {}

    if (!text || text.length < 20) {
      text = 'This PDF appears to be image-based (scanned). Text extraction was limited.';
      method = 'fallback';
    }

    res.json({ success: true, text, method });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to process PDF: ' + err.message });
  }
});

// ── SAVE PDF TO LIBRARY (separate route, keeps file) ─────────────────────────
app.post('/api/library/save-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileBuffer = fs.readFileSync(req.file.path);

    let extractedText = '';
    try {
      const parsed = await pdfParse(fileBuffer);
      extractedText = parsed.text?.trim() || '';
    } catch (_) {}

    try { fs.unlinkSync(req.file.path); } catch (_) {}

    const result = savePDF(req.user.userId, req.file.originalname, fileBuffer, extractedText);
    res.json({ success: true, pdf: result });
  } catch (err) {
    console.error('Save PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GENERATE AI NOTES ─────────────────────────────────────────────────────
app.post('/api/notes', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const truncated = text.slice(0, 6000);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert educator. Create well-structured, easy-to-understand study notes from the given text. 
Format with:
- A clear title
- Key Concepts (bullet points)
- Important Points (numbered)
- Summary paragraph
- Key Terms with definitions
Make it student-friendly and comprehensive.`
        },
        { role: 'user', content: `Create study notes from this text:\n\n${truncated}` }
      ],
      max_tokens: 1500
    });

    res.json({ notes: completion.choices[0].message.content });
  } catch (err) {
    console.error('Notes error:', err);
    res.status(500).json({ error: 'AI notes failed: ' + err.message });
  }
});

// ── Q&A GENERATOR (2, 5, 8 marks) ────────────────────────────────────────────
app.post('/api/qa-generate', async (req, res) => {
  try {
    const { text, marks } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const markInstructions = {
      2: 'Generate 8 short answer questions worth 2 marks each. Each answer should be 2-3 sentences (30-50 words).',
      5: 'Generate 5 medium answer questions worth 5 marks each. Each answer should be a paragraph (80-120 words) with key points.',
      8: 'Generate 3 long answer questions worth 8 marks each. Each answer should be detailed (150-200 words) with introduction, main points, and conclusion.'
    };

    const result = await groqChat(
      `You are an exam question paper generator. ${markInstructions[marks] || markInstructions[5]}
Format each Q&A as:
Q1. [Question]
Ans: [Answer]

Make questions based strictly on the provided content.`,
      text.slice(0, 6000),
      2000
    );
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRANSLATE TEXT ────────────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text || !language) return res.status(400).json({ error: 'Missing text or language' });

    const truncated = text.slice(0, 4000);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate the given text to ${language}. Keep the meaning accurate and natural.`
        },
        { role: 'user', content: truncated }
      ],
      max_tokens: 2000
    });

    res.json({ translated: completion.choices[0].message.content });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(500).json({ error: 'Translation failed: ' + err.message });
  }
});

// ── TOPIC SEARCH IN NOTES ─────────────────────────────────────────────────
app.post('/api/search-topic', async (req, res) => {
  try {
    const { topic, notes } = req.body;
    if (!topic || !notes) return res.status(400).json({ error: 'Missing topic or notes' });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a study assistant. From the provided notes, extract and explain the section most relevant to the user\'s topic query. If not found, say so clearly.'
        },
        {
          role: 'user',
          content: `Topic I want to find: "${topic}"\n\nNotes:\n${notes.slice(0, 5000)}`
        }
      ],
      max_tokens: 800
    });

    res.json({ result: completion.choices[0].message.content });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Topic search failed: ' + err.message });
  }
});

// ── YOUTUBE VIDEOS ────────────────────────────────────────────────────────
app.get('/api/videos', async (req, res) => {
  try {
    const { topic } = req.query;
    if (!topic) return res.status(400).json({ error: 'No topic provided' });

    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey || apiKey === 'your_youtube_api_key_here') {
      // Return mock video IDs for demo when no API key
      return res.json({
        videos: [
          { id: 'dQw4w9WgXcQ', title: `${topic} - Tutorial 1` },
          { id: 'ScMzIvxBSi4', title: `${topic} - Tutorial 2` },
          { id: 'rfscVS0vtbw', title: `${topic} - Tutorial 3` }
        ],
        demo: true
      });
    }

    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        part: 'snippet',
        q: topic + ' tutorial explanation',
        type: 'video',
        maxResults: 3,
        key: apiKey,
        relevanceLanguage: 'en',
        videoEmbeddable: true
      }
    });

    const videos = response.data.items.map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.medium.url
    }));

    res.json({ videos });
  } catch (err) {
    console.error('YouTube error:', err);
    res.status(500).json({ error: 'Video search failed: ' + err.message });
  }
});

// ── WORD LOOKUP ───────────────────────────────────────────────────────────
app.post('/api/word-lookup', async (req, res) => {
  try {
    const { word } = req.body;
    if (!word) return res.status(400).json({ error: 'No word provided' });

    // First try free dictionary API (no key needed)
    let dictData = null;
    try {
      const dictRes = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
      dictData = dictRes.data[0];
    } catch (_) { dictData = null; }

    // Build structured response from dictionary
    let pronunciation = '';
    let partOfSpeech = '';
    let definitions = [];
    let examples = [];
    let synonyms = [];

    if (dictData) {
      pronunciation = dictData.phonetic || (dictData.phonetics?.find(p => p.text)?.text) || '';
      dictData.meanings?.forEach(m => {
        if (!partOfSpeech) partOfSpeech = m.partOfSpeech;
        m.definitions?.slice(0, 3).forEach(d => {
          definitions.push(d.definition);
          if (d.example) examples.push(d.example);
        });
        m.synonyms?.slice(0, 5).forEach(s => synonyms.push(s));
      });
    }

    // AI explanation (simple, student-friendly)
    const aiPrompt = definitions.length > 0
      ? `Word: "${word}"\nDefinitions: ${definitions.slice(0,2).join('; ')}\n\nGive a simple 2-3 sentence explanation of this word that a student can easily understand. Include when/how to use it.`
      : `Explain the word "${word}" simply in 2-3 sentences for a student. Include its meaning and how to use it.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful dictionary assistant. Give clear, simple explanations.' },
        { role: 'user', content: aiPrompt }
      ],
      max_tokens: 200
    });

    res.json({
      word,
      pronunciation,
      partOfSpeech,
      definitions: definitions.slice(0, 3),
      examples: examples.slice(0, 2),
      synonyms: synonyms.slice(0, 6),
      aiExplanation: completion.choices[0].message.content
    });
  } catch (err) {
    console.error('Word lookup error:', err);
    res.status(500).json({ error: 'Word lookup failed: ' + err.message });
  }
});
// ── VISUAL LEARNING MODE ──────────────────────────────────────────────────────
app.post('/api/visualize', async (req, res) => {
  try {
    const { text, type, topic } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const truncated = text.slice(0, 5000);

    // Build context instruction based on topic
    const topicInstruction = topic
      ? `Focus ONLY on the topic: "${topic}". Extract information related to "${topic}" from the text.`
      : 'Use the main subject of the entire text.';

    if (type === 'mindmap') {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a mind map generator. ${topicInstruction}
Return ONLY valid JSON, no markdown, no extra text.
Format:
{
  "topic": "Main Topic Name",
  "color": "#6c63ff",
  "children": [
    {
      "topic": "Subtopic 1",
      "color": "#a78bfa",
      "children": [
        { "topic": "Detail 1", "color": "#38bdf8", "children": [] },
        { "topic": "Detail 2", "color": "#38bdf8", "children": [] }
      ]
    }
  ]
}
Rules:
- Main topic: the specific topic requested or core subject
- 4-6 subtopics maximum
- Each subtopic: 2-3 details maximum
- Keep all topics SHORT (max 4 words each)
- No punctuation in topic names`
          },
          { role: 'user', content: `Create a mind map${topic ? ` for the topic "${topic}"` : ''} from this text:\n\n${truncated}` }
        ],
        max_tokens: 1500
      });

      let raw = completion.choices[0].message.content.trim()
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      const mindmap = JSON.parse(raw);
      res.json({ type: 'mindmap', data: mindmap });

    } else if (type === 'flowchart') {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a flowchart generator. ${topicInstruction}
Return ONLY valid JSON array, no markdown, no extra text.
Format:
[
  { "step": "Start", "type": "terminal", "color": "#22c55e" },
  { "step": "Process description", "type": "process", "color": "#6c63ff" },
  { "step": "Decision question?", "type": "decision", "color": "#f59e0b" },
  { "step": "End", "type": "terminal", "color": "#ef4444" }
]
Types: terminal (oval), process (rectangle), decision (diamond)
Rules: 6-10 steps, start with Start terminal, end with End terminal, keep steps short`
          },
          { role: 'user', content: `Create a flowchart${topic ? ` for the topic "${topic}"` : ''} from this text:\n\n${truncated}` }
        ],
        max_tokens: 800
      });

      let raw = completion.choices[0].message.content.trim()
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      const flowchart = JSON.parse(raw);
      res.json({ type: 'flowchart', data: flowchart });
    } else {
      res.status(400).json({ error: 'Invalid type. Use mindmap or flowchart.' });
    }
  } catch (err) {
    console.error('Visualize error:', err);
    res.status(500).json({ error: 'Visualization failed: ' + err.message });
  }
});

// ── PDF PROOFREADER ───────────────────────────────────────────────────────────
app.post('/api/proofread', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert proofreader and editor. Analyze the given text and find ALL mistakes.
Return ONLY a valid JSON array, no extra text, no markdown.
Format:
[
  {
    "type": "spelling|grammar|punctuation|content",
    "original": "the wrong text",
    "suggestion": "the corrected text",
    "explanation": "why this is wrong"
  }
]
Check for:
- Spelling mistakes
- Grammar errors (wrong tense, subject-verb agreement, etc.)
- Punctuation errors (missing commas, full stops, wrong apostrophes)
- Content mistakes (factual inconsistencies, unclear sentences, repetition)
If no mistakes found, return empty array: []`
        },
        { role: 'user', content: `Proofread this text:\n\n${text.slice(0, 5000)}` }
      ],
      max_tokens: 2000
    });

    let raw = completion.choices[0].message.content.trim();
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const mistakes = JSON.parse(raw);
    res.json({ mistakes });
  } catch (err) {
    console.error('Proofread error:', err);
    res.status(500).json({ error: 'Proofreading failed: ' + err.message });
  }
});

// ── UNIVERSAL PLATFORM ROUTES ─────────────────────────────────────────────────

// Groq client for new modules (free)
const groqClient = process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here'
  ? new Groq({ apiKey: process.env.GROQ_API_KEY })
  : null;

async function groqChat(systemPrompt, userContent, maxTokens = 1500) {
  if (!groqClient) throw new Error('Groq API key not configured. Add GROQ_API_KEY to .env');
  const completion = await groqClient.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent }
    ],
    max_tokens: maxTokens
  });
  return completion.choices[0].message.content;
}

// Text processing (notes, summary, keypoints, quiz, simple, advanced)
app.post('/api/text-process', async (req, res) => {
  try {
    const { text, mode } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const prompts = {
      notes:     'Create well-structured study notes with Key Concepts, Important Points, Summary, and Key Terms.',
      summary:   'Write a concise summary in 3-5 paragraphs covering all main points.',
      keypoints: 'Extract the most important key points as a numbered list. Be specific and clear.',
      quiz:      'Generate 5 multiple choice questions with 4 options each. Mark the correct answer with (✓).',
      simple:    'Explain this in very simple words like teaching a 10-year-old. Use examples and analogies.',
      advanced:  'Give a deep technical explanation with proper terminology, underlying concepts, and advanced insights.'
    };

    const result = await groqChat(prompts[mode] || prompts.notes, text.slice(0, 6000));
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Multi-turn chat (Groq)
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body;
    if (!messages) return res.status(400).json({ error: 'No messages provided' });
    if (!groqClient) return res.status(400).json({ error: 'Groq API key not configured' });

    const completion = await groqClient.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt || 'You are a helpful AI assistant.' },
        ...messages.slice(-10)
      ],
      max_tokens: 1000
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process DOCX document
app.post('/api/process-doc', upload.single('doc'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mammoth = require('mammoth');
    const result  = await mammoth.extractRawText({ path: req.file.path });
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    const text = result.value.trim();
    if (!text) return res.status(400).json({ error: 'Could not extract text from document' });
    res.json({ text, chars: text.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process Image (OpenAI vision — Groq doesn't support vision yet)
app.post('/api/process-image', async (req, res) => {
  try {
    const { imageBase64, mimeType, mode } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image provided' });

    const modePrompts = {
      describe: 'Describe this image in detail. What do you see? Include objects, colors, context, and any text visible.',
      extract:  'Extract and transcribe ALL text visible in this image. Format it clearly.',
      explain:  'This appears to be a diagram or chart. Explain what it shows, what the components mean, and what insights can be drawn.',
      notes:    'Analyze this image and generate comprehensive study notes about what it depicts.'
    };

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: modePrompts[mode] || modePrompts.describe },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}` } }
        ]
      }],
      max_tokens: 1000
    });
    res.json({ result: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process Audio — Groq Whisper (free transcription)
app.post('/api/process-audio', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });
    if (!groqClient) return res.status(400).json({ error: 'Groq API key not configured' });

    const fileStream = fs.createReadStream(req.file.path);
    const transcription = await groqClient.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-large-v3-turbo',
      response_format: 'json'
    });

    try { fs.unlinkSync(req.file.path); } catch (_) {}

    const transcript = transcription.text;
    if (!transcript) return res.status(400).json({ error: 'Could not transcribe audio' });

    res.json({ transcript, chars: transcript.length });
  } catch (err) {
    console.error('Audio error:', err.message);
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: 'Audio transcription failed: ' + err.message });
  }
});

// ── RAG DEEP CHAT (Groq LLaMA3 — Free & Fast) ────────────────────────────────

// ── RAG DEEP CHAT (Groq LLaMA3 — Free & Fast) ────────────────────────────────
app.post('/api/rag-ask', async (req, res) => {
  try {
    const { question, pdfText } = req.body;
    if (!question || !pdfText) return res.status(400).json({ error: 'Missing question or PDF text' });

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey || groqKey === 'your_groq_api_key_here') {
      return res.status(400).json({ error: 'Groq API key not configured in .env' });
    }

    // ── STEP 1: Split PDF into chunks (500 words each) ──
    const words  = pdfText.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += 500) {
      chunks.push(words.slice(i, i + 500).join(' '));
    }

    // ── STEP 2: Find relevant chunks using keyword matching ──
    const qWords = question.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const scored = chunks.map((chunk, idx) => {
      const lower = chunk.toLowerCase();
      const score = qWords.reduce((s, w) => s + (lower.split(w).length - 1), 0);
      return { chunk, score, idx };
    });
    scored.sort((a, b) => b.score - a.score);
    const topChunks = scored.slice(0, 3).map(s => s.chunk).join('\n\n---\n\n');

    // ── STEP 3: Ask Groq LLaMA3 with relevant context ──
    const groq = new Groq({ apiKey: groqKey });

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful study assistant. Answer the question based ONLY on the provided PDF content. Be clear and concise. If the answer is not in the content, say so.'
        },
        {
          role: 'user',
          content: `PDF Content (most relevant sections):\n\n${topChunks}\n\nQuestion: ${question}`
        }
      ],
      max_tokens: 500,
      temperature: 0.3
    });

    res.json({
      answer: completion.choices[0].message.content,
      chunksUsed: scored.slice(0, 3).length,
      totalChunks: chunks.length,
      model: 'LLaMA3.1-8b (Groq)'
    });
  } catch (err) {
    console.error('RAG error:', err.message);
    res.status(500).json({ error: 'RAG failed: ' + err.message });
  }
});

// ── ASK FROM PDF CHATBOT ──────────────────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  try {
    const { question, pdfText } = req.body;
    if (!question) return res.status(400).json({ error: 'No question provided' });
    if (!pdfText)  return res.status(400).json({ error: 'No PDF text provided' });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant. Answer questions based only on the provided PDF content. Be concise — max 150 words.'
        },
        {
          role: 'user',
          content: `PDF Content:\n${pdfText.slice(0, 5000)}\n\nQuestion: ${question}`
        }
      ],
      max_tokens: 250
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (err) {
    console.error('Ask error:', err);
    res.status(500).json({ error: 'AI failed: ' + err.message });
  }
});

// ── SIMPLIFY / ADVANCED EXPLANATION ──────────────────────────────────────
app.post('/api/simplify', async (req, res) => {
  try {
    const { text, mode } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const systemPrompt = mode === 'easy'
      ? 'You are a friendly teacher explaining to a 10-year-old child. Use very simple words, short sentences, fun examples and analogies. Avoid all technical jargon.'
      : 'You are an expert professor. Give a deep, detailed, technical explanation with proper terminology, underlying concepts, and advanced insights.';

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text.slice(0, 2000) }
      ],
      max_tokens: 350
    });

    res.json({ result: completion.choices[0].message.content });
  } catch (err) {
    console.error('Simplify error:', err);
    res.status(500).json({ error: 'Explanation failed: ' + err.message });
  }
});
// ── PDF TO AUDIO (proxy Google TTS) ──────────────────────────────────────────
app.post('/api/tts', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text' });

    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    const buffers = [];

    for (const sentence of sentences.slice(0, 30)) {
      const trimmed = sentence.trim().slice(0, 200);
      if (!trimmed) continue;
      try {
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(trimmed)}&tl=en&client=tw-ob&ttsspeed=1`;
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://translate.google.com/'
          },
          timeout: 8000
        });
        buffers.push(Buffer.from(response.data));
      } catch (_) {}
    }

    if (buffers.length === 0) return res.status(500).json({ error: 'TTS fetch failed' });

    const combined = Buffer.concat(buffers);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="cognitive-curator-audio.mp3"');
    res.send(combined);
  } catch (err) {
    console.error('TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PDF TO AUDIO ──────────────────────────────────────────────────────────────
app.post('/api/generate-audio', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    // Use Google Translate TTS (free, no API key needed, limit ~200 chars per request)
    // Split text into chunks and combine
    const chunks = [];
    const words = text.slice(0, 5000).split(' ');
    let chunk = '';
    words.forEach(w => {
      if ((chunk + ' ' + w).length > 180) {
        chunks.push(chunk.trim());
        chunk = w;
      } else {
        chunk += ' ' + w;
      }
    });
    if (chunk) chunks.push(chunk.trim());

    // Return chunks for frontend to use with Web Speech API
    // Also provide Google TTS URLs for each chunk
    const audioUrls = chunks.map(c =>
      `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(c)}&tl=en&client=tw-ob`
    );

    res.json({ success: true, chunks, audioUrls, method: 'google-tts' });
  } catch (err) {
    console.error('Audio error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SHARE NOTES VIA EMAIL ─────────────────────────────────────────────────────
app.post('/api/share-notes', async (req, res) => {
  try {
    const { toEmail, notes, senderName } = req.body;
    if (!toEmail || !notes) return res.status(400).json({ error: 'Email and notes required' });

    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    if (!gmailUser || gmailUser === 'your_gmail@gmail.com')
      return res.status(400).json({ error: 'Gmail not configured in .env' });

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: gmailUser, pass: gmailPass },
      tls: { rejectUnauthorized: false }
    });

    const from = senderName ? `${senderName} via Cognitive Curator` : 'Cognitive Curator';
    await transporter.sendMail({
      from: `"${from}" <${gmailUser}>`,
      to: toEmail,
      subject: `📝 Study Notes shared with you — Cognitive Curator`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:32px;background:#1e1e3a;color:#e2e8f0;border-radius:16px">
          <h2 style="color:#a78bfa;margin-bottom:4px">🧠 Cognitive Curator</h2>
          <p style="color:#94a3b8;margin-bottom:24px">${senderName ? `<b>${senderName}</b> shared study notes with you` : 'Study notes shared with you'}</p>
          <div style="background:#0f0f1a;border:1px solid #2d2d5e;border-radius:12px;padding:24px;white-space:pre-wrap;font-size:0.92rem;line-height:1.7;color:#e2e8f0">${notes.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
          <p style="color:#64748b;font-size:0.78rem;margin-top:20px;text-align:center">Sent from Cognitive Curator — AI-Powered PDF Reader</p>
        </div>`
    });
    res.json({ success: true, message: `Notes sent to ${toEmail}` });
  } catch (err) {
    console.error('Share notes error:', err.message);
    res.status(500).json({ error: 'Failed to send: ' + err.message });
  }
});

app.post('/api/quiz', async (req, res) => {
  try {
    const { text, count = 10 } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const truncated = text.slice(0, 6000);
    const numQ = Math.min(Math.max(parseInt(count), 3), 15);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an expert quiz maker. Generate exactly ${numQ} multiple choice questions from the given text.
Return ONLY a valid JSON array, no extra text, no markdown, no code blocks.
Format:
[
  {
    "question": "Question text here?",
    "options": ["A) option1", "B) option2", "C) option3", "D) option4"],
    "answer": "A",
    "explanation": "Brief explanation why this is correct."
  }
]
Rules:
- Each question must have exactly 4 options labeled A) B) C) D)
- "answer" must be just the letter: A, B, C, or D
- Questions must be based strictly on the provided text
- Mix easy, medium and hard questions
- Make wrong options plausible but clearly incorrect`
        },
        { role: 'user', content: `Generate ${numQ} MCQ questions from this text:\n\n${truncated}` }
      ],
      max_tokens: 3000
    });

    let raw = completion.choices[0].message.content.trim();
    // Strip markdown code blocks if present
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    const questions = JSON.parse(raw);
    res.json({ questions });
  } catch (err) {
    console.error('Quiz error:', err);
    res.status(500).json({ error: 'Quiz generation failed: ' + err.message });
  }
});

app.post('/api/explain', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a friendly teacher. Explain the given text in simple, clear language as if talking to a student. Be engaging and easy to understand.'
        },
        { role: 'user', content: text.slice(0, 3000) }
      ],
      max_tokens: 1000
    });

    res.json({ explanation: completion.choices[0].message.content });
  } catch (err) {
    console.error('Explain error:', err);
    res.status(500).json({ error: 'Explanation failed: ' + err.message });
  }
});

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = 3443;

const certPath = path.join(__dirname, 'cert.pem');
const keyPath  = path.join(__dirname, 'key.pem');

async function startServers() {
  const httpServer = http.createServer(app);

  // ── SOCKET.IO SIGNALING ──────────────────────────────────────────────────────
  const { Server } = require('socket.io');
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
  });

  const rooms = {};

  io.on('connection', (socket) => {
    socket.on('join-room', ({ roomId, userName }) => {
      socket.join(roomId);
      socket.data.userName = userName;
      socket.data.roomId   = roomId;
      if (!rooms[roomId]) rooms[roomId] = [];
      rooms[roomId].push(socket.id);
      socket.to(roomId).emit('peer-joined', { socketId: socket.id, userName });
      const peers = rooms[roomId].filter(id => id !== socket.id);
      socket.emit('existing-peers', peers);
    });

    socket.on('offer',  ({ to, sdp })       => io.to(to).emit('offer',  { from: socket.id, sdp, userName: socket.data.userName }));
    socket.on('answer', ({ to, sdp })       => io.to(to).emit('answer', { from: socket.id, sdp }));
    socket.on('ice',    ({ to, candidate }) => io.to(to).emit('ice',    { from: socket.id, candidate }));
    socket.on('chat',   ({ roomId, text })  => io.to(roomId).emit('chat', { from: socket.data.userName, text }));

    socket.on('disconnect', () => {
      const { roomId, userName } = socket.data;
      if (roomId && rooms[roomId]) {
        rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
        if (rooms[roomId].length === 0) delete rooms[roomId];
        socket.to(roomId).emit('peer-left', { socketId: socket.id, userName });
      }
    });
  });

  // In production (Railway/Render) — HTTP only, they handle HTTPS
  // In development — also start HTTPS for microphone support
  httpServer.listen(PORT, () => {
    console.log('\n========================================');
    console.log('  ✅ Cognitive Curator is RUNNING!');
    console.log(`  👉 http://localhost:${PORT}`);
    console.log('========================================\n');
  });

  // HTTPS only in development
  if (process.env.NODE_ENV !== 'production') {
    try {
      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        const attrs = [{ name: 'commonName', value: 'localhost' }];
        const pems = await selfsigned.generate(attrs, { days: 365 });
        fs.writeFileSync(certPath, pems.cert);
        fs.writeFileSync(keyPath, pems.private);
      }
      const sslOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      https.createServer(sslOptions, app).listen(HTTPS_PORT, () => {
        console.log(`  🔒 HTTPS: https://localhost:${HTTPS_PORT}`);
      }).on('error', () => {});
    } catch (_) {}
  }
}

startServers();
