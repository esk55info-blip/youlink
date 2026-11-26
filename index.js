const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const PORT = process.env.PORT || 7860;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('WhatsApp Media Bridge is Running!');
}).listen(PORT, () => console.log('Server listening on port', PORT));

let lastSearchResults = [];
const sentByBot = new Set();

const YTDLP_COMMON_ARGS = [
  '--no-warnings',
  '--no-playlist',
  '--concurrent-fragments', '4',
  '--js-runtimes', 'node',
  ...(fs.existsSync('/tmp/cookies.txt') ? ['--cookies', '/tmp/cookies.txt'] : [])
];

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', [...YTDLP_COMMON_ARGS, ...args], { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        const cleanErr = (stderr || err.message || '')
          .split('\n')
          .filter((l) => !l.startsWith('WARNING:'))
          .join('\n')
          .trim();
        return reject(new Error(cleanErr || err.message));
      }
      resolve(stdout);
    });
  });
}

async function downloadDirectFile(url, destPath) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body), fileStream);
}

function cleanup(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
}

function parseQualityMode(mod) {
  const m = (mod || '').trim().toLowerCase();
  if (m === 'صوت') return 'audio';
  if (m === '360') return '360';
  if (m === '720' || m === 'عالية') return '720';
  if (m === '1080' || m === 'فول') return '1080';
  return '480';
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('/app/auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false
  });

  if (!sock.authState.creds.registered && process.env.PHONE_NUMBER) {
    setTimeout(async () => {
      try {
        const cleanNum = process.env.PHONE_NUMBER.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanNum);
        console.log('\n=========================================');
        console.log('PAIRING CODE:', code);
        console.log('=========================================\n');
      } catch (e) {
        console.error('Pairing error:', e.message);
      }
    }, 6000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      console.log('Connected to WhatsApp successfully!');
    } else if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startBot();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;
    if (sentByBot.has(msg.key.id)) return;
    if (!msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid || '';
    if (
      remoteJid.endsWith('@g.us') ||
      remoteJid.endsWith('@broadcast') ||
      remoteJid.endsWith('@newsletter')
    ) {
      return;
    }

    const myNum = (sock.user?.id || state.creds?.me?.id || '').split(':')[0].split('@')[0];
    const myLid = (sock.user?.lid || state.creds?.me?.lid || '').split(':')[0].split('@')[0];
    const remoteId = remoteJid.split(':')[0].split('@')[0];

    const isSelfChat =
      (myNum && remoteId === myNum) ||
      (myLid && remoteId === myLid);

    if (!isSelfChat) return;

    const text = (
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ''
    ).trim();

    if (!text) return;
    if (/^(⏳|🔍|🔎|📥|✅|❌|\*1\.\*|رقم غير موجود|لم يتم العثور)/.test(text)) return;

    const reply = async (content) => {
      const sent = await sock.sendMessage(remoteJid, content);
      if (sent?.key?.id) sentByBot.add(sent.key.id);
      return sent;
    };

    const sendMedia = async (url, mode = '480', customTitle = '') => {
      const id = Date.now();
      let outFile = '';
      try {
        const label = mode === 'audio' ? 'صوت MP3' : `دقة ${mode}p`;
        await reply({ text: `⏳ جاري التحميل (${label})، انتظر قليلاً...` });

        if (mode === 'audio') {
          outFile = `/tmp/audio_${id}.mp3`;
          await runYtDlp(['-x', '--audio-format', 'mp3', '-o', outFile, url]);
          await reply({
            document: { url: outFile },
            mimetype: 'audio/mpeg',
            fileName: `${(customTitle || 'audio').replace(/[\\/:*?"<>|]/g, '_')}.mp3`
          });
        } else {
          outFile = `/tmp/video_${id}.mp4`;
          const maxH = mode;
          const formatSelector =
            `bv*[height<=${maxH}][vcodec^=avc1]+ba[acodec^=mp4a]/` +
            `bv*[height<=${maxH}][ext=mp4]+ba[ext=m4a]/` +
            `bv*[height<=${maxH}]+ba/` +
            `b[height<=${maxH}]/` +
            `bv*+ba/b`;

          await runYtDlp([
            '-f', formatSelector,
            '--merge-output-format', 'mp4',
            '--remux-video', 'mp4',
            '--postprocessor-args', 'ffmpeg:-movflags +faststart',
            '-o', outFile,
            url
          ]);

          const sizeMB = fs.statSync(outFile).size / (1024 * 1024);
          const fileName = `${(customTitle || 'video').replace(/[\\/:*?"<>|]/g, '_')}.mp4`;

          // إرسال كفيديو مباشر قابل للتشغيل أثناء التحميل إذا كان أقل من 95 MB
          if (sizeMB < 95) {
            await reply({
              video: { url: outFile },
              caption: `✅ ${customTitle || 'تم التحميل'} [${maxH}p] (${sizeMB.toFixed(1)} MB)`
            });
          } else {
            await reply({
              document: { url: outFile },
              mimetype: 'video/mp4',
              fileName,
              caption: `✅ ${customTitle || 'تم التحميل'} [${maxH}p] (${sizeMB.toFixed(1)} MB)\n📦 أُرسل كملف لأن حجمه يتجاوز 95 MB.`
            });
          }
        }
      } catch (err) {
        await reply({ text: `❌ خطأ أثناء التحميل:\n${err.message.slice(0, 350)}` });
      } finally {
        cleanup(outFile);
      }
    };

    // 1. اختيار رقم من نتائج البحث مع الدقة أو الصوت
    const pickMatch = text.match(/^([1-5])(?:\s+(360|480|720|1080|صوت|عالية|فول))?$/i);
    if (pickMatch && lastSearchResults.length > 0) {
      const idx = parseInt(pickMatch[1], 10) - 1;
      const item = lastSearchResults[idx];
      if (!item) return reply({ text: 'رقم غير موجود في القائمة.' });
      const mode = parseQualityMode(pickMatch[2]);
      const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
      await sendMedia(videoUrl, mode, item.title);
      return;
    }

    // 2. أي رابط مباشر (يدعم إضافة الدقة بجانب الرابط مثل: رابط 1080 أو رابط صوت)
    if (text.startsWith('http://') || text.startsWith('https://')) {
      const parts = text.split(/\s+/);
      const url = parts[0];
      const isDirectFile = /\.(zip|rar|7z|apk|ipa|pdf|exe|dmg|iso|mp3)(\?.*)?$/i.test(url);

      if (isDirectFile) {
        const tempFile = `/tmp/file_${Date.now()}_${path.basename(new URL(url).pathname) || 'download.bin'}`;
        try {
          await reply({ text: '📥 جاري سحب الملف المباشر...' });
          await downloadDirectFile(url, tempFile);
          await reply({
            document: { url: tempFile },
            mimetype: 'application/octet-stream',
            fileName: path.basename(tempFile).replace(/^file_\d+_/, '')
          });
        } catch (err) {
          await reply({ text: `❌ فشل تحميل الملف: ${err.message}` });
        } finally {
          cleanup(tempFile);
        }
      } else {
        const mode = parseQualityMode(parts[1]);
        await sendMedia(url, mode);
      }
      return;
    }

    // 3. جلب آخر فيديو مباشرة
    if (/^(اخر|آخر)\s+فيديو\s+/i.test(text) || /الفيديو\s+(الاخير|الأخير)/i.test(text)) {
      const query = text
        .replace(/^(اخر|آخر)\s+فيديو\s+/i, '')
        .replace(/الفيديو\s+(الاخير|الأخير)/i, '')
        .trim();
      if (!query) return;
      await reply({ text: `🔎 جاري جلب أحدث فيديو لـ: "${query}"...` });
      try {
        const raw = await runYtDlp([
          `ytsearch1:${query}`,
          '--dump-json',
          '--flat-playlist'
        ]);
        const item = JSON.parse(raw.trim().split('\n')[0]);
        const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
        await sendMedia(videoUrl, '480', item.title);
      } catch (err) {
        await reply({ text: `❌ تعذر جلب الفيديو: ${err.message.slice(0, 250)}` });
      }
      return;
    }

    // 4. البحث في يوتيوب
    const query = text.replace(/^بحث\s+/, '').trim();
    await reply({ text: `🔍 جاري البحث في يوتيوب عن: "${query}"...` });
    try {
      const raw = await runYtDlp([
        `ytsearch5:${query}`,
        '--dump-json',
        '--flat-playlist'
      ]);
      lastSearchResults = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .slice(0, 5);

      if (!lastSearchResults.length) {
        return reply({ text: 'لم يتم العثور على نتائج.' });
      }

      const listText = lastSearchResults
        .map((v, i) => {
          const mins = v.duration
            ? `${Math.floor(v.duration / 60)}:${String(v.duration % 60).padStart(2, '0')}`
            : 'غير محدد';
          return `*${i + 1}.* ${v.title}\n   📺 ${v.uploader || ''} | ⏱ ${mins}`;
        })
        .join('\n\n');

      await reply({
        text:
          `${listText}\n\n` +
          `💡 أرسل رقم الفيديو مع الدقة المطلوبة:\n` +
          `• *1* (دقة 480p افتراضية)\n` +
          `• *1 360* (توفير بيانات)\n` +
          `• *1 720* (جودة HD)\n` +
          `• *1 1080* (جودة Full HD)\n` +
          `• *1 صوت* (ملف MP3)`
      });
    } catch (err) {
      await reply({ text: `❌ فشل البحث: ${err.message.slice(0, 250)}` });
    }
  });
}

startBot();
