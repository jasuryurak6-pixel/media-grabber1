// Telegram bot: send a link, get back video or audio buttons.
// Reuses the same yt-dlp logic as server.js.

const TelegramBot = require('node-telegram-bot-api').TelegramBot;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ====== SETTINGS ======
// Paste the token you got from @BotFather here, between the quotes.
const BOT_TOKEN = '8812849340:AAHHmoHMw3Gysa4r0jl0L4uZqP0OFTOd4qw';
// If you have a cookies.txt (for YouTube), put its filename here. Leave '' if not needed.
const COOKIES_FILE = fs.existsSync(path.join(__dirname, 'www.youtube.com_cookies.txt'))
  ? 'www.youtube.com_cookies.txt'
  : (fs.existsSync(path.join(__dirname, 'cookies.txt')) ? 'cookies.txt' : '');
// ACRCloud project settings (from console.acrcloud.com -> your project)
const ACR_HOST = 'identify-ap-southeast-1.acrcloud.com';
const ACR_ACCESS_KEY = '3a189df96bcc84157fa4ebc6829fc898';
const ACR_ACCESS_SECRET = 'cEIGwGoSx8DZX8Vc22xqLlIEarQUfTKcNtwcaj3p';
// =======================

// A real Telegram bot token always looks like: digits, a colon, then letters/numbers/-/_
const TOKEN_LOOKS_VALID = /^\d+:[\w-]{20,}$/.test(BOT_TOKEN);

if (!TOKEN_LOOKS_VALID) {
  console.error('XATO: Avval BOT_TOKEN ni bot.js faylining ichiga yozing!');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const YTDLP_CMD = process.platform === 'win32' ? 'py' : 'yt-dlp';
const ytdlpArgs = (args) => (process.platform === 'win32' ? ['-m', 'yt_dlp', ...args] : args);

function withCookies(args) {
  // Cookies help YouTube trust the request; the extra flags help solve
  // YouTube's JS challenge. Harmless for other sites (they're ignored).
  const extra = ['--js-runtimes', 'node', '--remote-components', 'ejs:github'];
  const withExtra = [...extra, ...args];
  return COOKIES_FILE ? ['--cookies', COOKIES_FILE, ...withExtra] : withExtra;
}

// Track which link each user most recently sent, so the button callback knows what to download
const lastLink = new Map(); // chatId -> url

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Salom! Menga video havolasini yuboring (YouTube, Instagram, TikTok va boshqalar), men video yoki audio qilib qaytaraman.\n\nYoki menga qo\u2018shiqning bir bo\u2018lagini (ovozli xabar yoki audio fayl) yuboring — men uni tanib, to\u2018liq qo\u2018shiqni topib beraman.'
  );
});

// Any message that looks like a link
bot.on('message', (msg) => {
  const text = msg.text || '';
  if (!/^https?:\/\//i.test(text)) return; // ignore non-links (and ignore /start etc.)

  const chatId = msg.chat.id;
  lastLink.set(chatId, text);

  bot.sendMessage(chatId, 'Nimani xohlaysiz?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🎬 Video', callback_data: 'video' },
          { text: '🎵 Audio (MP3)', callback_data: 'audio' },
        ],
      ],
    },
  });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const url = lastLink.get(chatId);
  const kind = query.data; // 'video', 'audio', or 'identify'

  bot.answerCallbackQuery(query.id);

  if (!url) {
    bot.sendMessage(chatId, 'Avval bir havola yuboring.');
    return;
  }

  if (kind === 'identify') {
    await identifySongFromUrl(chatId, url);
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, '⏳ Yuklab olinmoqda, biroz kuting...');

  const isAudio = kind === 'audio';
  const ext = isAudio ? 'mp3' : 'mp4';
  const outPath = path.join(os.tmpdir(), `dl_${Date.now()}.${ext}`);

  const args = withCookies(
    isAudio
      ? ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '-o', outPath, url]
      : ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', outPath, url]
  );

  const proc = spawn(YTDLP_CMD, ytdlpArgs(args));
  let errOutput = '';
  proc.stderr.on('data', (d) => (errOutput += d));

  proc.on('close', async (code) => {
    if (code !== 0 || !fs.existsSync(outPath)) {
      bot.editMessageText('❌ Yuklab olib bo\'lmadi. Havolani tekshirib qaytadan urinib ko\'ring.', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
      console.error(errOutput);
      return;
    }

    try {
      if (isAudio) {
        await bot.sendAudio(chatId, outPath, {
          reply_markup: {
            inline_keyboard: [[{ text: '🎼 Bu qo\u2018shiqni aniqla', callback_data: 'identify' }]],
          },
        });
      } else {
        await bot.sendVideo(chatId, outPath, {
          reply_markup: {
            inline_keyboard: [[{ text: '🎼 Bu qo\u2018shiqni aniqla', callback_data: 'identify' }]],
          },
        }, { filename: 'video.mp4' });
      }
      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
    } catch (e) {
      bot.sendMessage(chatId, '❌ Fayl juda katta yoki yuborishda xatolik yuz berdi.');
      console.error(e);
    } finally {
      fs.unlink(outPath, () => {});
    }
  });
});

console.log('Bot ishga tushdi. Telegram\'da botingizga /start yozib sinab ko\'ring.');

