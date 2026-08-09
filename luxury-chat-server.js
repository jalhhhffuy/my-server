"use strict";

// ============================================================================
// Luxury Chat Server - V12 SEND RECOVERY HARDENED
// Cloudinary-Authoritative Persistent 30 Days
// Text + Voice + Image + Video + Reports + Avatar/Profile
// IMAGE + VIDEO MODERATION: Amazon Rekognition via Cloudinary
// Node 18+ / Express / multer / Cloudinary / PlayFab
//
// BUILD:
// 2026-08-10-LUXURY-CHAT-SERVER-V12-SEND-RECOVERY-NO-ADMIN-DEPENDENCY
//
// server.js:
// const installLuxuryChat = require("./luxury-chat-server");
// installLuxuryChat(app, cloudinary);
//
// Required env:
// PLAYFAB_TITLE_ID
// PLAYFAB_SECRET_KEY
// CLOUDINARY_API_SECRET
//
// Optional env:
// CHAT_REPORTS_KEY=LUXURY_CHAT_REPORTS
// CHAT_PUBLIC_SERVER_URL=https://my-server-i40i.onrender.com
//
// مهم للـWebhook:
// الأفضل أن يكون server.js مستخدماً:
// app.use(express.json({ verify: (req, res, buffer) => {
//   req.rawBody = buffer ? buffer.toString("utf8") : "";
// }}));
// V10 يدعم أيضاً Buffer ويحاول JSON.stringify(req.body) كـ fallback آمن للتوقيع
// إذا لم يكن rawBody متوفراً، لكنه لا يقبل Webhook غير موقع.
//
// أهم إصلاحات V12 فوق V11:
// - نفس نظام History shards الخاص بـV9 بدون Shared Overwrite.
// - منع تراجع حالة الفيديو من approved/rejected إلى pending بسبب سباق Webhook/Upload callback.
// - Cloudinary Admin API هو المرجع النهائي لحالة الفيديو متى أمكن.
// - Webhook signature يدعم rawBody كسلسلة أو Buffer + fallback موقع فقط.
// - حذف ملفات الصوت/الصور اليتيمة إذا فشل حفظ الرسالة بعد نجاح الرفع.
// - محاولة حذف فيديو جزئي/فاشل عند فشل الرفع.
// - تنظيف Video Job shards المنتهية بأمان بدل تراكمها للأبد.
// - تنظيف خرائط Rate Limit دورياً لمنع نمو RAM بلا حد.
// - Timeouts لطلبات fetch المباشرة إلى PlayFab وCloudinary delivery URLs.
// - حذف History shards المنتهية حتى لو كانت فارغة، مع عدم حذف Shard حي.
// - لا يرجع Success لرسالة لم يتم التحقق من وجودها داخل Shard الخاص بها.
// - آخر 100 رسالة حقيقية + حالات التفاعل، والتفاعلات لا تأخذ من حد 100.
// - Message ID حتمي عند وجود clientMessageId لمنع Retry مزدوج بين instances.
// - تخفيض ضغط Cloudinary Admin API: اكتشاف Shards على فترات، مع قراءة المحتوى من Delivery URL بين الاكتشافات.
// - Shard فيديو تالف لا يعطل كل رفع/حالة الفيديو؛ يتم عزله، والمنتهي منه يحذف بأمان.
// - Public ID حتمي للصوت/الصور/الفيديو عند وجود clientMessageId لمنع رفع أصلين لنفس Retry بين instances.
// - الإرسال لا يتوقف إذا Cloudinary Admin API وصل Rate Limit أو تعطل مؤقتاً.
// - قراءة Legacy history والـLocal writer shard تتم مباشرة من Delivery URL بدون Admin resource lookup.
// - Force refresh يستخدم Runtime/Shard cache عند فشل المزامنة بدل إسقاط /chat/send بالكامل.
// ============================================================================

const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

