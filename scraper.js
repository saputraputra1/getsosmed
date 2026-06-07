/**
 * Media Scraper Module — v3 (Multi-Platform)
 * Mendukung: Instagram, TikTok, YouTube, Facebook
 * Menggunakan yt-dlp sebagai engine utama (andal & selalu diupdate)
 * dengan fallback ke oEmbed untuk Instagram.
 */

const { execFile, exec } = require("child_process");
const axios = require("axios");
const Tiktok = require("@tobyg74/tiktok-api-dl");

// ─── Platform Detection ─────────────────────────────────────────────────────

/**
 * Daftar platform yang didukung beserta pola URL-nya.
 */
const PLATFORMS = {
  instagram: {
    name: "Instagram",
    icon: "📸",
    hostPatterns: [/^(www\.)?instagram\.com$/],
    pathPatterns: [
      /\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/,
      /\/stories\/[\w.]+/,  // Instagram Stories
    ],
    requiresPath: true,  // harus punya path valid
  },
  tiktok: {
    name: "TikTok",
    icon: "🎵",
    hostPatterns: [
      /^(www\.)?tiktok\.com$/,
      /^vm\.tiktok\.com$/,           // short link
      /^vt\.tiktok\.com$/,           // short link variant
      /^m\.tiktok\.com$/,
    ],
    pathPatterns: [
      /\/@[\w.]+\/video\/(\d+)/,     // @user/video/1234
      /\/v\/(\d+)/,                  // /v/1234
      /^\/[A-Za-z0-9]+$/,           // short link /ZMxxxxxx
    ],
    requiresPath: false,
  },
  youtube: {
    name: "YouTube",
    icon: "▶️",
    hostPatterns: [
      /^(www\.)?youtube\.com$/,
      /^m\.youtube\.com$/,
      /^youtu\.be$/,
      /^music\.youtube\.com$/,
    ],
    pathPatterns: [
      /\/watch\?/,                   // /watch?v=xxx
      /\/shorts\/[\w-]+/,           // /shorts/xxx
      /^\/[\w-]{11}$/,              // youtu.be/xxx (11 char ID)
    ],
    requiresPath: false,
  },
  facebook: {
    name: "Facebook",
    icon: "👤",
    hostPatterns: [
      /^(www\.)?facebook\.com$/,
      /^m\.facebook\.com$/,
      /^web\.facebook\.com$/,
      /^fb\.watch$/,                 // short video links
      /^(www\.)?fb\.com$/,
    ],
    pathPatterns: [
      /\/(watch|videos|reel|share)\//,
      /\/posts\//,
      /\/photo/,
      /\/story\.php/,
      /^\/[\w.]+\/videos\//,
      /^\/\w+$/,                     // fb.watch/xxx
    ],
    requiresPath: false,
  },
  twitter: {
    name: "Twitter",
    icon: "🐦",
    hostPatterns: [
      /^(www\.)?twitter\.com$/,
      /^(www\.)?x\.com$/,
    ],
    pathPatterns: [/\/status\/\d+/],
    requiresPath: true,
  },
  spotify: {
    name: "Spotify",
    icon: "🎧",
    hostPatterns: [/^open\.spotify\.com$/],
    pathPatterns: [/\/track\/[a-zA-Z0-9]+/],
    requiresPath: true,
  },
  pinterest: {
    name: "Pinterest",
    icon: "📌",
    hostPatterns: [
      /^(www\.)?pinterest\.(com|co\.uk|de|fr|es|it|ca|com\.au|co\.kr|jp|at|ch|com\.mx|pt|se|nz|ph|ie|cl|co\.in)$/,
      /^pin\.it$/,
      /^(www\.)?pinterest\.\w+$/,
    ],
    pathPatterns: [
      /\/pin\/\d+/,
      /^\/[a-zA-Z0-9]+$/, // for pin.it shortlinks
    ],
    requiresPath: false,
  },
};

/**
 * Deteksi platform dari URL.
 * @returns {{ platform: string, config: object } | null}
 */
function detectPlatform(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase();

    for (const [key, config] of Object.entries(PLATFORMS)) {
      const hostMatch = config.hostPatterns.some((pat) => pat.test(host));
      if (hostMatch) {
        // Kalau platform butuh path validation
        if (config.requiresPath) {
          const fullPath = parsed.pathname + parsed.search;
          const pathMatch = config.pathPatterns.some((pat) => pat.test(fullPath));
          if (!pathMatch) return null;
        }
        return { platform: key, config };
      }
    }
  } catch {
    // URL tidak valid
  }
  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Cek apakah URL adalah Instagram Story URL.
 */
function isInstagramStoryUrl(url) {
  return /instagram\.com\/stories\//i.test(url);
}

function extractShortcode(url) {
  const patterns = [
    /instagram\.com\/p\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reel\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reels\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/tv\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/stories\/[\w.]+\/([A-Za-z0-9_-]+)/,  // story ID
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  return null;
}

function runCommand(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    // Gabungkan cmd dan args menjadi satu string untuk dijalankan melalui shell.
    // Ini diperlukan di Windows agar Python Scripts (yt-dlp) bisa ditemukan via PATH.
    const fullCmd = [cmd, ...args.map(a => `"${a}"`)].join(' ');
    let settled = false;

    const proc = exec(fullCmd, { timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (err) {
        if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
          return reject(new Error(`Command timeout setelah ${Math.round(timeout / 1000)} detik`));
        }
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout.trim());
    });

    // Safety net: jika callback tidak terpanggil setelah timeout + 5 detik
    const safetyTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { proc.kill('SIGKILL'); } catch (_) {}
        reject(new Error(`Command timeout (safety) setelah ${Math.round(timeout / 1000)} detik`));
      }
    }, timeout + 5000);

    // Bersihkan timer jika proses selesai normal
    proc.on('exit', () => clearTimeout(safetyTimeout));
  });
}

// ─── Cek apakah yt-dlp tersedia ─────────────────────────────────────────────

async function checkYtDlp() {
  try {
    await runCommand("yt-dlp", ["--version"], 5000);
    return true;
  } catch {
    return false;
  }
}

// ─── yt-dlp scraping (multi-platform) ───────────────────────────────────────

