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

const CACHE_FILE = '/app/auth/search_cache.json';
const sentByBot = new Set();
let searchSessionKeys = [];

function loadSearchCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { results: [], page: 0, query: '' };
}

function saveSearchCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch (_) {}
}

let searchCache = loadSearchCache();

const YTDLP_COMMON_ARGS = [
  '--no-warnings',
  '--no-playlist',
  '--force-ipv4',
  '--socket-timeout', '15',
  '--retries', '3',
  '--fragment-retries', '3',
  '--concurrent-fragments', '4',
  '--js-runtimes', 'node',
  ...(fs.existsSync('/tmp/cookies.txt') ? ['--cookies', '/tmp/cookies.txt'] : [])
];

function execCmd(bin, args, timeoutMs = 1000 * 60 * 8) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 25, timeout: timeoutMs }, (err, stdout, stderr) => {
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

function runYtDlp(args, timeoutMs = 1000 * 60 * 8) {
  return execCmd('yt-dlp', [...YTDLP_COMMON_ARGS, ...args], timeoutMs);
}

async function downloadDirectFile(url, destPath) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(1000 * 60 * 5) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body), fileStream);
}

function cleanup(targets) {
  const list = Array.isArray(targets) ? targets : [targets];
  for (const f of list) {
    if (f && fs.existsSync(f)) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
  }
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return 'غير محدد';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function getVideoDurationSec(filePath) {
  try {
    const out = await execCmd('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], 15000);
    return parseFloat(out.trim()) || 0;
  } catch (_) {
    return 0;
  }
}

async function splitVideoFile(inputPath, segmentSec, idPrefix) {
  const pattern = `/tmp/part_${idPrefix}_%03d.mp4`;
  await execCmd('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-c', 'copy',
    '-map', '0',
    '-f', 'segment',
    '-segment_time', String(segmentSec),
    '-reset_timestamps', '1',
    '-movflags', '+faststart',
    pattern
  ], 1000 * 60 * 5);

  return fs.readdirSync('/tmp')
    .filter((f) => f.startsWith(`part_${idPrefix}_`) && f.endsWith('.mp4'))
    .sort()
    .map((f) => `/tmp/${f}`);
}

// إنشاء صورة شبكة مصغرات يوتيوب مرقمة (2x3)
async function buildThumbnailGrid(items, startNumber, outGridPath) {
  const tempTiles = [];
  try {
    const count = Math.min(items.length, 6);
    if (count === 0) return false;

    await Promise.all(
      Array.from({ length: 6 }).map(async (_, idx) => {
        const tilePath = `/tmp/tile_${Date.now()}_${idx}.jpg`;
        tempTiles.push(tilePath);

        if (idx < count && items[idx]?.id) {
          const thumbUrl = `https://i.ytimg.com/vi/${items[idx].id}/mqdefault.jpg`;
          try {
            const res = await fetch(thumbUrl, { signal: AbortSignal.timeout(4500) });
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              if (buf.length > 500) {
                fs.writeFileSync(tilePath, buf);
                return;
              }
            }
          } catch (_) {}
        }
        // إطار داكن بديل لأي خانة فارغة
        await execCmd('ffmpeg', [
          '-y', '-f', 'lavfi', '-i', 'color=c=0x161b22:s=320x180:d=1',
          '-frames:v', '1', tilePath
        ], 10000);
      })
    );

    const rows = count <= 2 ? 1 : count <= 4 ? 2 : 3;
    const totalSlots = rows * 2;
    const inputs = [];
    const filterParts = [];
    const layoutCoords = [];

    for (let i = 0; i < totalSlots; i++) {
      inputs.push('-i', tempTiles[i]);
      const col = i % 2;
      const row = Math.floor(i / 2);
      layoutCoords.push(`${col * 320}_${row * 180}`);

      if (i < count) {
        const label = startNumber + i;
        filterParts.push(
          `[${i}:v]scale=320:180:force_original_aspect_ratio=increase,crop=320:180,` +
          `drawbox=x=8:y=8:w=42:h=34:color=black@0.8:t=fill,` +
          `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${label}':fontcolor=white:fontsize=22:x=21:y=14[v${i}]`
        );
      } else {
        filterParts.push(`[${i}:v]scale=320:180[v${i}]`);
      }
    }

    const stackInputs = Array.from({ length: totalSlots }, (_, i) => `[v${i}]`).join('');
    filterParts.push(`${stackInputs}xstack=inputs=${totalSlots}:layout=${layoutCoords.join('|')}[out]`);

    try {
      await execCmd('ffmpeg', [
        '-y', ...inputs,
        '-filter_complex', filterParts.join(';'),
        '-map', '[out]',
        '-q:v', '3',
        outGridPath
      ], 15000);
    } catch (_) {
      // خطة بديلة بدون drawtext إذا لم يتوفر الخط
      const simpleParts = [];
      for (let i = 0; i < totalSlots; i++) {
        simpleParts.push(`[${i}:v]scale=320:180:force_original_aspect_ratio=increase,crop=320:180[v${i}]`);
      }
      simpleParts.push(`${stackInputs}xstack=inputs=${totalSlots}:layout=${layoutCoords.join('|')}[out]`);
      await execCmd('ffmpeg', [
        '-y', ...inputs,
        '-filter_complex', simpleParts.join(';'),
        '-map', '[out]',
        '-q:v', '3',
        outGridPath
      ], 15000);
    }

    return fs.existsSync(outGridPath) && fs.statSync(outGridPath).size > 1000;
  } catch (_) {
    return false;
  } finally {
    cleanup(tempTiles);
  }
}

