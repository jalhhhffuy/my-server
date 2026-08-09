"use strict";

// ============================================================================
// Luxury Chat Server - V4
// Persistent 30 Days + Text + Voice + Image + Video + Reports + Avatar/Profile
// IMAGE MODERATION STEP 1: Amazon Rekognition AI Moderation via Cloudinary
// Node 18+ / Express / multer / Cloudinary / PlayFab
//
// server.js:
// const installLuxuryChat = require("./luxury-chat-server");
// installLuxuryChat(app, cloudinary);
//
// Required env:
// PLAYFAB_TITLE_ID
// PLAYFAB_SECRET_KEY
//
// Optional env:
// CHAT_REPORTS_KEY=LUXURY_CHAT_REPORTS
//
// السلوك:
// - تاريخ الشات محفوظ في Cloudinary Raw JSON وليس RAM فقط.
// - كل رسالة تبقى 30 يوماً كاملة، وعند دخولها اليوم 31 تُحذف.
// - السيرفر لا يحذف الرسالة رقم 101؛ Unity يحتفظ محلياً بآخر 100 فقط.
// - History يرجع بحد أقصى 100 رسالة في الطلب الواحد.
// - يدعم text / voice / image / video.
// - الصور والفيديوهات والملاحظات الصوتية ترفع إلى Cloudinary.
// - صور الشات تمر على Amazon Rekognition AI Moderation قبل نشرها.
// - الصورة لا تدخل تاريخ الشات إلا إذا كانت حالة aws_rek = approved.
// - الصورة المرفوضة أو التي لم يكتمل فحصها لا تنشر في الشات.
// - نحاول حذف الصورة المرفوضة/غير المعتمدة من Cloudinary مباشرة.
// - الفيديو في هذه النسخة ما زال يعمل بالنظام السابق، وسيضاف له Webhook في الخطوة التالية.
// - البلاغات تحفظ في PlayFab Title Internal Data.
// - كل رسالة تحمل اسم اللاعب + رابط صورته + نسخة الصورة.
// - بيانات البروفايل تُقرأ حديثة عند الإرسال حتى يظهر تغيير الاسم/الصورة بسرعة.
// - clientMessageId يمنع تكرار الرسالة عند Retry بعد نجاح الحفظ.
// - الرد يحفظ Snapshot: معرف الرسالة الأصلية + اسم صاحبها + معاينة المحتوى.
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

  const TITLE_ID = String(process.env.PLAYFAB_TITLE_ID || "").trim();
  const SECRET_KEY = String(process.env.PLAYFAB_SECRET_KEY || "").trim();

  const REPORTS_KEY =
    String(process.env.CHAT_REPORTS_KEY || "LUXURY_CHAT_REPORTS").trim() ||
    "LUXURY_CHAT_REPORTS";

  const MAX_TEXT_LENGTH = 200;
  const MAX_FETCH_LIMIT = 100;

  // 30 يوم كاملة. sent <= cutoff يعني دخلت الرسالة اليوم 31.
  const RETENTION_DAYS = 30;
  const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const MAX_REPORTS_IN_KEY = 500;

  // يجب أن تطابق حدود Unity الجديدة.
  const MAX_VOICE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

  const PROFILE_CACHE_MS = 15 * 1000;

  const HISTORY_FOLDER = "luxury_chat_history";
  const VOICE_FOLDER = "chat_voice_notes";
  const IMAGE_FOLDER = "chat_media_images";
  const VIDEO_FOLDER = "chat_media_videos";

  // Amazon Rekognition AI Moderation للصور.
  // نستخدم الإعداد الافتراضي من Cloudinary:
  // إذا تجاوزت أي فئة حد الثقة الافتراضي، تصبح الصورة rejected.
  const IMAGE_MODERATION_KIND = "aws_rek";

  // أنواع الصور التي نسمح بها فعليًا من Unity.
  // يمنع تمرير ملفات غريبة تحت image/*.
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
    // أكبر حد هو الفيديو. الصور تُفحص بعد ذلك بحد 8MB.
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

  const rooms = new Map();
  const profileCache = new Map();

  const sendRate = new Map();
  const reportRate = new Map();

  let reportsLoaded = false;
  let reports = [];
  let reportsLoadPromise = null;
  let reportsWriteChain = Promise.resolve();

  // ==========================================================================
  // BASIC HELPERS
  // ==========================================================================

  function nowMs() {
    return Date.now();
  }

  function cleanRoom(value) {
    const room = String(value || "global").trim().toLowerCase();
    return /^[a-z0-9_-]{1,40}$/.test(room) ? room : "global";
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u0000/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
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

    // احتياط إذا الحساب قديم ولا يملك player_display_name في UserData.
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
  // ROOM / CLOUDINARY PERSISTENCE
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
        writeChain: Promise.resolve(),
      });
    }

    return rooms.get(id);
  }

  function historyPublicId(roomId) {
    return `${HISTORY_FOLDER}/room_${cleanRoom(roomId)}.json`;
  }

  function historyUrl(roomId) {
    const base = cloudinary.url(historyPublicId(roomId), {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });

    return `${base}${base.includes("?") ? "&" : "?"}ts=${nowMs()}`;
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
      replyToName: safeString(raw.replyToName, 64),
      replyToPreview: safeString(raw.replyToPreview, 120),
    };
  }

  function pruneExpired(room) {
    if (!room || !Array.isArray(room.messages)) return false;

    const cutoff = nowMs() - RETENTION_MS;
    const oldLength = room.messages.length;

    room.messages = room.messages.filter((message) => {
      if (!message) return false;

      const sent = Number(message.sentUnixMs) || 0;

      // إذا أكملت 30 يوماً ودخلت اليوم 31 تُحذف.
      return sent > cutoff;
    });

    return room.messages.length !== oldLength;
  }

  async function loadRoomFromStorage(roomId) {
    const room = getRoom(roomId);

    const response = await fetch(historyUrl(roomId), {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache, no-store",
        Pragma: "no-cache",
      },
    });

    if (response.status === 404) {
      room.seq = 0;
      room.messages = [];
      room.loaded = true;
      return room;
    }

    if (!response.ok) {
      throw new Error(`chat_history_load_http_${response.status}`);
    }

    const text = await response.text();

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (_) {
      throw new Error("chat_history_invalid_json");
    }

    const source =
      parsed && Array.isArray(parsed.messages) ? parsed.messages : [];

    const messages = [];
    let maxSeq = 0;

    for (const raw of source) {
      const message = normalizeMessage(raw, roomId);
      if (!message) continue;

      messages.push(message);
      if (message.seq > maxSeq) maxSeq = message.seq;
    }

    messages.sort((a, b) => {
      const t = a.sentUnixMs - b.sentUnixMs;
      if (t !== 0) return t;

      const s = a.seq - b.seq;
      if (s !== 0) return s;

      return String(a.id).localeCompare(String(b.id));
    });

    room.messages = messages;
    room.seq = Math.max(maxSeq, Math.max(0, Number(parsed && parsed.seq) || 0));
    room.loaded = true;

    if (pruneExpired(room)) {
      await enqueueRoomSave(roomId);
    }

    return room;
  }

  async function ensureRoomLoaded(roomId) {
    const room = getRoom(roomId);

    if (room.loaded) return room;
    if (room.loadingPromise) return room.loadingPromise;

    room.loadingPromise = loadRoomFromStorage(roomId)
      .then((loaded) => {
        room.loadingPromise = null;
        return loaded;
      })
      .catch((error) => {
        room.loadingPromise = null;
        room.loaded = false;
        throw error;
      });

    return room.loadingPromise;
  }

  async function saveRoomNow(roomId) {
    const room = getRoom(roomId);

    pruneExpired(room);

    await uploadRawJson(historyPublicId(roomId), {
      version: 4,
      room: cleanRoom(roomId),
      seq: Math.max(0, Number(room.seq) || 0),
      retentionDays: RETENTION_DAYS,
      savedAtUnixMs: nowMs(),
      messages: room.messages,
    });
  }

  function enqueueRoomSave(roomId) {
    const room = getRoom(roomId);

    room.writeChain = room.writeChain
      .catch(() => {})
      .then(() => saveRoomNow(roomId));

    return room.writeChain;
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
        replyToName: "",
        replyToPreview: "",
      };
    }

    const room = await ensureRoomLoaded(roomId);
    const original = findMessage(room, id);

    if (!original) {
      return {
        replyToId: "",
        replyToName: "",
        replyToPreview: "",
      };
    }

    return {
      replyToId: original.id,
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
      replyToName: (reply && reply.replyToName) || "",
      replyToPreview: (reply && reply.replyToPreview) || "",
    };
  }

  async function pushMessage(roomId, message) {
    const room = await ensureRoomLoaded(roomId);

    pruneExpired(room);

    room.seq += 1;
    message.seq = room.seq;
    room.messages.push(message);

    // لا يوجد حذف بسبب عدد الرسائل.
    // الحذف الوحيد من السيرفر هو عمر 30 يوماً.
    await enqueueRoomSave(roomId);

    return message;
  }

  // ==========================================================================
  // CLOUDINARY MEDIA
  // ==========================================================================

  function uniqueMediaPublicId(playFabId) {
    return `${safeString(playFabId, 80)}_${Date.now()}_${crypto
      .randomBytes(5)
      .toString("hex")}`;
  }

  function getModerationEntry(uploadResult, kind) {
    const moderation =
      uploadResult && Array.isArray(uploadResult.moderation)
        ? uploadResult.moderation
        : [];

    for (const item of moderation) {
      if (!item || typeof item !== "object") continue;

      if (
        String(item.kind || "")
          .trim()
          .toLowerCase() === String(kind || "").trim().toLowerCase()
      ) {
        return item;
      }
    }

    return null;
  }

  function getModerationStatus(uploadResult, kind) {
    const entry = getModerationEntry(uploadResult, kind);

    return entry
      ? String(entry.status || "")
          .trim()
          .toLowerCase()
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

    // لا نعيدها إلى Unity. نستخدمها فقط للـLogs الداخلية.
    return entry.response.moderation_labels.slice(0, 20);
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

  // ==========================================================================
  // IMAGE UPLOAD + AMAZON REKOGNITION MODERATION
  //
  // مهم:
  // - لا نثق بمجرد نجاح الرفع.
  // - لا نرجع URL ولا ننشر رسالة إلا إذا aws_rek = approved.
  // - rejected / pending / missing = رفض مغلق Fail Closed.
  // ==========================================================================

  function uploadImageBuffer(buffer, playFabId) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "image",
          folder: IMAGE_FOLDER,
          public_id: uniqueMediaPublicId(playFabId),
          overwrite: false,
          format: "jpg",

          // هذه هي حماية الصور:
          moderation: IMAGE_MODERATION_KIND,
        },
        async (error, result) => {
          if (error) {
            return reject(error);
          }

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

          // لا نعتمد الصورة إلا عند approved بشكل صريح.
          if (moderationStatus !== "approved") {
            await destroyCloudinaryAsset(publicId, "image");

            if (moderationStatus === "rejected") {
              return reject(
                makeChatError(
                  "IMAGE_MODERATION_REJECTED",
                  "image_moderation_rejected",
                  {
                    moderationStatus,
                  }
                )
              );
            }

            return reject(
              makeChatError(
                "IMAGE_MODERATION_NOT_APPROVED",
                "image_moderation_not_approved",
                {
                  moderationStatus: moderationStatus || "missing",
                }
              )
            );
          }

          if (!result.secure_url) {
            await destroyCloudinaryAsset(publicId, "image");

            return reject(
              makeChatError(
                "IMAGE_UPLOAD_NO_URL",
                "cloudinary_image_no_url"
              )
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

  // ==========================================================================
  // VIDEO UPLOAD
  //
  // هذه النسخة تبقي الفيديو بالنظام السابق فقط.
  // سنضيف aws_rek_video + pending + webhook في الخطوة التالية.
  // ==========================================================================

  function uploadVideoBuffer(buffer, playFabId) {
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "video",
          folder: VIDEO_FOLDER,
          public_id: uniqueMediaPublicId(playFabId),
          overwrite: false,
        },
        (error, result) => {
          if (error) return reject(error);

          if (!result || !result.secure_url) {
            return reject(new Error("cloudinary_no_url"));
          }

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
          });
        }
      );

      stream.end(buffer);
    });
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

          if (Array.isArray(parsed)) {
            loaded = parsed;
          } else if (parsed && Array.isArray(parsed.reports)) {
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

  async function createReport(reporterId, roomId, message, reason) {
    await loadReports();

    const existing = reports.find(
      (report) =>
        report &&
        report.reporterId === reporterId &&
        report.messageId === message.id
    );

    if (existing) {
      return {
        report: existing,
        duplicate: true,
      };
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

      mediaType:
        kind === "image" || kind === "video" ? kind : "",

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
      replyToName: safeString(message.replyToName, 64),
      replyToPreview: safeString(message.replyToPreview, 120),

      reason: cleanReason(reason) || "بلاغ من داخل الشات",
    };

    reports.push(report);

    if (reports.length > MAX_REPORTS_IN_KEY) {
      reports = reports.slice(-MAX_REPORTS_IN_KEY);
    }

    await saveReports();

    return {
      report,
      duplicate: false,
    };
  }

  // ==========================================================================
  // HISTORY
  // ==========================================================================

  app.post("/chat/messages", async (req, res) => {
    try {
      await authenticateSessionTicket(req.body && req.body.sessionTicket);

      const roomId = cleanRoom(req.body && req.body.room);
      const afterSeq = Math.max(0, Number(req.body && req.body.afterSeq) || 0);

      const limit = Math.min(
        MAX_FETCH_LIMIT,
        Math.max(1, Number(req.body && req.body.limit) || 50)
      );

      const room = await ensureRoomLoaded(roomId);

      if (pruneExpired(room)) {
        await enqueueRoomSave(roomId);
      }

      let messages;

      if (afterSeq > 0) {
        messages = room.messages
          .filter((message) => message.seq > afterSeq)
          .slice(0, limit);
      } else {
        messages = room.messages.slice(
          Math.max(0, room.messages.length - limit)
        );
      }

      res.json({
        ok: true,
        messages,
        latestSeq: room.seq,
        retentionDays: RETENTION_DAYS,
      });
    } catch (error) {
      console.error("/chat/messages", error);

      res.status(500).json({
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

      const room = await ensureRoomLoaded(roomId);

      // نفحص Retry قبل Rate Limit حتى ترجع نفس الرسالة بدلاً من 429.
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

      // Force refresh حتى أي تغيير اسم/صورة يظهر في أول رسالة جديدة مباشرة.
      const profile = await getPlayerProfile(playFabId, true);

      const reply = await replySnapshot(
        roomId,
        req.body && req.body.replyToMessageId
      );

      const message = makeMessage({
        roomId,
        senderId: playFabId,
        profile,
        kind: "text",
        reply,
        clientMessageId,
      });

      message.text = text;

      await pushMessage(roomId, message);

      res.json({
        ok: true,
        message,
      });
    } catch (error) {
      console.error("/chat/send", error);

      res.status(500).json({
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

        const room = await ensureRoomLoaded(roomId);

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

        const message = makeMessage({
          roomId,
          senderId: playFabId,
          profile,
          kind: "voice",
          reply,
          clientMessageId,
        });

        message.voiceUrl = uploaded.url;
        message.voiceDuration = duration;

        await pushMessage(roomId, message);

        res.json({
          ok: true,
          message,
        });
      } catch (error) {
        console.error("/chat/voice", error);

        res.status(500).json({
          ok: false,
          error: "تعذر رفع الملاحظة الصوتية",
        });
      }
    }
  );

  // ==========================================================================
  // SEND IMAGE / VIDEO
  //
  // POST multipart/form-data /chat/media
  // fields:
  // sessionTicket
  // room
  // clientMessageId
  // mediaType = image | video
  // replyToMessageId
  // media = binary
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

        const room = await ensureRoomLoaded(roomId);

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

        let uploaded;

        if (requestedType === "image") {
          // uploadImageBuffer لن يرجع نجاح إلا عند approved.
          uploaded = await uploadImageBuffer(req.file.buffer, playFabId);
        } else {
          uploaded = await uploadVideoBuffer(req.file.buffer, playFabId);
        }

        // حماية إضافية:
        // حتى لو تغير uploadImageBuffer لاحقًا بالخطأ، لا ننشر صورة
        // بدون approved صريح.
        if (
          requestedType === "image" &&
          String(uploaded && uploaded.moderationStatus || "")
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

        const message = makeMessage({
          roomId,
          senderId: playFabId,
          profile,
          kind: requestedType,
          reply,
          clientMessageId,
        });

        message.mediaType = requestedType;
        message.mediaUrl = safeString(uploaded.url, 1600);
        message.mediaThumbnailUrl = safeString(uploaded.thumbnailUrl, 1600);
        message.mediaFileName = sanitizeFileName(
          req.file.originalname,
          requestedType === "image" ? "chat_image.jpg" : "chat_video.mp4"
        );

        // لا تصل الصورة إلى هنا إلا بعد approved.
        await pushMessage(roomId, message);

        res.json({
          ok: true,
          message,
        });
      } catch (error) {
        console.error("/chat/media", error);

        // رفض محتوى الصورة من Amazon Rekognition.
        if (error && error.code === "IMAGE_MODERATION_REJECTED") {
          return res.status(422).json({
            ok: false,
            moderationRejected: true,
            error: "تم رفض الصورة لأنها تخالف قوانين الشات",
          });
        }

        // الحماية لم ترجع approved: لا ننشر الصورة احتياطًا.
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

        res.status(500).json({
          ok: false,
          error: "تعذر رفع الصورة أو الفيديو",
        });
      }
    }
  );

  // ==========================================================================
  // REPORT MESSAGE
  //
  // POST /chat/report
  // {
  //   sessionTicket,
  //   room,
  //   messageId,
  //   reason
  // }
  //
  // لا نثق بمحتوى الرسالة القادم من Unity.
  // نأخذ النسخة الأصلية من تاريخ السيرفر بواسطة messageId.
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

      const room = await ensureRoomLoaded(roomId);

      if (pruneExpired(room)) {
        await enqueueRoomSave(roomId);
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

      res.json({
        ok: true,
        duplicate: result.duplicate,
        reportId: result.report.reportId,
        reportKey: REPORTS_KEY,
      });
    } catch (error) {
      console.error("/chat/report", error);

      res.status(500).json({
        ok: false,
        error: "تعذر إرسال البلاغ",
      });
    }
  });

  // ==========================================================================
  // READY LOG
  // ==========================================================================

  console.log("[LuxuryChat] installed", {
    version: 4,
    imageModeration: IMAGE_MODERATION_KIND,
    imageModerationFailClosed: true,
    videoModeration: "not-yet-enabled-step-2",
    persistentHistory: "Cloudinary raw JSON",
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
      "/chat/report",
    ],
  });
};

