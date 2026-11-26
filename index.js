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

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
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

    const myJid = sock.user?.id?.split(':')[0] + '@s.whatsapp.net';
    const myLid = sock.user?.lid ? sock.user.lid.split(':')[0] + '@lid' : '';
    const remoteJid = msg.key.remoteJid || '';

    // يدعم مراسلة نفسك سواء بالرقم أو بالمعرّف الجديد (@lid)
    const isSelfChat =
      remoteJid === myJid ||
      (myLid && remoteJid === myLid) ||
      (msg.key.fromMe && remoteJid.endsWith('@lid'));

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

    const sendMedia = async (url, mode = 'video', customTitle = '') => {
      const id = Date.now();
      let outFile = '';
      try {
        await reply({ text: '⏳ جاري التحميل من السيرفر، انتظر قليلاً...' });

        if (mode === 'audio') {
          outFile = `/tmp/audio_${id}.mp3`;
          await runYtDlp(['-x', '--audio-format', 'mp3', '--no-playlist', '-o', outFile, url]);
          await reply({
            document: fs.readFileSync(outFile),
            mimetype: 'audio/mpeg',
            fileName: `${customTitle || 'audio'}.mp3`
          });
        } else {
          outFile = `/tmp/video_${id}.mp4`;
          const maxH = mode === 'hd' ? '720' : '480';
          const formatStr = `bestvideo[height<=${maxH}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/best[height<=${maxH}][ext=mp4]/best[ext=mp4]/best`;
          await runYtDlp([
            '-f', formatStr,
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '-o', outFile,
            url
          ]);

          const sizeMB = fs.statSync(outFile).size / (1024 * 1024);
          const fileName = `${(customTitle || 'video').replace(/[\\/:*?"<>|]/g, '_')}.mp4`;

          if (sizeMB < 75 && mode !== 'hd') {
            await reply({
              video: fs.readFileSync(outFile),
              caption: `✅ ${customTitle || 'تم التحميل'} (${sizeMB.toFixed(1)} MB)`
            });
          } else {
            await reply({
              document: fs.readFileSync(outFile),
              mimetype: 'video/mp4',
              fileName,
              caption: `✅ ${customTitle || 'تم التحميل'} (${sizeMB.toFixed(1)} MB)`
            });
          }
        }
      } catch (err) {
        await reply({ text: `❌ خطأ أثناء التحميل:\n${err.message.slice(0, 300)}` });
      } finally {
        cleanup(outFile);
      }
    };

    // 1. اختيار رقم من نتائج البحث
    const pickMatch = text.match(/^([1-5])(\s+(صوت|عالية|720))?$/);
    if (pickMatch && lastSearchResults.length > 0) {
      const idx = parseInt(pickMatch[1], 10) - 1;
      const item = lastSearchResults[idx];
      if (!item) return reply({ text: 'رقم غير موجود في القائمة.' });
      const modifier = pickMatch[3] || '';
      const mode = modifier === 'صوت' ? 'audio' : modifier ? 'hd' : 'video';
      const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
      await sendMedia(videoUrl, mode, item.title);
      return;
    }

    // 2. أي رابط مباشر
    if (text.startsWith('http://') || text.startsWith('https://')) {
      const url = text.split(/\s+/)[0];
      const isDirectFile = /\.(zip|rar|7z|apk|ipa|pdf|exe|dmg|iso|mp3)(\?.*)?$/i.test(url);

      if (isDirectFile) {
        const tempFile = `/tmp/file_${Date.now()}_${path.basename(new URL(url).pathname) || 'download.bin'}`;
        try {
          await reply({ text: '📥 جاري سحب الملف المباشر...' });
          await downloadDirectFile(url, tempFile);
          await reply({
            document: fs.readFileSync(tempFile),
            mimetype: 'application/octet-stream',
            fileName: path.basename(tempFile).replace(/^file_\d+_/, '')
          });
        } catch (err) {
          await reply({ text: `❌ فشل تحميل الملف: ${err.message}` });
        } finally {
          cleanup(tempFile);
        }
      } else {
        await sendMedia(url, 'video');
      }
      return;
    }

    // 3. جلب آخر فيديو مباشرة إذا ذُكرت عبارة "اخر فيديو" أو "الفيديو الاخير"
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
          '--flat-playlist',
          '--no-warnings'
        ]);
        const item = JSON.parse(raw.trim().split('\n')[0]);
        const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
        await sendMedia(videoUrl, 'video', item.title);
      } catch (err) {
        await reply({ text: `❌ تعذر جلب الفيديو: ${err.message.slice(0, 200)}` });
      }
      return;
    }

    // 4. أي نص آخر يُعتبر بحثاً مباشراً في يوتيوب تلقائياً
    const query = text.replace(/^بحث\s+/, '').trim();
    await reply({ text: `🔍 جاري البحث في يوتيوب عن: "${query}"...` });
    try {
      const raw = await runYtDlp([
        `ytsearch5:${query}`,
        '--dump-json',
        '--flat-playlist',
        '--no-warnings'
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
        text: `${listText}\n\n💡 أرسل رقم الفيديو (مثلاً *1*) للمشاهدة، أو (*1 عالية*) لدقة 720p، أو (*1 صوت*) للتحميل MP3.`
      });
    } catch (err) {
      await reply({ text: `❌ فشل البحث: ${err.message.slice(0, 200)}` });
    }
  });
}

startBot();