function parseModifiers(rawMod) {
  const tokens = (rawMod || '')
    .toLowerCase()
    .replace(/([عفقصك])/g, ' $1 ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let quality = '480';
  let splitMode = 'auto'; // auto | split | full

  for (const t of tokens) {
    if (t === 'صوت' || t === 'mp3' || t === 'ص') quality = 'audio';
    else if (t === '360' || t === 'ضعيف') quality = '360';
    else if (t === '480') quality = '480';
    else if (t === '720' || t === 'عالي' || t === 'عالية' || t === 'ع') quality = '720';
    else if (t === '1080' || t === 'فول' || t === 'ف') quality = '1080';
    else if (t === 'مقسم' || t === 'اجزاء' || t === 'أجزاء' || t === 'ق') splitMode = 'split';
    else if (t === 'كامل' || t === 'ك') splitMode = 'full';
  }

  return { quality, splitMode };
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
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      ''
    ).trim();

    if (!text) return;
    if (/^(⏳|🔍|🔎|📥|✅|❌|🎬|✂️|🧹|\*1\.\*|\*7\.\*|رقم غير موجود|لم يتم العثور|لا توجد نتائج)/.test(text)) return;

    const reply = async (content, trackForCleanup = false) => {
      const sent = await sock.sendMessage(remoteJid, content);
      if (sent?.key?.id) {
        sentByBot.add(sent.key.id);
        if (trackForCleanup) searchSessionKeys.push(sent.key);
      }
      return sent;
    };

    const deleteKeys = async (keys) => {
      for (const k of keys) {
        try {
          await sock.sendMessage(remoteJid, { delete: k });
          await new Promise((r) => setTimeout(r, 120));
        } catch (_) {}
      }
    };

    const cleanSearchMessages = async (extraKeys = []) => {
      const toDelete = [...searchSessionKeys, ...extraKeys];
      searchSessionKeys = [];
      if (toDelete.length > 0) await deleteKeys(toDelete);
    };

    const sendMedia = async (url, { quality = '480', splitMode = 'auto' } = {}, customTitle = '', triggerMsgKey = null) => {
      const id = Date.now();
      let outFile = '';
      let splitFiles = [];
      const statusKeys = [];
      if (triggerMsgKey) statusKeys.push(triggerMsgKey);

      try {
        const label = quality === 'audio' ? 'صوت MP3' : `دقة ${quality}p`;
        const statusMsg = await reply({ text: `⏳ جاري التحميل (${label})، انتظر قليلاً...` });
        if (statusMsg?.key) statusKeys.push(statusMsg.key);

        if (quality === 'audio') {
          outFile = `/tmp/audio_${id}.mp3`;
          await runYtDlp([
            '-f', 'ba[ext=m4a]/ba/b',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '128K',
            '-o', outFile,
            url
          ]);

          const sizeMB = fs.statSync(outFile).size / (1024 * 1024);
          const safeName = `${(customTitle || 'audio').replace(/[\\/:*?"<>|]/g, '_')}.mp3`;

          if (sizeMB < 95) {
            await reply({
              audio: { url: outFile },
              mimetype: 'audio/mpeg',
              ptt: false
            });
            await reply({ text: `🎵 *${customTitle || 'تم تحميل الصوت'}* (${sizeMB.toFixed(1)} MB)` });
          } else {
            await reply({
              document: { url: outFile },
              mimetype: 'audio/mpeg',
              fileName: safeName,
              caption: `🎵 ${customTitle || 'تم تحميل الصوت'} (${sizeMB.toFixed(1)} MB)`
            });
          }
          await cleanSearchMessages(statusKeys);
          return;
        }

        // تحميل الفيديو
        outFile = `/tmp/video_${id}.mp4`;
        const maxH = quality;
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
        const durationSec = await getVideoDurationSec(outFile);
        const safeTitle = (customTitle || 'video').replace(/[\\/:*?"<>|]/g, '_');
        const MAX_PART_SEC = 1800; // 30 دقيقة كحد أقصى للجزء
        const MAX_STREAM_MB = 92;  // حد واتساب للفيديو القابل للتشغيل المباشر

        const needsSplit =
          splitMode === 'split' ||
          (splitMode === 'auto' && (durationSec > MAX_PART_SEC || sizeMB > MAX_STREAM_MB));

        if (needsSplit && durationSec > 60) {
          // حساب مدة كل جزء بحيث لا تتجاوز 30 دقيقة ولا يتجاوز حجم الجزء 88 MB
          let segSec = MAX_PART_SEC;
          if (sizeMB > MAX_STREAM_MB && durationSec > 0) {
            const bySizeSec = Math.floor((durationSec * 85) / sizeMB);
            segSec = Math.max(240, Math.min(MAX_PART_SEC, bySizeSec));
          }

          const splitNotice = await reply({
            text: `✂️ الفيديو طويل (${formatDuration(durationSec)} | ${sizeMB.toFixed(1)} MB)، جاري تقسيمه إلى أجزاء قابلة للتشغيل الفوري...`
          });
          if (splitNotice?.key) statusKeys.push(splitNotice.key);

          splitFiles = await splitVideoFile(outFile, segSec, id);

          if (splitFiles.length > 1) {
            for (let i = 0; i < splitFiles.length; i++) {
              const partPath = splitFiles[i];
              const partMB = fs.statSync(partPath).size / (1024 * 1024);
              const partLabel = `الجزء ${i + 1} من ${splitFiles.length}`;

              if (partMB < 95) {
                await reply({
                  video: { url: partPath },
                  caption: `🎬 *${customTitle || 'فيديو'}*\n📌 ${partLabel} [${maxH}p] (${partMB.toFixed(1)} MB)`
                });
              } else {
                await reply({
                  document: { url: partPath },
                  mimetype: 'video/mp4',
                  fileName: `${safeTitle}_part${i + 1}.mp4`,
                  caption: `🎬 ${customTitle || 'فيديو'} — ${partLabel} [${maxH}p] (${partMB.toFixed(1)} MB)`
                });
              }
            }
            await cleanSearchMessages(statusKeys);
            return;
          }
        }

        // إرسال كفيديو واحد (مباشر إذا أقل من 95 MB أو كملف إذا اختار "كامل" وتجاوز الحد)
        if (sizeMB < 95) {
          await reply({
            video: { url: outFile },
            caption: `✅ *${customTitle || 'تم التحميل'}* [${maxH}p] (${sizeMB.toFixed(1)} MB)`
          });
        } else {
          await reply({
            document: { url: outFile },
            mimetype: 'video/mp4',
            fileName: `${safeTitle}.mp4`,
            caption: `✅ ${customTitle || 'تم التحميل'} [${maxH}p] (${sizeMB.toFixed(1)} MB)`
          });
        }

        await cleanSearchMessages(statusKeys);
      } catch (err) {
        await reply({ text: `❌ تعذر التحميل:\n${err.message.slice(0, 320)}` });
      } finally {
        cleanup(outFile);
        cleanup(splitFiles);
      }
    };

    const showSearchPage = async (pageIndex) => {
      const perPage = 6;
      const start = pageIndex * perPage;
      const slice = searchCache.results.slice(start, start + perPage);

      if (!slice.length) {
        return reply({ text: 'لا توجد نتائج إضافية لهذا البحث.' }, true);
      }

      const gridPath = `/tmp/grid_${Date.now()}.jpg`;
      const hasGrid = await buildThumbnailGrid(slice, start + 1, gridPath);

      const listLines = slice.map((v, i) => {
        const num = start + i + 1;
        return `*${num}.* ${v.title}\n   📺 ${v.uploader || 'YouTube'} | ⏱ ${formatDuration(v.duration)}`;
      });

      const hasMore = searchCache.results.length > start + perPage;
      const footer =
        `\n━━━━━━━━━━━━━━\n` +
        `⚡ *طريقة الطلب السريعة:*\n` +
        `• *${start + 1}* ⬅️ فيديو مباشر (480p)\n` +
        `• *${start + 1}ع* أو *${start + 1} 720* ⬅️ دقة عالية HD\n` +
        `• *${start + 1}ف* أو *${start + 1} 1080* ⬅️ فول HD\n` +
        `• *${start + 1}ص* أو *${start + 1} صوت* ⬅️ صوت MP3\n` +
        `• *${start + 1}ق* أو *${start + 1} مقسم* ⬅️ تقسيم 30 دقيقة\n` +
        `• *${start + 1}ك* أو *${start + 1} كامل* ⬅️ ملف واحد كامل\n` +
        `• *صورة ${start + 1}* ⬅️ عرض صورة وتفاصيل الفيديو` +
        (hasMore ? `\n• *المزيد* ⬅️ عرض النتائج من ${start + perPage + 1} إلى ${Math.min(searchCache.results.length, start + perPage * 2)}` : '');

      const captionText = `${listLines.join('\n\n')}${footer}`;

      if (hasGrid) {
        await reply({ image: { url: gridPath }, caption: captionText }, true);
        cleanup(gridPath);
      } else {
        await reply({ text: captionText }, true);
      }
    };

    // أمر تنظيف رسائل البحث يدوياً
    if (/^(مسح|تنظيف)$/i.test(text)) {
      await cleanSearchMessages([msg.key]);
      await reply({ text: '🧹 تم تنظيف رسائل البحث.' });
      return;
    }

    // عرض المزيد من النتائج
    if (/^(المزيد|بعد|التالي)$/i.test(text) && searchCache.results.length > 0) {
      searchSessionKeys.push(msg.key);
      const nextPage = searchCache.page + 1;
      if (nextPage * 6 >= searchCache.results.length) {
        return reply({ text: 'وصلت إلى نهاية نتائج البحث.' }, true);
      }
      searchCache.page = nextPage;
      saveSearchCache(searchCache);
      await showSearchPage(nextPage);
      return;
    }

    // معاينة صورة وتفاصيل فيديو محدد قبل تحميله (مثلاً: صورة 2 أو تفاصيل 2)
    const previewMatch = text.match(/^(?:صورة|صوره|معاينة|معاينه|تفاصيل)\s*([1-9]|1[0-2])$/i);
    if (previewMatch) {
      searchSessionKeys.push(msg.key);
      if (!searchCache.results.length) {
        return reply({ text: 'ابحث عن اسم فيديو أولاً لعرض تفاصيله.' }, true);
      }
      const idx = parseInt(previewMatch[1], 10) - 1;
      const item = searchCache.results[idx];
      if (!item) return reply({ text: 'رقم غير موجود في القائمة.' }, true);

      const hdThumb = `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`;
      const infoCaption =
        `🎬 *${item.title}*\n` +
        `📺 القناة: ${item.uploader || 'YouTube'}\n` +
        `⏱ المدة: ${formatDuration(item.duration)}\n\n` +
        `للتحميل أرسل: *${idx + 1}* (فيديو) أو *${idx + 1}ع* (720p) أو *${idx + 1}ص* (صوت)`;

      try {
        await reply({ image: { url: hdThumb }, caption: infoCaption }, true);
      } catch (_) {
        await reply({ text: infoCaption }, true);
      }
      return;
    }

    // 1. اختيار رقم من نتائج البحث (يدعم 1 إلى 12 مع أي اختصار مثل 1ع، 1ص، 1 720 مقسم، إلخ)
    const pickMatch = text.match(/^([1-9]|1[0-2])(?:\s*([عفقصك]|360|480|720|1080|صوت|mp3|عالي|عالية|فول|ضعيف|مقسم|اجزاء|أجزاء|كامل)(?:\s+(?:360|480|720|1080|صوت|mp3|عالي|عالية|فول|ضعيف|مقسم|اجزاء|أجزاء|كامل|[عفقصك]))*)?$/i);
    if (pickMatch) {
      if (!searchCache.results.length) {
        return reply({ text: 'قائمة البحث فارغة حالياً، اكتب اسم الفيديو للبحث أولاً.' });
      }
      const idx = parseInt(pickMatch[1], 10) - 1;
      const item = searchCache.results[idx];
      if (!item) return reply({ text: 'رقم غير موجود في القائمة.' });

      const restText = text.slice(pickMatch[1].length);
      const options = parseModifiers(restText);
      const videoUrl = `https://www.youtube.com/watch?v=${item.id}`;
      await sendMedia(videoUrl, options, item.title, msg.key);
      return;
    }

    // 2. أي رابط مباشر (يدعم إضافة الدقة أو الصوت أو التقسيم بجانب الرابط)
    if (text.startsWith('http://') || text.startsWith('https://')) {
      const parts = text.split(/\s+/);
      const url = parts[0];
      const isDirectFile = /\.(zip|rar|7z|apk|ipa|pdf|exe|dmg|iso|mp3)(\?.*)?$/i.test(url);

      if (isDirectFile) {
        const tempFile = `/tmp/file_${Date.now()}_${path.basename(new URL(url).pathname) || 'download.bin'}`;
        const statusMsg = await reply({ text: '📥 جاري سحب الملف المباشر...' });
        try {
          await downloadDirectFile(url, tempFile);
          await reply({
            document: { url: tempFile },
            mimetype: 'application/octet-stream',
            fileName: path.basename(tempFile).replace(/^file_\d+_/, '')
          });
          if (statusMsg?.key) await deleteKeys([statusMsg.key]);
        } catch (err) {
          await reply({ text: `❌ فشل تحميل الملف: ${err.message}` });
        } finally {
          cleanup(tempFile);
        }
      } else {
        const options = parseModifiers(parts.slice(1).join(' '));
        await sendMedia(url, options, '', msg.key);
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
      const searchNotice = await reply({ text: `🔎 جاري جلب أحدث فيديو لـ: "${query}"...` }, true);
      try {
        const raw = await runYtDlp([
          `ytsearch5:${query}`,
          '--dump-json',
          '--flat-playlist'
        ], 30000);

        const validItems = raw
          .trim()
          .split('\n')
          .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
          .filter((v) => v && v.id && v.id.length === 11 && v.title);

        if (!validItems.length) {
          return reply({ text: 'لم يتم العثور على فيديو مطابق.' });
        }

        const item = validItems[0];
        if (searchNotice?.key) searchSessionKeys.push(searchNotice.key);
        await sendMedia(`https://www.youtube.com/watch?v=${item.id}`, { quality: '480', splitMode: 'auto' }, item.title, msg.key);
      } catch (err) {
        await reply({ text: `❌ تعذر جلب الفيديو: ${err.message.slice(0, 250)}` });
      }
      return;
    }

    // 4. البحث في يوتيوب وعرض شبكة الصور المصغرة
    const query = text.replace(/^بحث\s+/, '').trim();
    searchSessionKeys = [msg.key];
    await reply({ text: `🔍 جاري البحث في يوتيوب عن: "${query}"...` }, true);

    try {
      const raw = await runYtDlp([
        `ytsearch15:${query}`,
        '--dump-json',
        '--flat-playlist'
      ], 35000);

      const seenIds = new Set();
      const parsed = raw
        .trim()
        .split('\n')
        .map((line) => { try { return JSON.parse(line); } catch (_) { return null; } })
        .filter((v) => {
          if (!v || !v.id || v.id.length !== 11 || !v.title) return false;
          if (seenIds.has(v.id)) return false;
          seenIds.add(v.id);
          return true;
        })
        .slice(0, 12)
        .map((v) => ({
          id: v.id,
          title: v.title,
          duration: v.duration || 0,
          uploader: v.uploader || v.channel || ''
        }));

      if (!parsed.length) {
        await cleanSearchMessages();
        return reply({ text: '🥴 لم يتم العثور على نتائج لهذا البحث، جرّب كلمات أوضح.' });
      }

      searchCache = { results: parsed, page: 0, query };
      saveSearchCache(searchCache);
      await showSearchPage(0);
    } catch (err) {
      await reply({ text: `🙂‍↔️ فشل البحث: ${err.message.slice(0, 250)}` });
    }
  });
}

startBot();