module.exports = function installLuxuryChat(app, cloudinary) {
  if (!app) throw new Error("installLuxuryChat: app is required");
  if (!cloudinary) throw new Error("installLuxuryChat: cloudinary is required");

  // ========================================================================
  // CONFIG
  // ========================================================================

  const SERVER_BUILD =
    "2026-08-10-LUXURY-CHAT-SERVER-V12-SEND-RECOVERY-NO-ADMIN-DEPENDENCY";

  const TITLE_ID = String(process.env.PLAYFAB_TITLE_ID || "").trim();
  const SECRET_KEY = String(process.env.PLAYFAB_SECRET_KEY || "").trim();

  const REPORTS_KEY =
    String(process.env.CHAT_REPORTS_KEY || "LUXURY_CHAT_REPORTS").trim() ||
    "LUXURY_CHAT_REPORTS";

  const MAX_TEXT_LENGTH = 200;
  const MAX_FETCH_LIMIT = 100;
  const MAX_REACTION_FETCH_LIMIT = 600;

  const REACTION_REMOVE_TOKEN = "__LUXURY_CHAT_REACTION_REMOVE__";
  const QUICK_REACTIONS = new Set(["👍", "😂", "❤", "🔥", "👏", "😮", "😢"]);

  const RETENTION_DAYS = 30;
  const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const MAX_REPORTS_IN_KEY = 500;

  const MAX_VOICE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

  const PROFILE_CACHE_MS = 15 * 1000;
  const DIRECT_FETCH_TIMEOUT_MS = 15 * 1000;

  const TEXT_SEGMENTER =
    typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("ar", { granularity: "grapheme" })
      : null;

  // نبقي مجلد V8/V9 نفسه حتى لا نفصل تاريخ النسخة الحالية عن V11.
  const HISTORY_FOLDER = "luxury_chat_history_v8";
  const LEGACY_HISTORY_FOLDER = "luxury_chat_history";

  const HISTORY_RENDER_INSTANCE_ID =
    String(process.env.RENDER_INSTANCE_ID || "local")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 64) || "local";

  const HISTORY_PROCESS_BOOT_ID = crypto.randomBytes(8).toString("hex");

  const HISTORY_INSTANCE_TOKEN =
    `${HISTORY_RENDER_INSTANCE_ID}_${process.pid}_${HISTORY_PROCESS_BOOT_ID}`
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 110);

  const VOICE_FOLDER = "chat_voice_notes";
  const IMAGE_FOLDER = "chat_media_images";
  const VIDEO_FOLDER = "chat_media_videos";

  const HISTORY_CACHE_SYNC_MS = 1500;
  // Admin API في Cloudinary محدود؛ نستخدمه فقط لاكتشاف Shards الجديدة.
  // تحديث Shards المعروفة يتم من Delivery URL غير المرقم بالإصدار.
  const HISTORY_SHARD_DISCOVERY_MS = Math.max(
    5000,
    Number(process.env.CHAT_HISTORY_SHARD_DISCOVERY_MS || 20000) || 20000
  );
  const VIDEO_JOB_SHARD_DISCOVERY_MS = Math.max(
    5000,
    Number(process.env.CHAT_VIDEO_JOB_SHARD_DISCOVERY_MS || 20000) || 20000
  );
  const HISTORY_READ_RETRY_DELAYS_MS = [0, 160, 420, 900];
  const HISTORY_WRITE_VERIFY_ATTEMPTS = 4;
  const HISTORY_WRITE_VERIFY_SETTLE_MS = 140;

  const IMAGE_MODERATION_KIND = "aws_rek";
  const VIDEO_MODERATION_KIND = "aws_rek_video";

  const PUBLIC_SERVER_URL =
    String(
      process.env.CHAT_PUBLIC_SERVER_URL ||
        process.env.PUBLIC_SERVER_URL ||
        "https://my-server-i40i.onrender.com"
    )
      .trim()
      .replace(/\/+$/, "");

  const VIDEO_MODERATION_WEBHOOK_PATH = "/chat/video-moderation-webhook";
  const VIDEO_MODERATION_WEBHOOK_URL =
    `${PUBLIC_SERVER_URL}${VIDEO_MODERATION_WEBHOOK_PATH}`;

  const LEGACY_VIDEO_JOBS_PUBLIC_ID =
    "luxury_chat_video_pending/video_jobs_v1.json";

  // نبقي مجلد V9 نفسه حتى تُقرأ Pending jobs القديمة.
  const VIDEO_JOBS_FOLDER = "luxury_chat_video_pending_v9";
  const VIDEO_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

  const CLOUDINARY_API_SECRET =
    String(process.env.CLOUDINARY_API_SECRET || "").trim();

  const CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS = 2 * 60 * 60;
  const VIDEO_STATUS_FALLBACK_CHECK_MS = 30 * 1000;

  const RATE_MAP_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
  const RATE_MAP_ENTRY_MAX_AGE_MS = 30 * 60 * 1000;
  let lastRateMapPruneUnixMs = 0;

  const ALLOWED_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ]);

  // ========================================================================
  // MULTER
  // ========================================================================

  const voiceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_VOICE_BYTES },
  });

  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_VIDEO_BYTES },
  });

  function uploadSingleJson(uploadInstance, fieldName, tooLargeMessage) {
    return function uploadMiddleware(req, res, next) {
      uploadInstance.single(fieldName)(req, res, (error) => {
        if (!error) return next();

        if (error && error.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            ok: false,
            error: tooLargeMessage || "حجم الملف أكبر من الحد المسموح",
          });
        }

        console.error(`[LuxuryChat][UPLOAD][${fieldName}]`, error);

        return res.status(400).json({
          ok: false,
          error: "تعذر قراءة الملف المرفوع",
        });
      });
    };
  }

  // ========================================================================
  // RUNTIME STATE
  // ========================================================================

  const rooms = new Map();
  const profileCache = new Map();

  const sendRate = new Map();
  const reportRate = new Map();

  let reportsLoaded = false;
  let reports = [];
  let reportsLoadPromise = null;
  let reportsWriteChain = Promise.resolve();

  const videoJobs = new Map();
  const videoJobShardCache = new Map();
  const videoJobKnownResources = new Map();
  let lastVideoJobShardDiscoveryUnixMs = 0;
  let videoJobsLoaded = false;
  let videoJobsLoadPromise = null;
  let videoJobsWriteChain = Promise.resolve();

  // ========================================================================
  // BASIC HELPERS
  // ========================================================================

  function nowMs() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  async function fetchWithTimeout(url, options, timeoutMs = DIRECT_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

    try {
      return await fetch(url, {
        ...(options || {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function cleanRoom(value) {
    const room = String(value || "global").trim().toLowerCase();
    return /^[a-z0-9_-]{1,40}$/.test(room) ? room : "global";
  }

  function truncateUnicode(value, maximumGraphemes) {
    const text = String(value || "");
    if (!maximumGraphemes || maximumGraphemes <= 0) return "";

    if (TEXT_SEGMENTER) {
      const segments = Array.from(
        TEXT_SEGMENTER.segment(text),
        (item) => item.segment
      );
      if (segments.length <= maximumGraphemes) return text;
      return segments.slice(0, maximumGraphemes).join("");
    }

    const chars = Array.from(text);
    if (chars.length <= maximumGraphemes) return text;
    return chars.slice(0, maximumGraphemes).join("");
  }

  function cleanText(value) {
    const text = String(value || "")
      .replace(/\u0000/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();

    return truncateUnicode(text, MAX_TEXT_LENGTH);
  }

  function cleanReason(value) {
    return String(value || "")
      .replace(/\u0000/g, "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 300);
  }

  function safeString(value, max) {
    const text = String(value || "").trim();
    return max && text.length > max ? text.slice(0, max) : text;
  }

  function cleanClientMessageId(value) {
    return safeString(value, 100);
  }

  function normalizeKind(value) {
    const kind = String(value || "text").trim().toLowerCase();
    if (kind === "voice") return "voice";
    if (kind === "image") return "image";
    if (kind === "video") return "video";
    return "text";
  }

  function pruneRateMap(map, current) {
    const cutoff = current - RATE_MAP_ENTRY_MAX_AGE_MS;
    for (const [key, timestamp] of map.entries()) {
      if (Number(timestamp || 0) <= cutoff) map.delete(key);
    }
  }

  function maybePruneRateMaps(current) {
    if (current - lastRateMapPruneUnixMs < RATE_MAP_PRUNE_INTERVAL_MS) return;
    lastRateMapPruneUnixMs = current;
    pruneRateMap(sendRate, current);
    pruneRateMap(reportRate, current);
  }

  function checkRate(map, key, minimumMs) {
    const current = nowMs();
    maybePruneRateMaps(current);

    const last = Number(map.get(key) || 0);
    if (current - last < minimumMs) return false;

    map.set(key, current);
    return true;
  }

  function sanitizeFileName(value, fallback) {
    const original = safeString(value, 180) || fallback || "media.bin";
    const ext = path.extname(original).slice(0, 12);
    const base = path
      .basename(original, ext)
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 80);

    return `${base || "media"}${ext.toLowerCase()}`;
  }

  function makeChatError(code, message, extra) {
    const error = new Error(message || code || "chat_error");
    error.code = code || "CHAT_ERROR";
    if (extra && typeof extra === "object") Object.assign(error, extra);
    return error;
  }

  function deterministicMessageId(roomId, senderId, clientMessageId) {
    const client = cleanClientMessageId(clientMessageId);
    if (!client) return crypto.randomUUID();

    const digest = crypto
      .createHash("sha256")
      .update(
        `${cleanRoom(roomId)}|${safeString(senderId, 100)}|${client}`,
        "utf8"
      )
      .digest("hex");

    return `m_${digest.slice(0, 48)}`;
  }

  function isReactionMessageServer(message) {
    if (!message || !safeString(message.replyToId, 100)) return false;
    const value = String(message.text || "").trim();
    return value === REACTION_REMOVE_TOKEN || QUICK_REACTIONS.has(value);
  }

  function positiveMin(a, b) {
    const x = Math.max(0, Number(a) || 0);
    const y = Math.max(0, Number(b) || 0);
    if (x <= 0) return y;
    if (y <= 0) return x;
    return Math.min(x, y);
  }

  function compareMessages(a, b) {
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;

    const seqA = Math.max(0, Number(a.seq) || 0);
    const seqB = Math.max(0, Number(b.seq) || 0);

    if (seqA > 0 && seqB > 0 && seqA !== seqB) return seqA - seqB;

    const timeA = Math.max(0, Number(a.sentUnixMs) || 0);
    const timeB = Math.max(0, Number(b.sentUnixMs) || 0);

    if (timeA !== timeB) return timeA - timeB;
    if (seqA !== seqB) return seqA - seqB;

    return String(a.id || "").localeCompare(String(b.id || ""));
  }

  // ========================================================================
  // PLAYFAB
  // ========================================================================

  async function playFabCall(group, endpoint, body) {
    if (!TITLE_ID || !SECRET_KEY) {
      throw new Error("PLAYFAB_TITLE_ID / PLAYFAB_SECRET_KEY missing");
    }

    const response = await fetchWithTimeout(
      `https://${TITLE_ID}.playfabapi.com/${group}/${endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SecretKey": SECRET_KEY,
        },
        body: JSON.stringify(body || {}),
      }
    );

    const json = await response.json().catch(() => null);

    if (!response.ok || !json || json.code !== 200 || json.data === undefined) {
      const message =
        json && json.errorMessage
          ? json.errorMessage
          : `PlayFab ${group}/${endpoint} failed`;
      throw new Error(message);
    }

    return json.data;
  }

  function playFabServerCall(endpoint, body) {
    return playFabCall("Server", endpoint, body);
  }

  function playFabAdminCall(endpoint, body) {
    return playFabCall("Admin", endpoint, body);
  }

  async function authenticateSessionTicket(sessionTicket) {
    const ticket = String(sessionTicket || "").trim();
    if (!ticket) throw makeChatError("AUTH_MISSING", "missing_session_ticket");

    const data = await playFabServerCall("AuthenticateSessionTicket", {
      SessionTicket: ticket,
    });

    const playFabId =
      data && data.UserInfo && data.UserInfo.PlayFabId
        ? String(data.UserInfo.PlayFabId)
        : "";

    if (!playFabId) throw makeChatError("AUTH_INVALID", "invalid_session_ticket");
    return playFabId;
  }

  async function getPlayerProfile(playFabId, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = profileCache.get(playFabId);
      if (cached && cached.expires > nowMs()) return cached.profile;
    }

    let playerName = "لاعب";
    let avatarUrl = "";
    let avatarVersion = "0";

    try {
      const data = await playFabServerCall("GetUserData", {
        PlayFabId: playFabId,
        Keys: [
          "player_display_name",
          "avatar_uploaded",
          "avatar_url",
          "avatar_version",
        ],
      });

      if (data && data.Data) {
        const nameRecord = data.Data.player_display_name;
        const uploadedRecord = data.Data.avatar_uploaded;
        const urlRecord = data.Data.avatar_url;
        const versionRecord = data.Data.avatar_version;

        if (nameRecord && nameRecord.Value) {
          playerName = safeString(nameRecord.Value, 32) || "لاعب";
        }

        const avatarUploaded =
          uploadedRecord && String(uploadedRecord.Value || "") === "1";

        if (avatarUploaded && urlRecord && urlRecord.Value) {
          avatarUrl = safeString(urlRecord.Value, 1000);
        }

        if (versionRecord && versionRecord.Value) {
          avatarVersion = safeString(versionRecord.Value, 100) || "0";
        }
      }
    } catch (error) {
      console.warn("[LuxuryChat] GetUserData profile failed", error.message);
    }

    if (playerName === "لاعب") {
      try {
        const data = await playFabServerCall("GetUserAccountInfo", {
          PlayFabId: playFabId,
        });

        const display =
          data &&
          data.UserInfo &&
          data.UserInfo.TitleInfo &&
          data.UserInfo.TitleInfo.DisplayName
            ? String(data.UserInfo.TitleInfo.DisplayName).trim()
            : "";

        if (display) playerName = display.slice(0, 32);
      } catch (_) {}
    }

    const profile = { playerName, avatarUrl, avatarVersion };

    profileCache.set(playFabId, {
      profile,
      expires: nowMs() + PROFILE_CACHE_MS,
    });

    return profile;
  }

  // ========================================================================
  // ROOM / CLOUDINARY HISTORY - SHARDED
  // ========================================================================

  function getRoom(roomId) {
    const id = cleanRoom(roomId);

    if (!rooms.has(id)) {
      rooms.set(id, {
        id,
        seq: 0,
        messages: [],
        loaded: false,
        syncPromise: null,
        mutationChain: Promise.resolve(),
        lastStorageSyncMs: 0,
        lastStorageSavedAtUnixMs: 0,
        lastShardDiscoveryMs: 0,
        knownShardResources: new Map(),
        shardCache: new Map(),
        legacyCache: null,
        legacyMissingUntilMs: 0,
      });
    }

    return rooms.get(id);
  }

  function historyShardPrefix(roomId) {
    return `${HISTORY_FOLDER}/room_${cleanRoom(roomId)}/`;
  }

  function historyShardPublicId(roomId, dayKey) {
    return `${historyShardPrefix(roomId)}${dayKey}_${HISTORY_INSTANCE_TOKEN}.json`;
  }

  function legacyHistoryPublicId(roomId) {
    return `${LEGACY_HISTORY_FOLDER}/room_${cleanRoom(roomId)}.json`;
  }

  function utcDayKey(unixMs) {
    const date = new Date(Math.max(0, Number(unixMs) || nowMs()));
    const y = String(date.getUTCFullYear()).padStart(4, "0");
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }

  function dayKeyEndUnixMs(dayKey) {
    const text = String(dayKey || "");
    if (!/^\d{8}$/.test(text)) return 0;

    const y = Number(text.slice(0, 4));
    const m = Number(text.slice(4, 6));
    const d = Number(text.slice(6, 8));
    const start = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    if (!Number.isFinite(start)) return 0;
    return start + 24 * 60 * 60 * 1000;
  }

  function extractHistoryShardDay(publicId) {
    const match = String(publicId || "").match(/\/(\d{8})_[^/]+\.json$/);
    return match ? match[1] : "";
  }

  function addCacheBust(url) {
    const value = String(url || "").trim();
    if (!value) return value;
    return `${value}${value.includes("?") ? "&" : "?"}ts=${nowMs()}_${crypto
      .randomBytes(3)
      .toString("hex")}`;
  }

  function uploadRawJson(publicId, object) {
    const buffer = Buffer.from(JSON.stringify(object), "utf8");

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "raw",
          type: "upload",
          public_id: publicId,
          overwrite: true,
          invalidate: true,
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error("cloudinary_no_result"));
          resolve(result);
        }
      );

      stream.end(buffer);
    });
  }

  function normalizeMessage(raw, roomId) {
    if (!raw || typeof raw !== "object") return null;

    const id = safeString(raw.id, 100);
    const sentUnixMs = Math.max(0, Number(raw.sentUnixMs) || 0);
    if (!id || !sentUnixMs) return null;

    const kind = normalizeKind(raw.kind || raw.mediaType);
    const rawMediaKind = normalizeKind(raw.mediaType);
    const mediaType =
      kind === "image" || kind === "video"
        ? kind
        : rawMediaKind === "image" || rawMediaKind === "video"
        ? rawMediaKind
        : "";

    return {
      id,
      clientMessageId: cleanClientMessageId(raw.clientMessageId),
      seq: Math.max(0, Number(raw.seq) || 0),
      room: cleanRoom(raw.room || roomId),
      senderId: safeString(raw.senderId, 100),
      senderName: safeString(raw.senderName, 64) || "لاعب",
      senderAvatarUrl: safeString(raw.senderAvatarUrl, 1000),
      senderAvatarVersion: safeString(raw.senderAvatarVersion, 100) || "0",
      sentUnixMs,
      kind,
      text: kind === "text" ? cleanText(raw.text || "") : "",
      voiceUrl: kind === "voice" ? safeString(raw.voiceUrl, 1200) : "",
      voiceDuration:
        kind === "voice"
          ? Math.min(180, Math.max(0, Number(raw.voiceDuration) || 0))
          : 0,
      mediaType,
      mediaUrl:
        kind === "image" || kind === "video"
          ? safeString(raw.mediaUrl, 1600)
          : "",
      mediaThumbnailUrl:
        kind === "image" || kind === "video"
          ? safeString(raw.mediaThumbnailUrl, 1600)
          : "",
      mediaFileName:
        kind === "image" || kind === "video"
          ? safeString(raw.mediaFileName, 180)
          : "",
      replyToId: safeString(raw.replyToId, 100),
      replyToSenderId: safeString(raw.replyToSenderId, 100),
      replyToName: safeString(raw.replyToName, 64),
      replyToPreview: safeString(raw.replyToPreview, 120),
    };
  }

  function parseHistoryDocument(text, roomId) {
    let parsed;
    try {
      parsed = JSON.parse(String(text || ""));
    } catch (_) {
      throw new Error("chat_history_invalid_json");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("chat_history_invalid_object");
    }

    const source = Array.isArray(parsed.messages) ? parsed.messages : [];
    const messages = [];
    let maxSeq = 0;

    for (const raw of source) {
      const message = normalizeMessage(raw, roomId);
      if (!message) continue;
      messages.push(message);
      maxSeq = Math.max(maxSeq, Math.max(0, Number(message.seq) || 0));
    }

    return {
      exists: true,
      version: Math.max(0, Number(parsed.version) || 0),
      build: safeString(parsed.build, 180),
      room: cleanRoom(parsed.room || roomId),
      seq: Math.max(maxSeq, Math.max(0, Number(parsed.seq) || 0)),
      retentionDays:
        Math.max(0, Number(parsed.retentionDays) || 0) || RETENTION_DAYS,
      savedAtUnixMs: Math.max(0, Number(parsed.savedAtUnixMs) || 0),
      shardInstance: safeString(parsed.shardInstance, 120),
      shardDay: safeString(parsed.shardDay, 16),
      messages,
    };
  }

  function isCloudinaryNotFoundError(error) {
    if (!error) return false;

    const code = Number(error.http_code || error.status || error.statusCode || 0);
    if (code === 404) return true;

    const message = String(error.message || error.error?.message || "").toLowerCase();
    return message.includes("not found") || message.includes("404");
  }

  async function resolveRawResource(publicId) {
    try {
      const resource = await cloudinary.api.resource(publicId, {
        resource_type: "raw",
        type: "upload",
      });

      if (!resource || !resource.secure_url) {
        throw new Error("chat_history_resource_missing_secure_url");
      }

      return {
        exists: true,
        publicId: safeString(resource.public_id, 600) || publicId,
        secureUrl: String(resource.secure_url),
        version: Math.max(0, Number(resource.version) || 0),
        createdAt: safeString(resource.created_at, 80),
      };
    } catch (error) {
      if (isCloudinaryNotFoundError(error)) {
        return {
          exists: false,
          publicId,
          secureUrl: "",
          version: 0,
          createdAt: "",
        };
      }
      throw error;
    }
  }

  async function fetchHistoryDocumentFromUrl(roomId, url) {
    let lastError = null;
    let sawNotFound = false;

    for (let attempt = 0; attempt < HISTORY_READ_RETRY_DELAYS_MS.length; attempt++) {
      const delay = HISTORY_READ_RETRY_DELAYS_MS[attempt];
      if (delay > 0) await sleep(delay);

      try {
        const response = await fetchWithTimeout(addCacheBust(url), {
          method: "GET",
          headers: {
            "Cache-Control": "no-cache, no-store, max-age=0",
            Pragma: "no-cache",
          },
        });

        if (response.status === 404) {
          sawNotFound = true;
          lastError = new Error("chat_history_not_found");
          continue;
        }

        if (!response.ok) {
          lastError = new Error(`chat_history_load_http_${response.status}`);
          continue;
        }

        return parseHistoryDocument(await response.text(), roomId);
      } catch (error) {
        lastError = error;
      }
    }

    if (sawNotFound) return null;
    throw lastError || new Error("chat_history_load_failed");
  }

  async function listHistoryShardResources(roomId) {
    const resources = [];
    let nextCursor = undefined;

    do {
      const result = await cloudinary.api.resources({
        resource_type: "raw",
        type: "upload",
        prefix: historyShardPrefix(roomId),
        max_results: 500,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      });

      if (result && Array.isArray(result.resources)) {
        for (const resource of result.resources) {
          if (!resource || !resource.public_id || !resource.secure_url) continue;
          resources.push({
            publicId: safeString(resource.public_id, 600),
            secureUrl: safeString(resource.secure_url, 1800),
            version: Math.max(0, Number(resource.version) || 0),
            createdAt: safeString(resource.created_at, 80),
          });
        }
      }

      nextCursor = result && result.next_cursor
        ? String(result.next_cursor)
        : undefined;
    } while (nextCursor);

    return resources;
  }

  function rawDeliveryUrl(publicId) {
    return cloudinary.url(publicId, {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });
  }

  async function getKnownHistoryShardResources(room, forceDiscovery = false) {
    const current = nowMs();
    const shouldDiscover =
      !room.knownShardResources ||
      room.knownShardResources.size === 0 ||
      room.lastShardDiscoveryMs <= 0 ||
      current - room.lastShardDiscoveryMs >= HISTORY_SHARD_DISCOVERY_MS ||
      (forceDiscovery && !room.loaded);

    if (shouldDiscover) {
      try {
        const discovered = await listHistoryShardResources(room.id);
        if (!room.knownShardResources) room.knownShardResources = new Map();

        for (const resource of discovered) {
          room.knownShardResources.set(resource.publicId, resource);
        }

        room.lastShardDiscoveryMs = current;
      } catch (error) {
        // Admin API محدود بالطلبات. فشل الاكتشاف لا يجوز أن يمنع الإرسال.
        // نحتفظ بأي Shards معروفة ونحاول الاكتشاف مرة أخرى بعد فترة قصيرة.
        room.lastShardDiscoveryMs = Math.max(
          0,
          current - HISTORY_SHARD_DISCOVERY_MS + 5000
        );

        console.warn("[LuxuryChat][HISTORY][ADMIN_DISCOVERY_FALLBACK]", {
          room: room.id,
          knownShards: room.knownShardResources
            ? room.knownShardResources.size
            : 0,
          error: error && error.message ? error.message : error,
        });
      }
    }

    return Array.from((room.knownShardResources || new Map()).values());
  }

  async function loadKnownHistoryShardDocument(room, resource) {
    const publicId = safeString(resource && resource.publicId, 600);
    if (!publicId) return null;

    const deliveryUrl = rawDeliveryUrl(publicId);
    const cached = room.shardCache.get(publicId);

    try {
      const document = await fetchHistoryDocumentFromUrl(room.id, deliveryUrl);
      if (!document) {
        if (cached && cached.document) return cached.document;
        return null;
      }

      document.storagePublicId = publicId;
      document.storageVersion = Math.max(
        Number(resource && resource.version) || 0,
        Number(document.storageVersion) || 0
      );
      document.secureUrl = deliveryUrl;

      room.shardCache.set(publicId, {
        version: document.storageVersion,
        secureUrl: deliveryUrl,
        document,
      });

      return document;
    } catch (error) {
      if (cached && cached.document) {
        console.warn("[LuxuryChat][HISTORY][DELIVERY_CACHE_FALLBACK]", {
          room: room.id,
          publicId,
          error: error && error.message ? error.message : error,
        });
        return cached.document;
      }
      throw error;
    }
  }

  function pruneExpired(room) {
    if (!room || !Array.isArray(room.messages)) return false;

    const cutoff = nowMs() - RETENTION_MS;
    const oldLength = room.messages.length;

    room.messages = room.messages.filter((message) => {
      if (!message) return false;
      return Math.max(0, Number(message.sentUnixMs) || 0) > cutoff;
    });

    return room.messages.length !== oldLength;
  }

  function mergeMessageFields(existing, incoming, roomId) {
    if (!existing) return normalizeMessage(incoming, roomId);
    if (!incoming) return normalizeMessage(existing, roomId);

    const a = normalizeMessage(existing, roomId);
    const b = normalizeMessage(incoming, roomId);
    if (!a) return b;
    if (!b) return a;

    return {
      id: b.id || a.id,
      clientMessageId: b.clientMessageId || a.clientMessageId,
      seq: Math.max(
        Math.max(0, Number(a.seq) || 0),
        Math.max(0, Number(b.seq) || 0)
      ),
      room: cleanRoom(b.room || a.room || roomId),
      senderId: b.senderId || a.senderId,
      senderName: b.senderName || a.senderName || "لاعب",
      senderAvatarUrl: b.senderAvatarUrl || a.senderAvatarUrl,
      senderAvatarVersion: b.senderAvatarVersion || a.senderAvatarVersion || "0",
      sentUnixMs: positiveMin(a.sentUnixMs, b.sentUnixMs),
      kind: b.kind || a.kind || "text",
      text: b.text || a.text || "",
      voiceUrl: b.voiceUrl || a.voiceUrl || "",
      voiceDuration: Math.max(
        0,
        Number(b.voiceDuration) || Number(a.voiceDuration) || 0
      ),
      mediaType: b.mediaType || a.mediaType || "",
      mediaUrl: b.mediaUrl || a.mediaUrl || "",
      mediaThumbnailUrl: b.mediaThumbnailUrl || a.mediaThumbnailUrl || "",
      mediaFileName: b.mediaFileName || a.mediaFileName || "",
      replyToId: b.replyToId || a.replyToId || "",
      replyToSenderId: b.replyToSenderId || a.replyToSenderId || "",
      replyToName: b.replyToName || a.replyToName || "",
      replyToPreview: b.replyToPreview || a.replyToPreview || "",
    };
  }

  function dedupeClientMessages(room) {
    if (!room || !Array.isArray(room.messages)) return false;

    const byClient = new Map();
    const withoutClient = [];
    let changed = false;

    for (const message of room.messages) {
      if (!message) continue;

      const clientMessageId = cleanClientMessageId(message.clientMessageId);
      const senderId = safeString(message.senderId, 100);

      if (!clientMessageId || !senderId) {
        withoutClient.push(message);
        continue;
      }

      const key = `${senderId}|${clientMessageId}`;
      const previous = byClient.get(key);

      if (!previous) {
        byClient.set(key, message);
        continue;
      }

      changed = true;

      const ordered = [previous, message].sort((x, y) => {
        const tx = Math.max(0, Number(x.sentUnixMs) || 0);
        const ty = Math.max(0, Number(y.sentUnixMs) || 0);
        if (tx !== ty) return tx - ty;
        return String(x.id || "").localeCompare(String(y.id || ""));
      });

      byClient.set(key, mergeMessageFields(ordered[1], ordered[0], room.id));
    }

    if (changed) {
      room.messages = withoutClient.concat(Array.from(byClient.values()));
    }

    return changed;
  }

  function repairSequenceCollisions(room) {
    if (!room || !Array.isArray(room.messages)) return false;

    room.messages.sort((a, b) => {
      const ta = Math.max(0, Number(a && a.sentUnixMs) || 0);
      const tb = Math.max(0, Number(b && b.sentUnixMs) || 0);
      if (ta !== tb) return ta - tb;
      return String((a && a.id) || "").localeCompare(String((b && b.id) || ""));
    });

    let changed = false;
    let index = 0;
    let latestSeq = 0;

    while (index < room.messages.length) {
      const first = room.messages[index];
      const sent = Math.max(0, Number(first && first.sentUnixMs) || 0);
      let end = index + 1;

      while (
        end < room.messages.length &&
        Math.max(0, Number(room.messages[end] && room.messages[end].sentUnixMs) || 0) === sent
      ) {
        end += 1;
      }

      const groupSize = end - index;
      if (groupSize > 4096) {
        throw makeChatError(
          "HISTORY_SEQUENCE_GROUP_OVERFLOW",
          "too_many_messages_in_same_millisecond"
        );
      }

      const base = Math.min(
        Number.MAX_SAFE_INTEGER - 4095,
        Math.max(0, sent) * 4096
      );

      for (let offset = 0; offset < groupSize; offset++) {
        const message = room.messages[index + offset];
        if (!message) continue;

        const fixed = base + offset;
        if (Number(message.seq || 0) !== fixed) {
          message.seq = fixed;
          changed = true;
        }
        latestSeq = Math.max(latestSeq, fixed);
      }

      index = end;
    }

    if (Number(room.seq || 0) !== latestSeq) {
      room.seq = latestSeq;
      changed = true;
    }

    room.messages.sort(compareMessages);
    return changed;
  }

  function mergeDocumentIntoRoom(room, document) {
    if (!room || !document || !Array.isArray(document.messages)) return false;

    const byId = new Map();

    for (const message of room.messages || []) {
      if (!message || !message.id) continue;
      const normalized = normalizeMessage(message, room.id);
      if (normalized) byId.set(normalized.id, normalized);
    }

    for (const raw of document.messages) {
      const incoming = normalizeMessage(raw, room.id);
      if (!incoming || !incoming.id) continue;

      const existing = byId.get(incoming.id);
      byId.set(
        incoming.id,
        existing ? mergeMessageFields(existing, incoming, room.id) : incoming
      );
    }

    room.messages = Array.from(byId.values());
    room.seq = Math.max(
      Math.max(0, Number(room.seq) || 0),
      Math.max(0, Number(document.seq) || 0)
    );

    pruneExpired(room);
    dedupeClientMessages(room);
    repairSequenceCollisions(room);
    return true;
  }

  async function destroyRawAsset(publicId) {
    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: "raw",
        type: "upload",
        invalidate: true,
      });
      return true;
    } catch (error) {
      console.warn("[LuxuryChat][RAW_DELETE_FAILED]", {
        publicId,
        error: error && error.message ? error.message : error,
      });
      return false;
    }
  }

  function historyShardDefinitelyExpired(resource) {
    if (!resource || !resource.publicId) return false;

    const dayKey = extractHistoryShardDay(resource.publicId);
    const dayEnd = dayKeyEndUnixMs(dayKey);
    if (!dayEnd) return false;

    return dayEnd <= nowMs() - RETENTION_MS;
  }

  async function loadShardDocument(room, resource) {
    const cached = room.shardCache.get(resource.publicId);

    if (cached && cached.version === resource.version && cached.document) {
      return cached.document;
    }

    try {
      const document = await fetchHistoryDocumentFromUrl(
        room.id,
        resource.secureUrl
      );

      if (!document) {
        if (cached && cached.document) return cached.document;
        throw makeChatError(
          "HISTORY_SHARD_NOT_READABLE",
          `history_shard_not_readable:${resource.publicId}`
        );
      }

      document.storagePublicId = resource.publicId;
      document.storageVersion = resource.version;
      document.secureUrl = resource.secureUrl;

      room.shardCache.set(resource.publicId, {
        version: resource.version,
        secureUrl: resource.secureUrl,
        document,
      });

      return document;
    } catch (error) {
      if (cached && cached.document) {
        console.warn("[LuxuryChat][HISTORY][SHARD_CACHE_FALLBACK]", {
          room: room.id,
          publicId: resource.publicId,
          error: error && error.message ? error.message : error,
        });
        return cached.document;
      }

      throw makeChatError(
        "HISTORY_SHARD_READ_FAILED",
        `history_shard_read_failed:${resource.publicId}`,
        { cause: error }
      );
    }
  }

  async function loadLegacyHistoryDocument(room) {
    if (room.legacyMissingUntilMs > nowMs()) return null;

    const publicId = legacyHistoryPublicId(room.id);
    const deliveryUrl = rawDeliveryUrl(publicId);

    try {
      const document = await fetchHistoryDocumentFromUrl(
        room.id,
        deliveryUrl
      );

      if (!document) {
        room.legacyMissingUntilMs = nowMs() + 60 * 1000;
        return room.legacyCache && room.legacyCache.document
          ? room.legacyCache.document
          : null;
      }

      document.storagePublicId = publicId;
      document.storageVersion = 0;
      document.secureUrl = deliveryUrl;

      room.legacyCache = {
        version: 0,
        secureUrl: deliveryUrl,
        document,
      };

      return document;
    } catch (error) {
      if (room.legacyCache && room.legacyCache.document) {
        console.warn("[LuxuryChat][HISTORY][LEGACY_CACHE_FALLBACK]", {
          room: room.id,
          error: error && error.message ? error.message : error,
        });
        return room.legacyCache.document;
      }

      // Legacy ملف توافق فقط؛ عطله أو فساده لا يجوز أن يوقف الشات الحالي.
      room.legacyMissingUntilMs = nowMs() + 60 * 1000;
      console.warn("[LuxuryChat][HISTORY][LEGACY_SKIPPED]", {
        room: room.id,
        error: error && error.message ? error.message : error,
      });
      return null;
    }
  }

  async function deleteExpiredShardIfSafe(room, resource, document) {
    if (!resource || !resource.publicId) return;

    const ownLiveShardPrefix = `${utcDayKey(nowMs())}_${HISTORY_INSTANCE_TOKEN}.json`;
    if (resource.publicId.endsWith(ownLiveShardPrefix)) return;

    let safeToDelete = historyShardDefinitelyExpired(resource);

    if (document && Array.isArray(document.messages) && document.messages.length > 0) {
      let newest = 0;
      for (const message of document.messages) {
        newest = Math.max(
          newest,
          Math.max(0, Number(message && message.sentUnixMs) || 0)
        );
      }
      safeToDelete = !!newest && newest <= nowMs() - RETENTION_MS;
    }

    if (!safeToDelete) return;

    if (await destroyRawAsset(resource.publicId)) {
      room.shardCache.delete(resource.publicId);
      if (room.knownShardResources) room.knownShardResources.delete(resource.publicId);
      console.log("[LuxuryChat][HISTORY][EXPIRED_SHARD_DELETED]", {
        room: room.id,
        publicId: resource.publicId,
      });
    }
  }

  async function syncRoomFromStorage(roomId, force = false) {
    const room = getRoom(roomId);

    if (
      !force &&
      room.loaded &&
      room.lastStorageSyncMs > 0 &&
      nowMs() - room.lastStorageSyncMs < HISTORY_CACHE_SYNC_MS
    ) {
      return room;
    }

    if (room.syncPromise) return room.syncPromise;

    room.syncPromise = (async () => {
      try {
        const resources = await getKnownHistoryShardResources(room, force);
        const activeResources = [];
        const expiredResources = [];

        for (const resource of resources) {
          if (historyShardDefinitelyExpired(resource)) expiredResources.push(resource);
          else activeResources.push(resource);
        }

        // المنتهية حسب يوم الـShard لا نسمح لها بتعطيل Full Snapshot بسبب JSON تالف.
        // نحاول قراءتها من Cache فقط إن وجدت ثم نحذفها بأمان في الخلفية.
        for (const resource of expiredResources) {
          const cached = room.shardCache.get(resource.publicId);
          if (cached && cached.document) mergeDocumentIntoRoom(room, cached.document);
        }

        const shardPairs = await Promise.all(
          activeResources.map(async (resource) => ({
            resource,
            // لا نحتاج Admin API لمعرفة version كل 1.5 ثانية؛
            // Delivery URL غير المرقم يعطينا أحدث محتوى للـpublic_id المعروف.
            document: await loadKnownHistoryShardDocument(room, resource),
          }))
        );

        for (const pair of shardPairs) {
          if (!pair.document) {
            throw makeChatError(
              "HISTORY_INCOMPLETE_SNAPSHOT",
              `history_incomplete_snapshot:${pair.resource.publicId}`
            );
          }
          mergeDocumentIntoRoom(room, pair.document);
        }

        try {
          const legacy = await loadLegacyHistoryDocument(room);
          if (legacy) mergeDocumentIntoRoom(room, legacy);
        } catch (error) {
          if (force) throw error;
          if (!room.loaded && room.messages.length === 0) throw error;

          console.warn("[LuxuryChat][HISTORY][LEGACY_CACHE_FALLBACK]", {
            room: room.id,
            error: error && error.message ? error.message : error,
          });
        }

        pruneExpired(room);
        dedupeClientMessages(room);
        repairSequenceCollisions(room);

        room.loaded = true;
        room.lastStorageSyncMs = nowMs();

        Promise.all([
          ...expiredResources.map((resource) =>
            deleteExpiredShardIfSafe(
              room,
              resource,
              room.shardCache.get(resource.publicId)?.document || null
            )
          ),
          ...shardPairs.map((pair) =>
            deleteExpiredShardIfSafe(room, pair.resource, pair.document)
          ),
        ]).catch(() => {});

        return room;
      } catch (error) {
        // V12: القراءة/الاكتشاف من Cloudinary لا يجوز أن يحول عطل خارجي مؤقت
        // إلى منع كامل للإرسال. نستخدم Runtime cache (حتى لو كانت فارغة عند أول تشغيل)
        // ونستمر بالمحاولة في الطلبات التالية. الكتابة نفسها ما زالت تُتحقق بعد الرفع.
        console.warn("[LuxuryChat][HISTORY][SYNC][SEND_SAFE_FALLBACK]", {
          room: room.id,
          force: !!force,
          loaded: !!room.loaded,
          cachedMessages: Array.isArray(room.messages) ? room.messages.length : 0,
          error: error && error.message ? error.message : error,
        });

        room.loaded = true;
        room.lastStorageSyncMs = nowMs() - HISTORY_CACHE_SYNC_MS + 250;
        pruneExpired(room);
        dedupeClientMessages(room);
        repairSequenceCollisions(room);
        return room;
      } finally {
        room.syncPromise = null;
      }
    })();

    return room.syncPromise;
  }

  async function ensureRoomLoaded(roomId, options = {}) {
    const room = getRoom(roomId);
    const forceStorageRefresh = !!options.forceStorageRefresh;

    if (!room.loaded || forceStorageRefresh) {
      return syncRoomFromStorage(roomId, true);
    }

    return syncRoomFromStorage(roomId, false);
  }

  function findMessage(room, messageId) {
    if (!room || !messageId) return null;

    for (let i = room.messages.length - 1; i >= 0; i--) {
      const message = room.messages[i];
      if (message && message.id === messageId) return message;
    }

    return null;
  }

  function findClientMessage(room, senderId, clientMessageId) {
    if (!room || !senderId || !clientMessageId) return null;

    for (let i = room.messages.length - 1; i >= 0; i--) {
      const message = room.messages[i];
      if (
        message &&
        message.senderId === senderId &&
        message.clientMessageId === clientMessageId
      ) {
        return message;
      }
    }

    return null;
  }

  function requiredMessageExists(document, requirement) {
    if (!requirement) return true;
    if (!document || !Array.isArray(document.messages)) return false;

    if (
      requirement.messageId &&
      document.messages.some((m) => m && m.id === requirement.messageId)
    ) {
      return true;
    }

    if (requirement.senderId && requirement.clientMessageId) {
      return document.messages.some(
        (m) =>
          m &&
          m.senderId === requirement.senderId &&
          m.clientMessageId === requirement.clientMessageId
      );
    }

    return false;
  }

  function buildShardPayload(roomId, dayKey, messages) {
    const tempRoom = {
      id: cleanRoom(roomId),
      seq: 0,
      messages: (messages || [])
        .map((m) => normalizeMessage(m, roomId))
        .filter(Boolean),
    };

    pruneExpired(tempRoom);
    dedupeClientMessages(tempRoom);
    repairSequenceCollisions(tempRoom);

    return {
      version: 12,
      build: SERVER_BUILD,
      storageMode: "render-process-daily-shard",
      room: cleanRoom(roomId),
      shardDay: dayKey,
      shardInstance: HISTORY_INSTANCE_TOKEN,
      seq: Math.max(0, Number(tempRoom.seq) || 0),
      retentionDays: RETENTION_DAYS,
      savedAtUnixMs: nowMs(),
      messages: tempRoom.messages,
    };
  }

  async function loadLocalShard(room, dayKey) {
    const publicId = historyShardPublicId(room.id, dayKey);
    const cached = room.shardCache.get(publicId);

    if (cached && cached.document) {
      return {
        publicId,
        version: cached.version || 0,
        secureUrl: cached.secureUrl || "",
        document: cached.document,
      };
    }

    // Writer shard الخاص بهذه العملية معروف Public ID مسبقاً؛
    // لا نحتاج Admin API لمعرفة هل هو موجود أم لا.
    const deliveryUrl = rawDeliveryUrl(publicId);
    const document = await fetchHistoryDocumentFromUrl(room.id, deliveryUrl);

    if (!document) {
      return {
        publicId,
        version: 0,
        secureUrl: deliveryUrl,
        document: {
          exists: true,
          version: 12,
          room: room.id,
          seq: 0,
          retentionDays: RETENTION_DAYS,
          savedAtUnixMs: 0,
          messages: [],
        },
      };
    }

    document.storagePublicId = publicId;
    document.storageVersion = 0;
    document.secureUrl = deliveryUrl;

    room.shardCache.set(publicId, {
      version: 0,
      secureUrl: deliveryUrl,
      document,
    });

    return {
      publicId,
      version: 0,
      secureUrl: deliveryUrl,
      document,
    };
  }

  async function saveRoomNow(roomId, requirement = null) {
    const room = getRoom(roomId);

    if (!requirement) {
      pruneExpired(room);
      dedupeClientMessages(room);
      repairSequenceCollisions(room);
      return room;
    }

    let target = requirement.messageId
      ? findMessage(room, requirement.messageId)
      : null;

    if (!target && requirement.senderId && requirement.clientMessageId) {
      target = findClientMessage(
        room,
        requirement.senderId,
        requirement.clientMessageId
      );
    }

    if (!target) {
      throw makeChatError(
        "HISTORY_TARGET_MISSING",
        "chat_history_target_missing_before_shard_write"
      );
    }

    const dayKey = utcDayKey(target.sentUnixMs);
    let lastError = null;

    for (let attempt = 1; attempt <= HISTORY_WRITE_VERIFY_ATTEMPTS; attempt++) {
      try {
        const localShard = await loadLocalShard(room, dayKey);
        const localMessages = Array.isArray(localShard.document.messages)
          ? localShard.document.messages.slice()
          : [];

        const existingById = localMessages.some((m) => m && m.id === target.id);
        const existingByClient =
          target.senderId &&
          target.clientMessageId &&
          localMessages.some(
            (m) =>
              m &&
              m.senderId === target.senderId &&
              m.clientMessageId === target.clientMessageId
          );

        if (!existingById && !existingByClient) localMessages.push(target);

        const payload = buildShardPayload(room.id, dayKey, localMessages);
        const uploadResult = await uploadRawJson(localShard.publicId, payload);

        if (!uploadResult || !uploadResult.secure_url) {
          throw new Error("history_shard_upload_missing_url");
        }

        if (HISTORY_WRITE_VERIFY_SETTLE_MS > 0) {
          await sleep(HISTORY_WRITE_VERIFY_SETTLE_MS);
        }

        const verifyDocument = await fetchHistoryDocumentFromUrl(
          room.id,
          uploadResult.secure_url
        );

        if (!verifyDocument || !requiredMessageExists(verifyDocument, requirement)) {
          throw new Error("history_shard_verify_required_message_missing");
        }

        verifyDocument.storagePublicId = localShard.publicId;
        verifyDocument.storageVersion = Math.max(
          0,
          Number(uploadResult.version) || 0
        );
        verifyDocument.secureUrl = String(uploadResult.secure_url);

        room.shardCache.set(localShard.publicId, {
          version: verifyDocument.storageVersion,
          secureUrl: verifyDocument.secureUrl,
          document: verifyDocument,
        });

        if (!room.knownShardResources) room.knownShardResources = new Map();
        room.knownShardResources.set(localShard.publicId, {
          publicId: localShard.publicId,
          secureUrl: verifyDocument.secureUrl,
          version: verifyDocument.storageVersion,
          createdAt: "",
        });

        room.lastStorageSavedAtUnixMs = nowMs();
        room.lastStorageSyncMs = nowMs();
        return room;
      } catch (error) {
        lastError = error;
        if (attempt < HISTORY_WRITE_VERIFY_ATTEMPTS) {
          room.shardCache.delete(historyShardPublicId(room.id, dayKey));
          await sleep(120 * attempt);
        }
      }
    }

    throw lastError || new Error("chat_history_shard_write_verify_failed");
  }

  function enqueueRoomMutation(roomId, operation) {
    const room = getRoom(roomId);
    room.mutationChain = room.mutationChain.catch(() => {}).then(operation);
    return room.mutationChain;
  }

  function enqueueRoomSave(roomId) {
    return enqueueRoomMutation(roomId, async () => {
      const room = await ensureRoomLoaded(roomId, {
        forceStorageRefresh: false,
      });
      pruneExpired(room);
      dedupeClientMessages(room);
      repairSequenceCollisions(room);
      return room;
    });
  }

  async function pushMessage(roomId, message) {
    return enqueueRoomMutation(roomId, async () => {
      const room = await ensureRoomLoaded(roomId, {
        forceStorageRefresh: true,
      });

      pruneExpired(room);
      dedupeClientMessages(room);
      repairSequenceCollisions(room);

      if (message && message.senderId && message.clientMessageId) {
        const duplicate = findClientMessage(
          room,
          message.senderId,
          message.clientMessageId
        );
        if (duplicate) return duplicate;
      }

      message.room = cleanRoom(roomId);
      room.messages.push(message);
      repairSequenceCollisions(room);

      const requirement = {
        messageId: message.id,
        senderId: message.senderId,
        clientMessageId: message.clientMessageId,
      };

      try {
        await saveRoomNow(roomId, requirement);
      } catch (error) {
        room.messages = room.messages.filter((m) => m && m.id !== message.id);
        room.seq = 0;
        repairSequenceCollisions(room);
        throw error;
      }

      if (message.senderId && message.clientMessageId) {
        const canonical = findClientMessage(
          room,
          message.senderId,
          message.clientMessageId
        );
        if (canonical) return canonical;
      }

      return findMessage(room, message.id) || message;
    });
  }

  // ========================================================================
  // VIDEO MODERATION JOB PERSISTENCE - V11 HARDENED SHARDS
  // ========================================================================

  function legacyVideoJobsUrl() {
    const base = cloudinary.url(LEGACY_VIDEO_JOBS_PUBLIC_ID, {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });
    return addCacheBust(base);
  }

  function videoJobsShardPrefix() {
    return `${VIDEO_JOBS_FOLDER}/`;
  }

  function videoJobsShardPublicId(dayKey = utcDayKey(nowMs())) {
    return `${VIDEO_JOBS_FOLDER}/${dayKey}_${HISTORY_INSTANCE_TOKEN}.json`;
  }

  function extractVideoJobShardDay(publicId) {
    const match = String(publicId || "").match(/\/(\d{8})_[^/]+\.json$/);
    return match ? match[1] : "";
  }

  function getVideoJobsCryptoKey() {
    if (!CLOUDINARY_API_SECRET) {
      throw new Error("CLOUDINARY_API_SECRET missing for video jobs encryption");
    }

    return crypto
      .createHash("sha256")
      .update(`luxury-chat-video-jobs-v1|${CLOUDINARY_API_SECRET}`, "utf8")
      .digest();
  }

  function encryptVideoJobsPayload(object) {
    const iv = crypto.randomBytes(12);
    const key = getVideoJobsCryptoKey();
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const plain = Buffer.from(JSON.stringify(object), "utf8");
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    };
  }

  function decryptVideoJobsPayload(envelope) {
    if (
      !envelope ||
      typeof envelope !== "object" ||
      envelope.algorithm !== "aes-256-gcm" ||
      !envelope.iv ||
      !envelope.tag ||
      !envelope.data
    ) {
      throw new Error("video_jobs_invalid_envelope");
    }

    const key = getVideoJobsCryptoKey();
    const iv = Buffer.from(String(envelope.iv), "base64");
    const tag = Buffer.from(String(envelope.tag), "base64");
    const encrypted = Buffer.from(String(envelope.data), "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const plain = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");

    return JSON.parse(plain);
  }

  function isTerminalVideoStatus(status) {
    const value = String(status || "").trim().toLowerCase();
    return value === "approved" || value === "rejected" || value === "failed";
  }

  function normalizeVideoJob(raw) {
    if (!raw || typeof raw !== "object") return null;

    const jobId = safeString(raw.jobId, 100);
    const publicId = safeString(raw.publicId, 500);
    const senderId = safeString(raw.senderId, 100);
    const roomId = cleanRoom(raw.roomId || raw.room || "global");
    const clientMessageId = cleanClientMessageId(raw.clientMessageId);

    if (!jobId || !publicId || !senderId || !clientMessageId) return null;

    const profileRaw =
      raw.profile && typeof raw.profile === "object" ? raw.profile : {};

    const replyRaw =
      raw.reply && typeof raw.reply === "object" ? raw.reply : {};

    return {
      jobId,
      publicId,
      senderId,
      roomId,
      clientMessageId,
      status: safeString(raw.status, 30) || "pending",
      moderationStatus: safeString(raw.moderationStatus, 30) || "pending",
      createdAtUnixMs:
        Math.max(0, Number(raw.createdAtUnixMs) || 0) || nowMs(),
      updatedAtUnixMs:
        Math.max(0, Number(raw.updatedAtUnixMs) || 0) || nowMs(),
      uploadCompleted: !!raw.uploadCompleted,
      lastCloudinaryCheckUnixMs: Math.max(
        0,
        Number(raw.lastCloudinaryCheckUnixMs) || 0
      ),
      mediaUrl: safeString(raw.mediaUrl, 1600),
      mediaThumbnailUrl: safeString(raw.mediaThumbnailUrl, 1600),
      mediaFileName:
        safeString(raw.mediaFileName, 180) || "chat_video.mp4",
      rejectReason: safeString(raw.rejectReason, 300),
      messageId: safeString(raw.messageId, 100),
      profile: {
        playerName: safeString(profileRaw.playerName, 64) || "لاعب",
        avatarUrl: safeString(profileRaw.avatarUrl, 1000),
        avatarVersion: safeString(profileRaw.avatarVersion, 100) || "0",
      },
      reply: {
        replyToId: safeString(replyRaw.replyToId, 100),
        replyToSenderId: safeString(replyRaw.replyToSenderId, 100),
        replyToName: safeString(replyRaw.replyToName, 64),
        replyToPreview: safeString(replyRaw.replyToPreview, 120),
      },
    };
  }

  function videoJobStatusRank(status) {
    switch (String(status || "").trim().toLowerCase()) {
      case "rejected":
        return 60;
      case "approved":
        return 50;
      case "failed":
        return 40;
      case "pending":
        return 20;
      case "uploading":
        return 10;
      default:
        return 0;
    }
  }

  function mergeVideoJob(job) {
    const incoming = normalizeVideoJob(job);
    if (!incoming) return null;

    const existing = videoJobs.get(incoming.publicId);
    if (!existing) {
      videoJobs.set(incoming.publicId, incoming);
      return incoming;
    }

    const incomingUpdated = Math.max(0, Number(incoming.updatedAtUnixMs) || 0);
    const existingUpdated = Math.max(0, Number(existing.updatedAtUnixMs) || 0);

    let newer = existing;
    let older = incoming;

    if (
      incomingUpdated > existingUpdated ||
      (incomingUpdated === existingUpdated &&
        videoJobStatusRank(incoming.status) > videoJobStatusRank(existing.status))
    ) {
      newer = incoming;
      older = existing;
    }

    const merged = normalizeVideoJob(newer) || { ...newer };

    // الحقول التي قد تصل بعد Webhook (خصوصاً upload callback) تُدمج ولا تضيع.
    merged.createdAtUnixMs = positiveMin(
      existing.createdAtUnixMs,
      incoming.createdAtUnixMs
    );
    merged.updatedAtUnixMs = Math.max(existingUpdated, incomingUpdated);
    merged.lastCloudinaryCheckUnixMs = Math.max(
      Number(existing.lastCloudinaryCheckUnixMs || 0),
      Number(incoming.lastCloudinaryCheckUnixMs || 0)
    );
    merged.uploadCompleted = !!(existing.uploadCompleted || incoming.uploadCompleted);
    merged.mediaUrl = newer.mediaUrl || older.mediaUrl || "";
    merged.mediaThumbnailUrl =
      newer.mediaThumbnailUrl || older.mediaThumbnailUrl || "";
    merged.mediaFileName =
      newer.mediaFileName || older.mediaFileName || "chat_video.mp4";
    merged.messageId = newer.messageId || older.messageId || "";
    merged.rejectReason = newer.rejectReason || older.rejectReason || "";

    merged.profile = {
      playerName:
        safeString(newer.profile && newer.profile.playerName, 64) ||
        safeString(older.profile && older.profile.playerName, 64) ||
        "لاعب",
      avatarUrl:
        safeString(newer.profile && newer.profile.avatarUrl, 1000) ||
        safeString(older.profile && older.profile.avatarUrl, 1000) ||
        "",
      avatarVersion:
        safeString(newer.profile && newer.profile.avatarVersion, 100) ||
        safeString(older.profile && older.profile.avatarVersion, 100) ||
        "0",
    };

    merged.reply = {
      replyToId:
        safeString(newer.reply && newer.reply.replyToId, 100) ||
        safeString(older.reply && older.reply.replyToId, 100) ||
        "",
      replyToSenderId:
        safeString(newer.reply && newer.reply.replyToSenderId, 100) ||
        safeString(older.reply && older.reply.replyToSenderId, 100) ||
        "",
      replyToName:
        safeString(newer.reply && newer.reply.replyToName, 64) ||
        safeString(older.reply && older.reply.replyToName, 64) ||
        "",
      replyToPreview:
        safeString(newer.reply && newer.reply.replyToPreview, 120) ||
        safeString(older.reply && older.reply.replyToPreview, 120) ||
        "",
    };

    const existingTerminal = isTerminalVideoStatus(existing.status);
    const incomingTerminal = isTerminalVideoStatus(incoming.status);

    if (existingTerminal && !incomingTerminal) {
      merged.status = existing.status;
    } else if (incomingTerminal && !existingTerminal) {
      merged.status = incoming.status;
    } else if (existingTerminal && incomingTerminal) {
      if (incomingUpdated > existingUpdated) merged.status = incoming.status;
      else if (existingUpdated > incomingUpdated) merged.status = existing.status;
      else {
        merged.status =
          videoJobStatusRank(incoming.status) >= videoJobStatusRank(existing.status)
            ? incoming.status
            : existing.status;
      }
    }

    const existingModerationFinal =
      existing.moderationStatus === "approved" ||
      existing.moderationStatus === "rejected";
    const incomingModerationFinal =
      incoming.moderationStatus === "approved" ||
      incoming.moderationStatus === "rejected";

    // الأهم في سباق Webhook/Upload: approved/rejected لا تضيع أمام pending أحدث.
    if (existingModerationFinal && !incomingModerationFinal) {
      merged.moderationStatus = existing.moderationStatus;
    } else if (incomingModerationFinal && !existingModerationFinal) {
      merged.moderationStatus = incoming.moderationStatus;
    } else if (existingModerationFinal && incomingModerationFinal) {
      if (incomingUpdated > existingUpdated) {
        merged.moderationStatus = incoming.moderationStatus;
      } else if (existingUpdated > incomingUpdated) {
        merged.moderationStatus = existing.moderationStatus;
      } else if (incoming.moderationStatus === "rejected") {
        merged.moderationStatus = "rejected";
      } else {
        merged.moderationStatus = existing.moderationStatus;
      }
    }

    // rejected يظل يحمل سبب الرفض إن وُجد في أي نسخة.
    if (merged.status === "rejected") {
      merged.rejectReason =
        safeString(incoming.rejectReason, 300) ||
        safeString(existing.rejectReason, 300) ||
        merged.rejectReason ||
        "تم رفض الفيديو لأنه يحتوي على محتوى غير مناسب للشات";
    }

    videoJobs.set(merged.publicId, merged);
    return merged;
  }

  function pruneVideoJobsInMemory() {
    const cutoff = nowMs() - VIDEO_JOB_RETENTION_MS;
    let changed = false;

    for (const [publicId, job] of videoJobs.entries()) {
      if (!job) {
        videoJobs.delete(publicId);
        changed = true;
        continue;
      }

      const updated = Math.max(0, Number(job.updatedAtUnixMs) || 0);

      if (
        updated > 0 &&
        updated <= cutoff &&
        isTerminalVideoStatus(job.status)
      ) {
        videoJobs.delete(publicId);
        changed = true;
      }
    }

    return changed;
  }

  async function listVideoJobShardResources() {
    const resources = [];
    let nextCursor = undefined;

    do {
      const result = await cloudinary.api.resources({
        resource_type: "raw",
        type: "upload",
        prefix: videoJobsShardPrefix(),
        max_results: 500,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      });

      if (result && Array.isArray(result.resources)) {
        for (const resource of result.resources) {
          if (!resource || !resource.public_id || !resource.secure_url) continue;

          resources.push({
            publicId: safeString(resource.public_id, 600),
            secureUrl: safeString(resource.secure_url, 1800),
            version: Math.max(0, Number(resource.version) || 0),
            createdAt: safeString(resource.created_at, 80),
          });
        }
      }

      nextCursor =
        result && result.next_cursor ? String(result.next_cursor) : undefined;
    } while (nextCursor);

    return resources;
  }

  async function getKnownVideoJobShardResources(forceDiscovery = false) {
    const current = nowMs();
    const shouldDiscover =
      videoJobKnownResources.size === 0 ||
      lastVideoJobShardDiscoveryUnixMs <= 0 ||
      current - lastVideoJobShardDiscoveryUnixMs >= VIDEO_JOB_SHARD_DISCOVERY_MS ||
      (forceDiscovery && !videoJobsLoaded);

    if (shouldDiscover) {
      try {
        const discovered = await listVideoJobShardResources();
        for (const resource of discovered) {
          videoJobKnownResources.set(resource.publicId, resource);
        }
        lastVideoJobShardDiscoveryUnixMs = current;
      } catch (error) {
        // مثل History: Rate Limit في Admin API لا يجوز أن يمنع رفع فيديو جديد.
        lastVideoJobShardDiscoveryUnixMs = Math.max(
          0,
          current - VIDEO_JOB_SHARD_DISCOVERY_MS + 5000
        );
        console.warn("[LuxuryChat][VIDEO_JOBS][ADMIN_DISCOVERY_FALLBACK]", {
          knownShards: videoJobKnownResources.size,
          error: error && error.message ? error.message : error,
        });
      }
    }

    return Array.from(videoJobKnownResources.values());
  }

  function videoJobShardDefinitelyExpired(resource) {
    if (!resource || !resource.publicId) return false;
    const shardDay = extractVideoJobShardDay(resource.publicId);
    const dayEnd = dayKeyEndUnixMs(shardDay);
    if (!dayEnd) return false;
    return dayEnd <= nowMs() - VIDEO_JOB_RETENTION_MS;
  }

  async function readEncryptedVideoJobsUrl(url) {
    const response = await fetchWithTimeout(
      addCacheBust(url),
      {
        method: "GET",
        headers: {
          "Cache-Control": "no-cache, no-store, max-age=0",
          Pragma: "no-cache",
        },
      },
      DIRECT_FETCH_TIMEOUT_MS
    );

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`video_jobs_load_http_${response.status}`);
    }

    let envelope;

    try {
      envelope = JSON.parse(await response.text());
    } catch (_) {
      throw new Error("video_jobs_invalid_json");
    }

    const decoded = decryptVideoJobsPayload(envelope);
    return decoded && Array.isArray(decoded.jobs) ? decoded.jobs : [];
  }

  function videoJobShardCanBeDeleted(resource, jobs, authoritativeJobs) {
    if (!resource || !Array.isArray(jobs)) return false;

    const shardDay = extractVideoJobShardDay(resource.publicId);
    if (!shardDay) return false;

    const currentDay = utcDayKey(nowMs());
    if (shardDay >= currentDay) return false;

    const cutoff = nowMs() - VIDEO_JOB_RETENTION_MS;

    // Shard قديم فارغ: آمن للحذف بعد انتهاء يومه.
    if (jobs.length === 0) {
      return dayKeyEndUnixMs(shardDay) > 0 && dayKeyEndUnixMs(shardDay) <= cutoff;
    }

    for (const rawJob of jobs) {
      const job = normalizeVideoJob(rawJob);
      if (!job) continue;

      const rawUpdated = Math.max(0, Number(job.updatedAtUnixMs) || 0);

      if (isTerminalVideoStatus(job.status) && rawUpdated > 0 && rawUpdated <= cutoff) {
        continue;
      }

      const authoritative = authoritativeJobs.get(job.publicId);
      if (!authoritative) return false;

      const authUpdated = Math.max(
        0,
        Number(authoritative.updatedAtUnixMs) || 0
      );

      if (
        !isTerminalVideoStatus(authoritative.status) ||
        authUpdated < rawUpdated ||
        authUpdated > cutoff
      ) {
        return false;
      }
    }

    return true;
  }

  async function cleanupExpiredVideoJobShards(shardPairs) {
    if (!Array.isArray(shardPairs) || shardPairs.length === 0) return;

    const authoritativeJobs = new Map(videoJobs);
    const ownCurrentPublicId = videoJobsShardPublicId(utcDayKey(nowMs()));

    await Promise.all(
      shardPairs.map(async (pair) => {
        if (!pair || !pair.resource || !Array.isArray(pair.jobs)) return;
        if (pair.resource.publicId === ownCurrentPublicId) return;

        if (
          !videoJobShardCanBeDeleted(
            pair.resource,
            pair.jobs,
            authoritativeJobs
          )
        ) {
          return;
        }

        try {
          await destroyRawAsset(pair.resource.publicId);
          videoJobShardCache.delete(pair.resource.publicId);
          videoJobKnownResources.delete(pair.resource.publicId);

          console.log("[LuxuryChat][VIDEO_JOBS][EXPIRED_SHARD_DELETED]", {
            publicId: pair.resource.publicId,
          });
        } catch (error) {
          console.warn("[LuxuryChat][VIDEO_JOBS][EXPIRED_SHARD_DELETE_FAILED]", {
            publicId: pair.resource.publicId,
            error: error && error.message ? error.message : error,
          });
        }
      })
    );
  }

  async function loadVideoJobsFromStorage(forceDiscovery = false) {
    const resources = await getKnownVideoJobShardResources(forceDiscovery);
    const shardPairs = [];

    // كل Shard معروف يجب أن يكون قابلاً للقراءة أو نستخدم Cache سليمة.
    for (const resource of resources) {
      const cached = videoJobShardCache.get(resource.publicId);
      let jobs = null;

      try {
        // نقرأ أحدث نسخة من Delivery URL غير المرقم، بدون Admin resource لكل تحديث.
        jobs = await readEncryptedVideoJobsUrl(rawDeliveryUrl(resource.publicId));
        if (!jobs) throw new Error("video_jobs_shard_not_found");

        videoJobShardCache.set(resource.publicId, {
          version: resource.version,
          secureUrl: rawDeliveryUrl(resource.publicId),
          jobs,
        });
      } catch (error) {
        if (cached && cached.jobs) {
          jobs = cached.jobs;
          console.warn("[LuxuryChat][VIDEO_JOBS][SHARD_CACHE_FALLBACK]", {
            publicId: resource.publicId,
            error: error && error.message ? error.message : error,
          });
        } else {
          // Shard تالف/غير قابل للقراءة لا يعطل جميع الفيديوهات.
          // إذا انتهت مدة الاحتفاظ نحذفه فوراً؛ وإلا نعزله ونكمل.
          jobs = [];
          console.error("[LuxuryChat][VIDEO_JOBS][CORRUPT_SHARD_SKIPPED]", {
            publicId: resource.publicId,
            error: error && error.message ? error.message : error,
          });

          if (videoJobShardDefinitelyExpired(resource)) {
            try {
              await destroyRawAsset(resource.publicId);
              videoJobKnownResources.delete(resource.publicId);
              videoJobShardCache.delete(resource.publicId);
              console.warn("[LuxuryChat][VIDEO_JOBS][CORRUPT_EXPIRED_SHARD_DELETED]", {
                publicId: resource.publicId,
              });
              continue;
            } catch (_) {}
          }
        }
      }

      shardPairs.push({ resource, jobs: jobs || [] });

      for (const job of jobs || []) {
        mergeVideoJob(job);
      }
    }

    // V8 القديم: قراءة فقط للتوافق مع Pending videos القديمة.
    // ملف Legacy لا يجوز أن يعطل نظام الفيديو الحديث إذا كان تالفاً أو غير متاح.
    try {
      const legacy = await readEncryptedVideoJobsUrl(legacyVideoJobsUrl());
      if (legacy) {
        for (const job of legacy) mergeVideoJob(job);
      }
    } catch (error) {
      console.warn(
        "[LuxuryChat][VIDEO_JOBS][LEGACY_READ_SKIPPED]",
        error && error.message ? error.message : error
      );
    }

    videoJobsLoaded = true;

    // ننظف Shards القديمة قبل حذف Terminal jobs من الذاكرة، حتى نملك مرجع الدمج.
    try {
      await cleanupExpiredVideoJobShards(shardPairs);
    } catch (error) {
      console.warn(
        "[LuxuryChat][VIDEO_JOBS][CLEANUP_FAILED]",
        error && error.message ? error.message : error
      );
    }

    pruneVideoJobsInMemory();
    return videoJobs;
  }

  async function ensureVideoJobsLoaded(forceRefresh = false) {
    if (videoJobsLoadPromise) return videoJobsLoadPromise;
    if (videoJobsLoaded && !forceRefresh) return videoJobs;

    videoJobsLoadPromise = loadVideoJobsFromStorage(forceRefresh)
      .then((result) => {
        videoJobsLoadPromise = null;
        return result;
      })
      .catch((error) => {
        videoJobsLoadPromise = null;

        if (!videoJobsLoaded) throw error;

        console.warn(
          "[LuxuryChat][VIDEO_JOBS][CACHE_FALLBACK]",
          error && error.message ? error.message : error
        );

        return videoJobs;
      });

    return videoJobsLoadPromise;
  }

  async function saveVideoJobsNow() {
    try {
      await ensureVideoJobsLoaded(true);
    } catch (error) {
      if (!videoJobsLoaded) throw error;
    }

    pruneVideoJobsInMemory();

    const dayKey = utcDayKey(nowMs());
    const publicId = videoJobsShardPublicId(dayKey);

    const payload = {
      version: 12,
      build: SERVER_BUILD,
      storageMode: "render-process-daily-video-job-shard",
      shardDay: dayKey,
      shardInstance: HISTORY_INSTANCE_TOKEN,
      savedAtUnixMs: nowMs(),
      jobs: Array.from(videoJobs.values()),
    };

    const encrypted = encryptVideoJobsPayload(payload);
    const uploadResult = await uploadRawJson(publicId, encrypted);

    if (!uploadResult || !uploadResult.secure_url) {
      throw new Error("video_jobs_shard_upload_missing_url");
    }

    if (HISTORY_WRITE_VERIFY_SETTLE_MS > 0) {
      await sleep(HISTORY_WRITE_VERIFY_SETTLE_MS);
    }

    const verifyJobs = await readEncryptedVideoJobsUrl(uploadResult.secure_url);
    if (!verifyJobs) throw new Error("video_jobs_shard_verify_failed");

    const expected = new Map(
      payload.jobs
        .map((job) => normalizeVideoJob(job))
        .filter(Boolean)
        .map((job) => [job.publicId, job])
    );

    const verified = new Map(
      verifyJobs
        .map((job) => normalizeVideoJob(job))
        .filter(Boolean)
        .map((job) => [job.publicId, job])
    );

    for (const [expectedPublicId, expectedJob] of expected.entries()) {
      const actual = verified.get(expectedPublicId);
      if (!actual) {
        throw new Error(
          `video_jobs_shard_verify_missing_job:${expectedPublicId}`
        );
      }

      if (
        Number(actual.updatedAtUnixMs || 0) <
        Number(expectedJob.updatedAtUnixMs || 0)
      ) {
        throw new Error(
          `video_jobs_shard_verify_stale_job:${expectedPublicId}`
        );
      }
    }

    const savedVideoJobResource = {
      publicId,
      version: Math.max(0, Number(uploadResult.version) || 0),
      secureUrl: String(uploadResult.secure_url),
      createdAt: "",
    };

    videoJobShardCache.set(publicId, {
      version: savedVideoJobResource.version,
      secureUrl: savedVideoJobResource.secureUrl,
      jobs: verifyJobs,
    });
    videoJobKnownResources.set(publicId, savedVideoJobResource);
  }

  function enqueueVideoJobsSave() {
    videoJobsWriteChain = videoJobsWriteChain
      .catch(() => {})
      .then(() => saveVideoJobsNow());

    return videoJobsWriteChain;
  }

  function videoJobClientPreferenceRank(status) {
    switch (String(status || "").trim().toLowerCase()) {
      case "approved":
        return 100;
      case "pending":
        return 80;
      case "uploading":
        return 70;
      case "rejected":
        return 60;
      case "failed":
        return 50;
      default:
        return 0;
    }
  }

  function findVideoJobByClient(senderId, clientMessageId) {
    if (!senderId || !clientMessageId) return null;

    let best = null;

    for (const job of videoJobs.values()) {
      if (
        !job ||
        job.senderId !== senderId ||
        job.clientMessageId !== clientMessageId
      ) {
        continue;
      }

      if (!best) {
        best = job;
        continue;
      }

      const jobPreference = videoJobClientPreferenceRank(job.status);
      const bestPreference = videoJobClientPreferenceRank(best.status);

      if (
        jobPreference > bestPreference ||
        (jobPreference === bestPreference &&
          Number(job.updatedAtUnixMs || 0) > Number(best.updatedAtUnixMs || 0))
      ) {
        best = job;
      }
    }

    return best;
  }

  // ========================================================================
  // VIDEO MODERATION HELPERS
  // ========================================================================

  function buildVideoRejectReason(source) {
    let text = "";

    try {
      text = JSON.stringify(source || {}).toLowerCase();
    } catch (_) {
      text = "";
    }

    if (
      text.includes("explicit_nudity") ||
      text.includes("nudity") ||
      text.includes("sexual") ||
      text.includes("suggestive")
    ) {
      return "تم رفض الفيديو لأنه يحتوي على محتوى مخل أو غير مناسب";
    }

    if (text.includes("violence") || text.includes("visually_disturbing")) {
      return "تم رفض الفيديو لأنه يحتوي على محتوى عنيف أو مزعج";
    }

    if (text.includes("rude_gestures") || text.includes("hate_symbols")) {
      return "تم رفض الفيديو لأنه يحتوي على محتوى أو إشارات غير مناسبة";
    }

    if (
      text.includes("drugs") ||
      text.includes("tobacco") ||
      text.includes("alcohol") ||
      text.includes("gambling")
    ) {
      return "تم رفض الفيديو لأنه لا يتوافق مع سياسة المحتوى في الشات";
    }

    return "تم رفض الفيديو لأنه يحتوي على محتوى غير مناسب للشات";
  }

  function getModerationEntry(uploadResult, kind) {
    let moderation = [];

    if (uploadResult && Array.isArray(uploadResult.moderation)) {
      moderation = uploadResult.moderation;
    } else if (uploadResult && Array.isArray(uploadResult.moderations)) {
      moderation = uploadResult.moderations;
    }

    const wanted = String(kind || "").trim().toLowerCase();

    for (const item of moderation) {
      if (!item || typeof item !== "object") continue;

      if (String(item.kind || "").trim().toLowerCase() === wanted) {
        return item;
      }
    }

    return null;
  }

  function getModerationStatus(uploadResult, kind) {
    const entry = getModerationEntry(uploadResult, kind);
    return entry ? String(entry.status || "").trim().toLowerCase() : "";
  }

  function getModerationLabels(uploadResult, kind) {
    const entry = getModerationEntry(uploadResult, kind);

    if (
      !entry ||
      !entry.response ||
      !Array.isArray(entry.response.moderation_labels)
    ) {
      return [];
    }

    return entry.response.moderation_labels.slice(0, 20);
  }

  function getDeepModerationStatus(value, seen = new Set()) {
    if (!value || typeof value !== "object") return "";
    if (seen.has(value)) return "";
    seen.add(value);

    const directCandidates = [
      value.moderation_status,
      value.moderationStatus,
      value.status,
    ];

    for (const candidate of directCandidates) {
      const status = String(candidate || "").trim().toLowerCase();

      if (status === "approved" || status === "rejected" || status === "pending") {
        return status;
      }
    }

    const entry = getModerationEntry(value, VIDEO_MODERATION_KIND);
    if (entry) {
      const status = String(entry.status || "").trim().toLowerCase();
      if (status === "approved" || status === "rejected" || status === "pending") {
        return status;
      }
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const nested = getDeepModerationStatus(child, seen);
        if (nested) return nested;
      }
    }

    return "";
  }

  async function getVideoModerationResource(publicId) {
    return await cloudinary.api.resource(publicId, {
      resource_type: "video",
      type: "upload",
      moderations: true,
    });
  }

  // ========================================================================
  // CLOUDINARY MEDIA
  // ========================================================================

  function safeMediaIdSegment(value, fallback = "player") {
    const cleaned = String(value || "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 70);
    return cleaned || fallback;
  }

  function uniqueMediaPublicId(playFabId) {
    return `${safeMediaIdSegment(playFabId)}_${Date.now()}_${crypto
      .randomBytes(5)
      .toString("hex")}`;
  }

  function mediaPublicId(folder, playFabId, clientMessageId, kind) {
    const client = cleanClientMessageId(clientMessageId);
    if (!client) return `${folder}/${uniqueMediaPublicId(playFabId)}`;

    const digest = crypto
      .createHash("sha256")
      .update(
        `${safeString(playFabId, 100)}|${client}|${safeString(kind, 30)}`,
        "utf8"
      )
      .digest("hex");

    return `${folder}/${safeMediaIdSegment(playFabId)}_${safeMediaIdSegment(
      kind,
      "media"
    )}_${digest.slice(0, 40)}`;
  }

  async function tryGetExistingCloudinaryAsset(publicId, resourceType, includeModeration = false) {
    try {
      return await cloudinary.api.resource(publicId, {
        resource_type: resourceType,
        type: "upload",
        ...(includeModeration ? { moderations: true } : {}),
      });
    } catch (_) {
      return null;
    }
  }

  async function destroyCloudinaryAsset(publicId, resourceType) {
    const id = safeString(publicId, 500);
    if (!id) return false;

    try {
      const result = await cloudinary.uploader.destroy(id, {
        resource_type: resourceType || "image",
        type: "upload",
        invalidate: true,
      });

      console.log("[LuxuryChat][CLOUDINARY][DESTROY]", {
        publicId: id,
        resourceType: resourceType || "image",
        result: result && result.result ? result.result : result,
      });

      return true;
    } catch (error) {
      console.error("[LuxuryChat][CLOUDINARY][DESTROY][FAILED]", {
        publicId: id,
        resourceType: resourceType || "image",
        error: error && error.message ? error.message : error,
      });

      return false;
    }
  }

  function uploadAudioBuffer(buffer, playFabId, clientMessageId) {
    return new Promise((resolve, reject) => {
      const publicId = mediaPublicId(
        VOICE_FOLDER,
        playFabId,
        clientMessageId,
        "voice"
      );
      const deterministic = !!cleanClientMessageId(clientMessageId);

      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          public_id: publicId,
          overwrite: false,
        },
        async (error, result) => {
          if (error) {
            const existing = await tryGetExistingCloudinaryAsset(
              publicId,
              "video",
              false
            );

            if (existing && existing.secure_url) {
              return resolve({
                url: existing.secure_url,
                publicId: existing.public_id || publicId,
                existing: true,
                deterministic,
              });
            }

            return reject(error);
          }

          if (!result || !result.secure_url) {
            return reject(new Error("cloudinary_no_url"));
          }

          resolve({
            url: result.secure_url,
            publicId: result.public_id || publicId,
            existing: !!result.existing,
            deterministic,
          });
        }
      );

      stream.end(buffer);
    });
  }

  function uploadImageBuffer(buffer, playFabId, clientMessageId) {
    return new Promise((resolve, reject) => {
      const publicId = mediaPublicId(
        IMAGE_FOLDER,
        playFabId,
        clientMessageId,
        "image"
      );
      const deterministic = !!cleanClientMessageId(clientMessageId);

      const finishWithResult = async (result, reusedExisting) => {
        if (!result || !result.public_id) {
          return reject(
            makeChatError("IMAGE_UPLOAD_NO_RESULT", "cloudinary_image_no_result")
          );
        }

        const actualPublicId = safeString(result.public_id, 500) || publicId;
        const moderationStatus =
          getModerationStatus(result, IMAGE_MODERATION_KIND) ||
          getDeepModerationStatus(result);
        const moderationLabels = getModerationLabels(
          result,
          IMAGE_MODERATION_KIND
        );

        console.log("[LuxuryChat][IMAGE_MODERATION]", {
          playFabId: safeString(playFabId, 100),
          publicId: actualPublicId,
          status: moderationStatus || "missing",
          labelsCount: moderationLabels.length,
          existing: !!reusedExisting,
        });

        if (moderationStatus !== "approved") {
          // لا نحذف Asset مشتركاً وصلنا إليه بسبب Retry متزامن وهو ما زال pending.
          if (!reusedExisting || moderationStatus === "rejected") {
            await destroyCloudinaryAsset(actualPublicId, "image");
          }

          if (moderationStatus === "rejected") {
            return reject(
              makeChatError(
                "IMAGE_MODERATION_REJECTED",
                "image_moderation_rejected",
                { moderationStatus }
              )
            );
          }

          return reject(
            makeChatError(
              "IMAGE_MODERATION_NOT_APPROVED",
              "image_moderation_not_approved",
              { moderationStatus: moderationStatus || "missing" }
            )
          );
        }

        if (!result.secure_url) {
          if (!reusedExisting) {
            await destroyCloudinaryAsset(actualPublicId, "image");
          }
          return reject(
            makeChatError("IMAGE_UPLOAD_NO_URL", "cloudinary_image_no_url")
          );
        }

        const thumb = cloudinary.url(actualPublicId, {
          resource_type: "image",
          type: "upload",
          secure: true,
          transformation: [
            {
              width: 700,
              height: 700,
              crop: "limit",
              quality: "auto:good",
              fetch_format: "auto",
            },
          ],
        });

        resolve({
          url: result.secure_url,
          thumbnailUrl: thumb || result.secure_url,
          publicId: actualPublicId,
          moderationStatus,
          existing: !!reusedExisting,
          deterministic,
        });
      };

      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "image",
          public_id: publicId,
          overwrite: false,
          format: "jpg",
          moderation: IMAGE_MODERATION_KIND,
        },
        async (error, result) => {
          if (error) {
            const existing = await tryGetExistingCloudinaryAsset(
              publicId,
              "image",
              true
            );
            if (existing) return finishWithResult(existing, true);
            return reject(error);
          }

          return finishWithResult(result, !!(result && result.existing));
        }
      );

      stream.end(buffer);
    });
  }

  function uploadVideoBuffer(buffer, playFabId, forcedPublicId) {
    return new Promise((resolve, reject) => {
      const publicId =
        safeString(forcedPublicId, 500) ||
        mediaPublicId(VIDEO_FOLDER, playFabId, "", "video");

      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          public_id: publicId,
          overwrite: false,
          moderation: VIDEO_MODERATION_KIND,
          notification_url: VIDEO_MODERATION_WEBHOOK_URL,
        },
        async (error, result) => {
          if (error) {
            const existing = await tryGetExistingCloudinaryAsset(
              publicId,
              "video",
              true
            );
            if (existing && existing.public_id && existing.secure_url) {
              result = { ...existing, existing: true };
            } else {
              return reject(error);
            }
          }

          if (!result || !result.public_id || !result.secure_url) {
            return reject(
              makeChatError("VIDEO_UPLOAD_NO_RESULT", "cloudinary_video_no_result")
            );
          }

          const moderationStatus =
            getModerationStatus(result, VIDEO_MODERATION_KIND) ||
            getDeepModerationStatus(result) ||
            "pending";

          const thumb = cloudinary.url(result.public_id, {
            resource_type: "video",
            type: "upload",
            secure: true,
            format: "jpg",
            transformation: [
              {
                width: 700,
                height: 394,
                crop: "limit",
                quality: "auto:good",
              },
            ],
          });

          resolve({
            url: result.secure_url,
            thumbnailUrl: thumb || "",
            publicId: result.public_id || "",
            moderationStatus: String(moderationStatus || "pending")
              .trim()
              .toLowerCase(),
            raw: result,
            existing: !!result.existing,
          });
        }
      );

      stream.end(buffer);
    });
  }

  // ========================================================================
  // MESSAGE HELPERS / REPLY
  // ========================================================================

  function messagePreview(message) {
    if (!message) return "";

    if (message.kind === "voice") {
      const total = Math.max(0, Math.round(Number(message.voiceDuration) || 0));
      const mm = String(Math.floor(total / 60)).padStart(2, "0");
      const ss = String(total % 60).padStart(2, "0");
      return `ملاحظة صوتية ${mm}:${ss}`;
    }

    if (message.kind === "image" || message.mediaType === "image") {
      return "صورة";
    }

    if (message.kind === "video" || message.mediaType === "video") {
      return "فيديو";
    }

    return String(message.text || "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 100);
  }

  async function replySnapshot(roomId, replyToMessageId) {
    const id = String(replyToMessageId || "").trim();

    if (!id) {
      return {
        replyToId: "",
        replyToSenderId: "",
        replyToName: "",
        replyToPreview: "",
      };
    }

    const room = await ensureRoomLoaded(roomId, {
      forceStorageRefresh: false,
    });

    const original = findMessage(room, id);

    if (!original) {
      return {
        replyToId: "",
        replyToSenderId: "",
        replyToName: "",
        replyToPreview: "",
      };
    }

    return {
      replyToId: original.id,
      replyToSenderId: original.senderId || "",
      replyToName: original.senderName || "لاعب",
      replyToPreview: messagePreview(original),
    };
  }

  function makeMessage({
    roomId,
    senderId,
    profile,
    kind,
    reply,
    clientMessageId,
  }) {
    const normalizedKind = normalizeKind(kind);
    const sentUnixMs = nowMs();
    const messageId = deterministicMessageId(
      roomId,
      senderId,
      clientMessageId
    );

    return {
      id: messageId,
      clientMessageId: cleanClientMessageId(clientMessageId),
      seq: 0,
      room: cleanRoom(roomId),
      senderId: safeString(senderId, 100),
      senderName: safeString(profile && profile.playerName, 64) || "لاعب",
      senderAvatarUrl: safeString(profile && profile.avatarUrl, 1000),
      senderAvatarVersion:
        safeString(profile && profile.avatarVersion, 100) || "0",
      sentUnixMs,
      kind: normalizedKind,
      text: "",
      voiceUrl: "",
      voiceDuration: 0,
      mediaType:
        normalizedKind === "image" || normalizedKind === "video"
          ? normalizedKind
          : "",
      mediaUrl: "",
      mediaThumbnailUrl: "",
      mediaFileName: "",
      replyToId: (reply && reply.replyToId) || "",
      replyToSenderId: (reply && reply.replyToSenderId) || "",
      replyToName: (reply && reply.replyToName) || "",
      replyToPreview: (reply && reply.replyToPreview) || "",
    };
  }

  async function hydrateProfilesForResponse(messages, refreshProfiles) {
    const result = (messages || []).map((message) => ({ ...message }));

    if (!refreshProfiles || result.length === 0) return result;

    const uniqueSenderIds = Array.from(
      new Set(
        result.map((m) => safeString(m && m.senderId, 100)).filter(Boolean)
      )
    );

    const profiles = new Map();

    await Promise.all(
      uniqueSenderIds.map(async (senderId) => {
        try {
          const profile = await getPlayerProfile(senderId, false);
          profiles.set(senderId, profile);
        } catch (_) {}
      })
    );

    for (const message of result) {
      if (!message || !message.senderId) continue;

      const profile = profiles.get(message.senderId);
      if (!profile) continue;

      message.senderName =
        safeString(profile.playerName, 64) || message.senderName || "لاعب";
      message.senderAvatarUrl = safeString(profile.avatarUrl, 1000) || "";
      message.senderAvatarVersion =
        safeString(profile.avatarVersion, 100) || "0";
    }

    return result;
  }

  // ========================================================================
  // VIDEO MODERATION FINALIZATION
  // ========================================================================

  async function finalizeApprovedVideoJob(job, moderationSource) {
    if (!job) return null;

    job.moderationStatus = "approved";
    job.updatedAtUnixMs = nowMs();

    // Webhook قد يصل قبل اكتمال callback الرفع. لا ننشر قبل وجود URL كامل.
    if (!job.uploadCompleted || !job.mediaUrl) {
      if (!isTerminalVideoStatus(job.status)) {
        job.status = "pending";
      }
      videoJobs.set(job.publicId, job);
      await enqueueVideoJobsSave();
      return null;
    }

    const room = await ensureRoomLoaded(job.roomId, {
      forceStorageRefresh: true,
    });

    const duplicate = findClientMessage(
      room,
      job.senderId,
      job.clientMessageId
    );

    let message = duplicate;

    if (duplicate) {
      // Retry متزامن من Instance آخر قد يكون رفع فيديو ثانياً لنفس clientMessageId.
      // الرسالة الحتمية الموجودة هي Canonical؛ نحذف الأصل غير المستخدم حتى لا يصبح Orphan.
      if (
        duplicate.mediaUrl &&
        job.mediaUrl &&
        duplicate.mediaUrl !== job.mediaUrl
      ) {
        await destroyCloudinaryAsset(job.publicId, "video");
      }
    } else {
      message = makeMessage({
        roomId: job.roomId,
        senderId: job.senderId,
        profile: job.profile,
        kind: "video",
        reply: job.reply,
        clientMessageId: job.clientMessageId,
      });

      message.mediaType = "video";
      message.mediaUrl = safeString(job.mediaUrl, 1600);
      message.mediaThumbnailUrl = safeString(job.mediaThumbnailUrl, 1600);
      message.mediaFileName =
        safeString(job.mediaFileName, 180) || "chat_video.mp4";

      message = await pushMessage(job.roomId, message);

      // pushMessage قد يكون وجد Duplicate ظهر أثناء العملية.
      if (
        message &&
        message.mediaUrl &&
        job.mediaUrl &&
        message.mediaUrl !== job.mediaUrl
      ) {
        await destroyCloudinaryAsset(job.publicId, "video");
      }
    }

    job.status = "approved";
    job.rejectReason = "";
    job.messageId = message && message.id ? message.id : job.messageId;
    job.updatedAtUnixMs = nowMs();
    videoJobs.set(job.publicId, job);

    await enqueueVideoJobsSave();

    console.log("[LuxuryChat][VIDEO_MODERATION][APPROVED]", {
      publicId: job.publicId,
      senderId: job.senderId,
      clientMessageId: job.clientMessageId,
      messageId: job.messageId,
      source: moderationSource ? "moderation-result" : "status-refresh",
    });

    return message;
  }

  async function finalizeRejectedVideoJob(job, moderationSource) {
    if (!job) return;

    job.status = "rejected";
    job.moderationStatus = "rejected";
    job.rejectReason = buildVideoRejectReason(moderationSource);
    job.updatedAtUnixMs = nowMs();
    videoJobs.set(job.publicId, job);

    await destroyCloudinaryAsset(job.publicId, "video");
    await enqueueVideoJobsSave();

    console.log("[LuxuryChat][VIDEO_MODERATION][REJECTED]", {
      publicId: job.publicId,
      senderId: job.senderId,
      clientMessageId: job.clientMessageId,
      reason: job.rejectReason,
    });
  }

  async function applyVideoModerationResult(publicId, fallbackBody) {
    await ensureVideoJobsLoaded(true);

    const id = safeString(publicId, 500);
    if (!id) return { status: "ignored" };

    const job = videoJobs.get(id);

    if (!job) {
      console.warn("[LuxuryChat][VIDEO_MODERATION] job not found", id);
      return { status: "job_not_found" };
    }

    const previousStatus = safeString(job.status, 30) || "pending";
    const previousModerationStatus =
      safeString(job.moderationStatus, 30) || "pending";

    let adminResource = null;
    let adminStatus = "";

    // V12: نسأل Cloudinary Admin API لحالة الفيديو النهائية متى أمكن؛ فشلها لا يمنع fallback الموقع.
    try {
      adminResource = await getVideoModerationResource(id);
      job.lastCloudinaryCheckUnixMs = nowMs();
      adminStatus = getDeepModerationStatus(adminResource);
    } catch (error) {
      console.warn("[LuxuryChat][VIDEO_MODERATION] Admin API read failed", {
        publicId: id,
        error: error && error.message ? error.message : error,
      });
    }

    const fallbackStatus = getDeepModerationStatus(fallbackBody || {});

    let status = "";
    let source = null;

    if (adminStatus === "approved" || adminStatus === "rejected") {
      status = adminStatus;
      source = adminResource;
    } else if (
      fallbackStatus === "approved" ||
      fallbackStatus === "rejected"
    ) {
      // fallbackBody يصل من Webhook موقع أو من نتيجة رفع Cloudinary نفسها.
      status = fallbackStatus;
      source = fallbackBody || {};
    } else {
      status = adminStatus || fallbackStatus || "pending";
      source = adminResource || fallbackBody || {};
    }

    if (status === "approved") {
      await finalizeApprovedVideoJob(job, source);
      return { status: "approved" };
    }

    if (status === "rejected") {
      await finalizeRejectedVideoJob(job, source);
      return { status: "rejected" };
    }

    // أهم إصلاح سباق V12: pending لا يستطيع إنزال حالة نهائية سابقة.
    if (isTerminalVideoStatus(previousStatus)) {
      job.status = previousStatus;
      job.moderationStatus = previousModerationStatus;
      job.updatedAtUnixMs = Math.max(
        Number(job.updatedAtUnixMs || 0),
        nowMs()
      );
      videoJobs.set(job.publicId, job);
      await enqueueVideoJobsSave();
      return { status: previousStatus };
    }

    job.status = "pending";
    job.moderationStatus = status || "pending";
    job.updatedAtUnixMs = nowMs();
    videoJobs.set(job.publicId, job);

    await enqueueVideoJobsSave();
    return { status: "pending" };
  }

  function verifyCloudinaryWebhook(req) {
    const signature = String(
      (req && req.headers && req.headers["x-cld-signature"]) || ""
    )
      .trim()
      .replace(/^sha1=/i, "")
      .replace(/^sha256=/i, "");

    const timestampRaw = String(
      (req && req.headers && req.headers["x-cld-timestamp"]) || ""
    ).trim();
    const timestamp = Number(timestampRaw);

    if (
      !signature ||
      !timestampRaw ||
      !Number.isFinite(timestamp) ||
      !CLOUDINARY_API_SECRET
    ) {
      return false;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      Math.abs(nowSeconds - timestamp) > CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS
    ) {
      return false;
    }

    const bodyCandidates = [];

    if (req && Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) {
      bodyCandidates.push(req.rawBody.toString("utf8"));
    } else if (
      req &&
      typeof req.rawBody === "string" &&
      req.rawBody.length > 0
    ) {
      bodyCandidates.push(req.rawBody);
    }

    if (req && Buffer.isBuffer(req.body) && req.body.length > 0) {
      bodyCandidates.push(req.body.toString("utf8"));
    }

    // Fallback لا يتجاوز التوقيع؛ فقط يحاول إعادة بناء JSON إذا server.js لم يحتفظ rawBody.
    if (req && req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      try {
        bodyCandidates.push(JSON.stringify(req.body));
      } catch (_) {}
    }

    const uniqueBodies = Array.from(new Set(bodyCandidates.filter(Boolean)));
    if (uniqueBodies.length === 0) return false;

    const algorithm = signature.length === 64 ? "sha256" : "sha1";
    const signatureBuffer = Buffer.from(signature.toLowerCase(), "utf8");

    for (const rawBody of uniqueBodies) {
      const expected = crypto
        .createHash(algorithm)
        .update(rawBody + timestampRaw + CLOUDINARY_API_SECRET, "utf8")
        .digest("hex")
        .toLowerCase();

      const expectedBuffer = Buffer.from(expected, "utf8");

      if (expectedBuffer.length !== signatureBuffer.length) continue;

      if (crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
        return true;
      }
    }

    return false;
  }

  function extractWebhookPublicId(body, seen = new Set()) {
    if (!body || typeof body !== "object") return "";
    if (seen.has(body)) return "";
    seen.add(body);

    const direct = safeString(body.public_id, 500);
    if (direct) return direct;

    for (const child of Object.values(body)) {
      if (child && typeof child === "object") {
        const nested = extractWebhookPublicId(child, seen);
        if (nested) return nested;
      }
    }

    return "";
  }

  // ========================================================================
  // REPORTS -> PLAYFAB TITLE INTERNAL DATA
  // ========================================================================

  async function loadReports() {
    if (reportsLoaded) return reports;
    if (reportsLoadPromise) return reportsLoadPromise;

    reportsLoadPromise = (async () => {
      const data = await playFabServerCall("GetTitleInternalData", {
        Keys: [REPORTS_KEY],
      });

      const raw =
        data && data.Data && data.Data[REPORTS_KEY]
          ? String(data.Data[REPORTS_KEY])
          : "";

      let loaded = [];

      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) loaded = parsed;
          else if (parsed && Array.isArray(parsed.reports)) {
            loaded = parsed.reports;
          }
        } catch (_) {
          loaded = [];
        }
      }

      reports = loaded
        .filter((item) => item && typeof item === "object")
        .slice(-MAX_REPORTS_IN_KEY);

      reportsLoaded = true;
      reportsLoadPromise = null;
      return reports;
    })().catch((error) => {
      reportsLoaded = false;
      reportsLoadPromise = null;
      throw error;
    });

    return reportsLoadPromise;
  }

  function saveReports() {
    reportsWriteChain = reportsWriteChain
      .catch(() => {})
      .then(async () => {
        const payload = {
          version: 2,
          updatedAtUnixMs: nowMs(),
          reports: reports.slice(-MAX_REPORTS_IN_KEY),
        };

        await playFabAdminCall("SetTitleInternalData", {
          Key: REPORTS_KEY,
          Value: JSON.stringify(payload),
        });
      });

    return reportsWriteChain;
  }

  function reportItemKey(reporterId, messageId) {
    const digest = crypto
      .createHash("sha256")
      .update(
        `${safeString(reporterId, 100)}|${safeString(messageId, 100)}`,
        "utf8"
      )
      .digest("hex");

    return `${REPORTS_KEY}_ITEM_${digest.slice(0, 40)}`;
  }

  async function createReport(reporterId, roomId, message, reason) {
    const itemKey = reportItemKey(reporterId, message.id);

    try {
      const existingData = await playFabServerCall("GetTitleInternalData", {
        Keys: [itemKey],
      });

      const rawExisting =
        existingData && existingData.Data && existingData.Data[itemKey]
          ? String(existingData.Data[itemKey])
          : "";

      if (rawExisting) {
        try {
          const existingReport = JSON.parse(rawExisting);
          if (existingReport && existingReport.reportId) {
            return { report: existingReport, duplicate: true };
          }
        } catch (_) {}
      }
    } catch (_) {}

    const kind = normalizeKind(message.kind || message.mediaType);
    const deterministicReportId = crypto
      .createHash("sha256")
      .update(
        `${safeString(reporterId, 100)}|${safeString(message.id, 100)}`,
        "utf8"
      )
      .digest("hex")
      .slice(0, 48);

    const report = {
      reportId: `r_${deterministicReportId}`,
      createdAtUnixMs: nowMs(),
      room: cleanRoom(roomId),
      reporterId: safeString(reporterId, 100),
      messageId: safeString(message.id, 100),
      messageSeq: Math.max(0, Number(message.seq) || 0),
      messageSentUnixMs: Math.max(0, Number(message.sentUnixMs) || 0),
      reportedSenderId: safeString(message.senderId, 100),
      reportedSenderName: safeString(message.senderName, 64) || "لاعب",
      reportedSenderAvatarUrl: safeString(message.senderAvatarUrl, 1000),
      reportedSenderAvatarVersion:
        safeString(message.senderAvatarVersion, 100) || "0",
      kind,
      text: kind === "text" ? safeString(message.text, MAX_TEXT_LENGTH) : "",
      voiceUrl: kind === "voice" ? safeString(message.voiceUrl, 1200) : "",
      voiceDuration:
        kind === "voice"
          ? Math.min(180, Math.max(0, Number(message.voiceDuration) || 0))
          : 0,
      mediaType: kind === "image" || kind === "video" ? kind : "",
      mediaUrl:
        kind === "image" || kind === "video"
          ? safeString(message.mediaUrl, 1600)
          : "",
      mediaThumbnailUrl:
        kind === "image" || kind === "video"
          ? safeString(message.mediaThumbnailUrl, 1600)
          : "",
      mediaFileName:
        kind === "image" || kind === "video"
          ? safeString(message.mediaFileName, 180)
          : "",
      replyToId: safeString(message.replyToId, 100),
      replyToSenderId: safeString(message.replyToSenderId, 100),
      replyToName: safeString(message.replyToName, 64),
      replyToPreview: safeString(message.replyToPreview, 120),
      reason: cleanReason(reason) || "بلاغ من داخل الشات",
    };

    await playFabAdminCall("SetTitleInternalData", {
      Key: itemKey,
      Value: JSON.stringify(report),
    });

    // المفتاح التجميعي للتوافق فقط؛ البلاغ نفسه محفوظ Authoritative في itemKey.
    try {
      await loadReports();

      const existingIndex = reports.findIndex(
        (item) => item && item.reportId === report.reportId
      );

      if (existingIndex < 0) reports.push(report);
      if (reports.length > MAX_REPORTS_IN_KEY) {
        reports = reports.slice(-MAX_REPORTS_IN_KEY);
      }

      await saveReports();
    } catch (error) {
      console.warn("[LuxuryChat][REPORT][AGGREGATE_COMPAT_FAILED]", {
        reportId: report.reportId,
        error: error && error.message ? error.message : error,
      });
    }

    return { report, duplicate: false };
  }

  function buildHistoryResponseWindow(room, limit) {
    const normalMessages = [];
    const reactionMessages = [];

    for (const message of room.messages || []) {
      if (!message) continue;
      if (isReactionMessageServer(message)) reactionMessages.push(message);
      else normalMessages.push(message);
    }

    normalMessages.sort(compareMessages);
    reactionMessages.sort(compareMessages);

    const normalWindow = normalMessages.slice(
      Math.max(0, normalMessages.length - limit)
    );

    const visibleIds = new Set(
      normalWindow.map((m) => safeString(m && m.id, 100)).filter(Boolean)
    );

    const latestReactionByOwner = new Map();

    for (const reaction of reactionMessages) {
      if (!reaction || !visibleIds.has(reaction.replyToId)) continue;

      const key = `${reaction.replyToId}|${safeString(
        reaction.senderId,
        100
      )}`;
      const previous = latestReactionByOwner.get(key);

      if (!previous || compareMessages(previous, reaction) < 0) {
        latestReactionByOwner.set(key, reaction);
      }
    }

    const reactionStates = Array.from(latestReactionByOwner.values())
      .sort(compareMessages)
      .slice(-MAX_REACTION_FETCH_LIMIT);

    return {
      messages: normalWindow.concat(reactionStates).sort(compareMessages),
      hasMore: normalMessages.length > limit,
      normalCount: normalWindow.length,
      reactionCount: reactionStates.length,
    };
  }

  // ========================================================================
  // HISTORY
  // ========================================================================

  app.post("/chat/messages", async (req, res) => {
    try {
      await authenticateSessionTicket(req.body && req.body.sessionTicket);

      const roomId = cleanRoom(req.body && req.body.room);
      const afterSeq = Math.max(0, Number(req.body && req.body.afterSeq) || 0);
      const refreshProfiles = !!(req.body && req.body.refreshProfiles);

      const limit = Math.min(
        MAX_FETCH_LIMIT,
        Math.max(1, Number(req.body && req.body.limit) || 50)
      );

      const room = await ensureRoomLoaded(roomId, {
        forceStorageRefresh: afterSeq === 0,
      });

      pruneExpired(room);
      dedupeClientMessages(room);
      repairSequenceCollisions(room);

      const window = buildHistoryResponseWindow(room, limit);
      const responseMessages = await hydrateProfilesForResponse(
        window.messages,
        refreshProfiles
      );

      // نعيد Window حديثة في كل Poll. afterSeq لا يمنع رسالة Shard متأخرة من الظهور.
      const cursorLatestSeq = Math.max(
        afterSeq,
        Math.max(0, Number(room.seq) || 0)
      );

      return res.json({
        ok: true,
        messages: responseMessages,
        latestSeq: cursorLatestSeq,
        serverLatestSeq: Math.max(0, Number(room.seq) || 0),
        hasMore: window.hasMore,
        retentionDays: RETENTION_DAYS,
        source: "cloudinary-sharded-v12-send-recovery-window",
        build: SERVER_BUILD,
      });
    } catch (error) {
      console.error("/chat/messages", error);

      return res.status(500).json({
        ok: false,
        error: "تعذر تحميل رسائل الشات",
      });
    }
  });

  // ========================================================================
  // SEND TEXT
  // ========================================================================

  app.post("/chat/send", async (req, res) => {
    try {
      const playFabId = await authenticateSessionTicket(
        req.body && req.body.sessionTicket
      );

      const roomId = cleanRoom(req.body && req.body.room);
      const text = cleanText(req.body && req.body.text);

      if (!text) {
        return res.status(400).json({
          ok: false,
          error: "الرسالة فارغة",
        });
      }

      const clientMessageId = cleanClientMessageId(
        req.body && req.body.clientMessageId
      );

      const room = await ensureRoomLoaded(roomId, {
        forceStorageRefresh: true,
      });

      if (clientMessageId) {
        const duplicate = findClientMessage(room, playFabId, clientMessageId);

        if (duplicate) {
          return res.json({
            ok: true,
            duplicate: true,
            message: duplicate,
          });
        }
      }

      if (!checkRate(sendRate, playFabId, 500)) {
        return res.status(429).json({
          ok: false,
          error: "أرسل بهدوء قليلاً",
        });
      }

      const profile = await getPlayerProfile(playFabId, true);
      const reply = await replySnapshot(
        roomId,
        req.body && req.body.replyToMessageId
      );

      let message = makeMessage({
        roomId,
        senderId: playFabId,
        profile,
        kind: "text",
        reply,
        clientMessageId,
      });

      message.text = text;
      message = await pushMessage(roomId, message);

      return res.json({
        ok: true,
        message,
      });
    } catch (error) {
      console.error("/chat/send", error);

      return res.status(500).json({
        ok: false,
        error: "تعذر إرسال الرسالة",
      });
    }
  });

  // ========================================================================
  // SEND VOICE
  // ========================================================================

  app.post(
    "/chat/voice",
    uploadSingleJson(
      voiceUpload,
      "clip",
      "حجم الملاحظة الصوتية أكبر من الحد المسموح"
    ),
    async (req, res) => {
      let uploaded = null;

      try {
        const playFabId = await authenticateSessionTicket(
          req.body && req.body.sessionTicket
        );

        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({
            ok: false,
            error: "ملف الصوت غير موجود",
          });
        }

        const roomId = cleanRoom(req.body && req.body.room);
        const clientMessageId = cleanClientMessageId(
          req.body && req.body.clientMessageId
        );

        const room = await ensureRoomLoaded(roomId, {
          forceStorageRefresh: true,
        });

        if (clientMessageId) {
          const duplicate = findClientMessage(room, playFabId, clientMessageId);

          if (duplicate) {
            return res.json({
              ok: true,
              duplicate: true,
              message: duplicate,
            });
          }
        }

        if (!checkRate(sendRate, playFabId, 900)) {
          return res.status(429).json({
            ok: false,
            error: "انتظر قليلاً قبل الإرسال",
          });
        }

        const duration = Math.min(
          180,
          Math.max(0, Number(req.body && req.body.duration) || 0)
        );

        const profile = await getPlayerProfile(playFabId, true);
        const reply = await replySnapshot(
          roomId,
          req.body && req.body.replyToMessageId
        );

        uploaded = await uploadAudioBuffer(
          req.file.buffer,
          playFabId,
          clientMessageId
        );

        let attemptedMessage = makeMessage({
          roomId,
          senderId: playFabId,
          profile,
          kind: "voice",
          reply,
          clientMessageId,
        });

        attemptedMessage.voiceUrl = uploaded.url;
        attemptedMessage.voiceDuration = duration;

        const message = await pushMessage(roomId, attemptedMessage);

        // إذا سبقنا Retry متزامن لنفس clientMessageId، ملفنا غير مستخدم.
        if (
          uploaded.publicId &&
          message &&
          message.voiceUrl &&
          message.voiceUrl !== uploaded.url
        ) {
          if (!uploaded.deterministic) {
            await destroyCloudinaryAsset(uploaded.publicId, "video");
          }
          uploaded = null;
        }

        return res.json({
          ok: true,
          message,
        });
      } catch (error) {
        if (uploaded && uploaded.publicId && !uploaded.deterministic) {
          await destroyCloudinaryAsset(uploaded.publicId, "video");
        }

        console.error("/chat/voice", error);

        return res.status(500).json({
          ok: false,
          error: "تعذر رفع الملاحظة الصوتية",
        });
      }
    }
  );

  // ========================================================================
  // CLOUDINARY VIDEO MODERATION WEBHOOK
  // ========================================================================

  app.post(VIDEO_MODERATION_WEBHOOK_PATH, async (req, res) => {
    try {
      if (!verifyCloudinaryWebhook(req)) {
        console.warn("[LuxuryChat][VIDEO_WEBHOOK] invalid signature");

        return res.status(401).json({
          ok: false,
          error: "invalid_cloudinary_signature",
        });
      }

      const publicId = extractWebhookPublicId(req.body);

      if (!publicId) {
        console.warn("[LuxuryChat][VIDEO_WEBHOOK] public_id missing");
        return res.json({ ok: true, ignored: true });
      }

      const result = await applyVideoModerationResult(publicId, req.body);

      return res.json({
        ok: true,
        publicId,
        status: result && result.status ? result.status : "pending",
      });
    } catch (error) {
      console.error("[LuxuryChat][VIDEO_WEBHOOK]", error);

      return res.status(500).json({
        ok: false,
        error: "video_moderation_webhook_failed",
      });
    }
  });

  // ========================================================================
  // VIDEO STATUS FOR UNITY
  // ========================================================================

  app.post("/chat/video-status", async (req, res) => {
    try {
      const playFabId = await authenticateSessionTicket(
        req.body && req.body.sessionTicket
      );

      const clientMessageId = cleanClientMessageId(
        req.body && req.body.clientMessageId
      );

      if (!clientMessageId) {
        return res.status(400).json({
          ok: false,
          error: "clientMessageId مطلوب",
        });
      }

      await ensureVideoJobsLoaded(true);

      const job = findVideoJobByClient(playFabId, clientMessageId);

      if (!job) {
        return res.status(404).json({
          ok: false,
          status: "not_found",
          error: "حالة الفيديو غير موجودة",
        });
      }

      if (
        (job.status === "pending" || job.status === "uploading") &&
        nowMs() - Number(job.lastCloudinaryCheckUnixMs || 0) >=
          VIDEO_STATUS_FALLBACK_CHECK_MS
      ) {
        try {
          await applyVideoModerationResult(job.publicId, null);
        } catch (error) {
          console.warn(
            "[LuxuryChat][VIDEO_STATUS] refresh failed",
            error && error.message ? error.message : error
          );
        }
      }

      const fresh = videoJobs.get(job.publicId) || job;

      return res.json({
        ok: true,
        clientMessageId: fresh.clientMessageId,
        status: fresh.status,
        moderationStatus: fresh.moderationStatus,
        rejectReason: fresh.status === "rejected" ? fresh.rejectReason : "",
        messageId: fresh.status === "approved" ? fresh.messageId : "",
      });
    } catch (error) {
      console.error("/chat/video-status", error);

      return res.status(500).json({
        ok: false,
        error: "تعذر قراءة حالة الفيديو",
      });
    }
  });

  // ========================================================================
  // SEND IMAGE / VIDEO
  // ========================================================================

  app.post(
    "/chat/media",
    uploadSingleJson(
      mediaUpload,
      "media",
      "حجم الملف أكبر من الحد المسموح للفيديو"
    ),
    async (req, res) => {
      let uploadedImage = null;

      try {
        const playFabId = await authenticateSessionTicket(
          req.body && req.body.sessionTicket
        );

        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({
            ok: false,
            error: "الملف غير موجود",
          });
        }

        const roomId = cleanRoom(req.body && req.body.room);
        const requestedType = String(
          (req.body && req.body.mediaType) || ""
        )
          .trim()
          .toLowerCase();

        if (requestedType !== "image" && requestedType !== "video") {
          return res.status(400).json({
            ok: false,
            error: "نوع الملف غير مدعوم",
          });
        }

        const mime = String(req.file.mimetype || "").toLowerCase();
        const fileSize = Number(req.file.size || req.file.buffer.length || 0);

        if (requestedType === "image") {
          if (!ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
            return res.status(400).json({
              ok: false,
              error: "نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WEBP",
            });
          }

          if (fileSize > MAX_IMAGE_BYTES) {
            return res.status(413).json({
              ok: false,
              error: "حجم الصورة أكبر من 8 ميجابايت",
            });
          }
        }

        if (requestedType === "video") {
          if (!mime.startsWith("video/")) {
            return res.status(400).json({
              ok: false,
              error: "الملف المختار ليس فيديو",
            });
          }

          if (fileSize > MAX_VIDEO_BYTES) {
            return res.status(413).json({
              ok: false,
              error: "حجم الفيديو أكبر من 50 ميجابايت",
            });
          }
        }

        const clientMessageId = cleanClientMessageId(
          req.body && req.body.clientMessageId
        );

        const room = await ensureRoomLoaded(roomId, {
          forceStorageRefresh: true,
        });

        if (clientMessageId) {
          const duplicate = findClientMessage(room, playFabId, clientMessageId);

          if (duplicate) {
            return res.json({
              ok: true,
              duplicate: true,
              message: duplicate,
            });
          }
        }

        if (!checkRate(sendRate, playFabId, 900)) {
          return res.status(429).json({
            ok: false,
            error: "انتظر قليلاً قبل إرسال ملف آخر",
          });
        }

        const profile = await getPlayerProfile(playFabId, true);
        const reply = await replySnapshot(
          roomId,
          req.body && req.body.replyToMessageId
        );

        // ------------------------------------------------------------------
        // VIDEO
        // ------------------------------------------------------------------

        if (requestedType === "video") {
          await ensureVideoJobsLoaded(true);

          const effectiveClientMessageId =
            clientMessageId || `video_${crypto.randomUUID()}`;

          const existingJob = findVideoJobByClient(
            playFabId,
            effectiveClientMessageId
          );

          if (existingJob) {
            return res.json({
              ok: true,
              pending:
                existingJob.status !== "approved" &&
                existingJob.status !== "rejected",
              status: existingJob.status,
              moderationStatus: existingJob.moderationStatus,
              clientMessageId: existingJob.clientMessageId,
              rejectReason:
                existingJob.status === "rejected"
                  ? existingJob.rejectReason
                  : "",
              messageId:
                existingJob.status === "approved"
                  ? existingJob.messageId
                  : "",
            });
          }

          const videoPublicId = mediaPublicId(
            VIDEO_FOLDER,
            playFabId,
            effectiveClientMessageId,
            "video"
          );

          const job = {
            jobId: crypto.randomUUID(),
            publicId: videoPublicId,
            senderId: safeString(playFabId, 100),
            roomId: cleanRoom(roomId),
            clientMessageId: effectiveClientMessageId,
            status: "uploading",
            moderationStatus: "pending",
            createdAtUnixMs: nowMs(),
            updatedAtUnixMs: nowMs(),
            uploadCompleted: false,
            lastCloudinaryCheckUnixMs: 0,
            mediaUrl: "",
            mediaThumbnailUrl: "",
            mediaFileName: sanitizeFileName(
              req.file.originalname,
              "chat_video.mp4"
            ),
            rejectReason: "",
            messageId: "",
            profile: {
              playerName:
                safeString(profile && profile.playerName, 64) || "لاعب",
              avatarUrl: safeString(profile && profile.avatarUrl, 1000),
              avatarVersion:
                safeString(profile && profile.avatarVersion, 100) || "0",
            },
            reply: {
              replyToId: safeString(reply && reply.replyToId, 100),
              replyToSenderId: safeString(
                reply && reply.replyToSenderId,
                100
              ),
              replyToName: safeString(reply && reply.replyToName, 64),
              replyToPreview: safeString(reply && reply.replyToPreview, 120),
            },
          };

          videoJobs.set(videoPublicId, job);
          await enqueueVideoJobsSave();

          let uploadedVideo;

          try {
            uploadedVideo = await uploadVideoBuffer(
              req.file.buffer,
              playFabId,
              videoPublicId
            );
          } catch (error) {
            // قد يكون Webhook/Instance آخر وصل لحالة نهائية قبل callback الخطأ.
            try {
              await ensureVideoJobsLoaded(true);
            } catch (_) {}

            const current = videoJobs.get(videoPublicId) || job;

            if (
              current.status !== "approved" &&
              current.status !== "rejected"
            ) {
              current.status = "failed";
              current.moderationStatus = "failed";
              current.rejectReason = "تعذر رفع الفيديو للفحص";
              current.updatedAtUnixMs = nowMs();
              videoJobs.set(videoPublicId, current);

              try {
                await enqueueVideoJobsSave();
              } catch (_) {}

              // إذا Unity أعطانا clientMessageId فـpublicId مشترك وحتمي بين instances.
              // لا نحذفه هنا لأن Instance آخر قد يكون أكمل نفس الـRetry بنجاح.
              if (!clientMessageId) {
                await destroyCloudinaryAsset(videoPublicId, "video");
              }
              throw error;
            }

            return res.json({
              ok: true,
              pending: false,
              status: current.status,
              moderationStatus: current.moderationStatus,
              clientMessageId: current.clientMessageId,
              rejectReason:
                current.status === "rejected" ? current.rejectReason : "",
              messageId:
                current.status === "approved" ? current.messageId : "",
            });
          }

          // التقط أي Webhook ربما عالجه Instance آخر أثناء الرفع.
          try {
            await ensureVideoJobsLoaded(true);
          } catch (error) {
            console.warn("[LuxuryChat][VIDEO_UPLOAD][POST_UPLOAD_SYNC_FAILED]", {
              publicId: videoPublicId,
              error: error && error.message ? error.message : error,
            });
          }

          const activeJob = videoJobs.get(videoPublicId) || job;
          const uploadModerationStatus =
            safeString(uploadedVideo.moderationStatus, 30) || "pending";

          activeJob.uploadCompleted = true;
          activeJob.mediaUrl = safeString(uploadedVideo.url, 1600);
          activeJob.mediaThumbnailUrl = safeString(
            uploadedVideo.thumbnailUrl,
            1600
          );
          activeJob.mediaFileName =
            safeString(activeJob.mediaFileName, 180) || "chat_video.mp4";

          // لا نرجع Terminal state إلى pending بسبب callback متأخر.
          if (!isTerminalVideoStatus(activeJob.status)) {
            activeJob.status = "pending";
          }

          if (
            activeJob.moderationStatus !== "approved" &&
            activeJob.moderationStatus !== "rejected"
          ) {
            activeJob.moderationStatus = uploadModerationStatus;
          }

          activeJob.updatedAtUnixMs = nowMs();
          videoJobs.set(videoPublicId, activeJob);
          await enqueueVideoJobsSave();

          console.log("[LuxuryChat][VIDEO_MODERATION][UPLOADED]", {
            publicId: activeJob.publicId,
            senderId: activeJob.senderId,
            clientMessageId: activeJob.clientMessageId,
            moderationStatus: activeJob.moderationStatus,
            webhook: VIDEO_MODERATION_WEBHOOK_URL,
          });

          if (activeJob.status === "rejected") {
            await destroyCloudinaryAsset(activeJob.publicId, "video");
          } else if (
            activeJob.status !== "approved" &&
            (activeJob.moderationStatus === "approved" ||
              activeJob.moderationStatus === "rejected" ||
              uploadModerationStatus === "approved" ||
              uploadModerationStatus === "rejected")
          ) {
            await applyVideoModerationResult(
              activeJob.publicId,
              uploadedVideo.raw
            );
          } else if (
            activeJob.status === "approved" &&
            !activeJob.messageId
          ) {
            await finalizeApprovedVideoJob(activeJob, uploadedVideo.raw);
          }

          const fresh = videoJobs.get(activeJob.publicId) || activeJob;

          return res.json({
            ok: true,
            pending:
              fresh.status !== "approved" && fresh.status !== "rejected",
            status: fresh.status,
            moderationStatus: fresh.moderationStatus,
            clientMessageId: fresh.clientMessageId,
            rejectReason:
              fresh.status === "rejected" ? fresh.rejectReason : "",
            messageId: fresh.status === "approved" ? fresh.messageId : "",
          });
        }

        // ------------------------------------------------------------------
        // IMAGE
        // ------------------------------------------------------------------

        uploadedImage = await uploadImageBuffer(
          req.file.buffer,
          playFabId,
          clientMessageId
        );

        if (
          String((uploadedImage && uploadedImage.moderationStatus) || "")
            .trim()
            .toLowerCase() !== "approved"
        ) {
          if (uploadedImage && uploadedImage.publicId) {
            await destroyCloudinaryAsset(uploadedImage.publicId, "image");
            uploadedImage = null;
          }

          return res.status(503).json({
            ok: false,
            error: "تعذر اعتماد الصورة من نظام الحماية، حاول مرة أخرى",
          });
        }

        let attemptedMessage = makeMessage({
          roomId,
          senderId: playFabId,
          profile,
          kind: "image",
          reply,
          clientMessageId,
        });

        attemptedMessage.mediaType = "image";
        attemptedMessage.mediaUrl = safeString(uploadedImage.url, 1600);
        attemptedMessage.mediaThumbnailUrl = safeString(
          uploadedImage.thumbnailUrl,
          1600
        );
        attemptedMessage.mediaFileName = sanitizeFileName(
          req.file.originalname,
          "chat_image.jpg"
        );

        const message = await pushMessage(roomId, attemptedMessage);

        if (
          uploadedImage.publicId &&
          message &&
          message.mediaUrl &&
          message.mediaUrl !== uploadedImage.url
        ) {
          if (!uploadedImage.deterministic) {
            await destroyCloudinaryAsset(uploadedImage.publicId, "image");
          }
          uploadedImage = null;
        }

        return res.json({
          ok: true,
          message,
        });
      } catch (error) {
        if (
          uploadedImage &&
          uploadedImage.publicId &&
          !uploadedImage.deterministic
        ) {
          await destroyCloudinaryAsset(uploadedImage.publicId, "image");
        }

        console.error("/chat/media", error);

        if (error && error.code === "IMAGE_MODERATION_REJECTED") {
          return res.status(422).json({
            ok: false,
            moderationRejected: true,
            error: "تم رفض الصورة لأنها تخالف قوانين الشات",
          });
        }

        if (error && error.code === "IMAGE_MODERATION_NOT_APPROVED") {
          return res.status(503).json({
            ok: false,
            moderationRejected: false,
            error: "تعذر فحص الصورة الآن، حاول مرة أخرى بعد قليل",
          });
        }

        if (
          error &&
          (error.code === "IMAGE_UPLOAD_NO_RESULT" ||
            error.code === "IMAGE_UPLOAD_NO_URL")
        ) {
          return res.status(502).json({
            ok: false,
            error: "تعذر اعتماد الصورة بعد رفعها",
          });
        }

        if (error && error.code === "VIDEO_UPLOAD_NO_RESULT") {
          return res.status(502).json({
            ok: false,
            error: "تعذر رفع الفيديو للفحص",
          });
        }

        return res.status(500).json({
          ok: false,
          error: "تعذر رفع الصورة أو الفيديو",
        });
      }
    }
  );

  // ========================================================================
  // REPORT MESSAGE
  // ========================================================================

  app.post("/chat/report", async (req, res) => {
    try {
      const reporterId = await authenticateSessionTicket(
        req.body && req.body.sessionTicket
      );

      if (!checkRate(reportRate, reporterId, 1500)) {
        return res.status(429).json({
          ok: false,
          error: "انتظر قليلاً قبل إرسال بلاغ آخر",
        });
      }

      const roomId = cleanRoom(req.body && req.body.room);
      const messageId = safeString(req.body && req.body.messageId, 100);

      if (!messageId) {
        return res.status(400).json({
          ok: false,
          error: "معرف الرسالة غير موجود",
        });
      }

      const room = await ensureRoomLoaded(roomId, {
        forceStorageRefresh: true,
      });

      const pruned = pruneExpired(room);
      if (pruned) {
        enqueueRoomSave(roomId).catch((error) => {
          console.warn("[LuxuryChat][HISTORY][PRUNE_SAVE_FAILED]", {
            room: roomId,
            error: error && error.message ? error.message : error,
          });
        });
      }

      const message = findMessage(room, messageId);

      if (!message) {
        return res.status(404).json({
          ok: false,
          error: "الرسالة غير موجودة على السيرفر",
        });
      }

      if (message.senderId === reporterId) {
        return res.status(400).json({
          ok: false,
          error: "لا يمكنك الإبلاغ عن رسالتك",
        });
      }

      const result = await createReport(
        reporterId,
        roomId,
        message,
        req.body && req.body.reason
      );

      console.log("[LuxuryChat][REPORT]", {
        reportId: result.report.reportId,
        reporterId: result.report.reporterId,
        messageId: result.report.messageId,
        reportedSenderId: result.report.reportedSenderId,
        kind: result.report.kind,
        duplicate: result.duplicate,
      });

      return res.json({
        ok: true,
        duplicate: result.duplicate,
        reportId: result.report.reportId,
        reportKey: REPORTS_KEY,
      });
    } catch (error) {
      console.error("/chat/report", error);

      return res.status(500).json({
        ok: false,
        error: "تعذر إرسال البلاغ",
      });
    }
  });

  // ========================================================================
  // READY LOG
  // ========================================================================

  console.log("[LuxuryChat] installed", {
    version: 12,
    build: SERVER_BUILD,
    imageModeration: IMAGE_MODERATION_KIND,
    imageModerationFailClosed: true,
    videoModeration: VIDEO_MODERATION_KIND,
    videoModerationWebhook: VIDEO_MODERATION_WEBHOOK_URL,
    videoPendingPersistence:
      "Cloudinary encrypted per-process daily shards - terminal-state hardened",
    persistentHistory:
      "Cloudinary raw JSON - per-process daily shards + strict full snapshots",
    historyCacheRole:
      "runtime cache + throttled Admin discovery + send-safe fallback + direct raw delivery refresh",
    historyShardDiscoveryMs: HISTORY_SHARD_DISCOVERY_MS,
    videoJobShardDiscoveryMs: VIDEO_JOB_SHARD_DISCOVERY_MS,
    deterministicMediaPublicIds: true,
    retentionDays: RETENTION_DAYS,
    fetchLimit: MAX_FETCH_LIMIT,
    maxTextLength: MAX_TEXT_LENGTH,
    voiceLimitMB: MAX_VOICE_BYTES / 1024 / 1024,
    imageLimitMB: MAX_IMAGE_BYTES / 1024 / 1024,
    videoLimitMB: MAX_VIDEO_BYTES / 1024 / 1024,
    reportsKey: REPORTS_KEY,
    routes: [
      "/chat/messages",
      "/chat/send",
      "/chat/voice",
      "/chat/media",
      "/chat/video-status",
      VIDEO_MODERATION_WEBHOOK_PATH,
      "/chat/report",
    ],
  });
};