// ====== SONG RECOGNITION ======
// Two entry points:
//  - recognizeAndFetchSong: user sent a voice note / audio file directly to the bot
//  - identifySongFromUrl: user picked "identify" on a video link; we extract the
//    audio from that video first, then run the same recognition + search flow.

async function sendBufferToACR(buffer) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const stringToSign = ['POST', '/v1/identify', ACR_ACCESS_KEY, 'audio', '1', timestamp].join('\n');
  const signature = crypto
    .createHmac('sha1', ACR_ACCESS_SECRET)
    .update(stringToSign)
    .digest('base64');

  const form = new FormData();
  form.append('sample', new Blob([buffer]), 'sample.mp3');
  form.append('sample_bytes', String(buffer.length));
  form.append('access_key', ACR_ACCESS_KEY);
  form.append('data_type', 'audio');
  form.append('signature_version', '1');
  form.append('signature', signature);
  form.append('timestamp', timestamp);

  const res = await fetch(`https://${ACR_HOST}/v1/identify`, { method: 'POST', body: form });
  const data = await res.json();

  if (data.status?.code !== 0 || !data.metadata?.music?.length) return null;

  const track = data.metadata.music[0];
  return {
    title: track.title,
    artist: (track.artists || []).map((a) => a.name).join(', '),
  };
}

// Once we know the title/artist, search YouTube and send the full track back.
async function fetchAndSendSong(chatId, statusMsg, title, artist) {
  const query = `${artist} - ${title}`;

  bot.editMessageText(`✅ Topildi: *${title}* — ${artist}\n⏳ Yuklab olinmoqda...`, {
    chat_id: chatId,
    message_id: statusMsg.message_id,
    parse_mode: 'Markdown',
  });

  const outPath = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);
  const args = ytdlpArgs(
    withCookies(['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '-o', outPath, `ytsearch1:${query}`])
  );

  const proc = spawn(YTDLP_CMD, args);
  let errOutput = '';
  proc.stderr.on('data', (d) => (errOutput += d));

  proc.on('close', async (code) => {
    if (code !== 0 || !fs.existsSync(outPath)) {
      bot.sendMessage(chatId, `Qo\u2018shiq topildi (${query}), lekin yuklab olishda xatolik yuz berdi.`);
      console.error(errOutput);
      return;
    }
    try {
      await bot.sendAudio(chatId, outPath, { title, performer: artist });
    } catch (e) {
      bot.sendMessage(chatId, '❌ Faylni yuborishda xatolik yuz berdi.');
      console.error(e);
    } finally {
      fs.unlink(outPath, () => {});
    }
  });
}

async function recognizeAndFetchSong(chatId, fileId) {
  const statusMsg = await bot.sendMessage(chatId, '🎧 Tinglayapman, qo\u2018shiqni aniqlashga harakat qilyapman...');

  try {
    const fileLink = await bot.getFileLink(fileId);
    const fileRes = await fetch(fileLink);
    const fileBuffer = Buffer.from(await fileRes.arrayBuffer());

    const result = await sendBufferToACR(fileBuffer);
    if (!result) {
      bot.editMessageText('❌ Qo\u2018shiqni tanib bo\u2018lmadi. Boshqa, aniqroq bo\u2018lakni sinab ko\u2018ring.', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
      return;
    }

    await fetchAndSendSong(chatId, statusMsg, result.title, result.artist);
  } catch (e) {
    console.error(e);
    bot.editMessageText('❌ Xatolik yuz berdi, qaytadan urinib ko\u2018ring.', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    });
  }
}

async function identifySongFromUrl(chatId, url) {
  const statusMsg = await bot.sendMessage(chatId, '🎧 Videodan qo\u2018shiqni ajratib olyapman...');

  const clipPath = path.join(os.tmpdir(), `clip_${Date.now()}.mp3`);
  // Grab only the first ~25 seconds of audio — plenty for recognition, and much faster.
  const args = ytdlpArgs(
    withCookies([
      '-f', 'bestaudio',
      '--extract-audio', '--audio-format', 'mp3',
      '--postprocessor-args', 'ffmpeg:-t 25',
      '-o', clipPath,
      url,
    ])
  );

  const proc = spawn(YTDLP_CMD, args);
  let errOutput = '';
  proc.stderr.on('data', (d) => (errOutput += d));

  proc.on('close', async (code) => {
    if (code !== 0 || !fs.existsSync(clipPath)) {
      bot.editMessageText('❌ Videodan audio ajratib bo\u2018lmadi.', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
      console.error(errOutput);
      return;
    }

    try {
      bot.editMessageText('🎧 Tinglayapman, qo\u2018shiqni aniqlashga harakat qilyapman...', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });

      const buffer = fs.readFileSync(clipPath);
      const result = await sendBufferToACR(buffer);

      if (!result) {
        bot.editMessageText('❌ Bu videodagi qo\u2018shiqni tanib bo\u2018lmadi.', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
        return;
      }

      await fetchAndSendSong(chatId, statusMsg, result.title, result.artist);
    } catch (e) {
      console.error(e);
      bot.editMessageText('❌ Xatolik yuz berdi, qaytadan urinib ko\u2018ring.', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });
    } finally {
      fs.unlink(clipPath, () => {});
    }
  });
}

bot.on('voice', (msg) => recognizeAndFetchSong(msg.chat.id, msg.voice.file_id));
bot.on('audio', (msg) => recognizeAndFetchSong(msg.chat.id, msg.audio.file_id));
