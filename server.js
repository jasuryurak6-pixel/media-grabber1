const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const YTDLP_CMD = process.platform === 'win32' ? 'py' : 'yt-dlp';
const ytdlpArgs = (args) => (process.platform === 'win32' ? ['-m', 'yt_dlp', ...args] : args);

// Cookies faylini aniqlash (cookies.txt yoki www.youtube.com_cookies.txt)
function getCookiePath() {
  const defaultCookie = path.join(__dirname, 'cookies.txt');
  const ytCookie = path.join(__dirname, 'www.youtube.com_cookies.txt');

  if (fs.existsSync(defaultCookie)) return defaultCookie;
  if (fs.existsSync(ytCookie)) return ytCookie;
  return null;
}

// Helper: run yt-dlp and collect stdout as a string
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const cookiePath = getCookiePath();
    const extraArgs = [];

    if (cookiePath) {
      extraArgs.push('--cookies', cookiePath);
    }

    const finalArgs = [...extraArgs, ...args];
    const proc = spawn(YTDLP_CMD, ytdlpArgs(finalArgs));

    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `yt-dlp exited with code ${code}`));
    });
  });
}

// POST /api/info  { url }
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Link kiritilmagan.' });
  }

  try {
    const raw = await runYtDlp([
      '-j',
      '--no-playlist',
      '--extractor-args', 'youtube:player_client=mweb,ios',
      url
    ]);
    const data = JSON.parse(raw.trim().split('\n')[0]);

    const formats = (data.formats || []).filter(
      (f) => f.vcodec !== 'none' || f.acodec !== 'none'
    );

    const bestVideo = formats
      .filter((f) => f.vcodec !== 'none')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    const bestAudio = formats
      .filter((f) => f.vcodec === 'none' && f.acodec !== 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    res.json({
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      uploader: data.uploader,
      extractor: data.extractor_key,
      options: [
        bestVideo && {
          kind: 'video',
          label: `Video (${bestVideo.height ? bestVideo.height + 'p' : 'eng yaxshi sifat'})`,
        },
        bestAudio && { kind: 'audio', label: 'Faqat audio (MP3)' },
      ].filter(Boolean),
    });
  } catch (e) {
    console.error('yt-dlp error:', e.message);
    res.status(422).json({ error: 'Link tahlil qilinmadi. Havolani tekshirib qaytadan urinib ko‘ring.' });
  }
});

// GET /api/download?url=...&kind=video|audio
app.get('/api/download', (req, res) => {
  const { url, kind } = req.query;
  if (!url) return res.status(400).send('Link kiritilmagan.');

  const isAudio = kind === 'audio';
  const cookiePath = getCookiePath();
  const baseArgs = [];

  if (cookiePath) {
    baseArgs.push('--cookies', cookiePath);
  }

  baseArgs.push('--extractor-args', 'youtube:player_client=mweb,ios');

  const mediaArgs = isAudio
    ? ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '-o', '-', url]
    : ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', '-', url];

  const args = [...baseArgs, ...mediaArgs];

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="media.${isAudio ? 'mp3' : 'mp4'}"`
  );
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

  const proc = spawn(YTDLP_CMD, ytdlpArgs(args));
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  proc.on('error', () => res.end());
  req.on('close', () => proc.kill());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

// ==========================================
// TELEGRAM BOTNI SHU YERDA ISHGA TUSHIRAMIZ:
// ==========================================
try {
  require('./bot.js');
  console.log('Telegram bot muvaffaqiyatli ishga tushirildi.');
} catch (err) {
  console.error('bot.js yuklashda xatolik yuz berdi:', err.message);
}
