"use strict";

// ============================================================================
// Luxury Chat Server - V6
// Cloudinary-Authoritative Persistent 30 Days
// Text + Voice + Image + Video + Reports + Avatar/Profile
// IMAGE + VIDEO MODERATION: Amazon Rekognition via Cloudinary
// Node 18+ / Express / multer / Cloudinary / PlayFab
//
// BUILD:
// 2026-08-10-LUXURY-CHAT-SERVER-V6-CLOUDINARY-AUTHORITATIVE-MERGE-VERIFY
//
// server.js:
// const installLuxuryChat = require("./luxury-chat-server");
// installLuxuryChat(app, cloudinary);
//
// Required env:
// PLAYFAB_TITLE_ID
// PLAYFAB_SECRET_KEY
// CLOUDINARY_API_SECRET   // مطلوب أصلاً لتوقيع Webhook + تشفير video jobs
//
// Optional env:
// CHAT_REPORTS_KEY=LUXURY_CHAT_REPORTS
// CHAT_PUBLIC_SERVER_URL=https://my-server-i40i.onrender.com
//
// أهم إصلاحات V6:
// - Cloudinary هو المصدر الدائم لتاريخ الغرف؛ rooms Map أصبح Cache فقط.
// - Full history requests تعيد مزامنة الغرفة من Cloudinary بدلاً من الاعتماد على RAM القديمة.
// - الكتابة تعمل Read -> Merge -> Write -> Verify لتقليل فقد الرسائل عند تعدد Render instances.
// - 404/JSON تالف/رد ناقص من Cloudinary لا يمسح Runtime صالح موجود مسبقاً.
// - قبل كل رسالة جديدة نعمل مزامنة تخزين حديثة ثم نحدد seq.
// - عند تعارض seq لرسالتين مختلفتين يتم إصلاح التعارض بدون مسح الرسائل.
// - clientMessageId يُستخدم لمنع التكرار حتى أثناء Retry/تعدد instances.
// - /chat/messages لا يقفز latestSeq إلى آخر الغرفة إذا رجع فقط أول 100 رسالة بعد afterSeq.
//   latestSeq أصبح Cursor آخر رسالة تم تسليمها فعلياً، وserverLatestSeq يعرض آخر Seq الحقيقي.
// - لا يوجد حذف بسبب عدد الرسائل؛ الحذف الوحيد من التخزين هو بعد 30 يوماً.
// - refreshProfiles يحدث الاسم/الصورة في Response بدون إعادة كتابة التاريخ كله.
// - الرد يحفظ replyToSenderId أيضاً حتى Unity يحدد "أنت" بشكل صحيح.
// - كل ميزات V5 باقية: نص/صوت/صور/فيديو/Moderation/بلاغات/فيديو Pending/Webhook.
// ============================================================================

const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

