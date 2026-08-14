const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Which command launches yt-dlp on this machine.
// On Windows, running it as a Python module ("py -m yt_dlp") avoids PATH problems.
const YTDLP_CMD = process.platform === 'win32' ? 'py' : 'yt-dlp';
const ytdlpArgs = (args) => (process.platform === 'win32' ? ['-m', 'yt_dlp', ...args] : args);

// Helper: run yt-dlp and collect stdout as a string
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_CMD, ytdlpArgs(args));
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
// Returns title, thumbnail, duration, and a curated list of downloadable formats
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Link kiritilmagan.' });
  }

  try {
    const raw = await runYtDlp(['-j', '--no-playlist', url]);
    const data = JSON.parse(raw.trim().split('\n')[0]);

    // Curate formats: best video+audio (mp4) and a best audio-only (mp3-able) option
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
    res.status(422).json({ error: 'Link tahlil qilinmadi. Havolani tekshirib qaytadan urinib ko\u2018ring.' });
  }
});

// GET /api/download?url=...&kind=video|audio
// Streams the media directly to the client as a file download
app.get('/api/download', (req, res) => {
  const { url, kind } = req.query;
  if (!url) return res.status(400).send('Link kiritilmagan.');

  const isAudio = kind === 'audio';
  const args = isAudio
    ? ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '-o', '-', url]
    : ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', '-', url];

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="media.${isAudio ? 'mp3' : 'mp4'}"`
  );
  res.setHeader('Content-Type', isAudio ? 'audio/mpeg' : 'video/mp4');

  const proc = spawn(YTDLP_CMD, ytdlpArgs(args));
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {}); // swallow progress logs
  proc.on('error', () => res.end());
  req.on('close', () => proc.kill());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