/**
 * Menggunakan yt-dlp --dump-json untuk mengambil semua metadata
 * tanpa mengunduh file. yt-dlp menangani semua seluk-beluk setiap platform
 * (cookie, header, rotasi endpoint) secara otomatis.
 *
 * @param {string} url - URL media
 * @param {string} platform - Nama platform (instagram, tiktok, youtube, facebook)
 */
async function scrapeViaYtDlp(url, platform = "instagram") {
  console.log(`[Scraper] Mencoba yt-dlp untuk ${platform}...`);

  // Spotify Intercept: Fetch title then search on YouTube
  let targetUrl = url;
  if (platform === "spotify") {
    console.log(`[Scraper] Intercepting Spotify URL untuk mendapatkan judul...`);
    try {
      const spRes = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      const titleMatch = spRes.data.match(/<title>(.*?)<\/title>/);
      if (titleMatch && titleMatch[1]) {
        let title = titleMatch[1];
        // Bersihkan title, misal: "Nama Lagu - song and lyrics by Artis | Spotify"
        title = title.replace(/ - song and lyrics by /i, " ");
        title = title.replace(/ \| Spotify/i, "");
        console.log(`[Scraper] Spotify Title ditemukan: ${title}`);
        targetUrl = `ytsearch1:${title}`;
      } else {
        throw new Error("Tidak dapat menemukan judul lagu dari Spotify.");
      }
    } catch (e) {
      throw new Error("Gagal mengambil metadata Spotify: " + e.message);
    }
  }

  const args = [
    "--dump-single-json",
    "--no-warnings",
  ];

  // Deteksi apakah URL mengarah ke Playlist / Profil
  const isPlaylist = url.match(/(\/user\/|\/c\/|\/channel\/|@|list=|playlist\/|\/collection\/)/i) !== null;
  
  if (isPlaylist) {
    console.log(`[Scraper] Mendeteksi URL Playlist/Profil. Mengambil maksimal 10 video...`);
    args.push("--yes-playlist");
    args.push("--playlist-end", "10"); 
  } else {
    args.push("--no-playlist");
  }

  // Argumen spesifik per platform
  switch (platform) {
    case "instagram":
      args.push("--extractor-args", "instagram:direct_video_url=true");
      break;

    case "youtube":
      break;

    case "tiktok":
      args.push("--add-header", "User-Agent:Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
      break;

    case "facebook":
    case "twitter":
    case "pinterest":
      break;
      
    case "spotify":
      args.push("-f", "bestaudio[ext=m4a]/bestaudio/best");
      break;
  }

  args.push(targetUrl);

  // YouTube/Facebook mungkin butuh waktu lebih lama
  const timeout = (platform === "youtube" || platform === "facebook") ? 90000 : 60000;
  const raw = await runCommand("yt-dlp", args, timeout);
  const info = JSON.parse(raw);

  return parseYtDlpOutput(info, platform);
}

/**
 * Konversi output yt-dlp ke format internal yang dipakai server & frontend
 */
function parseYtDlpOutput(info, platform = "instagram") {
  const result = {
    platform,
    type: "unknown",
    shortcode: info.id || "",
    author: info.uploader || info.channel || info.creator || "unknown",
    caption: info.description || info.title || "",
    title: info.title || "",
    timestamp: info.timestamp || null,
    likeCount: info.like_count || 0,
    commentCount: info.comment_count || 0,
    viewCount: info.view_count || 0,
    duration: info.duration || null,
    mediaItems: [],
    source: "ytdlp",
  };

  // Carousel/playlist: yt-dlp mengembalikan field "entries"
  if (info.entries && info.entries.length > 0) {
    result.type = "playlist";
    result.mediaItems = info.entries.map((entry) =>
      extractMediaItem(entry)
    );
  }
  // Single video/photo
  else {
    const item = extractMediaItem(info);
    result.type = item.type === "video" ? "video" : "image";
    result.mediaItems = [item];
  }

  return result;
}

/**
 * Ekstrak URL terbaik dari satu entry yt-dlp
 * Prioritas: format kualitas tertinggi → url langsung → thumbnail
 */
function extractMediaItem(entry) {
  const isVideo = entry.ext === "mp4" || entry.ext === "webm" ||
    entry._type === "video" ||
    (entry.formats && entry.formats.some((f) => f.vcodec !== "none"));

  // Pilih format terbaik untuk video
  let bestUrl = entry.url;
  let availableFormats = [];

  // ─── Penanganan khusus FOTO ───
  // Jika bukan video, cari URL gambar dari berbagai field yang mungkin tersedia
  if (!isVideo) {
    // Coba ambil URL gambar dari berbagai sumber
    let imageUrl = entry.url || null;

    // Jika url kosong, gunakan thumbnail sebagai URL gambar utama
    if (!imageUrl && entry.thumbnail) {
      imageUrl = entry.thumbnail;
    }

    // Jika masih kosong, cek array thumbnails (resolusi tertinggi)
    if (!imageUrl && entry.thumbnails && entry.thumbnails.length > 0) {
      const sorted = [...entry.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
      imageUrl = sorted[0].url || sorted[0];
    }

    // Jika ada formats, cek apakah ada format gambar di sana
    if (entry.formats && entry.formats.length > 0) {
      const imgFormats = entry.formats.filter(
        (f) => f.url && (f.ext === 'jpg' || f.ext === 'jpeg' || f.ext === 'png' || f.ext === 'webp' || f.vcodec === 'none')
      );
      if (imgFormats.length > 0) {
        // Pilih resolusi tertinggi
        imgFormats.sort((a, b) => (b.width || 0) - (a.width || 0));
        imageUrl = imgFormats[0].url;
      }
    }

    if (imageUrl) {
      bestUrl = imageUrl;
      // Tentukan ekstensi dari URL
      let imgExt = entry.ext || 'jpg';
      if (imageUrl.includes('.png')) imgExt = 'png';
      else if (imageUrl.includes('.webp')) imgExt = 'webp';
      else if (imageUrl.includes('.jpg') || imageUrl.includes('.jpeg')) imgExt = 'jpg';

      availableFormats.push({
        type: 'image',
        quality: 'Original',
        url: imageUrl,
        ext: imgExt
      });
    }

    // Return early untuk foto, tidak perlu proses video formats
    let thumb = entry.thumbnail || null;
    if (!thumb && entry.thumbnails && entry.thumbnails.length > 0) {
      const sorted = [...entry.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
      thumb = sorted[0].url || sorted[0];
    }
    const finalUrl = bestUrl || imageUrl || thumb || "";
    if (!thumb) thumb = finalUrl;

    // Jika sama sekali kosong, set flag agar bisa di-retry
    if (availableFormats.length === 0 && finalUrl) {
      availableFormats.push({
        type: 'image',
        quality: 'Default',
        url: finalUrl,
        ext: entry.ext || 'jpg'
      });
    }

    return {
      type: "image",
      url: finalUrl,
      thumbnail: thumb || finalUrl,
      width: entry.width || null,
      height: entry.height || null,
      duration: null,
      ext: entry.ext || 'jpg',
      formats: availableFormats
    };
  }

  // ─── Penanganan VIDEO (kode asli) ───
  if (isVideo && entry.formats && entry.formats.length > 0) {
    // Format dengan video codec terbaik yang JUGA memiliki audio dan BUKAN playlist (HLS/DASH)
    const videoFormats = entry.formats.filter(
      (f) => f.vcodec !== "none" && f.acodec !== "none" && f.url && f.ext === "mp4" && f.protocol && f.protocol.startsWith('http')
    );
    if (videoFormats.length > 0) {
      // Sort by height descending, ambil yang terbesar
      videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));
      bestUrl = videoFormats[0].url;

      // Kumpulkan resolusi unik
      const seenResolutions = new Set();
      videoFormats.forEach(f => {
        const res = f.height ? `${f.height}p` : 'HD';
        if (!seenResolutions.has(res)) {
          seenResolutions.add(res);
          availableFormats.push({
            type: 'video',
            quality: res,
            url: f.url,
            ext: f.ext
          });
        }
      });
    }

    // Ekstrak audio format jika ada (audio only) dan bukan playlist
    const audioFormats = entry.formats.filter(
      (f) => f.vcodec === "none" && f.url && f.protocol && f.protocol.startsWith('http')
    );
    let bestAudioUrl = null;
    if (audioFormats.length > 0) {
      // Sort by abr (audio bitrate) descending
      audioFormats.sort((a, b) => (b.abr || 0) - (a.abr || 0));
      bestAudioUrl = audioFormats[0].url;
      availableFormats.push({
        type: 'audio',
        quality: 'Audio',
        url: audioFormats[0].url,
        ext: audioFormats[0].ext === 'm4a' ? 'm4a' : 'mp3'
      });
    }

    // ─── Format Video-Only 1080p+ (needsMerge) ───
    if (bestAudioUrl) {
      const videoOnlyFormats = entry.formats.filter(
        (f) => f.vcodec !== "none" && f.acodec === "none" && f.url &&
               f.protocol && f.protocol.startsWith('http') &&
               (f.height || 0) >= 1080
      );
      const seenMergeRes = new Set();
      const existingRes = new Set(availableFormats.filter(f => f.type === 'video').map(f => f.quality));
      videoOnlyFormats.sort((a, b) => (b.height || 0) - (a.height || 0));
      videoOnlyFormats.forEach(f => {
        const res = f.height ? `${f.height}p` : 'HD';
        if (!seenMergeRes.has(res) && !existingRes.has(res)) {
          seenMergeRes.add(res);
          availableFormats.push({
            type: 'video',
            quality: `${res} HD`,
            url: f.url,
            ext: 'mp4',
            needsMerge: true,
            audioUrl: bestAudioUrl
          });
        }
      });
    }
  }

  // Jika tidak ada format yang tersaring tapi ada URL, jadikan default
  if (availableFormats.length === 0 && entry.url) {
    availableFormats.push({
      type: 'video',
      quality: 'Default',
      url: entry.url,
      ext: entry.ext || "mp4"
    });
  }

  // Fallback tambahan: jika video, dan yt-dlp tidak memberi audio-only track,
  // beri pseudo-audio option (menggunakan URL video utama)
  if (isVideo && !availableFormats.some(f => f.type === 'audio')) {
    availableFormats.push({
      type: 'audio',
      quality: 'Audio',
      url: bestUrl || entry.url,
      ext: 'mp3'
    });
  }

  // Ambil thumbnail terbaik
  let thumb = entry.thumbnail || null;
  if (!thumb && entry.thumbnails && entry.thumbnails.length > 0) {
    const sorted = [...entry.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    thumb = sorted[0].url || sorted[0];
  }
  let finalUrl = bestUrl || entry.url;
  if (!finalUrl && availableFormats.length > 0) {
    finalUrl = availableFormats[0].url;
  }
  if (!thumb) thumb = finalUrl;

  return {
    type: "video",
    url: finalUrl || "",
    thumbnail: thumb,
    width: entry.width || null,
    height: entry.height || null,
    duration: entry.duration || null,
    ext: entry.ext || "mp4",
    formats: availableFormats
  };
}

// ─── Metode 2: oEmbed (fallback khusus Instagram) ────────────────────────────

/**
 * oEmbed hanya bisa dapat thumbnail (bukan video asli).
 * Dipakai sebagai last-resort kalau yt-dlp tidak terinstall.
 * Hanya mendukung Instagram.
 */
async function scrapeViaOEmbed(url) {
  console.log("[Scraper] Mencoba oEmbed API (data terbatas)...");

  const oembedUrl = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}&maxwidth=640`;
  const response = await axios.get(oembedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MediaGet/3.0)",
    },
    timeout: 10000,
  });

  const d = response.data;
  return {
    platform: "instagram",
    type: "image",
    shortcode: "",
    author: d.author_name || "unknown",
    caption: d.title || "",
    title: d.title || "",
    timestamp: null,
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    duration: null,
    mediaItems: [
      {
        type: "image",
        url: d.thumbnail_url,
        thumbnail: d.thumbnail_url,
        width: d.thumbnail_width,
        height: d.thumbnail_height,
        ext: "jpg",
      },
    ],
    source: "oembed",
    warning:
      "⚠️ yt-dlp tidak terinstall — hanya thumbnail yang tersedia. " +
      "Install yt-dlp untuk mengunduh video resolusi penuh.",
  };
}

// ─── TikTok & Facebook retry dengan cookies browser ──────────────────────────

async function scrapeViaCookiesRetry(url, platform) {
  console.log(`[Scraper] Mencoba yt-dlp ${platform} dengan cookies browser...`);

  // Coba beberapa browser yang umum digunakan
  const browsers = ["chrome", "edge", "firefox", "brave"];
  for (const browser of browsers) {
    try {
      const args = [
        "--dump-single-json",
        "--no-warnings",
        "--no-playlist",
        "--cookies-from-browser", browser,
        url,
      ];
      
      // Khusus TikTok, gunakan User-Agent mobile
      if (platform === "tiktok") {
        args.push("--add-header", "User-Agent:Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
      }

      const raw = await runCommand("yt-dlp", args, 60000);
      const info = JSON.parse(raw);
      console.log(`[Scraper] Berhasil dengan cookies dari ${browser}`);
      return parseYtDlpOutput(info, platform);
    } catch (err) {
      console.warn(`[Scraper] Cookies ${browser} gagal: ${err.message.substring(0, 80)}`);
    }
  }
  throw new Error(`Semua metode cookies browser gagal untuk ${platform}`);
}

// ─── RapidAPI Instagram (Cobalt wrapper) ──────────────────────────────────────

async function scrapeViaRapidAPI(url) {
  console.log("[Scraper] Mencoba RapidAPI untuk Instagram...");

  const options = {
    method: 'GET',
    url: 'https://instagram-post-reels-stories-downloader-api.p.rapidapi.com/instagram/',
    params: { url: url },
    headers: {
      'x-rapidapi-host': 'instagram-post-reels-stories-downloader-api.p.rapidapi.com',
      'x-rapidapi-key': '29be28c9fbmsh38d097de4f364c3p10b509jsn3a0f41eb7e83',
      'Content-Type': 'application/json'
    },
    timeout: 15000
  };

  const response = await axios.request(options);
  const data = response.data;

  if (!data || data.status !== true || !data.result || !Array.isArray(data.result)) {
    throw new Error(data.message || "RapidAPI tidak mengembalikan hasil valid");
  }

  const mediaItems = [];
  let hasVideo = false;

  data.result.forEach((item, index) => {
    const isVideo = item.type && item.type.includes('video');
    const isImage = item.type && item.type.includes('image');
    if (isVideo) hasVideo = true;

    const ext = isVideo ? 'mp4' : 'jpg';
    mediaItems.push({
      type: isVideo ? "video" : "image",
      url: item.url,
      thumbnail: item.thumb || item.url,
      width: null,
      height: null,
      duration: null,
      ext: ext,
      formats: [
        { type: isVideo ? "video" : "image", quality: `Media ${index + 1}`, url: item.url, ext: ext }
      ]
    });
  });

  return {
    platform: "instagram",
    type: hasVideo ? "video" : "playlist",
    shortcode: extractShortcode(url) || "rapidapi",
    author: "Instagram User",
    caption: "",
    title: "",
    timestamp: null,
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    duration: null,
    mediaItems: mediaItems,
    source: "rapidapi",
    warning: null
  };
}

// ─── Playwright Instagram Fallback ──────────────────────────────────────────────

async function scrapeInstagramViaPlaywright(url) {
  let browser;
  try {
    const { chromium } = require('playwright');
    console.log("[Scraper] Mencoba Playwright untuk Instagram foto...");
    
    // Launch browser (tambahkan headless: true jika sudah production)
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    
    // Cegah resource berat untuk mempercepat
    await page.route('**/*.{woff,woff2,ttf,js}', route => route.abort());

    // Pergi ke URL post IG
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    
    // Tunggu sebentar untuk pastikan gambar muncul (jika bukan login wall)
    await page.waitForTimeout(4000);

    // Ambil gambar yang memuat konten asli (scontent)
    const images = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs
        .map(img => img.src)
        .filter(src => src && src.includes('scontent') && !src.includes('profile_pic'));
    });

    if (!images || images.length === 0) {
      throw new Error("Gambar tidak ditemukan via Playwright. Mungkin diblokir login wall Instagram.");
    }

    const uniqueImages = [...new Set(images)];
    const mediaItems = uniqueImages.map((imgUrl, idx) => {
      return {
        type: "image",
        url: imgUrl,
        thumbnail: imgUrl,
        width: null,
        height: null,
        duration: null,
        ext: 'jpg',
        formats: [
          { type: "image", quality: `Foto ${idx + 1}`, url: imgUrl, ext: 'jpg' }
        ]
      };
    });

    return {
      platform: "instagram",
      type: mediaItems.length > 1 ? "playlist" : "image",
      shortcode: extractShortcode(url) || "playwright",
      author: "Instagram User",
      caption: "",
      title: "",
      timestamp: null,
      likeCount: 0,
      commentCount: 0,
      viewCount: 0,
      duration: null,
      mediaItems: mediaItems,
      source: "playwright",
      warning: null
    };
  } catch (err) {
    throw new Error("Playwright gagal: " + err.message);
  } finally {
    if (browser) {
      await browser.close().catch(console.error);
    }
  }
}

// ─── TikTok TikWM API fallback ─────────────────────────────────────────────────

async function scrapeViaTikwmAPI(url) {
  console.log("[Scraper] Mencoba TikWM API...");

  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
  const response = await axios.get(apiUrl, { timeout: 15000 });

  const data = response.data;
  if (!data || data.code !== 0 || !data.data) {
    throw new Error("TikWM API tidak mengembalikan data yang valid");
  }

  const item = data.data;
  
  // TikWM memberikan direct MP4 URL tanpa watermark (item.play)
  // dan audio MP3 (item.music)
  const isVideo = !!item.play;
  const isImage = !!item.images; // Photo slide
  
  const mediaItems = [];
  
  if (isVideo) {
    mediaItems.push({
      type: "video",
      url: item.play,
      thumbnail: item.cover,
      width: null,
      height: null,
      duration: item.duration || null,
      ext: "mp4",
      formats: [
        { type: "video", quality: "No Watermark", url: item.play, ext: "mp4" },
        ...(item.music ? [{ type: "audio", quality: "Audio", url: item.music, ext: "mp3" }] : [])
      ]
    });
  } else if (isImage && item.images.length > 0) {
    item.images.forEach((imgUrl, i) => {
      mediaItems.push({
        type: "image",
        url: imgUrl,
        thumbnail: imgUrl,
        width: null,
        height: null,
        duration: null,
        ext: "jpg",
        formats: [
          { type: "image", quality: `Image ${i+1}`, url: imgUrl, ext: "jpg" }
        ]
      });
    });
  } else {
    throw new Error("Tipe media tidak dikenali oleh TikWM API");
  }

  return {
    platform: "tiktok",
    type: isVideo ? "video" : "playlist",
    shortcode: item.id || "",
    author: item.author?.unique_id || "unknown",
    caption: item.title || "",
    title: item.title || "",
    timestamp: item.create_time || null,
    likeCount: item.digg_count || 0,
    commentCount: item.comment_count || 0,
    viewCount: item.play_count || 0,
    duration: item.duration || null,
    mediaItems: mediaItems,
    source: "tikwm",
    warning: null
  };
}

// ─── @tobyg74/tiktok-api-dl (Tiktok Downloader) ──────────────────────────────
async function scrapeViaTikTokApiDl(url) {
  console.log("[Scraper] Mencoba @tobyg74/tiktok-api-dl...");
  
  // Downloader bisa meng-handle video & image slide
  const data = await Tiktok.Downloader(url, { version: "v1" });
  if (!data || data.status !== "success" || !data.result) {
    throw new Error(data?.message || "tiktok-api-dl tidak mengembalikan data yang valid");
  }

  const res = data.result;
  const isVideo = res.type === "video";
  const isImage = res.type === "image";
  const mediaItems = [];

  if (isVideo && res.video) {
    // Video type
    const playAddr = res.video.playAddr && res.video.playAddr[0] ? res.video.playAddr[0] : null;
    const downloadAddr = res.video.downloadAddr && res.video.downloadAddr[0] ? res.video.downloadAddr[0] : null;
    const cover = res.video.cover && res.video.cover[0] ? res.video.cover[0] : null;

    if (downloadAddr || playAddr) {
      mediaItems.push({
        type: "video",
        url: downloadAddr || playAddr,
        thumbnail: cover,
        width: null,
        height: null,
        duration: null,
        ext: "mp4",
        formats: [
          { type: "video", quality: "No Watermark", url: downloadAddr || playAddr, ext: "mp4" },
          ...(res.music && res.music.playUrl && res.music.playUrl[0] ? [{ type: "audio", quality: "Audio", url: res.music.playUrl[0], ext: "mp3" }] : [])
        ]
      });
    }
  } else if (isImage && res.images && res.images.length > 0) {
    // Image slide type
    res.images.forEach((imgUrl, i) => {
      mediaItems.push({
        type: "image",
        url: imgUrl,
        thumbnail: imgUrl,
        width: null,
        height: null,
        duration: null,
        ext: "jpg",
        formats: [
          { type: "image", quality: `Foto Slide ${i+1}`, url: imgUrl, ext: "jpg" }
        ]
      });
    });

    // Tambahkan background music jika ada
    if (res.music && res.music.playUrl && res.music.playUrl[0]) {
      mediaItems[0].formats.push({ type: "audio", quality: "Audio Musik", url: res.music.playUrl[0], ext: "mp3" });
    }
  }

  if (mediaItems.length === 0) {
    throw new Error("Tidak ditemukan media dari link tersebut oleh tiktok-api-dl");
  }

  return {
    platform: "tiktok",
    type: mediaItems.length > 1 ? "playlist" : mediaItems[0].type,
    shortcode: res.id || "",
    author: res.author?.nickname || "TikTok User",
    caption: res.description || "",
    title: res.description || "TikTok Video",
    timestamp: res.createTime || null,
    likeCount: res.statistics?.likeCount || 0,
    commentCount: res.statistics?.commentCount || 0,
    viewCount: res.statistics?.playCount || 0,
    duration: null,
    mediaItems: mediaItems,
    source: "tiktok-api-dl",
    warning: null
  };
}

// ─── Facebook Siputzx API fallback ─────────────────────────────────────────────

async function scrapeViaSiputzxAPI(url) {
  console.log("[Scraper] Mencoba Siputzx API untuk Facebook...");

  const apiUrl = `https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`;
  const response = await axios.get(apiUrl, { timeout: 15000 });

  const data = response.data;
  if (!data || data.status !== true || !data.data || !data.data.downloads) {
    throw new Error("Siputzx API tidak mengembalikan data yang valid untuk Facebook");
  }

  const item = data.data;
  const formats = [];
  
  item.downloads.forEach(dl => {
    if (dl.url) {
      formats.push({
        type: dl.type === "video" ? "video" : "audio",
        quality: dl.quality || "HD",
        url: dl.url,
        ext: "mp4" // Assuming mp4 for facebook video
      });
    }
  });

  if (formats.length === 0) {
    throw new Error("Tidak ditemukan link unduhan dari Siputzx API");
  }

  // Ambil URL dengan kualitas terbaik sebagai default url
  const bestFormat = formats.find(f => f.quality.toLowerCase().includes('hd')) || formats[0];

  return {
    platform: "facebook",
    type: "video",
    shortcode: "",
    author: "facebook_user",
    caption: item.title || "Facebook Video",
    title: item.title || "Facebook Video",
    timestamp: null,
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    duration: item.duration || null,
    mediaItems: [
      {
        type: "video",
        url: bestFormat.url,
        thumbnail: item.thumbnail || null,
        width: null,
        height: null,
        duration: item.duration || null,
        ext: "mp4",
        formats: formats
      }
    ],
    source: "siputzx",
    warning: null
  };
}

// ─── Scrape Foto via HTML Page (og:image) ───────────────────────────────────

/**
 * Fallback untuk mengambil foto dari halaman web manapun.
 * Mengekstrak og:image, twitter:image, dan URL gambar dari meta tags.
 * Bekerja untuk semua platform: Instagram, Twitter/X, Pinterest, Facebook, dll.
 */
async function scrapePhotoViaPage(url) {
  console.log(`[Scraper] Mencoba scrape foto via HTML page...`);

  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    timeout: 15000,
    maxRedirects: 5,
  });

  const html = response.data;
  const imageUrls = [];
  const seen = new Set();

  // 1. og:image (digunakan Instagram, Facebook, Pinterest, dll)
  const ogImageRegex = /<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/gi;
  let match;
  while ((match = ogImageRegex.exec(html)) !== null) {
    const u = match[1].replace(/&amp;/g, '&');
    if (!seen.has(u)) { seen.add(u); imageUrls.push(u); }
  }
  // Juga cek format terbalik: content dulu, property setelahnya
  const ogImageRegex2 = /<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image["']/gi;
  while ((match = ogImageRegex2.exec(html)) !== null) {
    const u = match[1].replace(/&amp;/g, '&');
    if (!seen.has(u)) { seen.add(u); imageUrls.push(u); }
  }

  // 2. twitter:image
  const twImageRegex = /<meta\s+(?:property|name)=["']twitter:image(?::src)?["']\s+content=["']([^"']+)["']/gi;
  while ((match = twImageRegex.exec(html)) !== null) {
    const u = match[1].replace(/&amp;/g, '&');
    if (!seen.has(u)) { seen.add(u); imageUrls.push(u); }
  }
  const twImageRegex2 = /<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']twitter:image(?::src)?["']/gi;
  while ((match = twImageRegex2.exec(html)) !== null) {
    const u = match[1].replace(/&amp;/g, '&');
    if (!seen.has(u)) { seen.add(u); imageUrls.push(u); }
  }

  // 3. Instagram: cari URL CDN gambar dari embedded JSON data
  const cdnRegex = /https?:\/\/[^\s"'<>]*(?:cdninstagram\.com|fbcdn\.net)[^\s"'<>]*\.(?:jpg|jpeg|png|webp)[^\s"'<>]*/gi;
  while ((match = cdnRegex.exec(html)) !== null) {
    let u = match[0].replace(/\\u0026/g, '&').replace(/\\/g, '');
    // Hindari thumbnail kecil
    if (u.includes('s150x150') || u.includes('150x150')) continue;
    if (!seen.has(u)) { seen.add(u); imageUrls.push(u); }
  }

  // 4. Pinterest: cari URL pinimg
  const pinRegex = /https?:\/\/i\.pinimg\.com\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)/gi;
  while ((match = pinRegex.exec(html)) !== null) {
    let u = match[0];
    // Ganti ukuran kecil ke original
    u = u.replace(/\/[0-9]+x[0-9]*\//, '/originals/');
    if (!seen.has(u)) { seen.add(u); imageUrls.push(u); }
  }

  // 5. Twitter/X: cari URL twimg
  const twimgRegex = /https?:\/\/pbs\.twimg\.com\/media\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)[^\s"'<>]*/gi;
  while ((match = twimgRegex.exec(html)) !== null) {
    let u = match[0].replace(/&amp;/g, '&');
    // Ambil kualitas terbaik
    if (!u.includes('name=') && !u.includes('format=')) {
      u = u + '?format=jpg&name=orig';
    } else if (u.includes('name=')) {
      u = u.replace(/name=[a-z]+/i, 'name=orig');
    }
    if (!seen.has(u)) { seen.add(u); imageUrls.push(u); }
  }

  // Ambil title dan author dari meta tags
  let title = '';
  const titleMatch = html.match(/<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:title["']/i)
    || html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) title = titleMatch[1];

  let author = '';
  const authorMatch = html.match(/<meta\s+(?:property|name)=["'](?:og:site_name|author|twitter:creator)["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["'](?:og:site_name|author|twitter:creator)["']/i);
  if (authorMatch) author = authorMatch[1];

  if (imageUrls.length === 0) {
    throw new Error("Tidak ditemukan foto dalam halaman ini.");
  }

  // Deduplikasi: buang URL yang mirip (hanya beda parameter query)
  const uniqueUrls = [];
  const seenBase = new Set();
  for (const u of imageUrls) {
    // Abaikan logo Instagram/UI statis yang muncul karena login wall
    if (u.includes('static.cdninstagram.com') || u.includes('rsrc.php')) continue;

    const base = u.split('?')[0];
    if (!seenBase.has(base)) {
      seenBase.add(base);
      uniqueUrls.push(u);
    }
  }

  if (uniqueUrls.length === 0) {
    throw new Error("Hanya ditemukan logo/UI, tidak ditemukan foto konten asli.");
  }

  console.log(`[Scraper] Ditemukan ${uniqueUrls.length} foto via HTML page.`);

  const mediaItems = uniqueUrls.slice(0, 10).map((imgUrl, i) => {
    let ext = 'jpg';
    if (imgUrl.includes('.png')) ext = 'png';
    else if (imgUrl.includes('.webp')) ext = 'webp';

    return {
      type: 'image',
      url: imgUrl,
      thumbnail: imgUrl,
      width: null,
      height: null,
      duration: null,
      ext: ext,
      formats: [
        { type: 'image', quality: `Foto ${i + 1}`, url: imgUrl, ext: ext }
      ]
    };
  });

  return {
    platform: "unknown", // Akan di-overwrite oleh caller
    type: mediaItems.length > 1 ? "playlist" : "image",
    shortcode: "",
    author: author || "unknown",
    caption: title || "",
    title: title || "",
    timestamp: null,
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    duration: null,
    mediaItems: mediaItems,
    source: "page_scrape",
    warning: null
  };
}

// ─── Fungsi utama (multi-platform) ──────────────────────────────────────────

/**
 * Scrape media dari URL yang didukung.
 * Mendukung: Instagram, TikTok, YouTube, Facebook, Twitter, Pinterest.
 *
 * @param {string} url - URL media
 * @returns {Promise<object>} Data media
 */
async function scrapeMedia(url) {
  // Deteksi platform
  const detected = detectPlatform(url);
  if (!detected) {
    throw new Error(
      "URL tidak valid atau platform tidak didukung. " +
      "Platform yang didukung: Instagram, TikTok, YouTube, Facebook."
    );
  }

  const { platform, config } = detected;
  console.log(`[Scraper] Platform terdeteksi: ${config.name}`);

  // Untuk Instagram, validasi tambahan shortcode (kecuali Story URL)
  if (platform === "instagram" && !isInstagramStoryUrl(url)) {
    const shortcode = extractShortcode(url);
    if (!shortcode) {
      throw new Error(
        "URL Instagram tidak valid. Gunakan link postingan, reel, story, atau IGTV."
      );
    }
  }

  // Prioritaskan RapidAPI untuk Instagram agar bypass login
  if (platform === "instagram") {
    try {
      const rapidResult = await scrapeViaRapidAPI(url);
      console.log(`[Scraper] Berhasil via RapidAPI (${rapidResult.mediaItems.length} item)`);
      return rapidResult;
    } catch (err) {
      console.warn(`[Scraper] RapidAPI gagal, mencoba fallback Playwright... ${err.message}`);
      
      try {
        const playwrightResult = await scrapeInstagramViaPlaywright(url);
        console.log(`[Scraper] Berhasil via Playwright (${playwrightResult.mediaItems.length} item)`);
        return playwrightResult;
      } catch (pwErr) {
        console.warn(`[Scraper] Playwright juga gagal, mencoba yt-dlp... ${pwErr.message}`);
      }
    }
  }

  // Prioritaskan @tobyg74/tiktok-api-dl untuk TikTok agar foto slide & story ditangani dengan baik
  if (platform === "tiktok") {
    try {
      const apiDlResult = await scrapeViaTikTokApiDl(url);
      console.log(`[Scraper] Berhasil via tiktok-api-dl (${apiDlResult.mediaItems.length} item)`);
      return apiDlResult;
    } catch (err) {
      console.warn(`[Scraper] tiktok-api-dl gagal, mencoba fallback TikWM API... ${err.message}`);
      try {
        const tikwmResult = await scrapeViaTikwmAPI(url);
        console.log(`[Scraper] Berhasil via TikWM (${tikwmResult.mediaItems.length} item)`);
        return tikwmResult;
      } catch (err2) {
        console.warn(`[Scraper] TikWM gagal, mencoba fallback yt-dlp... ${err2.message}`);
      }
    }
  }

  // Cek yt-dlp tersedia
  const ytdlpAvailable = await checkYtDlp();

  if (ytdlpAvailable) {
    try {
      const result = await scrapeViaYtDlp(url, platform);

      // Validasi: cek apakah semua media items memiliki URL yang valid
      const hasValidMedia = result.mediaItems.some(item => item.url && item.url.length > 10);
      if (!hasValidMedia) {
        console.warn(`[Scraper] yt-dlp mengembalikan data tapi URL media kosong. Mencoba fallback foto...`);
        throw new Error("URL media kosong dari yt-dlp");
      }

      console.log(
        `[Scraper] Berhasil via yt-dlp (${result.mediaItems.length} item dari ${config.name})`
      );
      return result;
    } catch (err) {
      console.warn(`[Scraper] yt-dlp gagal untuk ${config.name}: ${err.message}`);

      // TikTok & Instagram: coba retry dengan cookies browser
      if (platform === "tiktok" || platform === "instagram") {
        try {
          const result = await scrapeViaCookiesRetry(url, platform);
          console.log(`[Scraper] ${platform} berhasil via cookies browser`);
          return result;
        } catch (retryErr) {
          console.warn(`[Scraper] ${platform} cookies retry gagal: ${retryErr.message}`);
        }
      }
      
      // Facebook: gunakan Siputzx fallback
      if (platform === "facebook") {
        try {
          return await scrapeViaSiputzxAPI(url);
        } catch (fbErr) {
          console.warn(`[Scraper] Facebook fallback gagal: ${fbErr.message}`);
        }
      }
    }
  } else {
    console.warn("[Scraper] yt-dlp tidak ditemukan!");
  }



  // ─── Fallback foto via HTML page scraping (semua platform) ───
  try {
    const photoResult = await scrapePhotoViaPage(url);
    photoResult.platform = platform;
    console.log(`[Scraper] Berhasil via page scrape (${photoResult.mediaItems.length} foto)`);
    return photoResult;
  } catch (photoErr) {
    console.warn(`[Scraper] Page scrape gagal: ${photoErr.message}`);
  }

  if (platform === "tiktok") {
    try {
      return await scrapeViaTikwmAPI(url);
    } catch (err) {
      throw new Error(
        `Semua metode scraping gagal untuk TikTok.\n` +
        `Detail: ${err.message}`
      );
    }
  }

  if (platform === "instagram") {
    throw new Error(
      `Semua metode scraping gagal untuk Instagram. ` +
      `URL mungkin private atau sistem sedang down.`
    );
  }

  // Platform lain tanpa yt-dlp = tidak bisa
  throw new Error(
    `yt-dlp diperlukan untuk mengunduh dari ${config.name}. ` +
    `Install dengan: pip install yt-dlp`
  );
}

// ─── TikTok Stories by Username ─────────────────────────────────────────────

/**
 * Mengambil TikTok Stories dari username.
 * Stories di TikTok berbeda dari video biasa — muncul di bagian atas profil
 * dan menghilang setelah 24 jam.
 *
 * @param {string} username - Username TikTok (tanpa @)
 * @returns {Promise<object>} Data stories
 */
async function scrapeTikTokStoriesByUsername(username) {
  username = username.replace(/^@/, '').trim();
  if (!username || username.length < 2) {
    throw new Error("Username TikTok tidak valid. Masukkan username tanpa @.");
  }

  console.log(`[Scraper] Mengambil TikTok Stories untuk @${username}...`);

  // ─── Metode 1: TikWM API ───
  try {
    console.log(`[Scraper] Mencoba TikWM API untuk stories @${username}...`);
    const apiUrl = `https://www.tikwm.com/api/user/stories?unique_id=${encodeURIComponent(username)}`;
    const response = await axios.get(apiUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
      },
    });

    const data = response.data;
    if (data && data.code === 0 && data.data && Array.isArray(data.data) && data.data.length > 0) {
      const mediaItems = [];

      data.data.forEach((story, index) => {
        if (story.video_url || story.play) {
          // Video story
          mediaItems.push({
            type: 'video',
            url: story.video_url || story.play,
            thumbnail: story.cover || story.origin_cover || story.video_url,
            width: null,
            height: null,
            duration: story.duration || null,
            ext: 'mp4',
            formats: [
              { type: 'video', quality: `Story ${index + 1}`, url: story.video_url || story.play, ext: 'mp4' },
            ],
          });
        } else if (story.image_url || story.images) {
          // Image story
          const images = story.images || [story.image_url];
          images.forEach((imgUrl, imgIdx) => {
            if (imgUrl) {
              mediaItems.push({
                type: 'image',
                url: imgUrl,
                thumbnail: imgUrl,
                width: null,
                height: null,
                duration: null,
                ext: 'jpg',
                formats: [
                  { type: 'image', quality: `Story ${index + 1}${images.length > 1 ? ` (${imgIdx + 1})` : ''}`, url: imgUrl, ext: 'jpg' },
                ],
              });
            }
          });
        }
      });

      if (mediaItems.length > 0) {
        console.log(`[Scraper] TikWM: Ditemukan ${mediaItems.length} stories untuk @${username}`);
        return {
          platform: 'tiktok',
          type: mediaItems.length > 1 ? 'playlist' : mediaItems[0].type,
          shortcode: '',
          author: username,
          caption: `TikTok Stories dari @${username}`,
          title: `TikTok Stories @${username}`,
          timestamp: null,
          likeCount: 0,
          commentCount: 0,
          viewCount: 0,
          duration: null,
          mediaItems: mediaItems.slice(0, 20),
          source: 'tikwm_stories',
          warning: null,
        };
      }
    }
    console.warn(`[Scraper] TikWM stories API: tidak ada data untuk @${username}`);
  } catch (err) {
    console.warn(`[Scraper] TikWM stories API gagal: ${err.message}`);
  }

  // ─── Metode 2: yt-dlp dengan URL profil ───
  const ytdlpAvailable = await checkYtDlp();
  if (ytdlpAvailable) {
    try {
      console.log(`[Scraper] Mencoba yt-dlp untuk stories @${username}...`);
      const profileUrl = `https://www.tiktok.com/@${username}`;
      const args = [
        '--dump-single-json',
        '--no-warnings',
        '--playlist-end', '20',
        '--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        profileUrl,
      ];

      const raw = await runCommand('yt-dlp', args, 60000);
      const info = JSON.parse(raw);
      const result = parseYtDlpOutput(info, 'tiktok');
      result.title = `TikTok @${username}`;
      result.author = username;
      result.caption = `Konten dari @${username}`;

      if (result.mediaItems.length > 0) {
        console.log(`[Scraper] yt-dlp: Ditemukan ${result.mediaItems.length} konten dari @${username}`);
        return result;
      }
    } catch (err) {
      console.warn(`[Scraper] yt-dlp stories gagal: ${err.message}`);
    }

    // ─── Metode 2b: yt-dlp dengan cookies browser ───
    try {
      const browsers = ['chrome', 'edge', 'firefox', 'brave'];
      for (const browser of browsers) {
        try {
          const profileUrl = `https://www.tiktok.com/@${username}`;
          const args = [
            '--dump-single-json',
            '--no-warnings',
            '--playlist-end', '20',
            '--cookies-from-browser', browser,
            '--add-header', 'User-Agent:Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
            profileUrl,
          ];
          const raw = await runCommand('yt-dlp', args, 60000);
          const info = JSON.parse(raw);
          const result = parseYtDlpOutput(info, 'tiktok');
          result.title = `TikTok @${username}`;
          result.author = username;
          result.caption = `Konten dari @${username}`;

          if (result.mediaItems.length > 0) {
            console.log(`[Scraper] yt-dlp (cookies ${browser}): Ditemukan ${result.mediaItems.length} konten`);
            return result;
          }
        } catch (e) {
          console.warn(`[Scraper] yt-dlp cookies ${browser} gagal: ${e.message.substring(0, 80)}`);
        }
      }
    } catch (err) {
      console.warn(`[Scraper] yt-dlp cookies retry gagal: ${err.message}`);
    }
  }

  // ─── Metode 3: TikWM user posts sebagai alternatif ───
  try {
    console.log(`[Scraper] Mencoba TikWM user posts untuk @${username}...`);
    const apiUrl = `https://www.tikwm.com/api/user/posts?unique_id=${encodeURIComponent(username)}&count=20`;
    const response = await axios.get(apiUrl, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    });

    const data = response.data;
    if (data && data.code === 0 && data.data && data.data.videos && data.data.videos.length > 0) {
      const mediaItems = [];

      data.data.videos.forEach((item) => {
        if (item.images && item.images.length > 0) {
          // Photo slide
          item.images.forEach((imgUrl, imgIdx) => {
            mediaItems.push({
              type: 'image',
              url: imgUrl,
              thumbnail: imgUrl,
              width: null,
              height: null,
              duration: null,
              ext: 'jpg',
              formats: [{ type: 'image', quality: `Foto ${imgIdx + 1}`, url: imgUrl, ext: 'jpg' }],
            });
          });
        } else if (item.play) {
          mediaItems.push({
            type: 'video',
            url: item.play,
            thumbnail: item.cover || item.origin_cover || item.play,
            width: null,
            height: null,
            duration: item.duration || null,
            ext: 'mp4',
            formats: [
              { type: 'video', quality: 'No Watermark', url: item.play, ext: 'mp4' },
              ...(item.music ? [{ type: 'audio', quality: 'Audio', url: item.music, ext: 'mp3' }] : []),
            ],
          });
        }
      });

      if (mediaItems.length > 0) {
        console.log(`[Scraper] TikWM posts: Ditemukan ${mediaItems.length} konten dari @${username}`);
        return {
          platform: 'tiktok',
          type: 'playlist',
          shortcode: '',
          author: username,
          caption: `Konten terbaru dari @${username}`,
          title: `TikTok @${username}`,
          timestamp: null,
          likeCount: 0,
          commentCount: 0,
          viewCount: 0,
          duration: null,
          mediaItems: mediaItems.slice(0, 20),
          source: 'tikwm_posts',
          warning: 'Menampilkan postingan terbaru. Stories mungkin tidak tersedia jika sudah kedaluwarsa atau akun private.',
        };
      }
    }
  } catch (err) {
    console.warn(`[Scraper] TikWM user posts gagal: ${err.message}`);
  }

  throw new Error(
    `Gagal mengambil TikTok Stories/konten dari @${username}. ` +
    `Pastikan username benar, akun bersifat publik, dan memiliki story aktif.`
  );
}

// Backward-compatible alias
const scrapeInstagram = scrapeMedia;

module.exports = {
  scrapeMedia,
  scrapeInstagram,
  scrapeTikTokStoriesByUsername,
  detectPlatform,
  extractShortcode,
  isInstagramStoryUrl,
  checkYtDlp,
  PLATFORMS,
};