module.exports = function installLuxuryChat(app, cloudinary) {
  if (!app) throw new Error("installLuxuryChat: app is required");
  if (!cloudinary) throw new Error("installLuxuryChat: cloudinary is required");

  // ==========================================================================
  // CONFIG
  // ==========================================================================

  const SERVER_BUILD =
    "2026-08-10-LUXURY-CHAT-SERVER-V6-CLOUDINARY-AUTHORITATIVE-MERGE-VERIFY";

  const TITLE_ID = String(process.env.PLAYFAB_TITLE_ID || "").trim();
  const SECRET_KEY = String(process.env.PLAYFAB_SECRET_KEY || "").trim();

  const REPORTS_KEY =
    String(process.env.CHAT_REPORTS_KEY || "LUXURY_CHAT_REPORTS").trim() ||
    "LUXURY_CHAT_REPORTS";

  const MAX_TEXT_LENGTH = 200;
  const MAX_FETCH_LIMIT = 100;

  const RETENTION_DAYS = 30;
  const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const MAX_REPORTS_IN_KEY = 500;

  const MAX_VOICE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

  const PROFILE_CACHE_MS = 15 * 1000;

  const HISTORY_FOLDER = "luxury_chat_history";
  const VOICE_FOLDER = "chat_voice_notes";
  const IMAGE_FOLDER = "chat_media_images";
  const VIDEO_FOLDER = "chat_media_videos";

  // مزامنة Cache مع Cloudinary. Full Snapshot يتجاوز هذا الحد ويجبر Refresh.
  const HISTORY_CACHE_SYNC_MS = 1500;

  // قراءة Cloudinary تعاد عند 404/فشل مؤقت قبل اعتبار الملف غير موجود فعلاً.
  const HISTORY_READ_RETRY_DELAYS_MS = [0, 160, 420, 900];

  // Read -> Merge -> Write -> Verify.
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

  const VIDEO_JOBS_PUBLIC_ID =
    "luxury_chat_video_pending/video_jobs_v1.json";

  const VIDEO_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

  const CLOUDINARY_API_SECRET =
    String(process.env.CLOUDINARY_API_SECRET || "").trim();

  const CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS = 2 * 60 * 60;
  const VIDEO_STATUS_FALLBACK_CHECK_MS = 30 * 1000;

  const ALLOWED_IMAGE_MIME_TYPES = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ]);

  // ==========================================================================
  // MULTER
  // ==========================================================================

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

  // ==========================================================================
  // RUNTIME STATE
  // ==========================================================================

  // rooms = Cache فقط. Cloudinary هو التخزين الدائم.
  const rooms = new Map();
  const profileCache = new Map();

  const sendRate = new Map();
  const reportRate = new Map();

  let reportsLoaded = false;
  let reports = [];
  let reportsLoadPromise = null;
  let reportsWriteChain = Promise.resolve();

  const videoJobs = new Map();
  let videoJobsLoaded = false;
  let videoJobsLoadPromise = null;
  let videoJobsWriteChain = Promise.resolve();

  // ==========================================================================
  // BASIC HELPERS
  // ==========================================================================

  function nowMs() {
    return Date.now();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  }

  function cleanRoom(value) {
    const room = String(value || "global").trim().toLowerCase();
    return /^[a-z0-9_-]{1,40}$/.test(room) ? room : "global";
  }

  function truncateUnicode(value, maximumCodePoints) {
    const text = String(value || "");
    if (!maximumCodePoints || maximumCodePoints <= 0) return "";

    const chars = Array.from(text);
    if (chars.length <= maximumCodePoints) return text;
    return chars.slice(0, maximumCodePoints).join("");
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

  function checkRate(map, key, minimumMs) {
    const now = nowMs();
    const last = Number(map.get(key) || 0);

    if (now - last < minimumMs) return false;

    map.set(key, now);
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

    if (extra && typeof extra === "object") {
      Object.assign(error, extra);
    }

    return error;
  }

  function compareMessages(a, b) {
    if (a === b) return 0;
    if (!a) return -1;
    if (!b) return 1;

    const seqA = Math.max(0, Number(a.seq) || 0);
    const seqB = Math.max(0, Number(b.seq) || 0);

    // seq هو ترتيب السيرفر الأساسي إذا كان متوفراً.
    if (seqA > 0 && seqB > 0 && seqA !== seqB) {
      return seqA - seqB;
    }

    const timeA = Math.max(0, Number(a.sentUnixMs) || 0);
    const timeB = Math.max(0, Number(b.sentUnixMs) || 0);

    if (timeA !== timeB) return timeA - timeB;
    if (seqA !== seqB) return seqA - seqB;

    return String(a.id || "").localeCompare(String(b.id || ""));
  }

  // ==========================================================================
  // PLAYFAB
  // ==========================================================================

  async function playFabCall(group, endpoint, body) {
    if (!TITLE_ID || !SECRET_KEY) {
      throw new Error("PLAYFAB_TITLE_ID / PLAYFAB_SECRET_KEY missing");
    }

    const response = await fetch(
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
    if (!ticket) throw new Error("missing_session_ticket");

    const data = await playFabServerCall("AuthenticateSessionTicket", {
      SessionTicket: ticket,
    });

    const playFabId =
      data && data.UserInfo && data.UserInfo.PlayFabId
        ? String(data.UserInfo.PlayFabId)
        : "";

    if (!playFabId) throw new Error("invalid_session_ticket");

    return playFabId;
  }

  async function getPlayerProfile(playFabId, forceRefresh = false) {
    if (!forceRefresh) {
      const cached = profileCache.get(playFabId);

      if (cached && cached.expires > nowMs()) {
        return cached.profile;
      }
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

    const profile = {
      playerName,
      avatarUrl,
      avatarVersion,
    };

    profileCache.set(playFabId, {
      profile,
      expires: nowMs() + PROFILE_CACHE_MS,
    });

    return profile;
  }

  // ==========================================================================
  // ROOM / CLOUDINARY PERSISTENCE - V6
  // ==========================================================================

  function getRoom(roomId) {
    const id = cleanRoom(roomId);

    if (!rooms.has(id)) {
      rooms.set(id, {
        id,
        seq: 0,
        messages: [],
        loaded: false,
        loadingPromise: null,
        syncPromise: null,
        mutationChain: Promise.resolve(),
        lastStorageSyncMs: 0,
        lastStorageSavedAtUnixMs: 0,
      });
    }

    return rooms.get(id);
  }

  function historyPublicId(roomId) {
    return `${HISTORY_FOLDER}/room_${cleanRoom(roomId)}.json`;
  }

  function addCacheBust(url) {
    const value = String(url || "").trim();
    if (!value) return value;
    return `${value}${value.includes("?") ? "&" : "?"}ts=${nowMs()}_${crypto
      .randomBytes(3)
      .toString("hex")}`;
  }

  function historyUrl(roomId) {
    const base = cloudinary.url(historyPublicId(roomId), {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });

    return addCacheBust(base);
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
    const mediaType =
      kind === "image" || kind === "video"
        ? kind
        : normalizeKind(raw.mediaType) === "image" ||
          normalizeKind(raw.mediaType) === "video"
        ? normalizeKind(raw.mediaType)
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
      if (message.seq > maxSeq) maxSeq = message.seq;
    }

    messages.sort(compareMessages);

    return {
      exists: true,
      version: Math.max(0, Number(parsed.version) || 0),
      room: cleanRoom(parsed.room || roomId),
      seq: Math.max(maxSeq, Math.max(0, Number(parsed.seq) || 0)),
      retentionDays:
        Math.max(0, Number(parsed.retentionDays) || 0) || RETENTION_DAYS,
      savedAtUnixMs: Math.max(0, Number(parsed.savedAtUnixMs) || 0),
      messages,
    };
  }

  async function readHistoryDocument(roomId, explicitUrl = "") {
    let lastError = null;
    let sawNotFound = false;

    for (let attempt = 0; attempt < HISTORY_READ_RETRY_DELAYS_MS.length; attempt++) {
      const delay = HISTORY_READ_RETRY_DELAYS_MS[attempt];
      if (delay > 0) await sleep(delay);

      const url = explicitUrl
        ? addCacheBust(explicitUrl)
        : historyUrl(roomId);

      try {
        const response = await fetch(url, {
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

        const text = await response.text();
        const parsed = parseHistoryDocument(text, roomId);
        return parsed;
      } catch (error) {
        lastError = error;
      }
    }

    if (sawNotFound && (!lastError || lastError.message === "chat_history_not_found")) {
      return {
        exists: false,
        version: 0,
        room: cleanRoom(roomId),
        seq: 0,
        retentionDays: RETENTION_DAYS,
        savedAtUnixMs: 0,
        messages: [],
      };
    }

    throw lastError || new Error("chat_history_load_failed");
  }

  function pruneExpired(room) {
    if (!room || !Array.isArray(room.messages)) return false;

    const cutoff = nowMs() - RETENTION_MS;
    const oldLength = room.messages.length;

    room.messages = room.messages.filter((message) => {
      if (!message) return false;

      const sent = Number(message.sentUnixMs) || 0;
      return sent > cutoff;
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

    // نفس Message ID. نسخة التخزين الأحدث هي الأساس، لكن لا نمسح حقلاً مفيداً
    // إذا جاء رد مؤقت ناقص.
    return {
      id: b.id || a.id,
      clientMessageId: b.clientMessageId || a.clientMessageId,
      seq: Math.max(0, Number(b.seq) || Number(a.seq) || 0),
      room: cleanRoom(b.room || a.room || roomId),
      senderId: b.senderId || a.senderId,
      senderName: b.senderName || a.senderName || "لاعب",
      senderAvatarUrl: b.senderAvatarUrl || a.senderAvatarUrl,
      senderAvatarVersion:
        b.senderAvatarVersion || a.senderAvatarVersion || "0",
      sentUnixMs:
        Math.max(0, Number(b.sentUnixMs) || Number(a.sentUnixMs) || 0),
      kind: b.kind || a.kind || "text",
      text: b.text || a.text || "",
      voiceUrl: b.voiceUrl || a.voiceUrl || "",
      voiceDuration:
        Math.max(0, Number(b.voiceDuration) || Number(a.voiceDuration) || 0),
      mediaType: b.mediaType || a.mediaType || "",
      mediaUrl: b.mediaUrl || a.mediaUrl || "",
      mediaThumbnailUrl: b.mediaThumbnailUrl || a.mediaThumbnailUrl || "",
      mediaFileName: b.mediaFileName || a.mediaFileName || "",
      replyToId: b.replyToId || a.replyToId || "",
      replyToSenderId:
        b.replyToSenderId || a.replyToSenderId || "",
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

      // Retry مزدوج من instance مختلف: نحتفظ بالأقدم/الأثبت.
      const ordered = [previous, message].sort((x, y) => {
        const tx = Math.max(0, Number(x.sentUnixMs) || 0);
        const ty = Math.max(0, Number(y.sentUnixMs) || 0);
        if (tx !== ty) return tx - ty;

        const sx = Math.max(0, Number(x.seq) || 0);
        const sy = Math.max(0, Number(y.seq) || 0);
        if (sx !== sy) return sx - sy;

        return String(x.id || "").localeCompare(String(y.id || ""));
      });

      byClient.set(key, ordered[0]);
    }

    if (changed) {
      room.messages = withoutClient.concat(Array.from(byClient.values()));
      room.messages.sort(compareMessages);
    }

    return changed;
  }

  function repairSequenceCollisions(room) {
    if (!room || !Array.isArray(room.messages)) return false;

    room.messages.sort((a, b) => {
      const timeA = Math.max(0, Number(a && a.sentUnixMs) || 0);
      const timeB = Math.max(0, Number(b && b.sentUnixMs) || 0);
      if (timeA !== timeB) return timeA - timeB;

      const seqA = Math.max(0, Number(a && a.seq) || 0);
      const seqB = Math.max(0, Number(b && b.seq) || 0);
      if (seqA !== seqB) return seqA - seqB;

      return String((a && a.id) || "").localeCompare(String((b && b.id) || ""));
    });

    let maxSeq = Math.max(0, Number(room.seq) || 0);

    for (const message of room.messages) {
      if (!message) continue;
      maxSeq = Math.max(maxSeq, Math.max(0, Number(message.seq) || 0));
    }

    const used = new Set();
    let changed = false;

    for (const message of room.messages) {
      if (!message) continue;

      let seq = Math.max(0, Number(message.seq) || 0);

      if (seq <= 0 || used.has(seq)) {
        maxSeq += 1;
        message.seq = maxSeq;
        seq = maxSeq;
        changed = true;
      }

      used.add(seq);
    }

    if (room.seq !== maxSeq) {
      room.seq = maxSeq;
      changed = true;
    }

    room.messages.sort(compareMessages);
    return changed;
  }

  function mergeHistoryDocumentIntoRoom(room, document) {
    if (!room || !document || !document.exists) {
      return { changed: false, sequenceChanged: false };
    }

    const beforeCount = room.messages.length;
    const byId = new Map();

    for (const local of room.messages) {
      if (!local || !local.id) continue;
      byId.set(local.id, normalizeMessage(local, room.id));
    }

    for (const remote of document.messages || []) {
      if (!remote || !remote.id) continue;

      const previous = byId.get(remote.id);
      byId.set(
        remote.id,
        previous
          ? mergeMessageFields(previous, remote, room.id)
          : normalizeMessage(remote, room.id)
      );
    }

    room.messages = Array.from(byId.values()).filter(Boolean);
    room.seq = Math.max(
      Math.max(0, Number(room.seq) || 0),
      Math.max(0, Number(document.seq) || 0)
    );

    const deduped = dedupeClientMessages(room);
    pruneExpired(room);
    const sequenceChanged = repairSequenceCollisions(room);

    room.loaded = true;
    room.lastStorageSyncMs = nowMs();
    room.lastStorageSavedAtUnixMs = Math.max(
      room.lastStorageSavedAtUnixMs || 0,
      Number(document.savedAtUnixMs) || 0
    );

    return {
      changed: beforeCount !== room.messages.length || deduped || sequenceChanged,
      sequenceChanged,
    };
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
        const document = await readHistoryDocument(roomId);

        if (!document.exists) {
          // 404 مؤكد بعد retries:
          // - أول تحميل بدون أي Cache = غرفة جديدة فعلاً.
          // - إذا عندنا Runtime صالح لا نمسحه بسبب 404 متأخر/مؤقت.
          if (!room.loaded && room.messages.length === 0) {
            room.seq = 0;
            room.messages = [];
            room.loaded = true;
          }

          room.lastStorageSyncMs = nowMs();
          return room;
        }

        if (!room.loaded) {
          room.messages = (document.messages || []).map((m) =>
            normalizeMessage(m, room.id)
          ).filter(Boolean);
          room.seq = Math.max(0, Number(document.seq) || 0);
          room.loaded = true;
          room.lastStorageSyncMs = nowMs();
          room.lastStorageSavedAtUnixMs =
            Math.max(0, Number(document.savedAtUnixMs) || 0);
          pruneExpired(room);
          dedupeClientMessages(room);
          repairSequenceCollisions(room);
          return room;
        }

        mergeHistoryDocumentIntoRoom(room, document);
        return room;
      } catch (error) {
        // إذا عندنا Cache صالح لا نمسحه بسبب فشل تخزين مؤقت.
        if (room.loaded) {
          console.warn("[LuxuryChat][HISTORY][SYNC][CACHE_FALLBACK]", {
            room: room.id,
            error: error && error.message ? error.message : error,
          });

          // لا نضع TTL طويل؛ المحاولة القادمة تعيد التزامن بسرعة.
          room.lastStorageSyncMs = nowMs() - HISTORY_CACHE_SYNC_MS + 300;
          return room;
        }

        throw error;
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
    if (!document || !document.exists) return false;

    const list = Array.isArray(document.messages) ? document.messages : [];

    if (requirement.messageId) {
      if (list.some((m) => m && m.id === requirement.messageId)) {
        return true;
      }
    }

    if (requirement.senderId && requirement.clientMessageId) {
      if (
        list.some(
          (m) =>
            m &&
            m.senderId === requirement.senderId &&
            m.clientMessageId === requirement.clientMessageId
        )
      ) {
        return true;
      }
    }

    return false;
  }

  function makeHistoryPayload(room) {
    pruneExpired(room);
    dedupeClientMessages(room);
    repairSequenceCollisions(room);

    return {
      version: 6,
      build: SERVER_BUILD,
      room: cleanRoom(room.id),
      seq: Math.max(0, Number(room.seq) || 0),
      retentionDays: RETENTION_DAYS,
      savedAtUnixMs: nowMs(),
      messages: room.messages,
    };
  }

  async function saveRoomNow(roomId, requirement = null) {
    const room = getRoom(roomId);

    // قبل أي كتابة: اقرأ آخر نسخة من Cloudinary وادمجها مع Cache الحالي.
    // هذا أهم فرق عن V5 الذي كان يكتب RAM قديمة فوق الملف مباشرة.
    try {
      const currentDocument = await readHistoryDocument(roomId);
      if (currentDocument.exists) {
        mergeHistoryDocumentIntoRoom(room, currentDocument);
      }
    } catch (error) {
      // V6 Fail Safe: ممنوع نكتب Cache قديمة فوق Cloudinary إذا فشلت قراءة
      // آخر نسخة من التخزين. الأفضل يفشل الإرسال مؤقتاً على أن نخسر التاريخ.
      console.error("[LuxuryChat][HISTORY][PREWRITE_SYNC][ABORT_WRITE]", {
        room: room.id,
        error: error && error.message ? error.message : error,
      });

      throw makeChatError(
        "HISTORY_PREWRITE_SYNC_FAILED",
        "chat_history_prewrite_sync_failed"
      );
    }

    pruneExpired(room);
    dedupeClientMessages(room);
    repairSequenceCollisions(room);

    let lastError = null;

    for (let attempt = 1; attempt <= HISTORY_WRITE_VERIFY_ATTEMPTS; attempt++) {
      try {
        const payload = makeHistoryPayload(room);
        const uploadResult = await uploadRawJson(historyPublicId(roomId), payload);

        // نتأكد أولاً أن النسخة التي رفعناها نفسها قابلة للقراءة.
        if (uploadResult && uploadResult.secure_url) {
          try {
            const ownVersionDocument = await readHistoryDocument(
              roomId,
              uploadResult.secure_url
            );

            if (ownVersionDocument.exists) {
              mergeHistoryDocumentIntoRoom(room, ownVersionDocument);
            }
          } catch (error) {
            console.warn("[LuxuryChat][HISTORY][VERIFY_OWN_VERSION]", {
              room: room.id,
              attempt,
              error: error && error.message ? error.message : error,
            });
          }
        }

        // نعطي فرصة قصيرة لأي instance متزامن ثم نقرأ الرابط الحالي غير المثبت على version.
        await sleep(HISTORY_WRITE_VERIFY_SETTLE_MS);

        const latestDocument = await readHistoryDocument(roomId);

        if (!latestDocument.exists) {
          lastError = new Error("history_verify_not_found");
          continue;
        }

        const mergeResult = mergeHistoryDocumentIntoRoom(room, latestDocument);
        const requirementPresent = requiredMessageExists(latestDocument, requirement);

        // إذا اصطدم seq أثناء دمج كتابتين متزامنتين، نعيد الكتابة مرة أخرى
        // حتى تصبح نسخة Cloudinary نفسها تحمل seq المصحح.
        if (requirementPresent && !mergeResult.sequenceChanged) {
          room.lastStorageSyncMs = nowMs();
          room.lastStorageSavedAtUnixMs = Math.max(
            room.lastStorageSavedAtUnixMs || 0,
            Number(latestDocument.savedAtUnixMs) || 0
          );

          return room;
        }

        lastError = new Error(
          requirementPresent
            ? "history_sequence_repair_requires_rewrite"
            : "history_required_message_missing_after_write"
        );
      } catch (error) {
        lastError = error;
      }

      if (attempt < HISTORY_WRITE_VERIFY_ATTEMPTS) {
        // قبل Retry نقرأ آخر نسخة مرة أخرى ونضم رسائل أي instance آخر.
        try {
          const latest = await readHistoryDocument(roomId);
          if (latest.exists) mergeHistoryDocumentIntoRoom(room, latest);
        } catch (_) {}

        await sleep(120 * attempt);
      }
    }

    throw lastError || new Error("chat_history_write_verify_failed");
  }

  function enqueueRoomMutation(roomId, operation) {
    const room = getRoom(roomId);

    room.mutationChain = room.mutationChain
      .catch(() => {})
      .then(operation);

    return room.mutationChain;
  }

  function enqueueRoomSave(roomId) {
    return enqueueRoomMutation(roomId, async () => {
      const room = await ensureRoomLoaded(roomId, {
        forceStorageRefresh: true,
      });

      pruneExpired(room);
      await saveRoomNow(roomId, null);
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

      // فحص idempotency مرة أخرى بعد آخر Sync، حتى لو instance آخر سبقنا.
      if (message && message.senderId && message.clientMessageId) {
        const duplicate = findClientMessage(
          room,
          message.senderId,
          message.clientMessageId
        );

        if (duplicate) return duplicate;
      }

      let latestKnownSeq = Math.max(0, Number(room.seq) || 0);

      for (const existingMessage of room.messages) {
        latestKnownSeq = Math.max(
          latestKnownSeq,
          Math.max(0, Number(existingMessage && existingMessage.seq) || 0)
        );
      }

      room.seq = latestKnownSeq + 1;
      message.seq = room.seq;
      message.room = cleanRoom(roomId);
      room.messages.push(message);

      dedupeClientMessages(room);
      repairSequenceCollisions(room);

      const requirement = {
        messageId: message.id,
        senderId: message.senderId,
        clientMessageId: message.clientMessageId,
      };

      await saveRoomNow(roomId, requirement);

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

  // ==========================================================================
  // VIDEO MODERATION JOB PERSISTENCE
  // ==========================================================================

  function videoJobsUrl() {
    const base = cloudinary.url(VIDEO_JOBS_PUBLIC_ID, {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });

    return addCacheBust(base);
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
        (job.status === "approved" ||
          job.status === "rejected" ||
          job.status === "failed")
      ) {
        videoJobs.delete(publicId);
        changed = true;
      }
    }

    return changed;
  }

  async function loadVideoJobsFromStorage() {
    const response = await fetch(videoJobsUrl(), {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
    });

    if (response.status === 404) {
      // لا نمسح Map موجودة بسبب 404 مؤقت بعد ما كانت محملة.
      if (!videoJobsLoaded) videoJobs.clear();
      videoJobsLoaded = true;
      return videoJobs;
    }

    if (!response.ok) {
      throw new Error(`video_jobs_load_http_${response.status}`);
    }

    const text = await response.text();

    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch (_) {
      throw new Error("video_jobs_invalid_json");
    }

    const decoded = decryptVideoJobsPayload(envelope);
    const source = decoded && Array.isArray(decoded.jobs) ? decoded.jobs : [];

    // Merge بدلاً من clear حتى لا يمسح Job محلي أحدث بسبب نسخة تخزين أقدم لحظياً.
    for (const raw of source) {
      const job = normalizeVideoJob(raw);
      if (!job) continue;

      const existing = videoJobs.get(job.publicId);

      if (
        !existing ||
        Number(job.updatedAtUnixMs || 0) >=
          Number(existing.updatedAtUnixMs || 0)
      ) {
        videoJobs.set(job.publicId, job);
      }
    }

    videoJobsLoaded = true;
    pruneVideoJobsInMemory();
    return videoJobs;
  }

  async function ensureVideoJobsLoaded(forceRefresh = false) {
    if (videoJobsLoadPromise) return videoJobsLoadPromise;
    if (videoJobsLoaded && !forceRefresh) return videoJobs;

    videoJobsLoadPromise = loadVideoJobsFromStorage()
      .then((result) => {
        videoJobsLoadPromise = null;
        return result;
      })
      .catch((error) => {
        videoJobsLoadPromise = null;
        if (!videoJobsLoaded) throw error;

        console.warn("[LuxuryChat][VIDEO_JOBS][CACHE_FALLBACK]", error.message);
        return videoJobs;
      });

    return videoJobsLoadPromise;
  }

  async function saveVideoJobsNow() {
    // قبل الكتابة نحاول دمج النسخة الحالية من Cloudinary.
    try {
      await ensureVideoJobsLoaded(true);
    } catch (_) {}

    pruneVideoJobsInMemory();

    const payload = {
      version: 1,
      savedAtUnixMs: nowMs(),
      jobs: Array.from(videoJobs.values()),
    };

    const encrypted = encryptVideoJobsPayload(payload);
    await uploadRawJson(VIDEO_JOBS_PUBLIC_ID, encrypted);
  }

  function enqueueVideoJobsSave() {
    videoJobsWriteChain = videoJobsWriteChain
      .catch(() => {})
      .then(() => saveVideoJobsNow());

    return videoJobsWriteChain;
  }

  function findVideoJobByClient(senderId, clientMessageId) {
    if (!senderId || !clientMessageId) return null;

    let best = null;

    for (const job of videoJobs.values()) {
      if (
        job &&
        job.senderId === senderId &&
        job.clientMessageId === clientMessageId
      ) {
        if (
          !best ||
          Number(job.updatedAtUnixMs || 0) >
            Number(best.updatedAtUnixMs || 0)
        ) {
          best = job;
        }
      }
    }

    return best;
  }

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

    for (const item of moderation) {
      if (!item || typeof item !== "object") continue;

      if (
        String(item.kind || "").trim().toLowerCase() ===
        String(kind || "").trim().toLowerCase()
      ) {
        return item;
      }
    }

    return null;
  }

  function getModerationStatus(uploadResult, kind) {
    const entry = getModerationEntry(uploadResult, kind);

    return entry
      ? String(entry.status || "").trim().toLowerCase()
      : "";
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

  function getDeepModerationStatus(value) {
    if (!value || typeof value !== "object") return "";

    const directCandidates = [
      value.moderation_status,
      value.moderationStatus,
    ];

    for (const candidate of directCandidates) {
      const status = String(candidate || "").trim().toLowerCase();

      if (
        status === "approved" ||
        status === "rejected" ||
        status === "pending"
      ) {
        return status;
      }
    }

    const entry = getModerationEntry(value, VIDEO_MODERATION_KIND);

    if (entry) {
      const status = String(entry.status || "").trim().toLowerCase();
      if (status) return status;
    }

    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        const nested = getDeepModerationStatus(child);
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

  // ==========================================================================
  // CLOUDINARY MEDIA
  // ==========================================================================

  function uniqueMediaPublicId(playFabId) {
    return `${safeString(playFabId, 80)}_${Date.now()}_${crypto
      .randomBytes(5)
      .toString("hex")}`;
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

  function uploadAudioBuffer(buffer, playFabId) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          folder: VOICE_FOLDER,
          public_id: uniqueMediaPublicId(playFabId),
          overwrite: false,
        },
        (error, result) => {
          if (error) return reject(error);

          if (!result || !result.secure_url) {
            return reject(new Error("cloudinary_no_url"));
          }

          resolve({
            url: result.secure_url,
            publicId: result.public_id || "",
          });
        }
      );

      stream.end(buffer);
    });
  }

  function uploadImageBuffer(buffer, playFabId) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "image",
          folder: IMAGE_FOLDER,
          public_id: uniqueMediaPublicId(playFabId),
          overwrite: false,
          format: "jpg",
          moderation: IMAGE_MODERATION_KIND,
        },
        async (error, result) => {
          if (error) return reject(error);

          if (!result || !result.public_id) {
            return reject(
              makeChatError(
                "IMAGE_UPLOAD_NO_RESULT",
                "cloudinary_image_no_result"
              )
            );
          }

          const publicId = safeString(result.public_id, 500);
          const moderationStatus = getModerationStatus(
            result,
            IMAGE_MODERATION_KIND
          );

          const moderationLabels = getModerationLabels(
            result,
            IMAGE_MODERATION_KIND
          );

          console.log("[LuxuryChat][IMAGE_MODERATION]", {
            playFabId: safeString(playFabId, 100),
            publicId,
            status: moderationStatus || "missing",
            labelsCount: moderationLabels.length,
          });

          if (moderationStatus !== "approved") {
            await destroyCloudinaryAsset(publicId, "image");

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
            await destroyCloudinaryAsset(publicId, "image");

            return reject(
              makeChatError("IMAGE_UPLOAD_NO_URL", "cloudinary_image_no_url")
            );
          }

          const thumb = cloudinary.url(result.public_id, {
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
            publicId,
            moderationStatus,
          });
        }
      );

      stream.end(buffer);
    });
  }

  function uploadVideoBuffer(buffer, playFabId, forcedPublicId) {
    return new Promise((resolve, reject) => {
      const publicId =
        safeString(forcedPublicId, 500) ||
        `${VIDEO_FOLDER}/${uniqueMediaPublicId(playFabId)}`;

      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          public_id: publicId,
          overwrite: false,
          moderation: VIDEO_MODERATION_KIND,
          notification_url: VIDEO_MODERATION_WEBHOOK_URL,
        },
        (error, result) => {
          if (error) return reject(error);

          if (!result || !result.public_id || !result.secure_url) {
            return reject(
              makeChatError(
                "VIDEO_UPLOAD_NO_RESULT",
                "cloudinary_video_no_result"
              )
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
          });
        }
      );

      stream.end(buffer);
    });
  }

  // ==========================================================================
  // MESSAGE HELPERS / REPLY
  // ==========================================================================

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

    return {
      id: crypto.randomUUID(),
      clientMessageId: cleanClientMessageId(clientMessageId),
      seq: 0,
      room: cleanRoom(roomId),
      senderId: safeString(senderId, 100),
      senderName: safeString(profile && profile.playerName, 64) || "لاعب",
      senderAvatarUrl: safeString(profile && profile.avatarUrl, 1000),
      senderAvatarVersion:
        safeString(profile && profile.avatarVersion, 100) || "0",
      sentUnixMs: nowMs(),
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
      new Set(result.map((m) => safeString(m && m.senderId, 100)).filter(Boolean))
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
      message.senderAvatarUrl =
        safeString(profile.avatarUrl, 1000) || "";
      message.senderAvatarVersion =
        safeString(profile.avatarVersion, 100) || "0";
    }

    return result;
  }

  // ==========================================================================
  // VIDEO MODERATION FINALIZATION
  // ==========================================================================

  async function finalizeApprovedVideoJob(job, moderationSource) {
    if (!job) return null;

    job.moderationStatus = "approved";
    job.updatedAtUnixMs = nowMs();

    if (!job.uploadCompleted || !job.mediaUrl) {
      job.status = "pending";
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

    if (!message) {
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
    }

    job.status = "approved";
    job.rejectReason = "";
    job.messageId = message && message.id ? message.id : job.messageId;
    job.updatedAtUnixMs = nowMs();

    await enqueueVideoJobsSave();

    console.log("[LuxuryChat][VIDEO_MODERATION][APPROVED]", {
      publicId: job.publicId,
      senderId: job.senderId,
      clientMessageId: job.clientMessageId,
      messageId: job.messageId,
    });

    return message;
  }

  async function finalizeRejectedVideoJob(job, moderationSource) {
    if (!job) return;

    job.status = "rejected";
    job.moderationStatus = "rejected";
    job.rejectReason = buildVideoRejectReason(moderationSource);
    job.updatedAtUnixMs = nowMs();

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

    let source = fallbackBody || {};
    let status = getDeepModerationStatus(source);

    if (status !== "approved" && status !== "rejected") {
      let resource = null;

      try {
        resource = await getVideoModerationResource(id);
        job.lastCloudinaryCheckUnixMs = nowMs();
      } catch (error) {
        console.warn("[LuxuryChat][VIDEO_MODERATION] Admin API read failed", {
          publicId: id,
          error: error && error.message ? error.message : error,
        });
      }

      if (resource) {
        source = resource;
        status = getDeepModerationStatus(resource);
      }
    }

    if (status === "approved") {
      await finalizeApprovedVideoJob(job, source);
      return { status: "approved" };
    }

    if (status === "rejected") {
      await finalizeRejectedVideoJob(job, source);
      return { status: "rejected" };
    }

    job.status = "pending";
    job.moderationStatus = status || "pending";
    job.updatedAtUnixMs = nowMs();

    await enqueueVideoJobsSave();
    return { status: "pending" };
  }

  function verifyCloudinaryWebhook(req) {
    const signature = String(req.headers["x-cld-signature"] || "")
      .trim()
      .replace(/^sha1=/i, "")
      .replace(/^sha256=/i, "");

    const timestampRaw = String(req.headers["x-cld-timestamp"] || "").trim();
    const timestamp = Number(timestampRaw);

    const rawBody = typeof req.rawBody === "string" ? req.rawBody : "";

    if (
      !signature ||
      !timestampRaw ||
      !Number.isFinite(timestamp) ||
      !rawBody ||
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

    const algorithm = signature.length === 64 ? "sha256" : "sha1";

    const expected = crypto
      .createHash(algorithm)
      .update(rawBody + timestampRaw + CLOUDINARY_API_SECRET, "utf8")
      .digest("hex");

    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");

    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  function extractWebhookPublicId(body) {
    if (!body || typeof body !== "object") return "";

    const direct = safeString(body.public_id, 500);
    if (direct) return direct;

    for (const child of Object.values(body)) {
      if (child && typeof child === "object") {
        const nested = extractWebhookPublicId(child);
        if (nested) return nested;
      }
    }

    return "";
  }

  // ==========================================================================
  // REPORTS -> PLAYFAB TITLE INTERNAL DATA
  // ==========================================================================

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
          else if (parsed && Array.isArray(parsed.reports)) loaded = parsed.reports;
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

  async function createReport(reporterId, roomId, message, reason) {
    await loadReports();

    const existing = reports.find(
      (report) =>
        report &&
        report.reporterId === reporterId &&
        report.messageId === message.id
    );

    if (existing) {
      return { report: existing, duplicate: true };
    }

    const kind = normalizeKind(message.kind || message.mediaType);

    const report = {
      reportId: crypto.randomUUID(),
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
      voiceUrl:
        kind === "voice" ? safeString(message.voiceUrl, 1200) : "",
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

    reports.push(report);

    if (reports.length > MAX_REPORTS_IN_KEY) {
      reports = reports.slice(-MAX_REPORTS_IN_KEY);
    }

    await saveReports();
    return { report, duplicate: false };
  }

  // ==========================================================================
  // HISTORY
  // ==========================================================================

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

      // Full Snapshot / refreshProfiles يجبر قراءة Cloudinary فعلياً.
      const room = await ensureRoomLoaded(roomId, {
        forceStorageRefresh: afterSeq === 0 || refreshProfiles,
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

      room.messages.sort(compareMessages);

      let messages = [];
      let hasMore = false;
      let cursorLatestSeq = afterSeq;

      if (afterSeq > 0) {
        const after = room.messages.filter(
          (message) => Math.max(0, Number(message && message.seq) || 0) > afterSeq
        );

        hasMore = after.length > limit;
        messages = after.slice(0, limit);

        // أهم إصلاح: لا نقفز إلى room.seq إذا سلمنا جزءاً فقط من الرسائل.
        if (messages.length > 0) {
          cursorLatestSeq = Math.max(
            afterSeq,
            Math.max(0, Number(messages[messages.length - 1].seq) || 0)
          );
        } else {
          cursorLatestSeq = afterSeq;
        }
      } else {
        messages = room.messages.slice(
          Math.max(0, room.messages.length - limit)
        );
        cursorLatestSeq = Math.max(0, Number(room.seq) || 0);
      }

      const responseMessages = await hydrateProfilesForResponse(
        messages,
        refreshProfiles
      );

      return res.json({
        ok: true,
        messages: responseMessages,
        latestSeq: cursorLatestSeq,
        serverLatestSeq: Math.max(0, Number(room.seq) || 0),
        hasMore,
        retentionDays: RETENTION_DAYS,
        source: "cloudinary",
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

  // ==========================================================================
  // SEND TEXT
  // ==========================================================================

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

  // ==========================================================================
  // SEND VOICE
  // ==========================================================================

  app.post(
    "/chat/voice",
    uploadSingleJson(
      voiceUpload,
      "clip",
      "حجم الملاحظة الصوتية أكبر من الحد المسموح"
    ),
    async (req, res) => {
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

        const uploaded = await uploadAudioBuffer(req.file.buffer, playFabId);

        let message = makeMessage({
          roomId,
          senderId: playFabId,
          profile,
          kind: "voice",
          reply,
          clientMessageId,
        });

        message.voiceUrl = uploaded.url;
        message.voiceDuration = duration;
        message = await pushMessage(roomId, message);

        return res.json({
          ok: true,
          message,
        });
      } catch (error) {
        console.error("/chat/voice", error);

        return res.status(500).json({
          ok: false,
          error: "تعذر رفع الملاحظة الصوتية",
        });
      }
    }
  );

  // ==========================================================================
  // CLOUDINARY VIDEO MODERATION WEBHOOK
  // ==========================================================================

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

  // ==========================================================================
  // VIDEO STATUS FOR UNITY
  // ==========================================================================

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

  // ==========================================================================
  // SEND IMAGE / VIDEO
  // ==========================================================================

  app.post(
    "/chat/media",
    uploadSingleJson(
      mediaUpload,
      "media",
      "حجم الملف أكبر من الحد المسموح للفيديو"
    ),
    async (req, res) => {
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

        // --------------------------------------------------------------------
        // VIDEO
        // --------------------------------------------------------------------

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

          const videoPublicId =
            `${VIDEO_FOLDER}/${uniqueMediaPublicId(playFabId)}`;

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
            videoJobs.delete(videoPublicId);
            await enqueueVideoJobsSave();
            throw error;
          }

          job.uploadCompleted = true;
          job.mediaUrl = safeString(uploadedVideo.url, 1600);
          job.mediaThumbnailUrl = safeString(
            uploadedVideo.thumbnailUrl,
            1600
          );
          job.moderationStatus =
            safeString(uploadedVideo.moderationStatus, 30) || "pending";
          job.status = "pending";
          job.updatedAtUnixMs = nowMs();

          await enqueueVideoJobsSave();

          console.log("[LuxuryChat][VIDEO_MODERATION][UPLOADED]", {
            publicId: job.publicId,
            senderId: job.senderId,
            clientMessageId: job.clientMessageId,
            moderationStatus: job.moderationStatus,
            webhook: VIDEO_MODERATION_WEBHOOK_URL,
          });

          if (
            job.moderationStatus === "approved" ||
            job.moderationStatus === "rejected"
          ) {
            await applyVideoModerationResult(job.publicId, uploadedVideo.raw);
          }

          const fresh = videoJobs.get(job.publicId) || job;

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

        // --------------------------------------------------------------------
        // IMAGE
        // --------------------------------------------------------------------

        const uploaded = await uploadImageBuffer(req.file.buffer, playFabId);

        if (
          String((uploaded && uploaded.moderationStatus) || "")
            .trim()
            .toLowerCase() !== "approved"
        ) {
          if (uploaded && uploaded.publicId) {
            await destroyCloudinaryAsset(uploaded.publicId, "image");
          }

          return res.status(503).json({
            ok: false,
            error: "تعذر اعتماد الصورة من نظام الحماية، حاول مرة أخرى",
          });
        }

        let message = makeMessage({
          roomId,
          senderId: playFabId,
          profile,
          kind: "image",
          reply,
          clientMessageId,
        });

        message.mediaType = "image";
        message.mediaUrl = safeString(uploaded.url, 1600);
        message.mediaThumbnailUrl = safeString(uploaded.thumbnailUrl, 1600);
        message.mediaFileName = sanitizeFileName(
          req.file.originalname,
          "chat_image.jpg"
        );

        message = await pushMessage(roomId, message);

        return res.json({
          ok: true,
          message,
        });
      } catch (error) {
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

  // ==========================================================================
  // REPORT MESSAGE
  // ==========================================================================

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

  // ==========================================================================
  // READY LOG
  // ==========================================================================

  console.log("[LuxuryChat] installed", {
    version: 6,
    build: SERVER_BUILD,
    imageModeration: IMAGE_MODERATION_KIND,
    imageModerationFailClosed: true,
    videoModeration: VIDEO_MODERATION_KIND,
    videoModerationWebhook: VIDEO_MODERATION_WEBHOOK_URL,
    videoPendingPersistence: "Cloudinary encrypted raw JSON",
    persistentHistory: "Cloudinary raw JSON - read/merge/write/verify",
    historyCacheRole: "runtime cache only",
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

