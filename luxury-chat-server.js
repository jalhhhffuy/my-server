"use strict";

// ============================================================================
// Luxury Chat Server - V5
// Persistent 30 Days + Text + Voice + Image + Video + Reports + Avatar/Profile
// IMAGE + VIDEO MODERATION: Amazon Rekognition via Cloudinary
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
// - الفيديو يرفع أولاً كملف Pending ولا يدخل تاريخ الشات قبل الموافقة.
// - فيديوهات الشات تمر على Amazon Rekognition Video Moderation (aws_rek_video).
// - Cloudinary يرسل نتيجة الفيديو إلى Webhook موقع ومتحقق منه.
// - approved: ينشئ السيرفر رسالة الفيديو الحقيقية ويضيفها للشات.
// - rejected: يحذف السيرفر الفيديو ويحفظ حالة الرفض مؤقتاً حتى يعرف Unity النتيجة.
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

  // Amazon Rekognition Video Moderation.
  const VIDEO_MODERATION_KIND = "aws_rek_video";

  // رابط السيرفر العام المستخدم في notification_url.
  const PUBLIC_SERVER_URL =
    String(
      process.env.CHAT_PUBLIC_SERVER_URL ||
        process.env.PUBLIC_SERVER_URL ||
        "https://my-server-i40i.onrender.com"
    )
      .trim()
      .replace(/\/+$/, "");

  const VIDEO_MODERATION_WEBHOOK_PATH =
    "/chat/video-moderation-webhook";

  const VIDEO_MODERATION_WEBHOOK_URL =
    `${PUBLIC_SERVER_URL}${VIDEO_MODERATION_WEBHOOK_PATH}`;

  // ملف داخلي مشفر لحالات الفيديو المعلقة حتى لا تضيع عند Restart في Render.
  const VIDEO_JOBS_PUBLIC_ID =
    "luxury_chat_video_pending/video_jobs_v1.json";

  // نحتفظ بنتائج pending/rejected/approved مؤقتاً حتى Unity يقدر يسأل عن الحالة.
  const VIDEO_JOB_RETENTION_MS =
    24 * 60 * 60 * 1000;

  // توقيع Cloudinary Webhook يحتاج API secret على السيرفر فقط.
  const CLOUDINARY_API_SECRET =
    String(process.env.CLOUDINARY_API_SECRET || "").trim();

  // نقبل Webhook حديث فقط. Cloudinary نفسه يوصي بفحص حد زمني معقول.
  const CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS =
    2 * 60 * 60;

  // /chat/video-status لا يضرب Admin API مع كل Poll.
  // الـWebhook هو الأساس، وهذا فحص احتياطي فقط كل 30 ثانية لكل فيديو.
  const VIDEO_STATUS_FALLBACK_CHECK_MS =
    30 * 1000;

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


  // Video moderation jobs.
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


  // ==========================================================================
  // VIDEO MODERATION JOB PERSISTENCE
  //
  // نحفظ jobs في Cloudinary Raw JSON ولكن المحتوى نفسه AES-256-GCM مشفر.
  // هذا يمنع ظهور PlayFabId / reply snapshot / URLs كنص واضح لو عُرف رابط الملف.
  // ==========================================================================

  function videoJobsUrl() {
    const base = cloudinary.url(VIDEO_JOBS_PUBLIC_ID, {
      resource_type: "raw",
      type: "upload",
      secure: true,
    });

    return `${base}${base.includes("?") ? "&" : "?"}ts=${nowMs()}`;
  }

  function getVideoJobsCryptoKey() {
    if (!CLOUDINARY_API_SECRET) {
      throw new Error("CLOUDINARY_API_SECRET missing for video jobs encryption");
    }

    return crypto
      .createHash("sha256")
      .update(
        `luxury-chat-video-jobs-v1|${CLOUDINARY_API_SECRET}`,
        "utf8"
      )
      .digest();
  }

  function encryptVideoJobsPayload(object) {
    const iv = crypto.randomBytes(12);
    const key = getVideoJobsCryptoKey();
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const plain = Buffer.from(JSON.stringify(object), "utf8");
    const encrypted = Buffer.concat([
      cipher.update(plain),
      cipher.final(),
    ]);

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

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      iv
    );

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

    if (!jobId || !publicId || !senderId || !clientMessageId) {
      return null;
    }

    const profileRaw =
      raw.profile && typeof raw.profile === "object"
        ? raw.profile
        : {};

    const replyRaw =
      raw.reply && typeof raw.reply === "object"
        ? raw.reply
        : {};

    return {
      jobId,
      publicId,
      senderId,
      roomId,
      clientMessageId,

      status: safeString(raw.status, 30) || "pending",
      moderationStatus:
        safeString(raw.moderationStatus, 30) || "pending",

      createdAtUnixMs:
        Math.max(0, Number(raw.createdAtUnixMs) || 0) || nowMs(),

      updatedAtUnixMs:
        Math.max(0, Number(raw.updatedAtUnixMs) || 0) || nowMs(),

      uploadCompleted: !!raw.uploadCompleted,

      lastCloudinaryCheckUnixMs:
        Math.max(0, Number(raw.lastCloudinaryCheckUnixMs) || 0),

      mediaUrl: safeString(raw.mediaUrl, 1600),
      mediaThumbnailUrl:
        safeString(raw.mediaThumbnailUrl, 1600),

      mediaFileName:
        safeString(raw.mediaFileName, 180) || "chat_video.mp4",

      rejectReason:
        safeString(raw.rejectReason, 300),

      messageId:
        safeString(raw.messageId, 100),

      profile: {
        playerName:
          safeString(profileRaw.playerName, 64) || "لاعب",

        avatarUrl:
          safeString(profileRaw.avatarUrl, 1000),

        avatarVersion:
          safeString(profileRaw.avatarVersion, 100) || "0",
      },

      reply: {
        replyToId:
          safeString(replyRaw.replyToId, 100),

        replyToName:
          safeString(replyRaw.replyToName, 64),

        replyToPreview:
          safeString(replyRaw.replyToPreview, 120),
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

      const updated =
        Math.max(0, Number(job.updatedAtUnixMs) || 0);

      // فقط النتائج النهائية القديمة نحذف سجلها.
      // pending لا نحذفه هنا حتى لا نفقد نتيجة Webhook متأخرة.
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
      videoJobs.clear();
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

    const source =
      decoded && Array.isArray(decoded.jobs)
        ? decoded.jobs
        : [];

    videoJobs.clear();

    for (const raw of source) {
      const job = normalizeVideoJob(raw);
      if (!job) continue;

      videoJobs.set(job.publicId, job);
    }

    videoJobsLoaded = true;

    if (pruneVideoJobsInMemory()) {
      await enqueueVideoJobsSave();
    }

    return videoJobs;
  }

  async function ensureVideoJobsLoaded() {
    if (videoJobsLoaded) return videoJobs;
    if (videoJobsLoadPromise) return videoJobsLoadPromise;

    videoJobsLoadPromise = loadVideoJobsFromStorage()
      .then((result) => {
        videoJobsLoadPromise = null;
        return result;
      })
      .catch((error) => {
        videoJobsLoadPromise = null;
        videoJobsLoaded = false;
        throw error;
      });

    return videoJobsLoadPromise;
  }

  async function saveVideoJobsNow() {
    pruneVideoJobsInMemory();

    const payload = {
      version: 1,
      savedAtUnixMs: nowMs(),
      jobs: Array.from(videoJobs.values()),
    };

    const encrypted = encryptVideoJobsPayload(payload);

    await uploadRawJson(
      VIDEO_JOBS_PUBLIC_ID,
      encrypted
    );
  }

  function enqueueVideoJobsSave() {
    videoJobsWriteChain = videoJobsWriteChain
      .catch(() => {})
      .then(() => saveVideoJobsNow());

    return videoJobsWriteChain;
  }

  function findVideoJobByClient(
    senderId,
    clientMessageId
  ) {
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

    if (
      text.includes("violence") ||
      text.includes("visually_disturbing")
    ) {
      return "تم رفض الفيديو لأنه يحتوي على محتوى عنيف أو مزعج";
    }

    if (
      text.includes("rude_gestures") ||
      text.includes("hate_symbols")
    ) {
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

  function getDeepModerationStatus(value) {
    if (!value || typeof value !== "object") return "";

    const directCandidates = [
      value.moderation_status,
      value.moderationStatus,
    ];

    for (const candidate of directCandidates) {
      const status =
        String(candidate || "")
          .trim()
          .toLowerCase();

      if (
        status === "approved" ||
        status === "rejected" ||
        status === "pending"
      ) {
        return status;
      }
    }

    const entry = getModerationEntry(
      value,
      VIDEO_MODERATION_KIND
    );

    if (entry) {
      const status =
        String(entry.status || "")
          .trim()
          .toLowerCase();

      if (status) return status;
    }

    for (const child of Object.values(value)) {
      if (
        child &&
        typeof child === "object"
      ) {
        const nested = getDeepModerationStatus(child);
        if (nested) return nested;
      }
    }

    return "";
  }

  async function getVideoModerationResource(publicId) {
    return await cloudinary.api.resource(
      publicId,
      {
        resource_type: "video",
        type: "upload",
        moderations: true,
      }
    );
  }

  async function finalizeApprovedVideoJob(
    job,
    moderationSource
  ) {
    if (!job) return null;

    job.moderationStatus = "approved";
    job.updatedAtUnixMs = nowMs();

    // لو وصل Webhook قبل انتهاء callback الرفع، ننتظر.
    if (
      !job.uploadCompleted ||
      !job.mediaUrl
    ) {
      job.status = "pending";
      await enqueueVideoJobsSave();
      return null;
    }

    const room =
      await ensureRoomLoaded(job.roomId);

    const duplicate =
      findClientMessage(
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
        clientMessageId:
          job.clientMessageId,
      });

      message.mediaType = "video";
      message.mediaUrl =
        safeString(job.mediaUrl, 1600);

      message.mediaThumbnailUrl =
        safeString(
          job.mediaThumbnailUrl,
          1600
        );

      message.mediaFileName =
        safeString(
          job.mediaFileName,
          180
        ) || "chat_video.mp4";

      await pushMessage(
        job.roomId,
        message
      );
    }

    job.status = "approved";
    job.rejectReason = "";
    job.messageId =
      message && message.id
        ? message.id
        : job.messageId;

    job.updatedAtUnixMs = nowMs();

    await enqueueVideoJobsSave();

    console.log(
      "[LuxuryChat][VIDEO_MODERATION][APPROVED]",
      {
        publicId: job.publicId,
        senderId: job.senderId,
        clientMessageId:
          job.clientMessageId,
        messageId: job.messageId,
      }
    );

    return message;
  }

  async function finalizeRejectedVideoJob(
    job,
    moderationSource
  ) {
    if (!job) return;

    job.status = "rejected";
    job.moderationStatus = "rejected";
    job.rejectReason =
      buildVideoRejectReason(
        moderationSource
      );

    job.updatedAtUnixMs = nowMs();

    await destroyCloudinaryAsset(
      job.publicId,
      "video"
    );

    await enqueueVideoJobsSave();

    console.log(
      "[LuxuryChat][VIDEO_MODERATION][REJECTED]",
      {
        publicId: job.publicId,
        senderId: job.senderId,
        clientMessageId:
          job.clientMessageId,
        reason: job.rejectReason,
      }
    );
  }

  async function applyVideoModerationResult(
    publicId,
    fallbackBody
  ) {
    await ensureVideoJobsLoaded();

    const id = safeString(publicId, 500);
    if (!id) return { status: "ignored" };

    const job = videoJobs.get(id);

    if (!job) {
      console.warn(
        "[LuxuryChat][VIDEO_MODERATION] job not found",
        id
      );

      return {
        status: "job_not_found",
      };
    }

    // الـWebhook موقع من Cloudinary، لذلك إذا حمل نتيجة نهائية
    // نستخدمها مباشرة بدون Admin API إضافي.
    let source =
      fallbackBody || {};

    let status =
      getDeepModerationStatus(source);

    if (
      status !== "approved" &&
      status !== "rejected"
    ) {
      let resource = null;

      try {
        resource =
          await getVideoModerationResource(id);

        job.lastCloudinaryCheckUnixMs =
          nowMs();
      } catch (error) {
        console.warn(
          "[LuxuryChat][VIDEO_MODERATION] Admin API read failed",
          {
            publicId: id,
            error:
              error && error.message
                ? error.message
                : error,
          }
        );
      }

      if (resource) {
        source = resource;
        status =
          getDeepModerationStatus(resource);
      }
    }

    if (status === "approved") {
      await finalizeApprovedVideoJob(
        job,
        source
      );

      return {
        status: "approved",
      };
    }

    if (status === "rejected") {
      await finalizeRejectedVideoJob(
        job,
        source
      );

      return {
        status: "rejected",
      };
    }

    job.status = "pending";
    job.moderationStatus =
      status || "pending";

    job.updatedAtUnixMs = nowMs();

    await enqueueVideoJobsSave();

    return {
      status: "pending",
    };
  }

  function verifyCloudinaryWebhook(req) {
    const signature =
      String(
        req.headers["x-cld-signature"] ||
          ""
      )
        .trim()
        .replace(/^sha1=/i, "")
        .replace(/^sha256=/i, "");

    const timestampRaw =
      String(
        req.headers["x-cld-timestamp"] ||
          ""
      ).trim();

    const timestamp =
      Number(timestampRaw);

    const rawBody =
      typeof req.rawBody === "string"
        ? req.rawBody
        : "";

    if (
      !signature ||
      !timestampRaw ||
      !Number.isFinite(timestamp) ||
      !rawBody ||
      !CLOUDINARY_API_SECRET
    ) {
      return false;
    }

    const nowSeconds =
      Math.floor(Date.now() / 1000);

    if (
      Math.abs(nowSeconds - timestamp) >
      CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS
    ) {
      return false;
    }

    const algorithm =
      signature.length === 64
        ? "sha256"
        : "sha1";

    const expected =
      crypto
        .createHash(algorithm)
        .update(
          rawBody +
            timestampRaw +
            CLOUDINARY_API_SECRET,
          "utf8"
        )
        .digest("hex");

    const a = Buffer.from(
      expected,
      "utf8"
    );

    const b = Buffer.from(
      signature,
      "utf8"
    );

    if (a.length !== b.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      a,
      b
    );
  }

  function extractWebhookPublicId(body) {
    if (!body || typeof body !== "object") {
      return "";
    }

    const direct =
      safeString(body.public_id, 500);

    if (direct) return direct;

    for (const child of Object.values(body)) {
      if (
        child &&
        typeof child === "object"
      ) {
        const nested =
          extractWebhookPublicId(child);

        if (nested) return nested;
      }
    }

    return "";
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
      version: 5,
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
    let moderation = [];

    if (uploadResult && Array.isArray(uploadResult.moderation)) {
      moderation = uploadResult.moderation;
    } else if (uploadResult && Array.isArray(uploadResult.moderations)) {
      moderation = uploadResult.moderations;
    }

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
  // VIDEO UPLOAD + AMAZON REKOGNITION VIDEO MODERATION
  //
  // الرفع يرجع عادة pending لأن الفحص غير متزامن.
  // لا ننشر رسالة الفيديو هنا.
  // ==========================================================================

  function uploadVideoBuffer(
    buffer,
    playFabId,
    forcedPublicId
  ) {
    return new Promise((resolve, reject) => {
      const publicId =
        safeString(forcedPublicId, 500) ||
        `${VIDEO_FOLDER}/${uniqueMediaPublicId(playFabId)}`;

      const stream =
        cloudinary.uploader.upload_stream(
          {
            resource_type: "video",

            // لأن publicId هنا يحتوي المجلد بالفعل.
            public_id: publicId,

            overwrite: false,

            moderation:
              VIDEO_MODERATION_KIND,

            notification_url:
              VIDEO_MODERATION_WEBHOOK_URL,
          },
          (error, result) => {
            if (error) {
              return reject(error);
            }

            if (
              !result ||
              !result.public_id ||
              !result.secure_url
            ) {
              return reject(
                makeChatError(
                  "VIDEO_UPLOAD_NO_RESULT",
                  "cloudinary_video_no_result"
                )
              );
            }

            const moderationStatus =
              getModerationStatus(
                result,
                VIDEO_MODERATION_KIND
              ) ||
              getDeepModerationStatus(
                result
              ) ||
              "pending";

            const thumb =
              cloudinary.url(
                result.public_id,
                {
                  resource_type:
                    "video",

                  type:
                    "upload",

                  secure:
                    true,

                  format:
                    "jpg",

                  transformation: [
                    {
                      width: 700,
                      height: 394,
                      crop: "limit",
                      quality:
                        "auto:good",
                    },
                  ],
                }
              );

            resolve({
              url:
                result.secure_url,

              thumbnailUrl:
                thumb || "",

              publicId:
                result.public_id || "",

              moderationStatus:
                String(
                  moderationStatus ||
                    "pending"
                )
                  .trim()
                  .toLowerCase(),

              raw:
                result,
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
  // CLOUDINARY VIDEO MODERATION WEBHOOK
  //
  // Cloudinary يرسل النتيجة هنا بعد انتهاء aws_rek_video.
  // التوقيع يعتمد على req.rawBody، لذلك server.js يجب أن يحتفظ به
  // داخل express.json({ verify: ... }).
  // ==========================================================================

  app.post(
    VIDEO_MODERATION_WEBHOOK_PATH,
    async (req, res) => {
      try {
        if (!verifyCloudinaryWebhook(req)) {
          console.warn(
            "[LuxuryChat][VIDEO_WEBHOOK] invalid signature"
          );

          return res
            .status(401)
            .json({
              ok: false,
              error:
                "invalid_cloudinary_signature",
            });
        }

        const publicId =
          extractWebhookPublicId(
            req.body
          );

        if (!publicId) {
          console.warn(
            "[LuxuryChat][VIDEO_WEBHOOK] public_id missing"
          );

          // الطلب موقع من Cloudinary لكن ليس نتيجة نحتاجها.
          return res.json({
            ok: true,
            ignored: true,
          });
        }

        const result =
          await applyVideoModerationResult(
            publicId,
            req.body
          );

        return res.json({
          ok: true,
          publicId,
          status:
            result &&
            result.status
              ? result.status
              : "pending",
        });
      } catch (error) {
        console.error(
          "[LuxuryChat][VIDEO_WEBHOOK]",
          error
        );

        return res
          .status(500)
          .json({
            ok: false,
            error:
              "video_moderation_webhook_failed",
          });
      }
    }
  );

  // ==========================================================================
  // VIDEO STATUS FOR UNITY
  //
  // Unity سيستخدمه بعد رفع الفيديو:
  // pending  -> "جاري فحص الفيديو..."
  // approved -> يحذف الفقاعة المؤقتة ويعرض الرسالة الحقيقية من History
  // rejected -> يعرض rejectReason عند المرسل فقط
  // ==========================================================================

  app.post(
    "/chat/video-status",
    async (req, res) => {
      try {
        const playFabId =
          await authenticateSessionTicket(
            req.body &&
              req.body.sessionTicket
          );

        const clientMessageId =
          cleanClientMessageId(
            req.body &&
              req.body.clientMessageId
          );

        if (!clientMessageId) {
          return res
            .status(400)
            .json({
              ok: false,
              error:
                "clientMessageId مطلوب",
            });
        }

        await ensureVideoJobsLoaded();

        const job =
          findVideoJobByClient(
            playFabId,
            clientMessageId
          );

        if (!job) {
          return res
            .status(404)
            .json({
              ok: false,
              status:
                "not_found",
              error:
                "حالة الفيديو غير موجودة",
            });
        }

        // احتياط: لو ضاع Webhook لكن Cloudinary أنهى الفحص،
        // نتحقق من المصدر الحقيقي عند كل استعلام pending.
        if (
          (job.status === "pending" ||
            job.status === "uploading") &&
          nowMs() -
              Number(
                job.lastCloudinaryCheckUnixMs ||
                  0
              ) >=
            VIDEO_STATUS_FALLBACK_CHECK_MS
        ) {
          try {
            await applyVideoModerationResult(
              job.publicId,
              null
            );
          } catch (error) {
            console.warn(
              "[LuxuryChat][VIDEO_STATUS] refresh failed",
              error &&
              error.message
                ? error.message
                : error
            );
          }
        }

        const fresh =
          videoJobs.get(
            job.publicId
          ) || job;

        return res.json({
          ok: true,

          clientMessageId:
            fresh.clientMessageId,

          status:
            fresh.status,

          moderationStatus:
            fresh.moderationStatus,

          rejectReason:
            fresh.status ===
            "rejected"
              ? fresh.rejectReason
              : "",

          messageId:
            fresh.status ===
            "approved"
              ? fresh.messageId
              : "",
        });
      } catch (error) {
        console.error(
          "/chat/video-status",
          error
        );

        return res
          .status(500)
          .json({
            ok: false,
            error:
              "تعذر قراءة حالة الفيديو",
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

        // ================================================================
        // VIDEO:
        // لا ننشئ Message عامة الآن.
        // نحفظ Job ثم نرفع الفيديو مع aws_rek_video.
        // ================================================================

        if (requestedType === "video") {
          await ensureVideoJobsLoaded();

          const effectiveClientMessageId =
            clientMessageId ||
            `video_${crypto.randomUUID()}`;

          const existingJob =
            findVideoJobByClient(
              playFabId,
              effectiveClientMessageId
            );

          if (existingJob) {
            return res.json({
              ok: true,
              pending:
                existingJob.status !==
                  "approved" &&
                existingJob.status !==
                  "rejected",

              status:
                existingJob.status,

              moderationStatus:
                existingJob.moderationStatus,

              clientMessageId:
                existingJob.clientMessageId,

              rejectReason:
                existingJob.status ===
                "rejected"
                  ? existingJob.rejectReason
                  : "",

              messageId:
                existingJob.status ===
                "approved"
                  ? existingJob.messageId
                  : "",
            });
          }

          const videoPublicId =
            `${VIDEO_FOLDER}/${uniqueMediaPublicId(playFabId)}`;

          const job = {
            jobId:
              crypto.randomUUID(),

            publicId:
              videoPublicId,

            senderId:
              safeString(
                playFabId,
                100
              ),

            roomId:
              cleanRoom(roomId),

            clientMessageId:
              effectiveClientMessageId,

            status:
              "uploading",

            moderationStatus:
              "pending",

            createdAtUnixMs:
              nowMs(),

            updatedAtUnixMs:
              nowMs(),

            uploadCompleted:
              false,

            lastCloudinaryCheckUnixMs:
              0,

            mediaUrl:
              "",

            mediaThumbnailUrl:
              "",

            mediaFileName:
              sanitizeFileName(
                req.file.originalname,
                "chat_video.mp4"
              ),

            rejectReason:
              "",

            messageId:
              "",

            profile: {
              playerName:
                safeString(
                  profile &&
                    profile.playerName,
                  64
                ) || "لاعب",

              avatarUrl:
                safeString(
                  profile &&
                    profile.avatarUrl,
                  1000
                ),

              avatarVersion:
                safeString(
                  profile &&
                    profile.avatarVersion,
                  100
                ) || "0",
            },

            reply: {
              replyToId:
                safeString(
                  reply &&
                    reply.replyToId,
                  100
                ),

              replyToName:
                safeString(
                  reply &&
                    reply.replyToName,
                  64
                ),

              replyToPreview:
                safeString(
                  reply &&
                    reply.replyToPreview,
                  120
                ),
            },
          };

          // نحفظ Job قبل Cloudinary حتى لو وصل Webhook بسرعة.
          videoJobs.set(
            videoPublicId,
            job
          );

          await enqueueVideoJobsSave();

          let uploadedVideo;

          try {
            uploadedVideo =
              await uploadVideoBuffer(
                req.file.buffer,
                playFabId,
                videoPublicId
              );
          } catch (error) {
            videoJobs.delete(
              videoPublicId
            );

            await enqueueVideoJobsSave();

            throw error;
          }

          job.uploadCompleted =
            true;

          job.mediaUrl =
            safeString(
              uploadedVideo.url,
              1600
            );

          job.mediaThumbnailUrl =
            safeString(
              uploadedVideo.thumbnailUrl,
              1600
            );

          job.moderationStatus =
            safeString(
              uploadedVideo.moderationStatus,
              30
            ) || "pending";

          job.status =
            job.moderationStatus ===
            "approved"
              ? "pending"
              : job.moderationStatus ===
                "rejected"
              ? "pending"
              : "pending";

          job.updatedAtUnixMs =
            nowMs();

          await enqueueVideoJobsSave();

          console.log(
            "[LuxuryChat][VIDEO_MODERATION][UPLOADED]",
            {
              publicId:
                job.publicId,

              senderId:
                job.senderId,

              clientMessageId:
                job.clientMessageId,

              moderationStatus:
                job.moderationStatus,

              webhook:
                VIDEO_MODERATION_WEBHOOK_URL,
            }
          );

          // لو Cloudinary أعطى نتيجة نهائية بسرعة نطبقها،
          // وإلا يظل pending حتى Webhook أو /chat/video-status.
          if (
            job.moderationStatus ===
              "approved" ||
            job.moderationStatus ===
              "rejected"
          ) {
            await applyVideoModerationResult(
              job.publicId,
              uploadedVideo.raw
            );
          }

          const fresh =
            videoJobs.get(
              job.publicId
            ) || job;

          return res.json({
            ok: true,

            pending:
              fresh.status !==
                "approved" &&
              fresh.status !==
                "rejected",

            status:
              fresh.status,

            moderationStatus:
              fresh.moderationStatus,

            clientMessageId:
              fresh.clientMessageId,

            rejectReason:
              fresh.status ===
              "rejected"
                ? fresh.rejectReason
                : "",

            messageId:
              fresh.status ===
              "approved"
                ? fresh.messageId
                : "",
          });
        }

        // ================================================================
        // IMAGE:
        // نفس حماية V4 بدون تغيير.
        // ================================================================

        const uploaded =
          await uploadImageBuffer(
            req.file.buffer,
            playFabId
          );

        if (
          String(
            uploaded &&
              uploaded.moderationStatus ||
              ""
          )
            .trim()
            .toLowerCase() !==
          "approved"
        ) {
          if (
            uploaded &&
            uploaded.publicId
          ) {
            await destroyCloudinaryAsset(
              uploaded.publicId,
              "image"
            );
          }

          return res
            .status(503)
            .json({
              ok: false,
              error:
                "تعذر اعتماد الصورة من نظام الحماية، حاول مرة أخرى",
            });
        }

        const message =
          makeMessage({
            roomId,
            senderId:
              playFabId,
            profile,
            kind:
              "image",
            reply,
            clientMessageId,
          });

        message.mediaType =
          "image";

        message.mediaUrl =
          safeString(
            uploaded.url,
            1600
          );

        message.mediaThumbnailUrl =
          safeString(
            uploaded.thumbnailUrl,
            1600
          );

        message.mediaFileName =
          sanitizeFileName(
            req.file.originalname,
            "chat_image.jpg"
          );

        await pushMessage(
          roomId,
          message
        );

        return res.json({
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

        if (
          error &&
          error.code === "VIDEO_UPLOAD_NO_RESULT"
        ) {
          return res.status(502).json({
            ok: false,
            error: "تعذر رفع الفيديو للفحص",
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
    version: 5,
    imageModeration: IMAGE_MODERATION_KIND,
    imageModerationFailClosed: true,
    videoModeration: VIDEO_MODERATION_KIND,
    videoModerationWebhook: VIDEO_MODERATION_WEBHOOK_URL,
    videoPendingPersistence: "Cloudinary encrypted raw JSON",
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
      "/chat/video-status",
      VIDEO_MODERATION_WEBHOOK_PATH,
      "/chat/report",
    ],
  });
};

