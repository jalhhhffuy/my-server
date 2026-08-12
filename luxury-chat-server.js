"use strict";

// ============================================================================
// Luxury Chat Server - V19 PRIVATE PRESENCE / READ ZERO / 24H PERSISTENT INDEX
// SERVER-AUTHORITATIVE PRIVATE INBOX + 24H CONVERSATION DELIVERY
// Cloudinary-Authoritative Persistent 30 Days
// Text + Voice + Image + Video + Reports + Avatar/Profile
// IMAGE + VIDEO MODERATION: Amazon Rekognition via Cloudinary
// Node 18+ / Express / multer / Cloudinary / PlayFab
//
// BUILD:
// 2026-08-11-LUXURY-CHAT-SERVER-V18-PRIVATE-24H-AUTH-TRACE-PAIR-INDEX
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
//
// أهم إصلاحات V13 فوق V12:
// - إصلاح نهائي لخطأ Unity:
//   JSON parse error: The surrogate pair in string is invalid.
// - تنظيف أي High Surrogate أو Low Surrogate تالف منفرد قبل إرساله إلى Unity.
// - الإيموجي الصحيح لا يتغير ولا يُحذف.
// - يسمح بعدة إيموجيات متتالية مثل 😂😂😂😂😂.
// - safeString لم يعد يستخدم slice على UTF-16 بطريقة قد تقطع الإيموجي من المنتصف.
// - cleanText أصبح ينظف UTF-16 قبل Intl.Segmenter.
// - messagePreview لم يعد يقطع Unicode من المنتصف.
// - كل JSON خارج من /chat يمر بطبقة حماية أخيرة قبل res.json.
// - كل JSON جديد يُحفظ في Cloudinary يمر بتنظيف Unicode.
// - PlayFab JSON والبلاغات وVideo Jobs أصبحت محمية من Surrogate تالف.
// - تاريخ Cloudinary القديم الذي يحتوي String تالف يمكن قراءته ثم تنظيفه قبل Unity.
// - لا نحذف الرسالة كاملة بسبب حرف UTF-16 تالف؛ نحذف فقط الوحدة التالفة.
// - نفس نظام V12 بالكامل بدون إزالة أنظمة الشات.
//
// إصلاح الخاص الحالي:
// - السيرفر نفسه أصبح يكتب Inbox للطرفين فور نجاح أي رسالة خاصة.
// - المستقبل يرى المحادثة في تبويب "خاص" وهو ما زال في العام، بدون فتح الغرفة أولاً.
// - كل رسالة خاصة واردة = Inbox Event مستقل، لذلك unreadCount يحسب عدد الرسائل فعلياً.
// - يدعم النص + الصوت + الصورة + الفيديو بعد اعتماد الفيديو.
// - يستخدم نفس __LPI1__ وصيغة clientMessageId الحالية في Unity لمنع التكرار.
// - عند Retry لن تتكرر المحادثة أو الرسالة في Inbox.
// - جلب inbox_ يجلب صور اللاعبين تلقائياً حتى لو Unity لم يطلب refreshProfiles.
// - في حدث "رسالتي" يعيد السيرفر Profile الطرف الآخر حتى تظهر صورته في قائمة المحادثات.
//
// V15 - نظام جديد لقائمة الخاص آخر 24 ساعة:
// - /chat/private-inbox يعيد ملخص المحادثات مباشرة، ولا يعتمد على آخر 100 رسالة.
// - آخر رسالة هي التي تعيد عداد 24 ساعة؛ بعد 24 ساعة بدون رسالة تختفي المحادثة.
// - يدعم حتى 2000 محادثة نشطة في الرد الواحد.
// - لا ينفذ مئات طلبات PlayFab عند كل Poll؛ الاسم والصورة يؤخذان من Inbox Events نفسها.
// - حدث المرسل على السيرفر يحمل Profile الطرف الآخر، لذلك الصورة تبقى صحيحة حتى لو المحادثة بدأت بإرسال فقط.
// - unreadCount يحسب من Inbox Events و Read Markers على السيرفر.
// - لا يغيّر تخزين الشات العام/القبيلة/الخاص ولا احتفاظ 30 يوماً.
//
// V16 - إصلاح اختفاء قائمة الخاص بعد إعادة فتح اللعبة:
// - أول طلب Inbox بعد تسجيل الدخول يستطيع Repair من غرف الخاص الحقيقية نفسها.
// - إذا كانت inbox_ ناقصة أو لم تكن موجودة في إصدار أقدم، نستخرج آخر نشاط خلال 24 ساعة
//   من Shards الخاصة الفعلية ونضمها إلى القائمة فوراً.
//
// V17 - الإصلاح النهائي لقائمة آخر 24 ساعة:
// - لا نعتمد على Runtime ولا على inbox_ وحده لكي تبقى المحادثة بعد إغلاق اللعبة.
// - لكل لاعب/طرف Marker مستقل دائم في Cloudinary داخل luxury_chat_private_index_v17.
// - أي رسالة خاصة ناجحة تحدث Marker للمرسل وMarker للمستقبل بنفس وقت آخر رسالة.
// - /chat/private-inbox يقرأ هذا الفهرس الدائم في كل مرة، ثم يدمجه مع inbox_ ومع Repair القديم.
// - المحادثات القديمة خلال آخر 24 ساعة يتم Backfill لها إلى الفهرس تلقائياً عند أول دخول.
// - لا يوجد ملف Inbox واحد مشترك يتم الكتابة فوقه؛ كل زوج لاعب/طرف له ملف مستقل.
//
// V19:
// - Presence من السيرفر: أخضر إذا وصل نشاط شات خلال آخر 35 ثانية، وإلا أحمر.
// - فتح المحادثة يثبت unreadCount=0 على السيرفر عبر /chat/private-inbox/read.
// - Snapshot يبقى مرتباً حسب أحدث lastActivityUnixMs، وأي رسالة جديدة ترفع المحادثة للأعلى.
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
    "2026-08-13-LUXURY-CHAT-SERVER-V21-INCREMENTAL-SERVER-RELATIONSHIPS";

  const TITLE_ID = String(process.env.PLAYFAB_TITLE_ID || "").trim();
  const SECRET_KEY = String(process.env.PLAYFAB_SECRET_KEY || "").trim();

  const REPORTS_KEY =
    String(process.env.CHAT_REPORTS_KEY || "LUXURY_CHAT_REPORTS").trim() ||
    "LUXURY_CHAT_REPORTS";

  const MAX_TEXT_LENGTH = 200;
  const MAX_FETCH_LIMIT = 100;
  const MAX_REACTION_FETCH_LIMIT = 600;

  const REACTION_REMOVE_TOKEN = "__LUXURY_CHAT_REACTION_REMOVE__";

  // نفس Tokens الموجودة في LuxuryPrivateChatManager الحالي.
  const PRIVATE_INBOX_EVENT_TOKEN = "__LPI1__";
  const PRIVATE_INBOX_READ_TOKEN = "__LPIR1__";

  const PRIVATE_INBOX_ACTIVE_HOURS = 24;
  const MAX_PRIVATE_INBOX_CONVERSATIONS = 2000;

  // V19: متصل إذا وصل من اللاعب طلب شات خلال آخر 35 ثانية.
  const PRIVATE_PRESENCE_ONLINE_WINDOW_MS =
    35 * 1000;

  // V16: إصلاح ذاتي من تاريخ غرف الخاص الفعلية.
  const PRIVATE_INBOX_REPAIR_CACHE_MS = 60 * 1000;
  const PRIVATE_INBOX_REPAIR_MAX_RESOURCES = 12000;
  const PRIVATE_INBOX_REPAIR_SCAN_DAYS = 3;
  const PRIVATE_INBOX_REPAIR_CONCURRENCY = 8;

  // V17: فهرس دائم مستقل لكل لاعب/طرف. هذا هو المصدر الأساسي لقائمة 24 ساعة.
  const PRIVATE_CONVERSATION_INDEX_FOLDER =
    "luxury_chat_private_index_v17";
  const PRIVATE_CONVERSATION_INDEX_SCHEMA = 17;
  const PRIVATE_CONVERSATION_INDEX_MAX_RESOURCES = 2500;
  const PRIVATE_CONVERSATION_INDEX_FETCH_CONCURRENCY = 12;

  const PRIVATE_INBOX_MIRROR_RETRY_DELAYS_MS = [
    0,
    140,
    420,
    900,
  ];

  const QUICK_REACTIONS = new Set([
    "👍",
    "😂",
    "❤",
    "❤️",
    "🔥",
    "👏",
    "😮",
    "😢",
  ]);

  const RETENTION_DAYS = 30;
  const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const MAX_REPORTS_IN_KEY = 500;

  const MAX_VOICE_BYTES = 12 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

  const PROFILE_CACHE_MS = 15 * 1000;
  const DIRECT_FETCH_TIMEOUT_MS = 15 * 1000;

  const TEXT_SEGMENTER =
    typeof Intl !== "undefined" &&
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("ar", {
          granularity: "grapheme",
        })
      : null;

  // نبقي نفس مجلد التاريخ حتى لا ننشئ تاريخ جديد منفصل.
  const HISTORY_FOLDER = "luxury_chat_history_v8";
  const LEGACY_HISTORY_FOLDER = "luxury_chat_history";

  const HISTORY_RENDER_INSTANCE_ID =
    String(process.env.RENDER_INSTANCE_ID || "local")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 64) || "local";

  const HISTORY_PROCESS_BOOT_ID =
    crypto.randomBytes(8).toString("hex");

  const HISTORY_INSTANCE_TOKEN =
    `${HISTORY_RENDER_INSTANCE_ID}_${process.pid}_${HISTORY_PROCESS_BOOT_ID}`
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 110);

  const VOICE_FOLDER = "chat_voice_notes";
  const IMAGE_FOLDER = "chat_media_images";
  const VIDEO_FOLDER = "chat_media_videos";

  const HISTORY_CACHE_SYNC_MS = 1500;

  const PRIVATE_RELATIONSHIP_STATE_KEY =
    "LUXURY_CHAT_PRIVATE_RELATIONSHIPS_V1";

  const HISTORY_SHARD_DISCOVERY_MS = Math.max(
    5000,
    Number(
      process.env.CHAT_HISTORY_SHARD_DISCOVERY_MS ||
        20000
    ) || 20000
  );

  const VIDEO_JOB_SHARD_DISCOVERY_MS = Math.max(
    5000,
    Number(
      process.env.CHAT_VIDEO_JOB_SHARD_DISCOVERY_MS ||
        20000
    ) || 20000
  );

  const HISTORY_READ_RETRY_DELAYS_MS = [
    0,
    160,
    420,
    900,
  ];

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

  const VIDEO_MODERATION_WEBHOOK_PATH =
    "/chat/video-moderation-webhook";

  const VIDEO_MODERATION_WEBHOOK_URL =
    `${PUBLIC_SERVER_URL}${VIDEO_MODERATION_WEBHOOK_PATH}`;

  const LEGACY_VIDEO_JOBS_PUBLIC_ID =
    "luxury_chat_video_pending/video_jobs_v1.json";

  const VIDEO_JOBS_FOLDER =
    "luxury_chat_video_pending_v9";

  const VIDEO_JOB_RETENTION_MS =
    24 * 60 * 60 * 1000;

  const CLOUDINARY_API_SECRET =
    String(
      process.env.CLOUDINARY_API_SECRET || ""
    ).trim();

  const CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS =
    2 * 60 * 60;

  const VIDEO_STATUS_FALLBACK_CHECK_MS =
    30 * 1000;

  const RATE_MAP_PRUNE_INTERVAL_MS =
    5 * 60 * 1000;

  const RATE_MAP_ENTRY_MAX_AGE_MS =
    30 * 60 * 1000;

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
    limits: {
      fileSize: MAX_VOICE_BYTES,
    },
  });

  const mediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_VIDEO_BYTES,
    },
  });

  function uploadSingleJson(
    uploadInstance,
    fieldName,
    tooLargeMessage
  ) {
    return function uploadMiddleware(
      req,
      res,
      next
    ) {
      uploadInstance.single(fieldName)(
        req,
        res,
        (error) => {
          if (!error)
            return next();

          if (
            error &&
            error.code === "LIMIT_FILE_SIZE"
          ) {
            return res.status(413).json({
              ok: false,
              error:
                tooLargeMessage ||
                "حجم الملف أكبر من الحد المسموح",
            });
          }

          console.error(
            `[LuxuryChat][UPLOAD][${fieldName}]`,
            error
          );

          return res.status(400).json({
            ok: false,
            error:
              "تعذر قراءة الملف المرفوع",
          });
        }
      );
    };
  }

  // ========================================================================
  // RUNTIME STATE
  // ========================================================================

  const rooms = new Map();
  const profileCache = new Map();

  // ownerPlayFabId(lowercase) -> { expires, promise, conversations }
  // Repair لا يعتمد على Runtime Unity؛ مصدره Cloudinary history الحقيقي.
  const privateInboxRepairCache = new Map();

  // V17: Cache قصير جداً للفهرس الدائم حتى لا نضرب Cloudinary كل 0.5 ثانية.
  // أي رسالة خاصة جديدة تمسح Cache للطرفين فوراً.
  const privateConversationIndexCache = new Map();
  const privateConversationIndexWriteChains = new Map();
  const PRIVATE_CONVERSATION_INDEX_CACHE_MS = 1500;

  // V19: Presence من السيرفر.
  const privatePresenceLastSeenUnixMs = new Map();

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
    return new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, ms || 0)
      )
    );
  }

  // ========================================================================
  // V13 - UTF-16 / SURROGATE PROTECTION
  //
  // Unity JsonUtility لا يقبل Lone Surrogate.
  //
  // صالح:
  // 😂 = High Surrogate + Low Surrogate
  //
  // تالف:
  // High Surrogate بدون Low
  // أو Low Surrogate بدون High
  //
  // لا نحذف الإيموجي الصحيح.
  // نحذف فقط UTF-16 unit التالفة.
  // ========================================================================

  function sanitizeUnicodeString(value) {
    const text =
      String(
        value === null ||
        value === undefined
          ? ""
          : value
      );

    if (!text)
      return "";

    let output = "";
    let changed = false;

    for (
      let i = 0;
      i < text.length;
      i++
    ) {
      const code =
        text.charCodeAt(i);

      // High surrogate.
      if (
        code >= 0xd800 &&
        code <= 0xdbff
      ) {
        if (
          i + 1 <
          text.length
        ) {
          const nextCode =
            text.charCodeAt(
              i + 1
            );

          if (
            nextCode >= 0xdc00 &&
            nextCode <= 0xdfff
          ) {
            output += text[i];
            output += text[i + 1];

            i++;

            continue;
          }
        }

        changed = true;
        continue;
      }

      // Lone Low surrogate.
      if (
        code >= 0xdc00 &&
        code <= 0xdfff
      ) {
        changed = true;
        continue;
      }

      output += text[i];
    }

    return changed
      ? output
      : text;
  }

  function truncateCodePointsSafe(
    value,
    maximumCharacters
  ) {
    const text =
      sanitizeUnicodeString(
        value
      );

    const maximum =
      Math.max(
        0,
        Number(
          maximumCharacters
        ) || 0
      );

    if (maximum <= 0)
      return "";

    const characters =
      Array.from(text);

    if (
      characters.length <=
      maximum
    ) {
      return text;
    }

    return characters
      .slice(
        0,
        maximum
      )
      .join("");
  }

  function sanitizeJsonForUnity(
    value,
    recursionStack
  ) {
    if (
      value === null ||
      value === undefined
    ) {
      return value;
    }

    if (
      typeof value ===
      "string"
    ) {
      return sanitizeUnicodeString(
        value
      );
    }

    if (
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return value;
    }

    if (
      typeof value !==
      "object"
    ) {
      return value;
    }

    if (
      Buffer.isBuffer(value)
    ) {
      return value;
    }

    const stack =
      recursionStack ||
      new WeakSet();

    if (stack.has(value)) {
      return null;
    }

    stack.add(value);

    try {
      if (
        Array.isArray(value)
      ) {
        const result = [];

        for (
          let i = 0;
          i < value.length;
          i++
        ) {
          result.push(
            sanitizeJsonForUnity(
              value[i],
              stack
            )
          );
        }

        return result;
      }

      const result = {};

      for (
        const key of
        Object.keys(value)
      ) {
        const safeKey =
          sanitizeUnicodeString(
            key
          );

        result[safeKey] =
          sanitizeJsonForUnity(
            value[key],
            stack
          );
      }

      return result;
    } finally {
      stack.delete(value);
    }
  }

  function safeJsonStringify(value) {
    return JSON.stringify(
      sanitizeJsonForUnity(
        value
      )
    );
  }

  // ========================================================================
  // FINAL UNITY RESPONSE GUARD
  //
  // مهم:
  // يوضع قبل تسجيل Routes.
  // كل res.json تحت /chat يمر عليه.
  // ========================================================================

  app.use(
    "/chat",
    (req, res, next) => {
      const originalJson =
        res.json.bind(res);

      res.json =
        function luxuryChatSafeJson(
          body
        ) {
          return originalJson(
            sanitizeJsonForUnity(
              body
            )
          );
        };

      next();
    }
  );

  async function fetchWithTimeout(
    url,
    options,
    timeoutMs =
      DIRECT_FETCH_TIMEOUT_MS
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () =>
          controller.abort(),
        Math.max(
          1000,
          timeoutMs
        )
      );

    try {
      return await fetch(
        url,
        {
          ...(options || {}),
          signal:
            controller.signal,
        }
      );
    } finally {
      clearTimeout(timer);
    }
  }

  function cleanRoom(value) {
    const room =
      String(
        value || "global"
      )
        .trim()
        .toLowerCase();

    return /^[a-z0-9_-]{1,40}$/.test(
      room
    )
      ? room
      : "global";
  }

  function truncateUnicode(
    value,
    maximumGraphemes
  ) {
    const text =
      sanitizeUnicodeString(
        value
      );

    if (
      !maximumGraphemes ||
      maximumGraphemes <= 0
    ) {
      return "";
    }

    if (TEXT_SEGMENTER) {
      const segments =
        Array.from(
          TEXT_SEGMENTER.segment(
            text
          ),
          (item) =>
            item.segment
        );

      if (
        segments.length <=
        maximumGraphemes
      ) {
        return text;
      }

      return segments
        .slice(
          0,
          maximumGraphemes
        )
        .join("");
    }

    const chars =
      Array.from(text);

    if (
      chars.length <=
      maximumGraphemes
    ) {
      return text;
    }

    return chars
      .slice(
        0,
        maximumGraphemes
      )
      .join("");
  }

  function cleanText(value) {
    const text =
      sanitizeUnicodeString(
        value
      )
        .replace(
          /\u0000/g,
          ""
        )
        .replace(
          /\r\n/g,
          "\n"
        )
        .replace(
          /\r/g,
          "\n"
        )
        .trim();

    return truncateUnicode(
      text,
      MAX_TEXT_LENGTH
    );
  }

  function cleanReason(value) {
    const text =
      sanitizeUnicodeString(
        value
      )
        .replace(
          /\u0000/g,
          ""
        )
        .replace(
          /[\r\n]+/g,
          " "
        )
        .trim();

    return truncateCodePointsSafe(
      text,
      300
    );
  }

  function safeString(
    value,
    max
  ) {
    const text =
      sanitizeUnicodeString(
        value
      ).trim();

    if (!max)
      return text;

    return truncateCodePointsSafe(
      text,
      max
    );
  }

  function cleanClientMessageId(
    value
  ) {
    return safeString(
      value,
      100
    );
  }

  function normalizeKind(value) {
    const kind =
      safeString(
        value || "text",
        30
      ).toLowerCase();

    if (kind === "voice")
      return "voice";

    if (kind === "image")
      return "image";

    if (kind === "video")
      return "video";

    return "text";
  }


  // ========================================================================
  // V19 - PRIVATE PRESENCE
  // ========================================================================

  function touchPrivatePresence(
    playFabId
  ) {
    const id =
      canonicalPrivatePlayerId(
        playFabId
      );

    if (!id)
      return 0;

    const seen =
      nowMs();

    privatePresenceLastSeenUnixMs.set(
      id,
      seen
    );

    return seen;
  }

  function getPrivatePresenceLastSeen(
    playFabId
  ) {
    const id =
      canonicalPrivatePlayerId(
        playFabId
      );

    if (!id)
      return 0;

    return Math.max(
      0,
      Number(
        privatePresenceLastSeenUnixMs.get(
          id
        )
      ) || 0
    );
  }

  function isPrivatePlayerOnline(
    playFabId,
    serverNowUnixMs
  ) {
    const lastSeen =
      getPrivatePresenceLastSeen(
        playFabId
      );

    if (lastSeen <= 0)
      return false;

    const current =
      Math.max(
        1,
        Number(
          serverNowUnixMs
        ) || nowMs()
      );

    return (
      current - lastSeen <=
      PRIVATE_PRESENCE_ONLINE_WINDOW_MS
    );
  }

  function decoratePrivateInboxWithPresence(
    conversations,
    serverNowUnixMs
  ) {
    const current =
      Math.max(
        1,
        Number(
          serverNowUnixMs
        ) || nowMs()
      );

    return (
      Array.isArray(
        conversations
      )
        ? conversations
        : []
    ).map(
      (item) => {
        const peerId =
          canonicalPrivatePlayerId(
            item &&
            item.peerId
          );

        const lastSeenUnixMs =
          getPrivatePresenceLastSeen(
            peerId
          );

        return {
          ...(item || {}),
          isOnline:
            isPrivatePlayerOnline(
              peerId,
              current
            ),
          lastSeenUnixMs,
        };
      }
    );
  }

  // ========================================================================
  // PRIVATE INBOX - SERVER AUTHORITATIVE
  // ========================================================================

  function canonicalPrivatePlayerId(
    value
  ) {
    const raw =
      safeString(
        value,
        100
      )
        .trim()
        .toLowerCase();

    if (!raw)
      return "";

    const chars =
      raw
        .replace(
          /[^a-z0-9_-]+/g,
          "_"
        )
        .replace(
          /^_+|_+$/g,
          ""
        );

    return /^[a-z0-9_-]{1,40}$/.test(
      chars
    )
      ? chars
      : "";
  }

  function isPrivateConversationRoom(
    roomId
  ) {
    const room =
      cleanRoom(
        roomId
      );

    return (
      room.startsWith(
        "private_"
      ) ||
      room.startsWith(
        "p_"
      )
    );
  }

  function isPrivateInboxRoom(
    roomId
  ) {
    const room =
      cleanRoom(
        roomId
      );

    return (
      room.startsWith(
        "inbox_"
      ) ||
      room.startsWith(
        "i_"
      )
    );
  }

  function privateRoomPayload(
    roomId
  ) {
    const room =
      cleanRoom(
        roomId
      );

    if (
      room.startsWith(
        "private_"
      )
    ) {
      return room.slice(
        "private_".length
      );
    }

    if (
      room.startsWith(
        "p_"
      )
    ) {
      return room.slice(2);
    }

    return "";
  }

  function privatePeerFromRoom(
    roomId,
    senderPlayFabId
  ) {
    if (
      !isPrivateConversationRoom(
        roomId
      )
    ) {
      return "";
    }

    const mine =
      canonicalPrivatePlayerId(
        senderPlayFabId
      );

    const payload =
      privateRoomPayload(
        roomId
      );

    if (
      !mine ||
      !payload
    ) {
      return "";
    }

    const mineAtStart =
      `${mine}_`;

    if (
      payload.startsWith(
        mineAtStart
      )
    ) {
      return canonicalPrivatePlayerId(
        payload.slice(
          mineAtStart.length
        )
      );
    }

    const mineAtEnd =
      `_${mine}`;

    if (
      payload.endsWith(
        mineAtEnd
      )
    ) {
      return canonicalPrivatePlayerId(
        payload.slice(
          0,
          payload.length -
            mineAtEnd.length
        )
      );
    }

    return "";
  }

  function buildPrivateInboxRoomId(
    playFabId
  ) {
    const part =
      canonicalPrivatePlayerId(
        playFabId
      );

    if (!part)
      return "";

    const normal =
      `inbox_${part}`;

    if (
      /^[a-z0-9_-]{1,40}$/.test(
        normal
      )
    ) {
      return normal;
    }

    const keep =
      Math.min(
        37,
        part.length
      );

    const shortId =
      `i_${part.slice(
        part.length - keep
      )}`;

    return /^[a-z0-9_-]{1,40}$/.test(
      shortId
    )
      ? shortId
      : "";
  }

  function cleanPrivateInboxField(
    value,
    maximumGraphemes
  ) {
    const clean =
      sanitizeUnicodeString(
        value
      )
        .replace(
          /\r\n/g,
          " "
        )
        .replace(
          /[\r\n]/g,
          " "
        )
        .replace(
          /\|/g,
          "¦"
        )
        .trim();

    return truncateUnicode(
      clean,
      maximumGraphemes
    );
  }

  function privateInboxKind(
    message
  ) {
    if (!message)
      return "text";

    const kind =
      normalizeKind(
        message.kind ||
        message.mediaType
      );

    if (
      kind === "voice" ||
      kind === "image" ||
      kind === "video"
    ) {
      return kind;
    }

    return "text";
  }

  function privateInboxPreview(
    message
  ) {
    const kind =
      privateInboxKind(
        message
      );

    if (kind === "voice")
      return "ملاحظة صوتية";

    if (kind === "image")
      return "صورة";

    if (kind === "video")
      return "فيديو";

    const text =
      cleanPrivateInboxField(
        message &&
        message.text,
        54
      );

    return text ||
      "رسالة خاصة";
  }

  function buildPrivateInboxEventText({
    mineEvent,
    peerId,
    peerName,
    kind,
    preview,
  }) {
    return [
      PRIVATE_INBOX_EVENT_TOKEN,
      mineEvent ? "1" : "0",
      canonicalPrivatePlayerId(
        peerId
      ),
      cleanPrivateInboxField(
        peerName || "لاعب",
        32
      ) || "لاعب",
      cleanPrivateInboxField(
        kind || "text",
        12
      ) || "text",
      cleanPrivateInboxField(
        preview || "رسالة خاصة",
        72
      ),
    ].join("|");
  }

  function parsePrivateInboxEventText(
    value
  ) {
    const text =
      sanitizeUnicodeString(
        value
      );

    if (
      !text.startsWith(
        `${PRIVATE_INBOX_EVENT_TOKEN}|`
      )
    ) {
      return null;
    }

    const parts =
      text.split(
        "|"
      );

    if (
      parts.length <
      6
    ) {
      return null;
    }

    const peerId =
      canonicalPrivatePlayerId(
        parts[2]
      );

    if (!peerId)
      return null;

    return {
      mineEvent:
        parts[1] === "1",

      peerId,

      peerName:
        safeString(
          parts[3],
          64
        ),

      kind:
        safeString(
          parts[4],
          30
        ),

      preview:
        safeString(
          parts
            .slice(5)
            .join("|"),
          120
        ),
    };
  }

  function parsePrivateInboxReadMarkerText(
    value
  ) {
    const text =
      sanitizeUnicodeString(
        value
      );

    if (
      !text.startsWith(
        `${PRIVATE_INBOX_READ_TOKEN}|`
      )
    ) {
      return null;
    }

    const parts =
      text.split(
        "|"
      );

    if (parts.length < 3)
      return null;

    const peerId =
      canonicalPrivatePlayerId(
        parts[1]
      );

    const upToSeq =
      Math.max(
        0,
        Number(
          parts[2]
        ) || 0
      );

    if (!peerId || upToSeq <= 0)
      return null;

    return {
      peerId,
      upToSeq,
    };
  }

  function buildPrivateInbox24HourSnapshot(
    room,
    ownerPlayFabId,
    requestedHours,
    requestedLimit
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    const lifetimeHours =
      Math.max(
        1,
        Math.min(
          PRIVATE_INBOX_ACTIVE_HOURS,
          Number(
            requestedHours
          ) || PRIVATE_INBOX_ACTIVE_HOURS
        )
      );

    const maxConversations =
      Math.max(
        1,
        Math.min(
          MAX_PRIVATE_INBOX_CONVERSATIONS,
          Number(
            requestedLimit
          ) || MAX_PRIVATE_INBOX_CONVERSATIONS
        )
      );

    const serverNowUnixMs =
      nowMs();

    const cutoffUnixMs =
      serverNowUnixMs -
      lifetimeHours *
        60 *
        60 *
        1000;

    const messages =
      Array.isArray(
        room &&
        room.messages
      )
        ? room.messages
            .map(
              (message) =>
                normalizeMessage(
                  message,
                  room.id
                )
            )
            .filter(Boolean)
            .sort(compareMessages)
        : [];

    // نحتاج فقط أحداث/علامات آخر 24 ساعة لأن أي محادثة أقدم من ذلك غير نشطة أصلاً.
    const recent = [];

    for (
      let i =
        messages.length - 1;
      i >= 0;
      i--
    ) {
      const message =
        messages[i];

      const sentUnixMs =
        Math.max(
          0,
          Number(
            message &&
            message.sentUnixMs
          ) || 0
        );

      if (
        sentUnixMs > 0 &&
        sentUnixMs < cutoffUnixMs
      ) {
        break;
      }

      recent.push(
        message
      );
    }

    recent.reverse();

    const latestReadByPeer =
      new Map();

    for (
      const message
      of recent
    ) {
      const marker =
        parsePrivateInboxReadMarkerText(
          message &&
          message.text
        );

      if (!marker)
        continue;

      const previous =
        latestReadByPeer.get(
          marker.peerId
        ) || 0;

      if (
        marker.upToSeq >
        previous
      ) {
        latestReadByPeer.set(
          marker.peerId,
          marker.upToSeq
        );
      }
    }

    const byPeer =
      new Map();

    for (
      const message
      of recent
    ) {
      const event =
        parsePrivateInboxEventText(
          message &&
          message.text
        );

      if (!event)
        continue;

      const peerId =
        canonicalPrivatePlayerId(
          event.peerId
        );

      if (
        !peerId ||
        peerId === ownerId
      ) {
        continue;
      }

      const sentUnixMs =
        Math.max(
          0,
          Number(
            message.sentUnixMs
          ) || 0
        );

      if (
        sentUnixMs <= 0 ||
        sentUnixMs < cutoffUnixMs
      ) {
        continue;
      }

      const seq =
        Math.max(
          0,
          Number(
            message.seq
          ) || 0
        );

      let item =
        byPeer.get(
          peerId
        );

      if (!item) {
        item = {
          peerId,
          peerName:
            safeString(
              event.peerName,
              64
            ) || "لاعب",
          preview:
            safeString(
              event.preview,
              120
            ),
          kind:
            safeString(
              event.kind,
              30
            ) || "text",
          peerAvatarUrl:
            "",
          peerAvatarVersion:
            "0",
          lastActivityUnixMs:
            0,
          lastInboxEventSeq:
            0,
          unreadCount:
            0,
          lastMessageMine:
            !!event.mineEvent,
          _latestKey:
            "",
        };

        byPeer.set(
          peerId,
          item
        );
      }

      const readSeq =
        latestReadByPeer.get(
          peerId
        ) || 0;

      if (
        !event.mineEvent &&
        seq > readSeq
      ) {
        item.unreadCount += 1;
      }

      const latestKey =
        `${String(sentUnixMs).padStart(16, "0")}|${String(seq).padStart(20, "0")}|${safeString(message.id, 120)}`;

      if (
        !item._latestKey ||
        latestKey >=
          item._latestKey
      ) {
        item._latestKey =
          latestKey;

        item.peerName =
          safeString(
            event.peerName,
            64
          ) ||
          item.peerName ||
          "لاعب";

        item.preview =
          safeString(
            event.preview,
            120
          );

        item.kind =
          safeString(
            event.kind,
            30
          ) || "text";

        item.lastActivityUnixMs =
          sentUnixMs;

        item.lastInboxEventSeq =
          seq;

        item.lastMessageMine =
          !!event.mineEvent;
      }

      // الحدث الوارد يحمل Profile الطرف الآخر مباشرة.
      // حدث المرسل الجديد في V15 أيضاً يحمل Profile الطرف الآخر من السيرفر.
      const canUseMessageProfile =
        !event.mineEvent ||
        String(
          message.clientMessageId || ""
        ).startsWith(
          "lpim_me_"
        );

      if (
        canUseMessageProfile &&
        message.senderAvatarUrl
      ) {
        item.peerAvatarUrl =
          safeString(
            message.senderAvatarUrl,
            1000
          );

        item.peerAvatarVersion =
          safeString(
            message.senderAvatarVersion,
            100
          ) || "0";
      }
    }

    const conversations =
      Array.from(
        byPeer.values()
      )
        .sort(
          (a, b) => {
            const timeDiff =
              Number(
                b.lastActivityUnixMs
              ) -
              Number(
                a.lastActivityUnixMs
              );

            if (timeDiff !== 0)
              return timeDiff;

            return String(
              a.peerId || ""
            ).localeCompare(
              String(
                b.peerId || ""
              )
            );
          }
        )
        .slice(
          0,
          maxConversations
        );

    for (
      const item
      of conversations
    ) {
      delete item._latestKey;
    }

    return {
      conversations:
        sanitizeJsonForUnity(
          conversations
        ),
      serverNowUnixMs,
      lifetimeHours,
      maxConversations,
    };
  }


  // ========================================================================
  // V17 - PERSISTENT PRIVATE CONVERSATION PAIR INDEX
  // ========================================================================

  function privateConversationIndexPrefix(
    ownerPlayFabId
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    if (!ownerId)
      return "";

    return `${PRIVATE_CONVERSATION_INDEX_FOLDER}/${ownerId}/`;
  }

  function privateConversationIndexPublicId(
    ownerPlayFabId,
    peerPlayFabId
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    const peerId =
      canonicalPrivatePlayerId(
        peerPlayFabId
      );

    if (
      !ownerId ||
      !peerId ||
      ownerId === peerId
    ) {
      return "";
    }

    return `${privateConversationIndexPrefix(
      ownerId
    )}${peerId}.json`;
  }

  async function writePrivateConversationIndexMarker(
    ownerPlayFabId,
    peerPlayFabId,
    peerProfile,
    kind,
    preview,
    sentUnixMs,
    lastMessageMine,
    sourceMessageId,
    unreadCount
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    const peerId =
      canonicalPrivatePlayerId(
        peerPlayFabId
      );

    const publicId =
      privateConversationIndexPublicId(
        ownerId,
        peerId
      );

    if (!publicId) {
      return {
        ok: false,
        reason:
          "private_index_invalid_ids",
      };
    }

    const activityUnixMs =
      Math.max(
        1,
        Number(
          sentUnixMs
        ) ||
        nowMs()
      );

    const profile =
      peerProfile &&
      typeof peerProfile ===
        "object"
        ? peerProfile
        : {};

    const document =
      sanitizeJsonForUnity({
        schema:
          PRIVATE_CONVERSATION_INDEX_SCHEMA,

        ownerId,
        peerId,

        peerName:
          safeString(
            profile.playerName,
            64
          ) ||
          "لاعب",

        peerAvatarUrl:
          safeString(
            profile.avatarUrl,
            1000
          ),

        peerAvatarVersion:
          safeString(
            profile.avatarVersion,
            100
          ) ||
          "0",

        kind:
          safeString(
            kind,
            30
          ) ||
          "text",

        preview:
          safeString(
            preview,
            120
          ),

        lastActivityUnixMs:
          activityUnixMs,

        lastMessageMine:
          !!lastMessageMine,

        unreadCount:
          Math.max(
            0,
            Number(
              unreadCount
            ) || 0
          ),

        sourceMessageId:
          safeString(
            sourceMessageId,
            120
          ),

        updatedAtUnixMs:
          nowMs(),
      });

    const result =
      await uploadRawJson(
        publicId,
        document
      );

    privateConversationIndexCache.delete(
      ownerId
    );

    return {
      ok:
        true,

      publicId,

      secureUrl:
        result &&
        result.secure_url
          ? safeString(
              result.secure_url,
              1800
            )
          : "",
    };
  }


  function enqueuePrivateConversationIndexMarker(
    ownerPlayFabId,
    peerPlayFabId,
    peerProfile,
    kind,
    preview,
    sentUnixMs,
    lastMessageMine,
    sourceMessageId,
    unreadCount
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    const peerId =
      canonicalPrivatePlayerId(
        peerPlayFabId
      );

    if (
      !ownerId ||
      !peerId ||
      ownerId === peerId
    ) {
      return Promise.resolve({
        ok: false,
        reason:
          "private_index_invalid_ids",
      });
    }

    const key =
      `${ownerId}|${peerId}`;

    const previous =
      privateConversationIndexWriteChains.get(
        key
      ) ||
      Promise.resolve();

    const next =
      previous
        .catch(
          () => {}
        )
        .then(
          () =>
            writePrivateConversationIndexMarker(
              ownerId,
              peerId,
              peerProfile,
              kind,
              preview,
              sentUnixMs,
              lastMessageMine,
              sourceMessageId,
              unreadCount
            )
        );

    const cleanup =
      next.finally(
        () => {
          if (
            privateConversationIndexWriteChains.get(
              key
            ) === cleanup
          ) {
            privateConversationIndexWriteChains.delete(
              key
            );
          }
        }
      );

    privateConversationIndexWriteChains.set(
      key,
      cleanup
    );

    return cleanup;
  }

  async function readPrivateConversationIndexMarker(
    resource
  ) {
    if (
      !resource ||
      !resource.secureUrl
    ) {
      return null;
    }

    try {
      const response =
        await fetchWithTimeout(
          addCacheBust(
            resource.secureUrl
          ),
          {
            method:
              "GET",

            headers: {
              "Cache-Control":
                "no-cache, no-store, max-age=0",

              Pragma:
                "no-cache",
            },
          }
        );

      if (!response.ok)
        return null;

      const rawText =
        await response.text();

      const parsed =
        JSON.parse(
          rawText
        );

      return parsed &&
        typeof parsed ===
          "object"
        ? parsed
        : null;
    } catch (_) {
      return null;
    }
  }

  async function listPrivateConversationIndexResources(
    ownerPlayFabId,
    maximumResources
  ) {
    const prefix =
      privateConversationIndexPrefix(
        ownerPlayFabId
      );

    if (!prefix)
      return [];

    const resources = [];

    const hardLimit =
      Math.max(
        1,
        Math.min(
          PRIVATE_CONVERSATION_INDEX_MAX_RESOURCES,
          Number(
            maximumResources
          ) ||
            PRIVATE_CONVERSATION_INDEX_MAX_RESOURCES
        )
      );

    let nextCursor =
      undefined;

    do {
      const result =
        await cloudinary.api.resources(
          {
            resource_type:
              "raw",

            type:
              "upload",

            prefix,

            max_results:
              Math.min(
                500,
                hardLimit -
                  resources.length
              ),

            ...(nextCursor
              ? {
                  next_cursor:
                    nextCursor,
                }
              : {}),
          }
        );

      if (
        result &&
        Array.isArray(
          result.resources
        )
      ) {
        for (
          const resource
          of result.resources
        ) {
          if (
            !resource ||
            !resource.public_id ||
            !resource.secure_url
          ) {
            continue;
          }

          resources.push({
            publicId:
              safeString(
                resource.public_id,
                1000
              ),

            secureUrl:
              safeString(
                resource.secure_url,
                1800
              ),

            version:
              Math.max(
                0,
                Number(
                  resource.version
                ) || 0
              ),

            createdAt:
              safeString(
                resource.created_at,
                80
              ),
          });

          if (
            resources.length >=
            hardLimit
          ) {
            break;
          }
        }
      }

      nextCursor =
        result &&
        result.next_cursor
          ? result.next_cursor
          : undefined;
    } while (
      nextCursor &&
      resources.length <
        hardLimit
    );

    return resources;
  }

  async function mapPrivateIndexWithConcurrency(
    items,
    worker
  ) {
    const source =
      Array.isArray(
        items
      )
        ? items
        : [];

    const results =
      new Array(
        source.length
      );

    let index = 0;

    async function runner() {
      while (true) {
        const current =
          index++;

        if (
          current >=
          source.length
        ) {
          return;
        }

        try {
          results[current] =
            await worker(
              source[current],
              current
            );
        } catch (_) {
          results[current] =
            null;
        }
      }
    }

    const workerCount =
      Math.max(
        1,
        Math.min(
          PRIVATE_CONVERSATION_INDEX_FETCH_CONCURRENCY,
          source.length || 1
        )
      );

    await Promise.all(
      Array.from(
        {
          length:
            workerCount,
        },
        () =>
          runner()
      )
    );

    return results;
  }

  async function loadPrivateConversationIndex(
    ownerPlayFabId,
    requestedLimit
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    if (!ownerId)
      return [];

    const cached =
      privateConversationIndexCache.get(
        ownerId
      );

    if (
      cached &&
      cached.expires >
        nowMs() &&
      Array.isArray(
        cached.conversations
      )
    ) {
      return cached.conversations;
    }

    const maxConversations =
      Math.max(
        1,
        Math.min(
          MAX_PRIVATE_INBOX_CONVERSATIONS,
          Number(
            requestedLimit
          ) ||
            MAX_PRIVATE_INBOX_CONVERSATIONS
        )
      );

    let resources =
      [];

    try {
      resources =
        await listPrivateConversationIndexResources(
          ownerId,
          Math.min(
            PRIVATE_CONVERSATION_INDEX_MAX_RESOURCES,
            Math.max(
              maxConversations,
              500
            )
          )
        );
    } catch (error) {
      console.warn(
        "[LuxuryChat][PRIVATE_INDEX][LIST_FAILED]",
        {
          ownerId,

          error:
            error &&
            error.message
              ? sanitizeUnicodeString(
                  error.message
                )
              : error,
        }
      );

      return [];
    }

    const documents =
      await mapPrivateIndexWithConcurrency(
        resources,
        async (resource) =>
          readPrivateConversationIndexMarker(
            resource
          )
      );

    const cutoffUnixMs =
      nowMs() -
      PRIVATE_INBOX_ACTIVE_HOURS *
        60 *
        60 *
        1000;

    const byPeer =
      new Map();

    for (
      const raw
      of documents
    ) {
      if (
        !raw ||
        typeof raw !==
          "object"
      ) {
        continue;
      }

      const rawOwner =
        canonicalPrivatePlayerId(
          raw.ownerId
        );

      const peerId =
        canonicalPrivatePlayerId(
          raw.peerId
        );

      const lastActivityUnixMs =
        Math.max(
          0,
          Number(
            raw.lastActivityUnixMs
          ) || 0
        );

      if (
        rawOwner !== ownerId ||
        !peerId ||
        peerId === ownerId ||
        lastActivityUnixMs <
          cutoffUnixMs
      ) {
        continue;
      }

      const item = {
        peerId,

        peerName:
          safeString(
            raw.peerName,
            64
          ) ||
          "لاعب",

        preview:
          safeString(
            raw.preview,
            120
          ),

        kind:
          safeString(
            raw.kind,
            30
          ) ||
          "text",

        peerAvatarUrl:
          safeString(
            raw.peerAvatarUrl,
            1000
          ),

        peerAvatarVersion:
          safeString(
            raw.peerAvatarVersion,
            100
          ) ||
          "0",

        lastActivityUnixMs,

        lastInboxEventSeq:
          0,

        unreadCount:
          Math.max(
            0,
            Number(
              raw.unreadCount
            ) || 0
          ),

        lastMessageMine:
          !!raw.lastMessageMine,
      };

      const previous =
        byPeer.get(
          peerId
        );

      if (
        !previous ||
        item.lastActivityUnixMs >=
          previous.lastActivityUnixMs
      ) {
        byPeer.set(
          peerId,
          item
        );
      }
    }

    const conversations =
      Array.from(
        byPeer.values()
      )
        .sort(
          (a, b) =>
            Number(
              b.lastActivityUnixMs
            ) -
            Number(
              a.lastActivityUnixMs
            )
        )
        .slice(
          0,
          maxConversations
        );

    privateConversationIndexCache.set(
      ownerId,
      {
        expires:
          nowMs() +
          PRIVATE_CONVERSATION_INDEX_CACHE_MS,

        conversations,
      }
    );

    return conversations;
  }

  async function backfillPrivateConversationIndex(
    ownerPlayFabId,
    conversations
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    const items =
      Array.isArray(
        conversations
      )
        ? conversations
        : [];

    if (
      !ownerId ||
      items.length === 0
    ) {
      return;
    }

    await mapPrivateIndexWithConcurrency(
      items.slice(
        0,
        MAX_PRIVATE_INBOX_CONVERSATIONS
      ),
      async (item) => {
        if (!item)
          return null;

        const peerId =
          canonicalPrivatePlayerId(
            item.peerId
          );

        if (
          !peerId ||
          peerId === ownerId
        ) {
          return null;
        }

        return enqueuePrivateConversationIndexMarker(
          ownerId,
          peerId,
          {
            playerName:
              item.peerName,

            avatarUrl:
              item.peerAvatarUrl,

            avatarVersion:
              item.peerAvatarVersion,
          },
          item.kind,
          item.preview,
          item.lastActivityUnixMs,
          item.lastMessageMine,
          "",
          item.unreadCount
        );
      }
    );
  }

  function stablePrivateInboxToken(
    value
  ) {
    // مطابق تماماً لـ StableShortToken في LuxuryPrivateChatManager:
    // ulong + UTF-16 char + overflow 64-bit + x16.
    let hash =
      1469598103934665603n;

    const prime =
      1099511628211n;

    const text =
      String(
        value || ""
      );

    for (
      let i = 0;
      i < text.length;
      i++
    ) {
      hash ^=
        BigInt(
          text.charCodeAt(i)
        );

      hash =
        BigInt.asUintN(
          64,
          hash * prime
        );
    }

    return hash
      .toString(16)
      .padStart(
        16,
        "0"
      );
  }

  function privateInboxSourceProfile(
    message
  ) {
    return {
      playerName:
        safeString(
          message &&
          message.senderName,
          32
        ) ||
        "لاعب",

      avatarUrl:
        safeString(
          message &&
          message.senderAvatarUrl,
          1000
        ),

      avatarVersion:
        safeString(
          message &&
          message.senderAvatarVersion,
          100
        ) ||
        "0",
    };
  }

  async function pushPrivateInboxEventWithRetry(
    inboxRoom,
    eventMessage
  ) {
    if (
      !inboxRoom ||
      !eventMessage
    ) {
      return null;
    }

    let lastError =
      null;

    for (
      let attempt = 0;
      attempt <
        PRIVATE_INBOX_MIRROR_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      const delay =
        PRIVATE_INBOX_MIRROR_RETRY_DELAYS_MS[
          attempt
        ];

      if (delay > 0) {
        await sleep(
          delay
        );
      }

      try {
        return await pushMessage(
          inboxRoom,
          eventMessage
        );
      } catch (error) {
        lastError =
          error;

        console.warn(
          "[LuxuryChat][PRIVATE_INBOX][WRITE_RETRY]",
          {
            room:
              inboxRoom,

            attempt:
              attempt + 1,

            error:
              error &&
              error.message
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error,
          }
        );
      }
    }

    throw (
      lastError ||
      new Error(
        "private_inbox_write_failed"
      )
    );
  }

  async function ensurePrivateInboxForMessage(
    roomId,
    sourceMessage
  ) {
    if (
      !sourceMessage ||
      !sourceMessage.id ||
      !isPrivateConversationRoom(
        roomId
      )
    ) {
      return {
        mirrored:
          false,

        reason:
          "not_private_message",
      };
    }

    const senderId =
      canonicalPrivatePlayerId(
        sourceMessage.senderId
      );

    const peerId =
      privatePeerFromRoom(
        roomId,
        senderId
      );

    if (
      !senderId ||
      !peerId ||
      senderId === peerId
    ) {
      console.warn(
        "[LuxuryChat][PRIVATE_INBOX][PEER_RESOLVE_FAILED]",
        {
          room:
            cleanRoom(
              roomId
            ),

          senderId:
            senderId ||
            safeString(
              sourceMessage.senderId,
              100
            ),
        }
      );

      return {
        mirrored:
          false,

        reason:
          "peer_resolve_failed",
      };
    }

    const senderInboxRoom =
      buildPrivateInboxRoomId(
        senderId
      );

    const peerInboxRoom =
      buildPrivateInboxRoomId(
        peerId
      );

    if (
      !senderInboxRoom ||
      !peerInboxRoom
    ) {
      return {
        mirrored:
          false,

        reason:
          "inbox_room_invalid",
      };
    }

    const senderProfile =
      privateInboxSourceProfile(
        sourceMessage
      );

    let peerProfile = {
      playerName:
        "لاعب",

      avatarUrl:
        "",

      avatarVersion:
        "0",
    };

    try {
      peerProfile =
        await getPlayerProfile(
          peerId,
          false
        );
    } catch (_) {}

    const kind =
      privateInboxKind(
        sourceMessage
      );

    const preview =
      privateInboxPreview(
        sourceMessage
      );

    const stable =
      stablePrivateInboxToken(
        sourceMessage.id
      );

    const sentUnixMs =
      Math.max(
        1,
        Number(
          sourceMessage.sentUnixMs
        ) ||
        nowMs()
      );

    const senderEvent =
      makeMessage({
        roomId:
          senderInboxRoom,

        senderId:
          sourceMessage.senderId,

        // V15: داخل Inbox المرسل نحتاج صورة الطرف الآخر، لا صورة صاحب الحساب.
        profile:
          peerProfile,

        kind:
          "text",

        reply:
          null,

        clientMessageId:
          `lpim_me_${stable}`,
      });

    senderEvent.sentUnixMs =
      sentUnixMs;

    senderEvent.text =
      buildPrivateInboxEventText({
        mineEvent:
          true,

        peerId,

        peerName:
          peerProfile &&
          peerProfile.playerName,

        kind,

        preview,
      });

    const peerEvent =
      makeMessage({
        roomId:
          peerInboxRoom,

        senderId:
          sourceMessage.senderId,

        profile:
          senderProfile,

        kind:
          "text",

        reply:
          null,

        clientMessageId:
          `lpim_peer_${stable}`,
      });

    peerEvent.sentUnixMs =
      sentUnixMs;

    peerEvent.text =
      buildPrivateInboxEventText({
        mineEvent:
          false,

        peerId:
          senderId,

        peerName:
          senderProfile.playerName,

        kind,

        preview,
      });

    // V17: أولاً نكتب فهرساً دائماً مستقلاً للطرفين.
    // هذا الفهرس هو الذي يعيد القائمة بعد إغلاق اللعبة وفتحها.
    const indexResults =
      await Promise.allSettled([
        enqueuePrivateConversationIndexMarker(
          senderId,
          peerId,
          peerProfile,
          kind,
          preview,
          sentUnixMs,
          true,
          sourceMessage.id,
          0
        ),

        enqueuePrivateConversationIndexMarker(
          peerId,
          senderId,
          senderProfile,
          kind,
          preview,
          sentUnixMs,
          false,
          sourceMessage.id,
          1
        ),
      ]);

    const senderIndexOk =
      indexResults[0] &&
      indexResults[0].status ===
        "fulfilled";

    const peerIndexOk =
      indexResults[1] &&
      indexResults[1].status ===
        "fulfilled";

    if (
      !senderIndexOk ||
      !peerIndexOk
    ) {
      console.warn(
        "[LuxuryChat][PRIVATE_INDEX][PARTIAL_FAILURE]",
        {
          sourceMessageId:
            safeString(
              sourceMessage.id,
              100
            ),

          senderId,
          peerId,

          senderIndex:
            senderIndexOk,

          peerIndex:
            peerIndexOk,
        }
      );
    }

    // نبقي Inbox Events الحالية للـ unread/read والتوافق مع Unity.
    const results =
      await Promise.allSettled([
        pushPrivateInboxEventWithRetry(
          senderInboxRoom,
          senderEvent
        ),

        pushPrivateInboxEventWithRetry(
          peerInboxRoom,
          peerEvent
        ),
      ]);

    const senderOk =
      results[0] &&
      results[0].status ===
        "fulfilled";

    const peerOk =
      results[1] &&
      results[1].status ===
        "fulfilled";

    if (
      !senderOk ||
      !peerOk
    ) {
      console.warn(
        "[LuxuryChat][PRIVATE_INBOX][PARTIAL_FAILURE]",
        {
          sourceMessageId:
            safeString(
              sourceMessage.id,
              100
            ),

          room:
            cleanRoom(
              roomId
            ),

          senderInbox:
            senderOk,

          peerInbox:
            peerOk,
        }
      );
    } else {
      console.log(
        "[LuxuryChat][PRIVATE_INBOX][MIRRORED]",
        {
          sourceMessageId:
            safeString(
              sourceMessage.id,
              100
            ),

          senderId,

          peerId,

          kind,
        }
      );
    }

    return {
      // يكفي نجاح المصدر الدائم أو Inbox القديم لكل طرف.
      mirrored:
        (
          senderIndexOk ||
          senderOk
        ) &&
        (
          peerIndexOk ||
          peerOk
        ),

      senderOk,
      peerOk,
      senderIndexOk,
      peerIndexOk,
    };
  }

  async function ensurePrivateInboxForMessageSafe(
    roomId,
    sourceMessage
  ) {
    try {
      return await ensurePrivateInboxForMessage(
        roomId,
        sourceMessage
      );
    } catch (error) {
      console.warn(
        "[LuxuryChat][PRIVATE_INBOX][MIRROR_FAILED]",
        {
          room:
            cleanRoom(
              roomId
            ),

          messageId:
            sourceMessage &&
            sourceMessage.id
              ? safeString(
                  sourceMessage.id,
                  100
                )
              : "",

          error:
            error &&
            error.message
              ? sanitizeUnicodeString(
                  error.message
                )
              : error,
        }
      );

      return {
        mirrored:
          false,

        reason:
          "mirror_failed",
      };
    }
  }


  // ========================================================================
  // PRIVATE INBOX V16 - SELF HEAL FROM REAL PRIVATE HISTORY
  // ========================================================================

  function privateRoomIdFromHistoryResource(
    publicId
  ) {
    const value =
      safeString(
        publicId,
        1000
      );

    if (!value)
      return "";

    const currentPrefix =
      `${HISTORY_FOLDER}/room_`;

    if (
      value.startsWith(
        currentPrefix
      )
    ) {
      const rest =
        value.slice(
          currentPrefix.length
        );

      const slash =
        rest.indexOf("/");

      if (slash <= 0)
        return "";

      const roomId =
        rest.slice(
          0,
          slash
        );

      return /^[a-z0-9_-]{1,40}$/.test(
        roomId
      )
        ? roomId
        : "";
    }

    const legacyPrefix =
      `${LEGACY_HISTORY_FOLDER}/room_`;

    if (
      value.startsWith(
        legacyPrefix
      )
    ) {
      let rest =
        value.slice(
          legacyPrefix.length
        );

      if (
        rest.endsWith(
          ".json"
        )
      ) {
        rest =
          rest.slice(
            0,
            -5
          );
      }

      if (
        rest.includes("/")
      ) {
        return "";
      }

      return /^[a-z0-9_-]{1,40}$/.test(
        rest
      )
        ? rest
        : "";
    }

    return "";
  }

  async function listPrivateHistoryResourcesByPrefix(
    prefix,
    maximumResources
  ) {
    const resources = [];
    let nextCursor =
      undefined;

    const hardLimit =
      Math.max(
        500,
        Number(
          maximumResources
        ) ||
          PRIVATE_INBOX_REPAIR_MAX_RESOURCES
      );

    do {
      const result =
        await cloudinary.api.resources(
          {
            resource_type:
              "raw",

            type:
              "upload",

            prefix,

            max_results:
              500,

            ...(nextCursor
              ? {
                  next_cursor:
                    nextCursor,
                }
              : {}),
          }
        );

      if (
        result &&
        Array.isArray(
          result.resources
        )
      ) {
        for (
          const resource
          of result.resources
        ) {
          if (
            !resource ||
            !resource.public_id ||
            !resource.secure_url
          ) {
            continue;
          }

          resources.push({
            publicId:
              safeString(
                resource.public_id,
                1000
              ),

            secureUrl:
              safeString(
                resource.secure_url,
                1800
              ),

            version:
              Math.max(
                0,
                Number(
                  resource.version
                ) || 0
              ),

            createdAt:
              safeString(
                resource.created_at,
                80
              ),
          });

          if (
            resources.length >=
            hardLimit
          ) {
            return resources;
          }
        }
      }

      nextCursor =
        result &&
        result.next_cursor
          ? result.next_cursor
          : undefined;
    } while (
      nextCursor &&
      resources.length <
        hardLimit
    );

    return resources;
  }

  async function mapPrivateRepairWithConcurrency(
    items,
    worker
  ) {
    const source =
      Array.isArray(
        items
      )
        ? items
        : [];

    const results =
      new Array(
        source.length
      );

    let index = 0;

    async function runner() {
      while (true) {
        const current =
          index++;

        if (
          current >=
          source.length
        ) {
          return;
        }

        try {
          results[current] =
            await worker(
              source[current],
              current
            );
        } catch (error) {
          results[current] =
            null;

          console.warn(
            "[LuxuryChat][PRIVATE_INBOX][REPAIR_ROOM_FAILED]",
            {
              error:
                error &&
                error.message
                  ? sanitizeUnicodeString(
                      error.message
                    )
                  : error,
            }
          );
        }
      }
    }

    const workerCount =
      Math.max(
        1,
        Math.min(
          PRIVATE_INBOX_REPAIR_CONCURRENCY,
          source.length || 1
        )
      );

    await Promise.all(
      Array.from(
        {
          length:
            workerCount,
        },
        () =>
          runner()
      )
    );

    return results;
  }

  async function recoverPrivateConversationFromResources(
    ownerPlayFabId,
    roomId,
    resources,
    cutoffUnixMs
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    const peerId =
      privatePeerFromRoom(
        roomId,
        ownerId
      );

    if (
      !ownerId ||
      !peerId ||
      ownerId === peerId
    ) {
      return null;
    }

    const candidates =
      Array.isArray(
        resources
      )
        ? resources
            .filter(
              (resource) =>
                resource &&
                resource.secureUrl
            )
            .slice(
              0,
              96
            )
        : [];

    if (
      candidates.length === 0
    ) {
      return null;
    }

    const byMessageId =
      new Map();

    for (
      const resource
      of candidates
    ) {
      let document =
        null;

      try {
        document =
          await fetchHistoryDocumentFromUrl(
            roomId,
            resource.secureUrl
          );
      } catch (_) {
        continue;
      }

      if (
        !document ||
        !Array.isArray(
          document.messages
        )
      ) {
        continue;
      }

      for (
        const rawMessage
        of document.messages
      ) {
        const message =
          normalizeMessage(
            rawMessage,
            roomId
          );

        if (
          !message ||
          !message.id ||
          message.sentUnixMs <
            cutoffUnixMs ||
          isReactionMessageServer(
            message
          )
        ) {
          continue;
        }

        const previous =
          byMessageId.get(
            message.id
          );

        if (
          !previous ||
          compareMessages(
            previous,
            message
          ) <= 0
        ) {
          byMessageId.set(
            message.id,
            message
          );
        }
      }
    }

    const messages =
      Array.from(
        byMessageId.values()
      )
        .sort(
          compareMessages
        );

    if (
      messages.length === 0
    ) {
      return null;
    }

    const latest =
      messages[
        messages.length - 1
      ];

    const latestSenderId =
      canonicalPrivatePlayerId(
        latest.senderId
      );

    let peerName =
      "";
    let peerAvatarUrl =
      "";
    let peerAvatarVersion =
      "0";
    let unreadCount = 0;

    for (
      const message
      of messages
    ) {
      const senderId =
        canonicalPrivatePlayerId(
          message.senderId
        );

      if (
        senderId === peerId
      ) {
        if (
          message.senderName
        ) {
          peerName =
            safeString(
              message.senderName,
              64
            ) ||
            peerName;
        }

        if (
          message.senderAvatarUrl
        ) {
          peerAvatarUrl =
            safeString(
              message.senderAvatarUrl,
              1000
            );

          peerAvatarVersion =
            safeString(
              message.senderAvatarVersion,
              100
            ) ||
            "0";
        }

        unreadCount += 1;
      }
    }

    if (!peerName) {
      const cached =
        profileCache.get(
          peerId
        );

      if (
        cached &&
        cached.profile
      ) {
        peerName =
          safeString(
            cached.profile.playerName,
            64
          );

        peerAvatarUrl =
          peerAvatarUrl ||
          safeString(
            cached.profile.avatarUrl,
            1000
          );

        peerAvatarVersion =
          peerAvatarVersion !==
            "0"
            ? peerAvatarVersion
            : safeString(
                cached.profile.avatarVersion,
                100
              ) ||
              "0";
      }
    }

    return {
      peerId,

      peerName:
        peerName ||
        "لاعب",

      preview:
        privateInboxPreview(
          latest
        ),

      kind:
        privateInboxKind(
          latest
        ),

      peerAvatarUrl,
      peerAvatarVersion,

      lastActivityUnixMs:
        Math.max(
          0,
          Number(
            latest.sentUnixMs
          ) || 0
        ),

      lastInboxEventSeq:
        0,

      unreadCount:
        latestSenderId ===
          ownerId
          ? 0
          : Math.max(
              1,
              unreadCount
            ),

      lastMessageMine:
        latestSenderId ===
        ownerId,
    };
  }

  async function repairPrivateInboxFromRealHistory(
    ownerPlayFabId,
    requestedLimit
  ) {
    const ownerId =
      canonicalPrivatePlayerId(
        ownerPlayFabId
      );

    if (!ownerId) {
      return {
        ok:
          false,
        conversations:
          [],
      };
    }

    const cached =
      privateInboxRepairCache.get(
        ownerId
      );

    if (
      cached &&
      cached.expires >
        nowMs() &&
      Array.isArray(
        cached.conversations
      )
    ) {
      return {
        ok:
          true,
        cached:
          true,
        conversations:
          cached.conversations,
      };
    }

    if (
      cached &&
      cached.promise
    ) {
      return cached.promise;
    }

    const promise =
      (async () => {
        const cutoffUnixMs =
          nowMs() -
          PRIVATE_INBOX_ACTIVE_HOURS *
            60 *
            60 *
            1000;

        const maxConversations =
          Math.max(
            1,
            Math.min(
              MAX_PRIVATE_INBOX_CONVERSATIONS,
              Number(
                requestedLimit
              ) ||
                MAX_PRIVATE_INBOX_CONVERSATIONS
            )
          );

        const prefixes = [
          `${HISTORY_FOLDER}/room_p_`,
          `${HISTORY_FOLDER}/room_private_`,
          `${LEGACY_HISTORY_FOLDER}/room_p_`,
          `${LEGACY_HISTORY_FOLDER}/room_private_`,
        ];

        const lists =
          await Promise.all(
            prefixes.map(
              (prefix) =>
                listPrivateHistoryResourcesByPrefix(
                  prefix,
                  PRIVATE_INBOX_REPAIR_MAX_RESOURCES
                )
            )
          );

        const allResources =
          [];

        for (
          const list
          of lists
        ) {
          for (
            const resource
            of list
          ) {
            allResources.push(
              resource
            );
          }
        }

        const byRoom =
          new Map();

        const minimumCreatedUnixMs =
          nowMs() -
          PRIVATE_INBOX_REPAIR_SCAN_DAYS *
            24 *
            60 *
            60 *
            1000;

        for (
          const resource
          of allResources
        ) {
          const roomId =
            privateRoomIdFromHistoryResource(
              resource.publicId
            );

          if (
            !roomId ||
            !isPrivateConversationRoom(
              roomId
            )
          ) {
            continue;
          }

          const peerId =
            privatePeerFromRoom(
              roomId,
              ownerId
            );

          if (
            !peerId ||
            peerId === ownerId
          ) {
            continue;
          }

          const isLegacy =
            resource.publicId.startsWith(
              `${LEGACY_HISTORY_FOLDER}/`
            );

          if (!isLegacy) {
            const shardDay =
              extractHistoryShardDay(
                resource.publicId
              );

            const shardDayEnd =
              dayKeyEndUnixMs(
                shardDay
              );

            if (
              shardDayEnd > 0 &&
              shardDayEnd <=
                cutoffUnixMs
            ) {
              continue;
            }

            const createdUnixMs =
              resource.createdAt
                ? Date.parse(
                    resource.createdAt
                  )
                : 0;

            if (
              createdUnixMs > 0 &&
              createdUnixMs <
                minimumCreatedUnixMs &&
              (
                !shardDayEnd ||
                shardDayEnd <=
                  cutoffUnixMs
              )
            ) {
              continue;
            }
          }

          if (
            !byRoom.has(
              roomId
            )
          ) {
            byRoom.set(
              roomId,
              []
            );
          }

          byRoom.get(
            roomId
          ).push(
            resource
          );
        }

        let roomEntries =
          Array.from(
            byRoom.entries()
          );

        // غرف أكثر من الحد: نبدأ بالغرف التي لها أحدث Resource.
        roomEntries.sort(
          (a, b) => {
            function latestCreated(
              pair
            ) {
              let latest = 0;

              for (
                const resource
                of pair[1]
              ) {
                const parsed =
                  resource.createdAt
                    ? Date.parse(
                        resource.createdAt
                      )
                    : 0;

                latest =
                  Math.max(
                    latest,
                    Number.isFinite(
                      parsed
                    )
                      ? parsed
                      : 0
                  );
              }

              return latest;
            }

            return (
              latestCreated(b) -
              latestCreated(a)
            );
          }
        );

        roomEntries =
          roomEntries.slice(
            0,
            maxConversations
          );

        const recovered =
          await mapPrivateRepairWithConcurrency(
            roomEntries,
            async (entry) =>
              recoverPrivateConversationFromResources(
                ownerId,
                entry[0],
                entry[1],
                cutoffUnixMs
              )
          );

        const conversations =
          recovered
            .filter(Boolean)
            .sort(
              (a, b) =>
                Number(
                  b.lastActivityUnixMs
                ) -
                Number(
                  a.lastActivityUnixMs
                )
            )
            .slice(
              0,
              maxConversations
            );

        privateInboxRepairCache.set(
          ownerId,
          {
            expires:
              nowMs() +
              PRIVATE_INBOX_REPAIR_CACHE_MS,

            promise:
              null,

            conversations,
          }
        );

        return {
          ok:
            true,
          cached:
            false,
          conversations,
        };
      })()
        .catch(
          (error) => {
            privateInboxRepairCache.delete(
              ownerId
            );

            console.warn(
              "[LuxuryChat][PRIVATE_INBOX][REPAIR_FAILED]",
              {
                ownerId,

                error:
                  error &&
                  error.message
                    ? sanitizeUnicodeString(
                        error.message
                      )
                    : error,
              }
            );

            return {
              ok:
                false,
              cached:
                false,
              conversations:
                [],
            };
          }
        );

    privateInboxRepairCache.set(
      ownerId,
      {
        expires:
          0,
        promise,
        conversations:
          null,
      }
    );

    return promise;
  }

  function mergePrivateInboxConversationLists(
    primary,
    recovered,
    maximum
  ) {
    const byPeer =
      new Map();

    function apply(
      source,
      recoveredSource
    ) {
      for (
        const item
        of (
          Array.isArray(
            source
          )
            ? source
            : []
        )
      ) {
        if (!item)
          continue;

        const peerId =
          canonicalPrivatePlayerId(
            item.peerId
          );

        const lastActivityUnixMs =
          Math.max(
            0,
            Number(
              item.lastActivityUnixMs
            ) || 0
          );

        if (
          !peerId ||
          lastActivityUnixMs <= 0
        ) {
          continue;
        }

        const clean = {
          peerId,

          peerName:
            safeString(
              item.peerName,
              64
            ) ||
            "لاعب",

          preview:
            safeString(
              item.preview,
              120
            ),

          kind:
            safeString(
              item.kind,
              30
            ) ||
            "text",

          peerAvatarUrl:
            safeString(
              item.peerAvatarUrl,
              1000
            ),

          peerAvatarVersion:
            safeString(
              item.peerAvatarVersion,
              100
            ) ||
            "0",

          lastActivityUnixMs,

          lastInboxEventSeq:
            Math.max(
              0,
              Number(
                item.lastInboxEventSeq
              ) || 0
            ),

          unreadCount:
            Math.max(
              0,
              Number(
                item.unreadCount
              ) || 0
            ),

          lastMessageMine:
            !!item.lastMessageMine,

          _recovered:
            !!recoveredSource,
        };

        const previous =
          byPeer.get(
            peerId
          );

        if (!previous) {
          byPeer.set(
            peerId,
            clean
          );

          continue;
        }

        if (
          clean.lastActivityUnixMs >
          previous.lastActivityUnixMs
        ) {
          // إذا المصدر المستعاد أحدث، نحافظ على بيانات Profile الموجودة في inbox_ إن كانت أفضل.
          if (
            !clean.peerAvatarUrl &&
            previous.peerAvatarUrl
          ) {
            clean.peerAvatarUrl =
              previous.peerAvatarUrl;

            clean.peerAvatarVersion =
              previous.peerAvatarVersion;
          }

          if (
            (
              !clean.peerName ||
              clean.peerName ===
                "لاعب"
            ) &&
            previous.peerName
          ) {
            clean.peerName =
              previous.peerName;
          }

          clean.unreadCount =
            Math.max(
              clean.unreadCount,
              previous.unreadCount
            );

          clean.lastInboxEventSeq =
            Math.max(
              clean.lastInboxEventSeq,
              previous.lastInboxEventSeq
            );

          byPeer.set(
            peerId,
            clean
          );

          continue;
        }

        if (
          recoveredSource
        ) {
          previous.unreadCount =
            Math.max(
              previous.unreadCount,
              clean.unreadCount
            );

          if (
            !previous.peerAvatarUrl &&
            clean.peerAvatarUrl
          ) {
            previous.peerAvatarUrl =
              clean.peerAvatarUrl;

            previous.peerAvatarVersion =
              clean.peerAvatarVersion;
          }

          if (
            (
              !previous.peerName ||
              previous.peerName ===
                "لاعب"
            ) &&
            clean.peerName
          ) {
            previous.peerName =
              clean.peerName;
          }
        }
      }
    }

    apply(
      primary,
      false
    );

    apply(
      recovered,
      true
    );

    const result =
      Array.from(
        byPeer.values()
      )
        .sort(
          (a, b) =>
            Number(
              b.lastActivityUnixMs
            ) -
            Number(
              a.lastActivityUnixMs
            )
        )
        .slice(
          0,
          Math.max(
            1,
            Math.min(
              MAX_PRIVATE_INBOX_CONVERSATIONS,
              Number(
                maximum
              ) ||
                MAX_PRIVATE_INBOX_CONVERSATIONS
            )
          )
        );

    for (
      const item
      of result
    ) {
      delete item._recovered;
    }

    return sanitizeJsonForUnity(
      result
    );
  }

  function profileLookupIdForResponseMessage(
    message
  ) {
    if (!message)
      return "";

    const parsed =
      parsePrivateInboxEventText(
        message.text
      );

    if (
      parsed &&
      parsed.mineEvent &&
      parsed.peerId
    ) {
      // حدث "رسالتي" داخل inbox الخاص بي:
      // للعرض نريد صورة الطرف الآخر وليس صورتي أنا.
      return parsed.peerId;
    }

    return safeString(
      message.senderId,
      100
    );
  }

  function pruneRateMap(
    map,
    current
  ) {
    const cutoff =
      current -
      RATE_MAP_ENTRY_MAX_AGE_MS;

    for (
      const [key, timestamp]
      of map.entries()
    ) {
      if (
        Number(
          timestamp || 0
        ) <= cutoff
      ) {
        map.delete(key);
      }
    }
  }

  function maybePruneRateMaps(
    current
  ) {
    if (
      current -
        lastRateMapPruneUnixMs <
      RATE_MAP_PRUNE_INTERVAL_MS
    ) {
      return;
    }

    lastRateMapPruneUnixMs =
      current;

    pruneRateMap(
      sendRate,
      current
    );

    pruneRateMap(
      reportRate,
      current
    );
  }

  function checkRate(
    map,
    key,
    minimumMs
  ) {
    const current =
      nowMs();

    maybePruneRateMaps(
      current
    );

    const last =
      Number(
        map.get(key) || 0
      );

    if (
      current - last <
      minimumMs
    ) {
      return false;
    }

    map.set(
      key,
      current
    );

    return true;
  }

  function sanitizeFileName(
    value,
    fallback
  ) {
    const original =
      safeString(
        value,
        180
      ) ||
      fallback ||
      "media.bin";

    const ext =
      path
        .extname(original)
        .slice(0, 12);

    const base =
      path
        .basename(
          original,
          ext
        )
        .replace(
          /[^a-zA-Z0-9_-]+/g,
          "_"
        )
        .slice(
          0,
          80
        );

    return `${
      base || "media"
    }${ext.toLowerCase()}`;
  }

  function makeChatError(
    code,
    message,
    extra
  ) {
    const error =
      new Error(
        message ||
        code ||
        "chat_error"
      );

    error.code =
      code ||
      "CHAT_ERROR";

    if (
      extra &&
      typeof extra ===
        "object"
    ) {
      Object.assign(
        error,
        extra
      );
    }

    return error;
  }

  function deterministicMessageId(
    roomId,
    senderId,
    clientMessageId
  ) {
    const client =
      cleanClientMessageId(
        clientMessageId
      );

    if (!client)
      return crypto.randomUUID();

    const digest =
      crypto
        .createHash("sha256")
        .update(
          `${
            cleanRoom(roomId)
          }|${
            safeString(
              senderId,
              100
            )
          }|${client}`,
          "utf8"
        )
        .digest("hex");

    return `m_${digest.slice(
      0,
      48
    )}`;
  }

  function isReactionMessageServer(
    message
  ) {
    if (
      !message ||
      !safeString(
        message.replyToId,
        100
      )
    ) {
      return false;
    }

    let value =
      cleanText(
        message.text || ""
      );

    if (
      value === "♥" ||
      value === "♥️"
    ) {
      value = "❤️";
    }

    return (
      value ===
        REACTION_REMOVE_TOKEN ||
      QUICK_REACTIONS.has(
        value
      )
    );
  }

  function positiveMin(a, b) {
    const x =
      Math.max(
        0,
        Number(a) || 0
      );

    const y =
      Math.max(
        0,
        Number(b) || 0
      );

    if (x <= 0)
      return y;

    if (y <= 0)
      return x;

    return Math.min(
      x,
      y
    );
  }

  function compareMessages(
    a,
    b
  ) {
    if (a === b)
      return 0;

    if (!a)
      return -1;

    if (!b)
      return 1;

    const seqA =
      Math.max(
        0,
        Number(a.seq) || 0
      );

    const seqB =
      Math.max(
        0,
        Number(b.seq) || 0
      );

    if (
      seqA > 0 &&
      seqB > 0 &&
      seqA !== seqB
    ) {
      return seqA - seqB;
    }

    const timeA =
      Math.max(
        0,
        Number(
          a.sentUnixMs
        ) || 0
      );

    const timeB =
      Math.max(
        0,
        Number(
          b.sentUnixMs
        ) || 0
      );

    if (timeA !== timeB)
      return timeA - timeB;

    if (seqA !== seqB)
      return seqA - seqB;

    return String(
      a.id || ""
    ).localeCompare(
      String(
        b.id || ""
      )
    );
  }

  // ========================================================================
  // PLAYFAB
  // ========================================================================

  async function playFabCall(
    group,
    endpoint,
    body
  ) {
    if (
      !TITLE_ID ||
      !SECRET_KEY
    ) {
      throw new Error(
        "PLAYFAB_TITLE_ID / PLAYFAB_SECRET_KEY missing"
      );
    }

    const response =
      await fetchWithTimeout(
        `https://${TITLE_ID}.playfabapi.com/${group}/${endpoint}`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "X-SecretKey":
              SECRET_KEY,
          },

          body:
            safeJsonStringify(
              body || {}
            ),
        }
      );

    const json =
      await response
        .json()
        .catch(
          () => null
        );

    if (
      !response.ok ||
      !json ||
      json.code !== 200 ||
      json.data === undefined
    ) {
      const message =
        json &&
        json.errorMessage
          ? sanitizeUnicodeString(
              json.errorMessage
            )
          : `PlayFab ${group}/${endpoint} failed`;

      throw new Error(
        message
      );
    }

    return json.data;
  }

  function playFabServerCall(
    endpoint,
    body
  ) {
    return playFabCall(
      "Server",
      endpoint,
      body
    );
  }

  function playFabAdminCall(
    endpoint,
    body
  ) {
    return playFabCall(
      "Admin",
      endpoint,
      body
    );
  }

  async function authenticateSessionTicket(
    sessionTicket
  ) {
    const ticket =
      safeString(
        sessionTicket,
        4096
      );

    if (!ticket) {
      throw makeChatError(
        "AUTH_MISSING",
        "missing_session_ticket"
      );
    }

    const data =
      await playFabServerCall(
        "AuthenticateSessionTicket",
        {
          SessionTicket:
            ticket,
        }
      );

    const playFabId =
      data &&
      data.UserInfo &&
      data.UserInfo.PlayFabId
        ? safeString(
            data.UserInfo.PlayFabId,
            100
          )
        : "";

    if (!playFabId) {
      throw makeChatError(
        "AUTH_INVALID",
        "invalid_session_ticket"
      );
    }

    return playFabId;
  }

  async function getPlayerProfile(
    playFabId,
    forceRefresh = false
  ) {
    if (!forceRefresh) {
      const cached =
        profileCache.get(
          playFabId
        );

      if (
        cached &&
        cached.expires >
          nowMs()
      ) {
        return cached.profile;
      }
    }

    let playerName = "لاعب";
    let avatarUrl = "";
    let avatarVersion = "0";

    try {
      const data =
        await playFabServerCall(
          "GetUserData",
          {
            PlayFabId:
              playFabId,

            Keys: [
              "player_display_name",
              "avatar_uploaded",
              "avatar_url",
              "avatar_version",
            ],
          }
        );

      if (
        data &&
        data.Data
      ) {
        const nameRecord =
          data.Data
            .player_display_name;

        const uploadedRecord =
          data.Data
            .avatar_uploaded;

        const urlRecord =
          data.Data
            .avatar_url;

        const versionRecord =
          data.Data
            .avatar_version;

        if (
          nameRecord &&
          nameRecord.Value
        ) {
          playerName =
            safeString(
              nameRecord.Value,
              32
            ) || "لاعب";
        }

        const avatarUploaded =
          uploadedRecord &&
          String(
            uploadedRecord.Value ||
              ""
          ) === "1";

        if (
          avatarUploaded &&
          urlRecord &&
          urlRecord.Value
        ) {
          avatarUrl =
            safeString(
              urlRecord.Value,
              1000
            );
        }

        if (
          versionRecord &&
          versionRecord.Value
        ) {
          avatarVersion =
            safeString(
              versionRecord.Value,
              100
            ) || "0";
        }
      }
    } catch (error) {
      console.warn(
        "[LuxuryChat] GetUserData profile failed",
        error &&
        error.message
          ? sanitizeUnicodeString(
              error.message
            )
          : error
      );
    }

    if (
      playerName ===
      "لاعب"
    ) {
      try {
        const data =
          await playFabServerCall(
            "GetUserAccountInfo",
            {
              PlayFabId:
                playFabId,
            }
          );

        const display =
          data &&
          data.UserInfo &&
          data.UserInfo.TitleInfo &&
          data.UserInfo.TitleInfo
            .DisplayName
            ? safeString(
                data.UserInfo
                  .TitleInfo
                  .DisplayName,
                32
              )
            : "";

        if (display)
          playerName = display;
      } catch (_) {}
    }

    const profile = {
      playerName:
        safeString(
          playerName,
          32
        ) || "لاعب",

      avatarUrl:
        safeString(
          avatarUrl,
          1000
        ),

      avatarVersion:
        safeString(
          avatarVersion,
          100
        ) || "0",
    };

    profileCache.set(
      playFabId,
      {
        profile,

        expires:
          nowMs() +
          PROFILE_CACHE_MS,
      }
    );

    return profile;
  }

  // ========================================================================
  // ROOM / CLOUDINARY HISTORY - SHARDED
  // ========================================================================

  function getRoom(roomId) {
    const id =
      cleanRoom(
        roomId
      );

    if (!rooms.has(id)) {
      rooms.set(
        id,
        {
          id,

          seq: 0,

          messages: [],

          loaded: false,

          syncPromise: null,

          mutationChain:
            Promise.resolve(),

          lastStorageSyncMs: 0,

          lastStorageSavedAtUnixMs:
            0,

          lastShardDiscoveryMs: 0,

          knownShardResources:
            new Map(),

          shardCache:
            new Map(),

          legacyCache:
            null,

          legacyMissingUntilMs:
            0,
        }
      );
    }

    return rooms.get(id);
  }

  function historyShardPrefix(
    roomId
  ) {
    return `${HISTORY_FOLDER}/room_${cleanRoom(
      roomId
    )}/`;
  }

  function historyShardPublicId(
    roomId,
    dayKey
  ) {
    return `${historyShardPrefix(
      roomId
    )}${dayKey}_${HISTORY_INSTANCE_TOKEN}.json`;
  }

  function legacyHistoryPublicId(
    roomId
  ) {
    return `${LEGACY_HISTORY_FOLDER}/room_${cleanRoom(
      roomId
    )}.json`;
  }

  function utcDayKey(
    unixMs
  ) {
    const date =
      new Date(
        Math.max(
          0,
          Number(unixMs) ||
            nowMs()
        )
      );

    const y =
      String(
        date.getUTCFullYear()
      ).padStart(
        4,
        "0"
      );

    const m =
      String(
        date.getUTCMonth() +
          1
      ).padStart(
        2,
        "0"
      );

    const d =
      String(
        date.getUTCDate()
      ).padStart(
        2,
        "0"
      );

    return `${y}${m}${d}`;
  }

  function dayKeyEndUnixMs(
    dayKey
  ) {
    const text =
      safeString(
        dayKey,
        16
      );

    if (
      !/^\d{8}$/.test(
        text
      )
    ) {
      return 0;
    }

    const y =
      Number(
        text.slice(
          0,
          4
        )
      );

    const m =
      Number(
        text.slice(
          4,
          6
        )
      );

    const d =
      Number(
        text.slice(
          6,
          8
        )
      );

    const start =
      Date.UTC(
        y,
        m - 1,
        d,
        0,
        0,
        0,
        0
      );

    if (
      !Number.isFinite(
        start
      )
    ) {
      return 0;
    }

    return (
      start +
      24 *
        60 *
        60 *
        1000
    );
  }

  function extractHistoryShardDay(
    publicId
  ) {
    const match =
      safeString(
        publicId,
        1000
      ).match(
        /\/(\d{8})_[^/]+\.json$/
      );

    return match
      ? match[1]
      : "";
  }

  function addCacheBust(url) {
    const value =
      safeString(
        url,
        4000
      );

    if (!value)
      return value;

    return `${value}${
      value.includes("?")
        ? "&"
        : "?"
    }ts=${nowMs()}_${crypto
      .randomBytes(3)
      .toString("hex")}`;
  }

  function uploadRawJson(
    publicId,
    object
  ) {
    const buffer =
      Buffer.from(
        safeJsonStringify(
          object
        ),
        "utf8"
      );

    return new Promise(
      (
        resolve,
        reject
      ) => {
        const stream =
          cloudinary.uploader
            .upload_stream(
              {
                resource_type:
                  "raw",

                type:
                  "upload",

                public_id:
                  publicId,

                overwrite:
                  true,

                invalidate:
                  true,
              },
              (
                error,
                result
              ) => {
                if (error)
                  return reject(
                    error
                  );

                if (!result) {
                  return reject(
                    new Error(
                      "cloudinary_no_result"
                    )
                  );
                }

                resolve(
                  result
                );
              }
            );

        stream.end(
          buffer
        );
      }
    );
  }

  function normalizeMessage(
    raw,
    roomId
  ) {
    if (
      !raw ||
      typeof raw !==
        "object"
    ) {
      return null;
    }

    const id =
      safeString(
        raw.id,
        100
      );

    const sentUnixMs =
      Math.max(
        0,
        Number(
          raw.sentUnixMs
        ) || 0
      );

    if (
      !id ||
      !sentUnixMs
    ) {
      return null;
    }

    const kind =
      normalizeKind(
        raw.kind ||
        raw.mediaType
      );

    const rawMediaKind =
      normalizeKind(
        raw.mediaType
      );

    const mediaType =
      kind === "image" ||
      kind === "video"
        ? kind
        : rawMediaKind ===
              "image" ||
            rawMediaKind ===
              "video"
          ? rawMediaKind
          : "";

    return {
      id,

      clientMessageId:
        cleanClientMessageId(
          raw.clientMessageId
        ),

      seq:
        Math.max(
          0,
          Number(
            raw.seq
          ) || 0
        ),

      room:
        cleanRoom(
          raw.room ||
          roomId
        ),

      senderId:
        safeString(
          raw.senderId,
          100
        ),

      senderName:
        safeString(
          raw.senderName,
          64
        ) || "لاعب",

      senderAvatarUrl:
        safeString(
          raw.senderAvatarUrl,
          1000
        ),

      senderAvatarVersion:
        safeString(
          raw.senderAvatarVersion,
          100
        ) || "0",

      sentUnixMs,

      kind,

      text:
        kind === "text"
          ? cleanText(
              raw.text || ""
            )
          : "",

      voiceUrl:
        kind === "voice"
          ? safeString(
              raw.voiceUrl,
              1200
            )
          : "",

      voiceDuration:
        kind === "voice"
          ? Math.min(
              180,
              Math.max(
                0,
                Number(
                  raw.voiceDuration
                ) || 0
              )
            )
          : 0,

      mediaType,

      mediaUrl:
        kind === "image" ||
        kind === "video"
          ? safeString(
              raw.mediaUrl,
              1600
            )
          : "",

      mediaThumbnailUrl:
        kind === "image" ||
        kind === "video"
          ? safeString(
              raw.mediaThumbnailUrl,
              1600
            )
          : "",

      mediaFileName:
        kind === "image" ||
        kind === "video"
          ? safeString(
              raw.mediaFileName,
              180
            )
          : "",

      replyToId:
        safeString(
          raw.replyToId,
          100
        ),

      replyToSenderId:
        safeString(
          raw.replyToSenderId,
          100
        ),

      replyToName:
        safeString(
          raw.replyToName,
          64
        ),

      replyToPreview:
        safeString(
          raw.replyToPreview,
          120
        ),
    };
  }

  function parseHistoryDocument(
    text,
    roomId
  ) {
    let parsed;

    try {
      parsed =
        JSON.parse(
          String(
            text || ""
          )
        );
    } catch (_) {
      throw new Error(
        "chat_history_invalid_json"
      );
    }

    if (
      !parsed ||
      typeof parsed !==
        "object"
    ) {
      throw new Error(
        "chat_history_invalid_object"
      );
    }

    const source =
      Array.isArray(
        parsed.messages
      )
        ? parsed.messages
        : [];

    const messages = [];

    let maxSeq = 0;

    for (
      const raw
      of source
    ) {
      const message =
        normalizeMessage(
          raw,
          roomId
        );

      if (!message)
        continue;

      messages.push(
        message
      );

      maxSeq =
        Math.max(
          maxSeq,
          Math.max(
            0,
            Number(
              message.seq
            ) || 0
          )
        );
    }

    return {
      exists: true,

      version:
        Math.max(
          0,
          Number(
            parsed.version
          ) || 0
        ),

      build:
        safeString(
          parsed.build,
          180
        ),

      room:
        cleanRoom(
          parsed.room ||
          roomId
        ),

      seq:
        Math.max(
          maxSeq,
          Math.max(
            0,
            Number(
              parsed.seq
            ) || 0
          )
        ),

      retentionDays:
        Math.max(
          0,
          Number(
            parsed.retentionDays
          ) || 0
        ) ||
        RETENTION_DAYS,

      savedAtUnixMs:
        Math.max(
          0,
          Number(
            parsed.savedAtUnixMs
          ) || 0
        ),

      shardInstance:
        safeString(
          parsed.shardInstance,
          120
        ),

      shardDay:
        safeString(
          parsed.shardDay,
          16
        ),

      messages,
    };
  }

  function isCloudinaryNotFoundError(
    error
  ) {
    if (!error)
      return false;

    const code =
      Number(
        error.http_code ||
        error.status ||
        error.statusCode ||
        0
      );

    if (code === 404)
      return true;

    const message =
      sanitizeUnicodeString(
        error.message ||
        error.error?.message ||
        ""
      ).toLowerCase();

    return (
      message.includes(
        "not found"
      ) ||
      message.includes(
        "404"
      )
    );
  }

  async function resolveRawResource(
    publicId
  ) {
    try {
      const resource =
        await cloudinary.api.resource(
          publicId,
          {
            resource_type:
              "raw",

            type:
              "upload",
          }
        );

      if (
        !resource ||
        !resource.secure_url
      ) {
        throw new Error(
          "chat_history_resource_missing_secure_url"
        );
      }

      return {
        exists: true,

        publicId:
          safeString(
            resource.public_id,
            600
          ) ||
          publicId,

        secureUrl:
          safeString(
            resource.secure_url,
            1800
          ),

        version:
          Math.max(
            0,
            Number(
              resource.version
            ) || 0
          ),

        createdAt:
          safeString(
            resource.created_at,
            80
          ),
      };
    } catch (error) {
      if (
        isCloudinaryNotFoundError(
          error
        )
      ) {
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

  async function fetchHistoryDocumentFromUrl(
    roomId,
    url
  ) {
    let lastError = null;
    let sawNotFound = false;

    for (
      let attempt = 0;
      attempt <
      HISTORY_READ_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      const delay =
        HISTORY_READ_RETRY_DELAYS_MS[
          attempt
        ];

      if (delay > 0)
        await sleep(delay);

      try {
        const response =
          await fetchWithTimeout(
            addCacheBust(
              url
            ),
            {
              method:
                "GET",

              headers: {
                "Cache-Control":
                  "no-cache, no-store, max-age=0",

                Pragma:
                  "no-cache",
              },
            }
          );

        if (
          response.status ===
          404
        ) {
          sawNotFound = true;

          lastError =
            new Error(
              "chat_history_not_found"
            );

          continue;
        }

        if (!response.ok) {
          lastError =
            new Error(
              `chat_history_load_http_${response.status}`
            );

          continue;
        }

        const rawText =
          await response.text();

        return parseHistoryDocument(
          rawText,
          roomId
        );
      } catch (error) {
        lastError = error;
      }
    }

    if (sawNotFound)
      return null;

    throw (
      lastError ||
      new Error(
        "chat_history_load_failed"
      )
    );
  }

  async function listHistoryShardResources(
    roomId
  ) {
    const resources = [];

    let nextCursor =
      undefined;

    do {
      const result =
        await cloudinary.api.resources(
          {
            resource_type:
              "raw",

            type:
              "upload",

            prefix:
              historyShardPrefix(
                roomId
              ),

            max_results:
              500,

            ...(nextCursor
              ? {
                  next_cursor:
                    nextCursor,
                }
              : {}),
          }
        );

      if (
        result &&
        Array.isArray(
          result.resources
        )
      ) {
        for (
          const resource
          of result.resources
        ) {
          if (
            !resource ||
            !resource.public_id ||
            !resource.secure_url
          ) {
            continue;
          }

          resources.push({
            publicId:
              safeString(
                resource.public_id,
                600
              ),

            secureUrl:
              safeString(
                resource.secure_url,
                1800
              ),

            version:
              Math.max(
                0,
                Number(
                  resource.version
                ) || 0
              ),

            createdAt:
              safeString(
                resource.created_at,
                80
              ),
          });
        }
      }

      nextCursor =
        result &&
        result.next_cursor
          ? String(
              result.next_cursor
            )
          : undefined;
    } while (nextCursor);

    return resources;
  }

  function rawDeliveryUrl(
    publicId
  ) {
    return cloudinary.url(
      publicId,
      {
        resource_type:
          "raw",

        type:
          "upload",

        secure:
          true,
      }
    );
  }

  async function getKnownHistoryShardResources(
    room,
    forceDiscovery = false
  ) {
    const current =
      nowMs();

    const shouldDiscover =
      !room.knownShardResources ||
      room.knownShardResources
        .size === 0 ||
      room.lastShardDiscoveryMs <=
        0 ||
      current -
        room.lastShardDiscoveryMs >=
        HISTORY_SHARD_DISCOVERY_MS ||
      (
        forceDiscovery &&
        !room.loaded
      );

    if (shouldDiscover) {
      try {
        const discovered =
          await listHistoryShardResources(
            room.id
          );

        if (
          !room.knownShardResources
        ) {
          room.knownShardResources =
            new Map();
        }

        for (
          const resource
          of discovered
        ) {
          room.knownShardResources.set(
            resource.publicId,
            resource
          );
        }

        room.lastShardDiscoveryMs =
          current;
      } catch (error) {
        room.lastShardDiscoveryMs =
          Math.max(
            0,
            current -
              HISTORY_SHARD_DISCOVERY_MS +
              5000
          );

        console.warn(
          "[LuxuryChat][HISTORY][ADMIN_DISCOVERY_FALLBACK]",
          {
            room:
              room.id,

            knownShards:
              room.knownShardResources
                ? room
                    .knownShardResources
                    .size
                : 0,

            error:
              error &&
              error.message
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error,
          }
        );
      }
    }

    return Array.from(
      (
        room.knownShardResources ||
        new Map()
      ).values()
    );
  }

  async function loadKnownHistoryShardDocument(
    room,
    resource
  ) {
    const publicId =
      safeString(
        resource &&
        resource.publicId,
        600
      );

    if (!publicId)
      return null;

    const deliveryUrl =
      rawDeliveryUrl(
        publicId
      );

    const cached =
      room.shardCache.get(
        publicId
      );

    try {
      const document =
        await fetchHistoryDocumentFromUrl(
          room.id,
          deliveryUrl
        );

      if (!document) {
        if (
          cached &&
          cached.document
        ) {
          return cached.document;
        }

        return null;
      }

      document.storagePublicId =
        publicId;

      document.storageVersion =
        Math.max(
          Number(
            resource &&
            resource.version
          ) || 0,
          Number(
            document.storageVersion
          ) || 0
        );

      document.secureUrl =
        deliveryUrl;

      room.shardCache.set(
        publicId,
        {
          version:
            document.storageVersion,

          secureUrl:
            deliveryUrl,

          document,
        }
      );

      return document;
    } catch (error) {
      if (
        cached &&
        cached.document
      ) {
        console.warn(
          "[LuxuryChat][HISTORY][DELIVERY_CACHE_FALLBACK]",
          {
            room:
              room.id,

            publicId,

            error:
              error &&
              error.message
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error,
          }
        );

        return cached.document;
      }

      throw error;
    }
  }

  function pruneExpired(room) {
    if (
      !room ||
      !Array.isArray(
        room.messages
      )
    ) {
      return false;
    }

    const cutoff =
      nowMs() -
      RETENTION_MS;

    const oldLength =
      room.messages.length;

    room.messages =
      room.messages.filter(
        (message) => {
          if (!message)
            return false;

          return (
            Math.max(
              0,
              Number(
                message.sentUnixMs
              ) || 0
            ) >
            cutoff
          );
        }
      );

    return (
      room.messages.length !==
      oldLength
    );
  }

  function mergeMessageFields(
    existing,
    incoming,
    roomId
  ) {
    if (!existing) {
      return normalizeMessage(
        incoming,
        roomId
      );
    }

    if (!incoming) {
      return normalizeMessage(
        existing,
        roomId
      );
    }

    const a =
      normalizeMessage(
        existing,
        roomId
      );

    const b =
      normalizeMessage(
        incoming,
        roomId
      );

    if (!a)
      return b;

    if (!b)
      return a;

    return {
      id:
        b.id ||
        a.id,

      clientMessageId:
        b.clientMessageId ||
        a.clientMessageId,

      seq:
        Math.max(
          Math.max(
            0,
            Number(
              a.seq
            ) || 0
          ),
          Math.max(
            0,
            Number(
              b.seq
            ) || 0
          )
        ),

      room:
        cleanRoom(
          b.room ||
          a.room ||
          roomId
        ),

      senderId:
        b.senderId ||
        a.senderId,

      senderName:
        b.senderName ||
        a.senderName ||
        "لاعب",

      senderAvatarUrl:
        b.senderAvatarUrl ||
        a.senderAvatarUrl,

      senderAvatarVersion:
        b.senderAvatarVersion ||
        a.senderAvatarVersion ||
        "0",

      sentUnixMs:
        positiveMin(
          a.sentUnixMs,
          b.sentUnixMs
        ),

      kind:
        b.kind ||
        a.kind ||
        "text",

      text:
        b.text ||
        a.text ||
        "",

      voiceUrl:
        b.voiceUrl ||
        a.voiceUrl ||
        "",

      voiceDuration:
        Math.max(
          0,
          Number(
            b.voiceDuration
          ) ||
          Number(
            a.voiceDuration
          ) ||
          0
        ),

      mediaType:
        b.mediaType ||
        a.mediaType ||
        "",

      mediaUrl:
        b.mediaUrl ||
        a.mediaUrl ||
        "",

      mediaThumbnailUrl:
        b.mediaThumbnailUrl ||
        a.mediaThumbnailUrl ||
        "",

      mediaFileName:
        b.mediaFileName ||
        a.mediaFileName ||
        "",

      replyToId:
        b.replyToId ||
        a.replyToId ||
        "",

      replyToSenderId:
        b.replyToSenderId ||
        a.replyToSenderId ||
        "",

      replyToName:
        b.replyToName ||
        a.replyToName ||
        "",

      replyToPreview:
        b.replyToPreview ||
        a.replyToPreview ||
        "",
    };
  }

  function dedupeClientMessages(
    room
  ) {
    if (
      !room ||
      !Array.isArray(
        room.messages
      )
    ) {
      return false;
    }

    const byClient =
      new Map();

    const withoutClient = [];

    let changed = false;

    for (
      const message
      of room.messages
    ) {
      if (!message)
        continue;

      const clientMessageId =
        cleanClientMessageId(
          message.clientMessageId
        );

      const senderId =
        safeString(
          message.senderId,
          100
        );

      if (
        !clientMessageId ||
        !senderId
      ) {
        withoutClient.push(
          message
        );

        continue;
      }

      const key =
        `${senderId}|${clientMessageId}`;

      const previous =
        byClient.get(key);

      if (!previous) {
        byClient.set(
          key,
          message
        );

        continue;
      }

      changed = true;

      const ordered =
        [
          previous,
          message,
        ].sort(
          (x, y) => {
            const tx =
              Math.max(
                0,
                Number(
                  x.sentUnixMs
                ) || 0
              );

            const ty =
              Math.max(
                0,
                Number(
                  y.sentUnixMs
                ) || 0
              );

            if (tx !== ty)
              return tx - ty;

            return String(
              x.id || ""
            ).localeCompare(
              String(
                y.id || ""
              )
            );
          }
        );

      byClient.set(
        key,
        mergeMessageFields(
          ordered[1],
          ordered[0],
          room.id
        )
      );
    }

    if (changed) {
      room.messages =
        withoutClient.concat(
          Array.from(
            byClient.values()
          )
        );
    }

    return changed;
  }

  function repairSequenceCollisions(
    room
  ) {
    if (
      !room ||
      !Array.isArray(
        room.messages
      )
    ) {
      return false;
    }

    room.messages.sort(
      (a, b) => {
        const ta =
          Math.max(
            0,
            Number(
              a &&
              a.sentUnixMs
            ) || 0
          );

        const tb =
          Math.max(
            0,
            Number(
              b &&
              b.sentUnixMs
            ) || 0
          );

        if (ta !== tb)
          return ta - tb;

        return String(
          (a && a.id) ||
          ""
        ).localeCompare(
          String(
            (b && b.id) ||
            ""
          )
        );
      }
    );

    let changed = false;
    let index = 0;
    let latestSeq = 0;

    while (
      index <
      room.messages.length
    ) {
      const first =
        room.messages[
          index
        ];

      const sent =
        Math.max(
          0,
          Number(
            first &&
            first.sentUnixMs
          ) || 0
        );

      let end =
        index + 1;

      while (
        end <
          room.messages
            .length &&
        Math.max(
          0,
          Number(
            room.messages[end] &&
            room.messages[end]
              .sentUnixMs
          ) || 0
        ) === sent
      ) {
        end += 1;
      }

      const groupSize =
        end - index;

      if (
        groupSize >
        4096
      ) {
        throw makeChatError(
          "HISTORY_SEQUENCE_GROUP_OVERFLOW",
          "too_many_messages_in_same_millisecond"
        );
      }

      const base =
        Math.min(
          Number.MAX_SAFE_INTEGER -
            4095,

          Math.max(
            0,
            sent
          ) *
            4096
        );

      for (
        let offset = 0;
        offset <
        groupSize;
        offset++
      ) {
        const message =
          room.messages[
            index +
            offset
          ];

        if (!message)
          continue;

        const fixed =
          base +
          offset;

        if (
          Number(
            message.seq || 0
          ) !== fixed
        ) {
          message.seq =
            fixed;

          changed = true;
        }

        latestSeq =
          Math.max(
            latestSeq,
            fixed
          );
      }

      index = end;
    }

    if (
      Number(
        room.seq || 0
      ) !== latestSeq
    ) {
      room.seq =
        latestSeq;

      changed = true;
    }

    room.messages.sort(
      compareMessages
    );

    return changed;
  }

  function mergeDocumentIntoRoom(
    room,
    document
  ) {
    if (
      !room ||
      !document ||
      !Array.isArray(
        document.messages
      )
    ) {
      return false;
    }

    const byId =
      new Map();

    for (
      const message
      of room.messages ||
      []
    ) {
      if (
        !message ||
        !message.id
      ) {
        continue;
      }

      const normalized =
        normalizeMessage(
          message,
          room.id
        );

      if (normalized) {
        byId.set(
          normalized.id,
          normalized
        );
      }
    }

    for (
      const raw
      of document.messages
    ) {
      const incoming =
        normalizeMessage(
          raw,
          room.id
        );

      if (
        !incoming ||
        !incoming.id
      ) {
        continue;
      }

      const existing =
        byId.get(
          incoming.id
        );

      byId.set(
        incoming.id,
        existing
          ? mergeMessageFields(
              existing,
              incoming,
              room.id
            )
          : incoming
      );
    }

    room.messages =
      Array.from(
        byId.values()
      );

    room.seq =
      Math.max(
        Math.max(
          0,
          Number(
            room.seq
          ) || 0
        ),

        Math.max(
          0,
          Number(
            document.seq
          ) || 0
        )
      );

    pruneExpired(room);
    dedupeClientMessages(room);
    repairSequenceCollisions(room);

    return true;
  }

  async function destroyRawAsset(
    publicId
  ) {
    try {
      await cloudinary.uploader.destroy(
        publicId,
        {
          resource_type:
            "raw",

          type:
            "upload",

          invalidate:
            true,
        }
      );

      return true;
    } catch (error) {
      console.warn(
        "[LuxuryChat][RAW_DELETE_FAILED]",
        {
          publicId,

          error:
            error &&
            error.message
              ? sanitizeUnicodeString(
                  error.message
                )
              : error,
        }
      );

      return false;
    }
  }

  function historyShardDefinitelyExpired(
    resource
  ) {
    if (
      !resource ||
      !resource.publicId
    ) {
      return false;
    }

    const dayKey =
      extractHistoryShardDay(
        resource.publicId
      );

    const dayEnd =
      dayKeyEndUnixMs(
        dayKey
      );

    if (!dayEnd)
      return false;

    return (
      dayEnd <=
      nowMs() -
        RETENTION_MS
    );
  }

  async function loadShardDocument(
    room,
    resource
  ) {
    const cached =
      room.shardCache.get(
        resource.publicId
      );

    if (
      cached &&
      cached.version ===
        resource.version &&
      cached.document
    ) {
      return cached.document;
    }

    try {
      const document =
        await fetchHistoryDocumentFromUrl(
          room.id,
          resource.secureUrl
        );

      if (!document) {
        if (
          cached &&
          cached.document
        ) {
          return cached.document;
        }

        throw makeChatError(
          "HISTORY_SHARD_NOT_READABLE",
          `history_shard_not_readable:${resource.publicId}`
        );
      }

      document.storagePublicId =
        resource.publicId;

      document.storageVersion =
        resource.version;

      document.secureUrl =
        resource.secureUrl;

      room.shardCache.set(
        resource.publicId,
        {
          version:
            resource.version,

          secureUrl:
            resource.secureUrl,

          document,
        }
      );

      return document;
    } catch (error) {
      if (
        cached &&
        cached.document
      ) {
        console.warn(
          "[LuxuryChat][HISTORY][SHARD_CACHE_FALLBACK]",
          {
            room:
              room.id,

            publicId:
              resource.publicId,

            error:
              error &&
              error.message
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error,
          }
        );

        return cached.document;
      }

      throw makeChatError(
        "HISTORY_SHARD_READ_FAILED",
        `history_shard_read_failed:${resource.publicId}`,
        {
          cause:
            error,
        }
      );
    }
  }

  async function loadLegacyHistoryDocument(
    room
  ) {
    if (
      room.legacyMissingUntilMs >
      nowMs()
    ) {
      return null;
    }

    const publicId =
      legacyHistoryPublicId(
        room.id
      );

    const deliveryUrl =
      rawDeliveryUrl(
        publicId
      );

    try {
      const document =
        await fetchHistoryDocumentFromUrl(
          room.id,
          deliveryUrl
        );

      if (!document) {
        room.legacyMissingUntilMs =
          nowMs() +
          60 *
            1000;

        return (
          room.legacyCache &&
          room.legacyCache
            .document
            ? room
                .legacyCache
                .document
            : null
        );
      }

      document.storagePublicId =
        publicId;

      document.storageVersion =
        0;

      document.secureUrl =
        deliveryUrl;

      room.legacyCache = {
        version:
          0,

        secureUrl:
          deliveryUrl,

        document,
      };

      return document;
    } catch (error) {
      if (
        room.legacyCache &&
        room.legacyCache
          .document
      ) {
        console.warn(
          "[LuxuryChat][HISTORY][LEGACY_CACHE_FALLBACK]",
          {
            room:
              room.id,

            error:
              error &&
              error.message
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error,
          }
        );

        return room
          .legacyCache
          .document;
      }

      room.legacyMissingUntilMs =
        nowMs() +
        60 *
          1000;

      console.warn(
        "[LuxuryChat][HISTORY][LEGACY_SKIPPED]",
        {
          room:
            room.id,

          error:
            error &&
            error.message
              ? sanitizeUnicodeString(
                  error.message
                )
              : error,
        }
      );

      return null;
    }
  }

  async function deleteExpiredShardIfSafe(
    room,
    resource,
    document
  ) {
    if (
      !resource ||
      !resource.publicId
    ) {
      return;
    }

    const ownLiveShardPrefix =
      `${utcDayKey(
        nowMs()
      )}_${HISTORY_INSTANCE_TOKEN}.json`;

    if (
      resource.publicId.endsWith(
        ownLiveShardPrefix
      )
    ) {
      return;
    }

    let safeToDelete =
      historyShardDefinitelyExpired(
        resource
      );

    if (
      document &&
      Array.isArray(
        document.messages
      ) &&
      document.messages.length >
        0
    ) {
      let newest = 0;

      for (
        const message
        of document.messages
      ) {
        newest =
          Math.max(
            newest,
            Math.max(
              0,
              Number(
                message &&
                message.sentUnixMs
              ) || 0
            )
          );
      }

      safeToDelete =
        !!newest &&
        newest <=
          nowMs() -
            RETENTION_MS;
    }

    if (!safeToDelete)
      return;

    if (
      await destroyRawAsset(
        resource.publicId
      )
    ) {
      room.shardCache.delete(
        resource.publicId
      );

      if (
        room.knownShardResources
      ) {
        room.knownShardResources.delete(
          resource.publicId
        );
      }

      console.log(
        "[LuxuryChat][HISTORY][EXPIRED_SHARD_DELETED]",
        {
          room:
            room.id,

          publicId:
            resource.publicId,
        }
      );
    }
  }

  async function syncRoomFromStorage(
    roomId,
    force = false
  ) {
    const room =
      getRoom(
        roomId
      );

    if (
      !force &&
      room.loaded &&
      room.lastStorageSyncMs >
        0 &&
      nowMs() -
        room.lastStorageSyncMs <
        HISTORY_CACHE_SYNC_MS
    ) {
      return room;
    }

    if (room.syncPromise)
      return room.syncPromise;

    room.syncPromise =
      (async () => {
        try {
          const resources =
            await getKnownHistoryShardResources(
              room,
              force
            );

          const activeResources = [];
          const expiredResources = [];

          for (
            const resource
            of resources
          ) {
            if (
              historyShardDefinitelyExpired(
                resource
              )
            ) {
              expiredResources.push(
                resource
              );
            } else {
              activeResources.push(
                resource
              );
            }
          }

          for (
            const resource
            of expiredResources
          ) {
            const cached =
              room.shardCache.get(
                resource.publicId
              );

            if (
              cached &&
              cached.document
            ) {
              mergeDocumentIntoRoom(
                room,
                cached.document
              );
            }
          }

          const shardPairs =
            await Promise.all(
              activeResources.map(
                async (
                  resource
                ) => ({
                  resource,

                  document:
                    await loadKnownHistoryShardDocument(
                      room,
                      resource
                    ),
                })
              )
            );

          for (
            const pair
            of shardPairs
          ) {
            if (!pair.document) {
              throw makeChatError(
                "HISTORY_INCOMPLETE_SNAPSHOT",
                `history_incomplete_snapshot:${pair.resource.publicId}`
              );
            }

            mergeDocumentIntoRoom(
              room,
              pair.document
            );
          }

          try {
            const legacy =
              await loadLegacyHistoryDocument(
                room
              );

            if (legacy) {
              mergeDocumentIntoRoom(
                room,
                legacy
              );
            }
          } catch (error) {
            if (force)
              throw error;

            if (
              !room.loaded &&
              room.messages.length ===
                0
            ) {
              throw error;
            }

            console.warn(
              "[LuxuryChat][HISTORY][LEGACY_CACHE_FALLBACK]",
              {
                room:
                  room.id,

                error:
                  error &&
                  error.message
                    ? sanitizeUnicodeString(
                        error.message
                      )
                    : error,
              }
            );
          }

          pruneExpired(room);
          dedupeClientMessages(room);
          repairSequenceCollisions(room);

          room.loaded = true;

          room.lastStorageSyncMs =
            nowMs();

          Promise.all([
            ...expiredResources.map(
              (resource) =>
                deleteExpiredShardIfSafe(
                  room,
                  resource,
                  room.shardCache.get(
                    resource.publicId
                  )?.document ||
                    null
                )
            ),

            ...shardPairs.map(
              (pair) =>
                deleteExpiredShardIfSafe(
                  room,
                  pair.resource,
                  pair.document
                )
            ),
          ]).catch(
            () => {}
          );

          return room;
        } catch (error) {
          console.warn(
            "[LuxuryChat][HISTORY][SYNC][SEND_SAFE_FALLBACK]",
            {
              room:
                room.id,

              force:
                !!force,

              loaded:
                !!room.loaded,

              cachedMessages:
                Array.isArray(
                  room.messages
                )
                  ? room
                      .messages
                      .length
                  : 0,

              error:
                error &&
                error.message
                  ? sanitizeUnicodeString(
                      error.message
                    )
                  : error,
            }
          );

          room.loaded = true;

          room.lastStorageSyncMs =
            nowMs() -
            HISTORY_CACHE_SYNC_MS +
            250;

          pruneExpired(room);
          dedupeClientMessages(room);
          repairSequenceCollisions(room);

          return room;
        } finally {
          room.syncPromise =
            null;
        }
      })();

    return room.syncPromise;
  }

  async function ensureRoomLoaded(
    roomId,
    options = {}
  ) {
    const room =
      getRoom(
        roomId
      );

    const forceStorageRefresh =
      !!options.forceStorageRefresh;

    if (
      !room.loaded ||
      forceStorageRefresh
    ) {
      return syncRoomFromStorage(
        roomId,
        true
      );
    }

    return syncRoomFromStorage(
      roomId,
      false
    );
  }

  function findMessage(
    room,
    messageId
  ) {
    if (
      !room ||
      !messageId
    ) {
      return null;
    }

    for (
      let i =
        room.messages.length -
        1;
      i >= 0;
      i--
    ) {
      const message =
        room.messages[i];

      if (
        message &&
        message.id ===
          messageId
      ) {
        return message;
      }
    }

    return null;
  }

  function findClientMessage(
    room,
    senderId,
    clientMessageId
  ) {
    if (
      !room ||
      !senderId ||
      !clientMessageId
    ) {
      return null;
    }

    for (
      let i =
        room.messages.length -
        1;
      i >= 0;
      i--
    ) {
      const message =
        room.messages[i];

      if (
        message &&
        message.senderId ===
          senderId &&
        message.clientMessageId ===
          clientMessageId
      ) {
        return message;
      }
    }

    return null;
  }

  function requiredMessageExists(
    document,
    requirement
  ) {
    if (!requirement)
      return true;

    if (
      !document ||
      !Array.isArray(
        document.messages
      )
    ) {
      return false;
    }

    if (
      requirement.messageId &&
      document.messages.some(
        (m) =>
          m &&
          m.id ===
            requirement.messageId
      )
    ) {
      return true;
    }

    if (
      requirement.senderId &&
      requirement.clientMessageId
    ) {
      return document.messages.some(
        (m) =>
          m &&
          m.senderId ===
            requirement.senderId &&
          m.clientMessageId ===
            requirement.clientMessageId
      );
    }

    return false;
  }

  function buildShardPayload(
    roomId,
    dayKey,
    messages
  ) {
    const tempRoom = {
      id:
        cleanRoom(
          roomId
        ),

      seq:
        0,

      messages:
        (
          messages ||
          []
        )
          .map(
            (m) =>
              normalizeMessage(
                m,
                roomId
              )
          )
          .filter(
            Boolean
          ),
    };

    pruneExpired(
      tempRoom
    );

    dedupeClientMessages(
      tempRoom
    );

    repairSequenceCollisions(
      tempRoom
    );

    return sanitizeJsonForUnity({
      version:
        13,

      build:
        SERVER_BUILD,

      storageMode:
        "render-process-daily-shard",

      room:
        cleanRoom(
          roomId
        ),

      shardDay:
        dayKey,

      shardInstance:
        HISTORY_INSTANCE_TOKEN,

      seq:
        Math.max(
          0,
          Number(
            tempRoom.seq
          ) || 0
        ),

      retentionDays:
        RETENTION_DAYS,

      savedAtUnixMs:
        nowMs(),

      messages:
        tempRoom.messages,
    });
  }

  async function loadLocalShard(
    room,
    dayKey
  ) {
    const publicId =
      historyShardPublicId(
        room.id,
        dayKey
      );

    const cached =
      room.shardCache.get(
        publicId
      );

    if (
      cached &&
      cached.document
    ) {
      return {
        publicId,

        version:
          cached.version ||
          0,

        secureUrl:
          cached.secureUrl ||
          "",

        document:
          cached.document,
      };
    }

    const deliveryUrl =
      rawDeliveryUrl(
        publicId
      );

    const document =
      await fetchHistoryDocumentFromUrl(
        room.id,
        deliveryUrl
      );

    if (!document) {
      return {
        publicId,

        version:
          0,

        secureUrl:
          deliveryUrl,

        document: {
          exists:
            true,

          version:
            13,

          room:
            room.id,

          seq:
            0,

          retentionDays:
            RETENTION_DAYS,

          savedAtUnixMs:
            0,

          messages:
            [],
        },
      };
    }

    document.storagePublicId =
      publicId;

    document.storageVersion =
      0;

    document.secureUrl =
      deliveryUrl;

    room.shardCache.set(
      publicId,
      {
        version:
          0,

        secureUrl:
          deliveryUrl,

        document,
      }
    );

    return {
      publicId,

      version:
        0,

      secureUrl:
        deliveryUrl,

      document,
    };
  }

  async function saveRoomNow(
    roomId,
    requirement = null
  ) {
    const room =
      getRoom(
        roomId
      );

    if (!requirement) {
      pruneExpired(room);
      dedupeClientMessages(room);
      repairSequenceCollisions(room);

      return room;
    }

    let target =
      requirement.messageId
        ? findMessage(
            room,
            requirement.messageId
          )
        : null;

    if (
      !target &&
      requirement.senderId &&
      requirement.clientMessageId
    ) {
      target =
        findClientMessage(
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

    target =
      normalizeMessage(
        target,
        room.id
      );

    if (!target) {
      throw makeChatError(
        "HISTORY_TARGET_INVALID",
        "chat_history_target_invalid"
      );
    }

    const dayKey =
      utcDayKey(
        target.sentUnixMs
      );

    let lastError =
      null;

    for (
      let attempt = 1;
      attempt <=
      HISTORY_WRITE_VERIFY_ATTEMPTS;
      attempt++
    ) {
      try {
        const localShard =
          await loadLocalShard(
            room,
            dayKey
          );

        const localMessages =
          Array.isArray(
            localShard
              .document
              .messages
          )
            ? localShard
                .document
                .messages
                .slice()
            : [];

        const existingById =
          localMessages.some(
            (m) =>
              m &&
              m.id ===
                target.id
          );

        const existingByClient =
          target.senderId &&
          target.clientMessageId &&
          localMessages.some(
            (m) =>
              m &&
              m.senderId ===
                target.senderId &&
              m.clientMessageId ===
                target.clientMessageId
          );

        if (
          !existingById &&
          !existingByClient
        ) {
          localMessages.push(
            target
          );
        }

        const payload =
          buildShardPayload(
            room.id,
            dayKey,
            localMessages
          );

        const uploadResult =
          await uploadRawJson(
            localShard.publicId,
            payload
          );

        if (
          !uploadResult ||
          !uploadResult.secure_url
        ) {
          throw new Error(
            "history_shard_upload_missing_url"
          );
        }

        if (
          HISTORY_WRITE_VERIFY_SETTLE_MS >
          0
        ) {
          await sleep(
            HISTORY_WRITE_VERIFY_SETTLE_MS
          );
        }

        const verifyDocument =
          await fetchHistoryDocumentFromUrl(
            room.id,
            uploadResult.secure_url
          );

        if (
          !verifyDocument ||
          !requiredMessageExists(
            verifyDocument,
            requirement
          )
        ) {
          throw new Error(
            "history_shard_verify_required_message_missing"
          );
        }

        verifyDocument.storagePublicId =
          localShard.publicId;

        verifyDocument.storageVersion =
          Math.max(
            0,
            Number(
              uploadResult.version
            ) || 0
          );

        verifyDocument.secureUrl =
          safeString(
            uploadResult.secure_url,
            1800
          );

        room.shardCache.set(
          localShard.publicId,
          {
            version:
              verifyDocument.storageVersion,

            secureUrl:
              verifyDocument.secureUrl,

            document:
              verifyDocument,
          }
        );

        if (
          !room.knownShardResources
        ) {
          room.knownShardResources =
            new Map();
        }

        room.knownShardResources.set(
          localShard.publicId,
          {
            publicId:
              localShard.publicId,

            secureUrl:
              verifyDocument.secureUrl,

            version:
              verifyDocument.storageVersion,

            createdAt:
              "",
          }
        );

        room.lastStorageSavedAtUnixMs =
          nowMs();

        room.lastStorageSyncMs =
          nowMs();

        return room;
      } catch (error) {
        lastError =
          error;

        if (
          attempt <
          HISTORY_WRITE_VERIFY_ATTEMPTS
        ) {
          room.shardCache.delete(
            historyShardPublicId(
              room.id,
              dayKey
            )
          );

          await sleep(
            120 *
            attempt
          );
        }
      }
    }

    throw (
      lastError ||
      new Error(
        "chat_history_shard_write_verify_failed"
      )
    );
  }

  function enqueueRoomMutation(
    roomId,
    operation
  ) {
    const room =
      getRoom(
        roomId
      );

    room.mutationChain =
      room.mutationChain
        .catch(
          () => {}
        )
        .then(
          operation
        );

    return room.mutationChain;
  }

  function enqueueRoomSave(
    roomId
  ) {
    return enqueueRoomMutation(
      roomId,
      async () => {
        const room =
          await ensureRoomLoaded(
            roomId,
            {
              forceStorageRefresh:
                false,
            }
          );

        pruneExpired(room);
        dedupeClientMessages(room);
        repairSequenceCollisions(room);

        return room;
      }
    );
  }

  async function pushMessage(
    roomId,
    message
  ) {
    return enqueueRoomMutation(
      roomId,
      async () => {
        const room =
          await ensureRoomLoaded(
            roomId,
            {
              forceStorageRefresh:
                true,
            }
          );

        pruneExpired(room);
        dedupeClientMessages(room);
        repairSequenceCollisions(room);

        message =
          normalizeMessage(
            message,
            roomId
          );

        if (!message) {
          throw makeChatError(
            "MESSAGE_INVALID",
            "chat_message_invalid"
          );
        }

        if (
          message.senderId &&
          message.clientMessageId
        ) {
          const duplicate =
            findClientMessage(
              room,
              message.senderId,
              message.clientMessageId
            );

          if (duplicate)
            return duplicate;
        }

        message.room =
          cleanRoom(
            roomId
          );

        room.messages.push(
          message
        );

        repairSequenceCollisions(
          room
        );

        const requirement = {
          messageId:
            message.id,

          senderId:
            message.senderId,

          clientMessageId:
            message.clientMessageId,
        };

        try {
          await saveRoomNow(
            roomId,
            requirement
          );
        } catch (error) {
          room.messages =
            room.messages.filter(
              (m) =>
                m &&
                m.id !==
                  message.id
            );

          room.seq = 0;

          repairSequenceCollisions(
            room
          );

          throw error;
        }

        if (
          message.senderId &&
          message.clientMessageId
        ) {
          const canonical =
            findClientMessage(
              room,
              message.senderId,
              message.clientMessageId
            );

          if (canonical)
            return canonical;
        }

        return (
          findMessage(
            room,
            message.id
          ) ||
          message
        );
      }
    );
  }

  // ========================================================================
  // VIDEO MODERATION JOB PERSISTENCE - V13
  // ========================================================================

  function legacyVideoJobsUrl() {
    const base =
      cloudinary.url(
        LEGACY_VIDEO_JOBS_PUBLIC_ID,
        {
          resource_type:
            "raw",

          type:
            "upload",

          secure:
            true,
        }
      );

    return addCacheBust(
      base
    );
  }

  function videoJobsShardPrefix() {
    return `${VIDEO_JOBS_FOLDER}/`;
  }

  function videoJobsShardPublicId(
    dayKey =
      utcDayKey(
        nowMs()
      )
  ) {
    return `${VIDEO_JOBS_FOLDER}/${dayKey}_${HISTORY_INSTANCE_TOKEN}.json`;
  }

  function extractVideoJobShardDay(
    publicId
  ) {
    const match =
      safeString(
        publicId,
        1000
      ).match(
        /\/(\d{8})_[^/]+\.json$/
      );

    return match
      ? match[1]
      : "";
  }

  function getVideoJobsCryptoKey() {
    if (
      !CLOUDINARY_API_SECRET
    ) {
      throw new Error(
        "CLOUDINARY_API_SECRET missing for video jobs encryption"
      );
    }

    return crypto
      .createHash(
        "sha256"
      )
      .update(
        `luxury-chat-video-jobs-v1|${CLOUDINARY_API_SECRET}`,
        "utf8"
      )
      .digest();
  }

  function encryptVideoJobsPayload(
    object
  ) {
    const iv =
      crypto.randomBytes(
        12
      );

    const key =
      getVideoJobsCryptoKey();

    const cipher =
      crypto.createCipheriv(
        "aes-256-gcm",
        key,
        iv
      );

    const plain =
      Buffer.from(
        safeJsonStringify(
          object
        ),
        "utf8"
      );

    const encrypted =
      Buffer.concat([
        cipher.update(
          plain
        ),
        cipher.final(),
      ]);

    const tag =
      cipher.getAuthTag();

    return {
      version:
        1,

      algorithm:
        "aes-256-gcm",

      iv:
        iv.toString(
          "base64"
        ),

      tag:
        tag.toString(
          "base64"
        ),

      data:
        encrypted.toString(
          "base64"
        ),
    };
  }

  function decryptVideoJobsPayload(
    envelope
  ) {
    if (
      !envelope ||
      typeof envelope !==
        "object" ||
      envelope.algorithm !==
        "aes-256-gcm" ||
      !envelope.iv ||
      !envelope.tag ||
      !envelope.data
    ) {
      throw new Error(
        "video_jobs_invalid_envelope"
      );
    }

    const key =
      getVideoJobsCryptoKey();

    const iv =
      Buffer.from(
        String(
          envelope.iv
        ),
        "base64"
      );

    const tag =
      Buffer.from(
        String(
          envelope.tag
        ),
        "base64"
      );

    const encrypted =
      Buffer.from(
        String(
          envelope.data
        ),
        "base64"
      );

    const decipher =
      crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        iv
      );

    decipher.setAuthTag(
      tag
    );

    const plain =
      Buffer.concat([
        decipher.update(
          encrypted
        ),

        decipher.final(),
      ]).toString(
        "utf8"
      );

    return JSON.parse(
      plain
    );
  }

  function isTerminalVideoStatus(
    status
  ) {
    const value =
      safeString(
        status,
        30
      ).toLowerCase();

    return (
      value === "approved" ||
      value === "rejected" ||
      value === "failed"
    );
  }

  function normalizeVideoJob(
    raw
  ) {
    if (
      !raw ||
      typeof raw !==
        "object"
    ) {
      return null;
    }

    const jobId =
      safeString(
        raw.jobId,
        100
      );

    const publicId =
      safeString(
        raw.publicId,
        500
      );

    const senderId =
      safeString(
        raw.senderId,
        100
      );

    const roomId =
      cleanRoom(
        raw.roomId ||
        raw.room ||
        "global"
      );

    const clientMessageId =
      cleanClientMessageId(
        raw.clientMessageId
      );

    if (
      !jobId ||
      !publicId ||
      !senderId ||
      !clientMessageId
    ) {
      return null;
    }

    const profileRaw =
      raw.profile &&
      typeof raw.profile ===
        "object"
        ? raw.profile
        : {};

    const replyRaw =
      raw.reply &&
      typeof raw.reply ===
        "object"
        ? raw.reply
        : {};

    return {
      jobId,

      publicId,

      senderId,

      roomId,

      clientMessageId,

      status:
        safeString(
          raw.status,
          30
        ) || "pending",

      moderationStatus:
        safeString(
          raw.moderationStatus,
          30
        ) || "pending",

      createdAtUnixMs:
        Math.max(
          0,
          Number(
            raw.createdAtUnixMs
          ) || 0
        ) ||
        nowMs(),

      updatedAtUnixMs:
        Math.max(
          0,
          Number(
            raw.updatedAtUnixMs
          ) || 0
        ) ||
        nowMs(),

      uploadCompleted:
        !!raw.uploadCompleted,

      lastCloudinaryCheckUnixMs:
        Math.max(
          0,
          Number(
            raw.lastCloudinaryCheckUnixMs
          ) || 0
        ),

      mediaUrl:
        safeString(
          raw.mediaUrl,
          1600
        ),

      mediaThumbnailUrl:
        safeString(
          raw.mediaThumbnailUrl,
          1600
        ),

      mediaFileName:
        safeString(
          raw.mediaFileName,
          180
        ) ||
        "chat_video.mp4",

      rejectReason:
        safeString(
          raw.rejectReason,
          300
        ),

      messageId:
        safeString(
          raw.messageId,
          100
        ),

      profile: {
        playerName:
          safeString(
            profileRaw.playerName,
            64
          ) ||
          "لاعب",

        avatarUrl:
          safeString(
            profileRaw.avatarUrl,
            1000
          ),

        avatarVersion:
          safeString(
            profileRaw.avatarVersion,
            100
          ) ||
          "0",
      },

      reply: {
        replyToId:
          safeString(
            replyRaw.replyToId,
            100
          ),

        replyToSenderId:
          safeString(
            replyRaw.replyToSenderId,
            100
          ),

        replyToName:
          safeString(
            replyRaw.replyToName,
            64
          ),

        replyToPreview:
          safeString(
            replyRaw.replyToPreview,
            120
          ),
      },
    };
  }

  function videoJobStatusRank(
    status
  ) {
    switch (
      safeString(
        status,
        30
      ).toLowerCase()
    ) {
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

  function mergeVideoJob(
    job
  ) {
    const incoming =
      normalizeVideoJob(
        job
      );

    if (!incoming)
      return null;

    const existing =
      videoJobs.get(
        incoming.publicId
      );

    if (!existing) {
      videoJobs.set(
        incoming.publicId,
        incoming
      );

      return incoming;
    }

    const incomingUpdated =
      Math.max(
        0,
        Number(
          incoming.updatedAtUnixMs
        ) || 0
      );

    const existingUpdated =
      Math.max(
        0,
        Number(
          existing.updatedAtUnixMs
        ) || 0
      );

    let newer =
      existing;

    let older =
      incoming;

    if (
      incomingUpdated >
        existingUpdated ||
      (
        incomingUpdated ===
          existingUpdated &&
        videoJobStatusRank(
          incoming.status
        ) >
          videoJobStatusRank(
            existing.status
          )
      )
    ) {
      newer =
        incoming;

      older =
        existing;
    }

    const merged =
      normalizeVideoJob(
        newer
      ) ||
      {
        ...newer,
      };

    merged.createdAtUnixMs =
      positiveMin(
        existing.createdAtUnixMs,
        incoming.createdAtUnixMs
      );

    merged.updatedAtUnixMs =
      Math.max(
        existingUpdated,
        incomingUpdated
      );

    merged.lastCloudinaryCheckUnixMs =
      Math.max(
        Number(
          existing.lastCloudinaryCheckUnixMs ||
          0
        ),

        Number(
          incoming.lastCloudinaryCheckUnixMs ||
          0
        )
      );

    merged.uploadCompleted =
      !!(
        existing.uploadCompleted ||
        incoming.uploadCompleted
      );

    merged.mediaUrl =
      newer.mediaUrl ||
      older.mediaUrl ||
      "";

    merged.mediaThumbnailUrl =
      newer.mediaThumbnailUrl ||
      older.mediaThumbnailUrl ||
      "";

    merged.mediaFileName =
      newer.mediaFileName ||
      older.mediaFileName ||
      "chat_video.mp4";

    merged.messageId =
      newer.messageId ||
      older.messageId ||
      "";

    merged.rejectReason =
      newer.rejectReason ||
      older.rejectReason ||
      "";

    merged.profile = {
      playerName:
        safeString(
          newer.profile &&
          newer.profile.playerName,
          64
        ) ||
        safeString(
          older.profile &&
          older.profile.playerName,
          64
        ) ||
        "لاعب",

      avatarUrl:
        safeString(
          newer.profile &&
          newer.profile.avatarUrl,
          1000
        ) ||
        safeString(
          older.profile &&
          older.profile.avatarUrl,
          1000
        ) ||
        "",

      avatarVersion:
        safeString(
          newer.profile &&
          newer.profile.avatarVersion,
          100
        ) ||
        safeString(
          older.profile &&
          older.profile.avatarVersion,
          100
        ) ||
        "0",
    };

    merged.reply = {
      replyToId:
        safeString(
          newer.reply &&
          newer.reply.replyToId,
          100
        ) ||
        safeString(
          older.reply &&
          older.reply.replyToId,
          100
        ) ||
        "",

      replyToSenderId:
        safeString(
          newer.reply &&
          newer.reply.replyToSenderId,
          100
        ) ||
        safeString(
          older.reply &&
          older.reply.replyToSenderId,
          100
        ) ||
        "",

      replyToName:
        safeString(
          newer.reply &&
          newer.reply.replyToName,
          64
        ) ||
        safeString(
          older.reply &&
          older.reply.replyToName,
          64
        ) ||
        "",

      replyToPreview:
        safeString(
          newer.reply &&
          newer.reply.replyToPreview,
          120
        ) ||
        safeString(
          older.reply &&
          older.reply.replyToPreview,
          120
        ) ||
        "",
    };

    const existingTerminal =
      isTerminalVideoStatus(
        existing.status
      );

    const incomingTerminal =
      isTerminalVideoStatus(
        incoming.status
      );

    if (
      existingTerminal &&
      !incomingTerminal
    ) {
      merged.status =
        existing.status;
    } else if (
      incomingTerminal &&
      !existingTerminal
    ) {
      merged.status =
        incoming.status;
    } else if (
      existingTerminal &&
      incomingTerminal
    ) {
      if (
        incomingUpdated >
        existingUpdated
      ) {
        merged.status =
          incoming.status;
      } else if (
        existingUpdated >
        incomingUpdated
      ) {
        merged.status =
          existing.status;
      } else {
        merged.status =
          videoJobStatusRank(
            incoming.status
          ) >=
          videoJobStatusRank(
            existing.status
          )
            ? incoming.status
            : existing.status;
      }
    }

    const existingModerationFinal =
      existing.moderationStatus ===
        "approved" ||
      existing.moderationStatus ===
        "rejected";

    const incomingModerationFinal =
      incoming.moderationStatus ===
        "approved" ||
      incoming.moderationStatus ===
        "rejected";

    if (
      existingModerationFinal &&
      !incomingModerationFinal
    ) {
      merged.moderationStatus =
        existing.moderationStatus;
    } else if (
      incomingModerationFinal &&
      !existingModerationFinal
    ) {
      merged.moderationStatus =
        incoming.moderationStatus;
    } else if (
      existingModerationFinal &&
      incomingModerationFinal
    ) {
      if (
        incomingUpdated >
        existingUpdated
      ) {
        merged.moderationStatus =
          incoming.moderationStatus;
      } else if (
        existingUpdated >
        incomingUpdated
      ) {
        merged.moderationStatus =
          existing.moderationStatus;
      } else if (
        incoming.moderationStatus ===
        "rejected"
      ) {
        merged.moderationStatus =
          "rejected";
      } else {
        merged.moderationStatus =
          existing.moderationStatus;
      }
    }

    if (
      merged.status ===
      "rejected"
    ) {
      merged.rejectReason =
        safeString(
          incoming.rejectReason,
          300
        ) ||
        safeString(
          existing.rejectReason,
          300
        ) ||
        merged.rejectReason ||
        "تم رفض الفيديو لأنه يحتوي على محتوى غير مناسب للشات";
    }

    videoJobs.set(
      merged.publicId,
      merged
    );

    return merged;
  }

  function pruneVideoJobsInMemory() {
    const cutoff =
      nowMs() -
      VIDEO_JOB_RETENTION_MS;

    let changed =
      false;

    for (
      const [
        publicId,
        job,
      ]
      of videoJobs.entries()
    ) {
      if (!job) {
        videoJobs.delete(
          publicId
        );

        changed =
          true;

        continue;
      }

      const updated =
        Math.max(
          0,
          Number(
            job.updatedAtUnixMs
          ) || 0
        );

      if (
        updated > 0 &&
        updated <= cutoff &&
        isTerminalVideoStatus(
          job.status
        )
      ) {
        videoJobs.delete(
          publicId
        );

        changed =
          true;
      }
    }

    return changed;
  }

  async function listVideoJobShardResources() {
    const resources = [];

    let nextCursor =
      undefined;

    do {
      const result =
        await cloudinary.api.resources(
          {
            resource_type:
              "raw",

            type:
              "upload",

            prefix:
              videoJobsShardPrefix(),

            max_results:
              500,

            ...(nextCursor
              ? {
                  next_cursor:
                    nextCursor,
                }
              : {}),
          }
        );

      if (
        result &&
        Array.isArray(
          result.resources
        )
      ) {
        for (
          const resource
          of result.resources
        ) {
          if (
            !resource ||
            !resource.public_id ||
            !resource.secure_url
          ) {
            continue;
          }

          resources.push({
            publicId:
              safeString(
                resource.public_id,
                600
              ),

            secureUrl:
              safeString(
                resource.secure_url,
                1800
              ),

            version:
              Math.max(
                0,
                Number(
                  resource.version
                ) || 0
              ),

            createdAt:
              safeString(
                resource.created_at,
                80
              ),
          });
        }
      }

      nextCursor =
        result &&
        result.next_cursor
          ? String(
              result.next_cursor
            )
          : undefined;
    } while (nextCursor);

    return resources;
  }

  async function getKnownVideoJobShardResources(
    forceDiscovery = false
  ) {
    const current =
      nowMs();

    const shouldDiscover =
      videoJobKnownResources.size ===
        0 ||
      lastVideoJobShardDiscoveryUnixMs <=
        0 ||
      current -
        lastVideoJobShardDiscoveryUnixMs >=
        VIDEO_JOB_SHARD_DISCOVERY_MS ||
      (
        forceDiscovery &&
        !videoJobsLoaded
      );

    if (shouldDiscover) {
      try {
        const discovered =
          await listVideoJobShardResources();

        for (
          const resource
          of discovered
        ) {
          videoJobKnownResources.set(
            resource.publicId,
            resource
          );
        }

        lastVideoJobShardDiscoveryUnixMs =
          current;
      } catch (error) {
        lastVideoJobShardDiscoveryUnixMs =
          Math.max(
            0,
            current -
              VIDEO_JOB_SHARD_DISCOVERY_MS +
              5000
          );

        console.warn(
          "[LuxuryChat][VIDEO_JOBS][ADMIN_DISCOVERY_FALLBACK]",
          {
            knownShards:
              videoJobKnownResources.size,

            error:
              error &&
              error.message
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error,
          }
        );
      }
    }

    return Array.from(
      videoJobKnownResources.values()
    );
  }

  function videoJobShardDefinitelyExpired(
    resource
  ) {
    if (
      !resource ||
      !resource.publicId
    ) {
      return false;
    }

    const shardDay =
      extractVideoJobShardDay(
        resource.publicId
      );

    const dayEnd =
      dayKeyEndUnixMs(
        shardDay
      );

    if (!dayEnd)
      return false;

    return (
      dayEnd <=
      nowMs() -
        VIDEO_JOB_RETENTION_MS
    );
  }

  async function readEncryptedVideoJobsUrl(
    url
  ) {
    const response =
      await fetchWithTimeout(
        addCacheBust(
          url
        ),
        {
          method:
            "GET",

          headers: {
            "Cache-Control":
              "no-cache, no-store, max-age=0",

            Pragma:
              "no-cache",
          },
        },
        DIRECT_FETCH_TIMEOUT_MS
      );

    if (
      response.status ===
      404
    ) {
      return null;
    }

    if (!response.ok) {
      throw new Error(
        `video_jobs_load_http_${response.status}`
      );
    }

    let envelope;

    try {
      envelope =
        JSON.parse(
          await response.text()
        );
    } catch (_) {
      throw new Error(
        "video_jobs_invalid_json"
      );
    }

    const decoded =
      decryptVideoJobsPayload(
        envelope
      );

    if (
      !decoded ||
      !Array.isArray(
        decoded.jobs
      )
    ) {
      return [];
    }

    return decoded.jobs.map(
      (job) =>
        sanitizeJsonForUnity(
          job
        )
    );
  }

  function videoJobShardCanBeDeleted(
    resource,
    jobs,
    authoritativeJobs
  ) {
    if (
      !resource ||
      !Array.isArray(jobs)
    ) {
      return false;
    }

    const shardDay =
      extractVideoJobShardDay(
        resource.publicId
      );

    if (!shardDay)
      return false;

    const currentDay =
      utcDayKey(
        nowMs()
      );

    if (
      shardDay >=
      currentDay
    ) {
      return false;
    }

    const cutoff =
      nowMs() -
      VIDEO_JOB_RETENTION_MS;

    if (
      jobs.length === 0
    ) {
      return (
        dayKeyEndUnixMs(
          shardDay
        ) > 0 &&
        dayKeyEndUnixMs(
          shardDay
        ) <= cutoff
      );
    }

    for (
      const rawJob
      of jobs
    ) {
      const job =
        normalizeVideoJob(
          rawJob
        );

      if (!job)
        continue;

      const rawUpdated =
        Math.max(
          0,
          Number(
            job.updatedAtUnixMs
          ) || 0
        );

      if (
        isTerminalVideoStatus(
          job.status
        ) &&
        rawUpdated > 0 &&
        rawUpdated <=
          cutoff
      ) {
        continue;
      }

      const authoritative =
        authoritativeJobs.get(
          job.publicId
        );

      if (!authoritative)
        return false;

      const authUpdated =
        Math.max(
          0,
          Number(
            authoritative.updatedAtUnixMs
          ) || 0
        );

      if (
        !isTerminalVideoStatus(
          authoritative.status
        ) ||
        authUpdated <
          rawUpdated ||
        authUpdated >
          cutoff
      ) {
        return false;
      }
    }

    return true;
  }

  async function cleanupExpiredVideoJobShards(
    shardPairs
  ) {
    if (
      !Array.isArray(
        shardPairs
      ) ||
      shardPairs.length ===
        0
    ) {
      return;
    }

    const authoritativeJobs =
      new Map(
        videoJobs
      );

    const ownCurrentPublicId =
      videoJobsShardPublicId(
        utcDayKey(
          nowMs()
        )
      );

    await Promise.all(
      shardPairs.map(
        async (pair) => {
          if (
            !pair ||
            !pair.resource ||
            !Array.isArray(
              pair.jobs
            )
          ) {
            return;
          }

          if (
            pair.resource.publicId ===
            ownCurrentPublicId
          ) {
            return;
          }

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
            await destroyRawAsset(
              pair.resource.publicId
            );

            videoJobShardCache.delete(
              pair.resource.publicId
            );

            videoJobKnownResources.delete(
              pair.resource.publicId
            );

            console.log(
              "[LuxuryChat][VIDEO_JOBS][EXPIRED_SHARD_DELETED]",
              {
                publicId:
                  pair.resource
                    .publicId,
              }
            );
          } catch (error) {
            console.warn(
              "[LuxuryChat][VIDEO_JOBS][EXPIRED_SHARD_DELETE_FAILED]",
              {
                publicId:
                  pair.resource
                    .publicId,

                error:
                  error &&
                  error.message
                    ? sanitizeUnicodeString(
                        error.message
                      )
                    : error,
              }
            );
          }
        }
      )
    );
  }

  async function loadVideoJobsFromStorage(
    forceDiscovery = false
  ) {
    const resources =
      await getKnownVideoJobShardResources(
        forceDiscovery
      );

    const shardPairs = [];

    for (
      const resource
      of resources
    ) {
      const cached =
        videoJobShardCache.get(
          resource.publicId
        );

      let jobs = null;

      try {
        jobs =
          await readEncryptedVideoJobsUrl(
            rawDeliveryUrl(
              resource.publicId
            )
          );

        if (!jobs) {
          throw new Error(
            "video_jobs_shard_not_found"
          );
        }

        videoJobShardCache.set(
          resource.publicId,
          {
            version:
              resource.version,

            secureUrl:
              rawDeliveryUrl(
                resource.publicId
              ),

            jobs,
          }
        );
      } catch (error) {
        if (
          cached &&
          cached.jobs
        ) {
          jobs =
            cached.jobs;

          console.warn(
            "[LuxuryChat][VIDEO_JOBS][SHARD_CACHE_FALLBACK]",
            {
              publicId:
                resource.publicId,

              error:
                error &&
                error.message
                  ? sanitizeUnicodeString(
                      error.message
                    )
                  : error,
            }
          );
        } else {
          jobs = [];

          console.error(
            "[LuxuryChat][VIDEO_JOBS][CORRUPT_SHARD_SKIPPED]",
            {
              publicId:
                resource.publicId,

              error:
                error &&
                error.message
                  ? sanitizeUnicodeString(
                      error.message
                    )
                  : error,
            }
          );

          if (
            videoJobShardDefinitelyExpired(
              resource
            )
          ) {
            try {
              await destroyRawAsset(
                resource.publicId
              );

              videoJobKnownResources.delete(
                resource.publicId
              );

              videoJobShardCache.delete(
                resource.publicId
              );

              console.warn(
                "[LuxuryChat][VIDEO_JOBS][CORRUPT_EXPIRED_SHARD_DELETED]",
                {
                  publicId:
                    resource.publicId,
                }
              );

              continue;
            } catch (_) {}
          }
        }
      }

      shardPairs.push({
        resource,
        jobs:
          jobs || [],
      });

      for (
        const job
        of jobs || []
      ) {
        mergeVideoJob(
          job
        );
      }
    }

    try {
      const legacy =
        await readEncryptedVideoJobsUrl(
          legacyVideoJobsUrl()
        );

      if (legacy) {
        for (
          const job
          of legacy
        ) {
          mergeVideoJob(
            job
          );
        }
      }
    } catch (error) {
      console.warn(
        "[LuxuryChat][VIDEO_JOBS][LEGACY_READ_SKIPPED]",
        error &&
        error.message
          ? sanitizeUnicodeString(
              error.message
            )
          : error
      );
    }

    videoJobsLoaded =
      true;

    try {
      await cleanupExpiredVideoJobShards(
        shardPairs
      );
    } catch (error) {
      console.warn(
        "[LuxuryChat][VIDEO_JOBS][CLEANUP_FAILED]",
        error &&
        error.message
          ? sanitizeUnicodeString(
              error.message
            )
          : error
      );
    }

    pruneVideoJobsInMemory();

    return videoJobs;
  }

  async function ensureVideoJobsLoaded(
    forceRefresh = false
  ) {
    if (videoJobsLoadPromise)
      return videoJobsLoadPromise;

    if (
      videoJobsLoaded &&
      !forceRefresh
    ) {
      return videoJobs;
    }

    videoJobsLoadPromise =
      loadVideoJobsFromStorage(
        forceRefresh
      )
        .then(
          (result) => {
            videoJobsLoadPromise =
              null;

            return result;
          }
        )
        .catch(
          (error) => {
            videoJobsLoadPromise =
              null;

            if (!videoJobsLoaded)
              throw error;

            console.warn(
              "[LuxuryChat][VIDEO_JOBS][CACHE_FALLBACK]",
              error &&
              error.message
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error
            );

            return videoJobs;
          }
        );

    return videoJobsLoadPromise;
  }

  async function saveVideoJobsNow() {
    try {
      await ensureVideoJobsLoaded(
        true
      );
    } catch (error) {
      if (!videoJobsLoaded)
        throw error;
    }

    pruneVideoJobsInMemory();

    const dayKey =
      utcDayKey(
        nowMs()
      );

    const publicId =
      videoJobsShardPublicId(
        dayKey
      );

    const payload =
      sanitizeJsonForUnity({
        version:
          13,

        build:
          SERVER_BUILD,

        storageMode:
          "render-process-daily-video-job-shard",

        shardDay:
          dayKey,

        shardInstance:
          HISTORY_INSTANCE_TOKEN,

        savedAtUnixMs:
          nowMs(),

        jobs:
          Array.from(
            videoJobs.values()
          ),
      });

    const encrypted =
      encryptVideoJobsPayload(
        payload
      );

    const uploadResult =
      await uploadRawJson(
        publicId,
        encrypted
      );

    if (
      !uploadResult ||
      !uploadResult.secure_url
    ) {
      throw new Error(
        "video_jobs_shard_upload_missing_url"
      );
    }

    if (
      HISTORY_WRITE_VERIFY_SETTLE_MS >
      0
    ) {
      await sleep(
        HISTORY_WRITE_VERIFY_SETTLE_MS
      );
    }

    const verifyJobs =
      await readEncryptedVideoJobsUrl(
        uploadResult.secure_url
      );

    if (!verifyJobs) {
      throw new Error(
        "video_jobs_shard_verify_failed"
      );
    }

    const expected =
      new Map(
        payload.jobs
          .map(
            (job) =>
              normalizeVideoJob(
                job
              )
          )
          .filter(
            Boolean
          )
          .map(
            (job) => [
              job.publicId,
              job,
            ]
          )
      );

    const verified =
      new Map(
        verifyJobs
          .map(
            (job) =>
              normalizeVideoJob(
                job
              )
          )
          .filter(
            Boolean
          )
          .map(
            (job) => [
              job.publicId,
              job,
            ]
          )
      );

    for (
      const [
        expectedPublicId,
        expectedJob,
      ]
      of expected.entries()
    ) {
      const actual =
        verified.get(
          expectedPublicId
        );

      if (!actual) {
        throw new Error(
          `video_jobs_shard_verify_missing_job:${expectedPublicId}`
        );
      }

      if (
        Number(
          actual.updatedAtUnixMs ||
          0
        ) <
        Number(
          expectedJob.updatedAtUnixMs ||
          0
        )
      ) {
        throw new Error(
          `video_jobs_shard_verify_stale_job:${expectedPublicId}`
        );
      }
    }

    const savedVideoJobResource = {
      publicId,

      version:
        Math.max(
          0,
          Number(
            uploadResult.version
          ) || 0
        ),

      secureUrl:
        safeString(
          uploadResult.secure_url,
          1800
        ),

      createdAt:
        "",
    };

    videoJobShardCache.set(
      publicId,
      {
        version:
          savedVideoJobResource.version,

        secureUrl:
          savedVideoJobResource.secureUrl,

        jobs:
          verifyJobs,
      }
    );

    videoJobKnownResources.set(
      publicId,
      savedVideoJobResource
    );
  }

  function enqueueVideoJobsSave() {
    videoJobsWriteChain =
      videoJobsWriteChain
        .catch(
          () => {}
        )
        .then(
          () =>
            saveVideoJobsNow()
        );

    return videoJobsWriteChain;
  }

  function videoJobClientPreferenceRank(
    status
  ) {
    switch (
      safeString(
        status,
        30
      ).toLowerCase()
    ) {
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

  function findVideoJobByClient(
    senderId,
    clientMessageId
  ) {
    if (
      !senderId ||
      !clientMessageId
    ) {
      return null;
    }

    let best =
      null;

    for (
      const job
      of videoJobs.values()
    ) {
      if (
        !job ||
        job.senderId !==
          senderId ||
        job.clientMessageId !==
          clientMessageId
      ) {
        continue;
      }

      if (!best) {
        best = job;
        continue;
      }

      const jobPreference =
        videoJobClientPreferenceRank(
          job.status
        );

      const bestPreference =
        videoJobClientPreferenceRank(
          best.status
        );

      if (
        jobPreference >
          bestPreference ||
        (
          jobPreference ===
            bestPreference &&
          Number(
            job.updatedAtUnixMs ||
            0
          ) >
            Number(
              best.updatedAtUnixMs ||
              0
            )
        )
      ) {
        best = job;
      }
    }

    return best;
  }

  // ========================================================================
  // VIDEO MODERATION HELPERS
  // ========================================================================

  function buildVideoRejectReason(
    source
  ) {
    let text = "";

    try {
      text =
        safeJsonStringify(
          source || {}
        ).toLowerCase();
    } catch (_) {
      text = "";
    }

    if (
      text.includes(
        "explicit_nudity"
      ) ||
      text.includes(
        "nudity"
      ) ||
      text.includes(
        "sexual"
      ) ||
      text.includes(
        "suggestive"
      )
    ) {
      return "تم رفض الفيديو لأنه يحتوي على محتوى مخل أو غير مناسب";
    }

    if (
      text.includes(
        "violence"
      ) ||
      text.includes(
        "visually_disturbing"
      )
    ) {
      return "تم رفض الفيديو لأنه يحتوي على محتوى عنيف أو مزعج";
    }

    if (
      text.includes(
        "rude_gestures"
      ) ||
      text.includes(
        "hate_symbols"
      )
    ) {
      return "تم رفض الفيديو لأنه يحتوي على محتوى أو إشارات غير مناسبة";
    }

    if (
      text.includes(
        "drugs"
      ) ||
      text.includes(
        "tobacco"
      ) ||
      text.includes(
        "alcohol"
      ) ||
      text.includes(
        "gambling"
      )
    ) {
      return "تم رفض الفيديو لأنه لا يتوافق مع سياسة المحتوى في الشات";
    }

    return "تم رفض الفيديو لأنه يحتوي على محتوى غير مناسب للشات";
  }

  function getModerationEntry(
    uploadResult,
    kind
  ) {
    let moderation = [];

    if (
      uploadResult &&
      Array.isArray(
        uploadResult.moderation
      )
    ) {
      moderation =
        uploadResult.moderation;
    } else if (
      uploadResult &&
      Array.isArray(
        uploadResult.moderations
      )
    ) {
      moderation =
        uploadResult.moderations;
    }

    const wanted =
      safeString(
        kind,
        100
      ).toLowerCase();

    for (
      const item
      of moderation
    ) {
      if (
        !item ||
        typeof item !==
          "object"
      ) {
        continue;
      }

      if (
        safeString(
          item.kind,
          100
        ).toLowerCase() ===
        wanted
      ) {
        return item;
      }
    }

    return null;
  }

  function getModerationStatus(
    uploadResult,
    kind
  ) {
    const entry =
      getModerationEntry(
        uploadResult,
        kind
      );

    return entry
      ? safeString(
          entry.status,
          30
        ).toLowerCase()
      : "";
  }

  function getModerationLabels(
    uploadResult,
    kind
  ) {
    const entry =
      getModerationEntry(
        uploadResult,
        kind
      );

    if (
      !entry ||
      !entry.response ||
      !Array.isArray(
        entry.response
          .moderation_labels
      )
    ) {
      return [];
    }

    return entry
      .response
      .moderation_labels
      .slice(
        0,
        20
      );
  }

  function getDeepModerationStatus(
    value,
    seen = new Set()
  ) {
    if (
      !value ||
      typeof value !==
        "object"
    ) {
      return "";
    }

    if (
      seen.has(
        value
      )
    ) {
      return "";
    }

    seen.add(
      value
    );

    const directCandidates = [
      value.moderation_status,
      value.moderationStatus,
      value.status,
    ];

    for (
      const candidate
      of directCandidates
    ) {
      const status =
        safeString(
          candidate,
          30
        ).toLowerCase();

      if (
        status === "approved" ||
        status === "rejected" ||
        status === "pending"
      ) {
        return status;
      }
    }

    const entry =
      getModerationEntry(
        value,
        VIDEO_MODERATION_KIND
      );

    if (entry) {
      const status =
        safeString(
          entry.status,
          30
        ).toLowerCase();

      if (
        status === "approved" ||
        status === "rejected" ||
        status === "pending"
      ) {
        return status;
      }
    }

    for (
      const child
      of Object.values(
        value
      )
    ) {
      if (
        child &&
        typeof child ===
          "object"
      ) {
        const nested =
          getDeepModerationStatus(
            child,
            seen
          );

        if (nested)
          return nested;
      }
    }

    return "";
  }

  async function getVideoModerationResource(
    publicId
  ) {
    return await cloudinary.api.resource(
      publicId,
      {
        resource_type:
          "video",

        type:
          "upload",

        moderations:
          true,
      }
    );
  }

  // ========================================================================
  // CLOUDINARY MEDIA
  // ========================================================================

  function safeMediaIdSegment(
    value,
    fallback = "player"
  ) {
    const cleaned =
      sanitizeUnicodeString(
        value
      )
        .replace(
          /[^a-zA-Z0-9_-]+/g,
          "_"
        )
        .replace(
          /^_+|_+$/g,
          ""
        )
        .slice(
          0,
          70
        );

    return (
      cleaned ||
      fallback
    );
  }

  function uniqueMediaPublicId(
    playFabId
  ) {
    return `${safeMediaIdSegment(
      playFabId
    )}_${Date.now()}_${crypto
      .randomBytes(5)
      .toString("hex")}`;
  }

  function mediaPublicId(
    folder,
    playFabId,
    clientMessageId,
    kind
  ) {
    const client =
      cleanClientMessageId(
        clientMessageId
      );

    if (!client) {
      return `${folder}/${uniqueMediaPublicId(
        playFabId
      )}`;
    }

    const digest =
      crypto
        .createHash(
          "sha256"
        )
        .update(
          `${
            safeString(
              playFabId,
              100
            )
          }|${client}|${
            safeString(
              kind,
              30
            )
          }`,
          "utf8"
        )
        .digest("hex");

    return `${folder}/${safeMediaIdSegment(
      playFabId
    )}_${safeMediaIdSegment(
      kind,
      "media"
    )}_${digest.slice(
      0,
      40
    )}`;
  }

  async function tryGetExistingCloudinaryAsset(
    publicId,
    resourceType,
    includeModeration = false
  ) {
    try {
      return await cloudinary.api.resource(
        publicId,
        {
          resource_type:
            resourceType,

          type:
            "upload",

          ...(includeModeration
            ? {
                moderations:
                  true,
              }
            : {}),
        }
      );
    } catch (_) {
      return null;
    }
  }

  async function destroyCloudinaryAsset(
    publicId,
    resourceType
  ) {
    const id =
      safeString(
        publicId,
        500
      );

    if (!id)
      return false;

    try {
      const result =
        await cloudinary.uploader.destroy(
          id,
          {
            resource_type:
              resourceType ||
              "image",

            type:
              "upload",

            invalidate:
              true,
          }
        );

      console.log(
        "[LuxuryChat][CLOUDINARY][DESTROY]",
        {
          publicId:
            id,

          resourceType:
            resourceType ||
            "image",

          result:
            result &&
            result.result
              ? result.result
              : result,
        }
      );

      return true;
    } catch (error) {
      console.error(
        "[LuxuryChat][CLOUDINARY][DESTROY][FAILED]",
        {
          publicId:
            id,

          resourceType:
            resourceType ||
            "image",

          error:
            error &&
            error.message
              ? sanitizeUnicodeString(
                  error.message
                )
              : error,
        }
      );

      return false;
    }
  }

  function uploadAudioBuffer(
    buffer,
    playFabId,
    clientMessageId
  ) {
    return new Promise(
      (
        resolve,
        reject
      ) => {
        const publicId =
          mediaPublicId(
            VOICE_FOLDER,
            playFabId,
            clientMessageId,
            "voice"
          );

        const deterministic =
          !!cleanClientMessageId(
            clientMessageId
          );

        const stream =
          cloudinary.uploader
            .upload_stream(
              {
                resource_type:
                  "video",

                public_id:
                  publicId,

                overwrite:
                  false,
              },
              async (
                error,
                result
              ) => {
                if (error) {
                  const existing =
                    await tryGetExistingCloudinaryAsset(
                      publicId,
                      "video",
                      false
                    );

                  if (
                    existing &&
                    existing.secure_url
                  ) {
                    return resolve({
                      url:
                        safeString(
                          existing.secure_url,
                          1600
                        ),

                      publicId:
                        safeString(
                          existing.public_id,
                          500
                        ) ||
                        publicId,

                      existing:
                        true,

                      deterministic,
                    });
                  }

                  return reject(
                    error
                  );
                }

                if (
                  !result ||
                  !result.secure_url
                ) {
                  return reject(
                    new Error(
                      "cloudinary_no_url"
                    )
                  );
                }

                resolve({
                  url:
                    safeString(
                      result.secure_url,
                      1600
                    ),

                  publicId:
                    safeString(
                      result.public_id,
                      500
                    ) ||
                    publicId,

                  existing:
                    !!result.existing,

                  deterministic,
                });
              }
            );

        stream.end(
          buffer
        );
      }
    );
  }

  function uploadImageBuffer(
    buffer,
    playFabId,
    clientMessageId
  ) {
    return new Promise(
      (
        resolve,
        reject
      ) => {
        const publicId =
          mediaPublicId(
            IMAGE_FOLDER,
            playFabId,
            clientMessageId,
            "image"
          );

        const deterministic =
          !!cleanClientMessageId(
            clientMessageId
          );

        const finishWithResult =
          async (
            result,
            reusedExisting
          ) => {
            if (
              !result ||
              !result.public_id
            ) {
              return reject(
                makeChatError(
                  "IMAGE_UPLOAD_NO_RESULT",
                  "cloudinary_image_no_result"
                )
              );
            }

            const actualPublicId =
              safeString(
                result.public_id,
                500
              ) ||
              publicId;

            const moderationStatus =
              getModerationStatus(
                result,
                IMAGE_MODERATION_KIND
              ) ||
              getDeepModerationStatus(
                result
              );

            const moderationLabels =
              getModerationLabels(
                result,
                IMAGE_MODERATION_KIND
              );

            console.log(
              "[LuxuryChat][IMAGE_MODERATION]",
              {
                playFabId:
                  safeString(
                    playFabId,
                    100
                  ),

                publicId:
                  actualPublicId,

                status:
                  moderationStatus ||
                  "missing",

                labelsCount:
                  moderationLabels.length,

                existing:
                  !!reusedExisting,
              }
            );

            if (
              moderationStatus !==
              "approved"
            ) {
              if (
                !reusedExisting ||
                moderationStatus ===
                  "rejected"
              ) {
                await destroyCloudinaryAsset(
                  actualPublicId,
                  "image"
                );
              }

              if (
                moderationStatus ===
                "rejected"
              ) {
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
                    moderationStatus:
                      moderationStatus ||
                      "missing",
                  }
                )
              );
            }

            if (
              !result.secure_url
            ) {
              if (
                !reusedExisting
              ) {
                await destroyCloudinaryAsset(
                  actualPublicId,
                  "image"
                );
              }

              return reject(
                makeChatError(
                  "IMAGE_UPLOAD_NO_URL",
                  "cloudinary_image_no_url"
                )
              );
            }

            const thumb =
              cloudinary.url(
                actualPublicId,
                {
                  resource_type:
                    "image",

                  type:
                    "upload",

                  secure:
                    true,

                  transformation: [
                    {
                      width:
                        700,

                      height:
                        700,

                      crop:
                        "limit",

                      quality:
                        "auto:good",

                      fetch_format:
                        "auto",
                    },
                  ],
                }
              );

            resolve({
              url:
                safeString(
                  result.secure_url,
                  1600
                ),

              thumbnailUrl:
                safeString(
                  thumb ||
                  result.secure_url,
                  1600
                ),

              publicId:
                actualPublicId,

              moderationStatus,

              existing:
                !!reusedExisting,

              deterministic,
            });
          };

        const stream =
          cloudinary.uploader
            .upload_stream(
              {
                resource_type:
                  "image",

                public_id:
                  publicId,

                overwrite:
                  false,

                format:
                  "jpg",

                moderation:
                  IMAGE_MODERATION_KIND,
              },
              async (
                error,
                result
              ) => {
                if (error) {
                  const existing =
                    await tryGetExistingCloudinaryAsset(
                      publicId,
                      "image",
                      true
                    );

                  if (existing) {
                    return finishWithResult(
                      existing,
                      true
                    );
                  }

                  return reject(
                    error
                  );
                }

                return finishWithResult(
                  result,
                  !!(
                    result &&
                    result.existing
                  )
                );
              }
            );

        stream.end(
          buffer
        );
      }
    );
  }

  function uploadVideoBuffer(
    buffer,
    playFabId,
    forcedPublicId
  ) {
    return new Promise(
      (
        resolve,
        reject
      ) => {
        const publicId =
          safeString(
            forcedPublicId,
            500
          ) ||
          mediaPublicId(
            VIDEO_FOLDER,
            playFabId,
            "",
            "video"
          );

        const stream =
          cloudinary.uploader
            .upload_stream(
              {
                resource_type:
                  "video",

                public_id:
                  publicId,

                overwrite:
                  false,

                moderation:
                  VIDEO_MODERATION_KIND,

                notification_url:
                  VIDEO_MODERATION_WEBHOOK_URL,
              },
              async (
                error,
                result
              ) => {
                if (error) {
                  const existing =
                    await tryGetExistingCloudinaryAsset(
                      publicId,
                      "video",
                      true
                    );

                  if (
                    existing &&
                    existing.public_id &&
                    existing.secure_url
                  ) {
                    result = {
                      ...existing,
                      existing:
                        true,
                    };
                  } else {
                    return reject(
                      error
                    );
                  }
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
                          width:
                            700,

                          height:
                            394,

                          crop:
                            "limit",

                          quality:
                            "auto:good",
                        },
                      ],
                    }
                  );

                resolve({
                  url:
                    safeString(
                      result.secure_url,
                      1600
                    ),

                  thumbnailUrl:
                    safeString(
                      thumb || "",
                      1600
                    ),

                  publicId:
                    safeString(
                      result.public_id,
                      500
                    ),

                  moderationStatus:
                    safeString(
                      moderationStatus ||
                      "pending",
                      30
                    ).toLowerCase(),

                  raw:
                    result,

                  existing:
                    !!result.existing,
                });
              }
            );

        stream.end(
          buffer
        );
      }
    );
  }

  // ========================================================================
  // MESSAGE HELPERS / REPLY
  // ========================================================================

  function messagePreview(
    message
  ) {
    if (!message)
      return "";

    if (
      message.kind ===
      "voice"
    ) {
      const total =
        Math.max(
          0,
          Math.round(
            Number(
              message.voiceDuration
            ) || 0
          )
        );

      const mm =
        String(
          Math.floor(
            total / 60
          )
        ).padStart(
          2,
          "0"
        );

      const ss =
        String(
          total % 60
        ).padStart(
          2,
          "0"
        );

      return `ملاحظة صوتية ${mm}:${ss}`;
    }

    if (
      message.kind ===
        "image" ||
      message.mediaType ===
        "image"
    ) {
      return "صورة";
    }

    if (
      message.kind ===
        "video" ||
      message.mediaType ===
        "video"
    ) {
      return "فيديو";
    }

    const text =
      cleanText(
        message.text ||
        ""
      )
        .replace(
          /[\r\n]+/g,
          " "
        )
        .trim();

    return truncateUnicode(
      text,
      100
    );
  }

  async function replySnapshot(
    roomId,
    replyToMessageId
  ) {
    const id =
      safeString(
        replyToMessageId,
        100
      );

    if (!id) {
      return {
        replyToId:
          "",

        replyToSenderId:
          "",

        replyToName:
          "",

        replyToPreview:
          "",
      };
    }

    const room =
      await ensureRoomLoaded(
        roomId,
        {
          forceStorageRefresh:
            false,
        }
      );

    const original =
      findMessage(
        room,
        id
      );

    if (!original) {
      return {
        replyToId:
          "",

        replyToSenderId:
          "",

        replyToName:
          "",

        replyToPreview:
          "",
      };
    }

    return {
      replyToId:
        safeString(
          original.id,
          100
        ),

      replyToSenderId:
        safeString(
          original.senderId,
          100
        ),

      replyToName:
        safeString(
          original.senderName,
          64
        ) ||
        "لاعب",

      replyToPreview:
        safeString(
          messagePreview(
            original
          ),
          120
        ),
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
    const normalizedKind =
      normalizeKind(
        kind
      );

    const sentUnixMs =
      nowMs();

    const messageId =
      deterministicMessageId(
        roomId,
        senderId,
        clientMessageId
      );

    return {
      id:
        messageId,

      clientMessageId:
        cleanClientMessageId(
          clientMessageId
        ),

      seq:
        0,

      room:
        cleanRoom(
          roomId
        ),

      senderId:
        safeString(
          senderId,
          100
        ),

      senderName:
        safeString(
          profile &&
          profile.playerName,
          64
        ) ||
        "لاعب",

      senderAvatarUrl:
        safeString(
          profile &&
          profile.avatarUrl,
          1000
        ),

      senderAvatarVersion:
        safeString(
          profile &&
          profile.avatarVersion,
          100
        ) ||
        "0",

      sentUnixMs,

      kind:
        normalizedKind,

      text:
        "",

      voiceUrl:
        "",

      voiceDuration:
        0,

      mediaType:
        normalizedKind ===
          "image" ||
        normalizedKind ===
          "video"
          ? normalizedKind
          : "",

      mediaUrl:
        "",

      mediaThumbnailUrl:
        "",

      mediaFileName:
        "",

      replyToId:
        safeString(
          reply &&
          reply.replyToId,
          100
        ),

      replyToSenderId:
        safeString(
          reply &&
          reply.replyToSenderId,
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
    };
  }

  async function hydrateProfilesForResponse(
    messages,
    refreshProfiles
  ) {
    const result =
      (
        messages ||
        []
      ).map(
        (message) =>
          sanitizeJsonForUnity({
            ...message,
          })
      );

    if (
      !refreshProfiles ||
      result.length === 0
    ) {
      return result;
    }

    const uniqueSenderIds =
      Array.from(
        new Set(
          result
            .map(
              (message) =>
                profileLookupIdForResponseMessage(
                  message
                )
            )
            .filter(
              Boolean
            )
        )
      );

    const profiles =
      new Map();

    await Promise.all(
      uniqueSenderIds.map(
        async (
          senderId
        ) => {
          try {
            const profile =
              await getPlayerProfile(
                senderId,
                false
              );

            profiles.set(
              senderId,
              profile
            );
          } catch (_) {}
        }
      )
    );

    for (
      const message
      of result
    ) {
      if (!message)
        continue;

      const profileId =
        profileLookupIdForResponseMessage(
          message
        );

      if (!profileId)
        continue;

      const profile =
        profiles.get(
          profileId
        );

      if (!profile)
        continue;

      // للـInbox mineEvent فقط نعيد senderId للطرف الآخر في Response.
      // التخزين نفسه يبقى senderId الأصلي حتى يتطابق Dedup مع Unity.
      const parsedInboxEvent =
        parsePrivateInboxEventText(
          message.text
        );

      if (
        parsedInboxEvent &&
        parsedInboxEvent.mineEvent &&
        parsedInboxEvent.peerId
      ) {
        message.senderId =
          parsedInboxEvent.peerId;
      }

      message.senderName =
        safeString(
          profile.playerName,
          64
        ) ||
        message.senderName ||
        "لاعب";

      message.senderAvatarUrl =
        safeString(
          profile.avatarUrl,
          1000
        ) ||
        "";

      message.senderAvatarVersion =
        safeString(
          profile.avatarVersion,
          100
        ) ||
        "0";
    }

    return sanitizeJsonForUnity(
      result
    );
  }

  // ========================================================================
  // VIDEO MODERATION FINALIZATION
  // ========================================================================

  async function finalizeApprovedVideoJob(
    job,
    moderationSource
  ) {
    if (!job)
      return null;

    job.moderationStatus =
      "approved";

    job.updatedAtUnixMs =
      nowMs();

    if (
      !job.uploadCompleted ||
      !job.mediaUrl
    ) {
      if (
        !isTerminalVideoStatus(
          job.status
        )
      ) {
        job.status =
          "pending";
      }

      videoJobs.set(
        job.publicId,
        job
      );

      await enqueueVideoJobsSave();

      return null;
    }

    const room =
      await ensureRoomLoaded(
        job.roomId,
        {
          forceStorageRefresh:
            true,
        }
      );

    const duplicate =
      findClientMessage(
        room,
        job.senderId,
        job.clientMessageId
      );

    let message =
      duplicate;

    if (duplicate) {
      if (
        duplicate.mediaUrl &&
        job.mediaUrl &&
        duplicate.mediaUrl !==
          job.mediaUrl
      ) {
        await destroyCloudinaryAsset(
          job.publicId,
          "video"
        );
      }
    } else {
      message =
        makeMessage({
          roomId:
            job.roomId,

          senderId:
            job.senderId,

          profile:
            job.profile,

          kind:
            "video",

          reply:
            job.reply,

          clientMessageId:
            job.clientMessageId,
        });

      message.mediaType =
        "video";

      message.mediaUrl =
        safeString(
          job.mediaUrl,
          1600
        );

      message.mediaThumbnailUrl =
        safeString(
          job.mediaThumbnailUrl,
          1600
        );

      message.mediaFileName =
        safeString(
          job.mediaFileName,
          180
        ) ||
        "chat_video.mp4";

      message =
        await pushMessage(
          job.roomId,
          message
        );

      if (
        message &&
        message.mediaUrl &&
        job.mediaUrl &&
        message.mediaUrl !==
          job.mediaUrl
      ) {
        await destroyCloudinaryAsset(
          job.publicId,
          "video"
        );
      }
    }

    if (message) {
      await ensurePrivateInboxForMessageSafe(
        job.roomId,
        message
      );
    }

    job.status =
      "approved";

    job.rejectReason =
      "";

    job.messageId =
      message &&
      message.id
        ? safeString(
            message.id,
            100
          )
        : safeString(
            job.messageId,
            100
          );

    job.updatedAtUnixMs =
      nowMs();

    videoJobs.set(
      job.publicId,
      job
    );

    await enqueueVideoJobsSave();

    console.log(
      "[LuxuryChat][VIDEO_MODERATION][APPROVED]",
      {
        publicId:
          job.publicId,

        senderId:
          job.senderId,

        clientMessageId:
          job.clientMessageId,

        messageId:
          job.messageId,

        source:
          moderationSource
            ? "moderation-result"
            : "status-refresh",
      }
    );

    return message;
  }

  async function finalizeRejectedVideoJob(
    job,
    moderationSource
  ) {
    if (!job)
      return;

    job.status =
      "rejected";

    job.moderationStatus =
      "rejected";

    job.rejectReason =
      safeString(
        buildVideoRejectReason(
          moderationSource
        ),
        300
      );

    job.updatedAtUnixMs =
      nowMs();

    videoJobs.set(
      job.publicId,
      job
    );

    await destroyCloudinaryAsset(
      job.publicId,
      "video"
    );

    await enqueueVideoJobsSave();

    console.log(
      "[LuxuryChat][VIDEO_MODERATION][REJECTED]",
      {
        publicId:
          job.publicId,

        senderId:
          job.senderId,

        clientMessageId:
          job.clientMessageId,

        reason:
          job.rejectReason,
      }
    );
  }

  async function applyVideoModerationResult(
    publicId,
    fallbackBody
  ) {
    await ensureVideoJobsLoaded(
      true
    );

    const id =
      safeString(
        publicId,
        500
      );

    if (!id) {
      return {
        status:
          "ignored",
      };
    }

    const job =
      videoJobs.get(
        id
      );

    if (!job) {
      console.warn(
        "[LuxuryChat][VIDEO_MODERATION] job not found",
        id
      );

      return {
        status:
          "job_not_found",
      };
    }

    const previousStatus =
      safeString(
        job.status,
        30
      ) ||
      "pending";

    const previousModerationStatus =
      safeString(
        job.moderationStatus,
        30
      ) ||
      "pending";

    let adminResource =
      null;

    let adminStatus =
      "";

    try {
      adminResource =
        await getVideoModerationResource(
          id
        );

      job.lastCloudinaryCheckUnixMs =
        nowMs();

      adminStatus =
        getDeepModerationStatus(
          adminResource
        );
    } catch (error) {
      console.warn(
        "[LuxuryChat][VIDEO_MODERATION] Admin API read failed",
        {
          publicId:
            id,

          error:
            error &&
            error.message
              ? sanitizeUnicodeString(
                  error.message
                )
              : error,
        }
      );
    }

    const fallbackStatus =
      getDeepModerationStatus(
        fallbackBody ||
        {}
      );

    let status = "";
    let source = null;

    if (
      adminStatus ===
        "approved" ||
      adminStatus ===
        "rejected"
    ) {
      status =
        adminStatus;

      source =
        adminResource;
    } else if (
      fallbackStatus ===
        "approved" ||
      fallbackStatus ===
        "rejected"
    ) {
      status =
        fallbackStatus;

      source =
        fallbackBody ||
        {};
    } else {
      status =
        adminStatus ||
        fallbackStatus ||
        "pending";

      source =
        adminResource ||
        fallbackBody ||
        {};
    }

    if (
      status ===
      "approved"
    ) {
      await finalizeApprovedVideoJob(
        job,
        source
      );

      return {
        status:
          "approved",
      };
    }

    if (
      status ===
      "rejected"
    ) {
      await finalizeRejectedVideoJob(
        job,
        source
      );

      return {
        status:
          "rejected",
      };
    }

    if (
      isTerminalVideoStatus(
        previousStatus
      )
    ) {
      job.status =
        previousStatus;

      job.moderationStatus =
        previousModerationStatus;

      job.updatedAtUnixMs =
        Math.max(
          Number(
            job.updatedAtUnixMs ||
            0
          ),
          nowMs()
        );

      videoJobs.set(
        job.publicId,
        job
      );

      await enqueueVideoJobsSave();

      return {
        status:
          previousStatus,
      };
    }

    job.status =
      "pending";

    job.moderationStatus =
      safeString(
        status ||
        "pending",
        30
      );

    job.updatedAtUnixMs =
      nowMs();

    videoJobs.set(
      job.publicId,
      job
    );

    await enqueueVideoJobsSave();

    return {
      status:
        "pending",
    };
  }

  function verifyCloudinaryWebhook(
    req
  ) {
    const signature =
      String(
        (
          req &&
          req.headers &&
          req.headers[
            "x-cld-signature"
          ]
        ) ||
        ""
      )
        .trim()
        .replace(
          /^sha1=/i,
          ""
        )
        .replace(
          /^sha256=/i,
          ""
        );

    const timestampRaw =
      String(
        (
          req &&
          req.headers &&
          req.headers[
            "x-cld-timestamp"
          ]
        ) ||
        ""
      ).trim();

    const timestamp =
      Number(
        timestampRaw
      );

    if (
      !signature ||
      !timestampRaw ||
      !Number.isFinite(
        timestamp
      ) ||
      !CLOUDINARY_API_SECRET
    ) {
      return false;
    }

    const nowSeconds =
      Math.floor(
        Date.now() /
        1000
      );

    if (
      Math.abs(
        nowSeconds -
        timestamp
      ) >
      CLOUDINARY_WEBHOOK_MAX_AGE_SECONDS
    ) {
      return false;
    }

    const bodyCandidates = [];

    if (
      req &&
      Buffer.isBuffer(
        req.rawBody
      ) &&
      req.rawBody.length >
        0
    ) {
      bodyCandidates.push(
        req.rawBody.toString(
          "utf8"
        )
      );
    } else if (
      req &&
      typeof req.rawBody ===
        "string" &&
      req.rawBody.length >
        0
    ) {
      bodyCandidates.push(
        req.rawBody
      );
    }

    if (
      req &&
      Buffer.isBuffer(
        req.body
      ) &&
      req.body.length >
        0
    ) {
      bodyCandidates.push(
        req.body.toString(
          "utf8"
        )
      );
    }

    // مهم: لا نستخدم safeJsonStringify هنا.
    // التوقيع يحتاج أقرب Body أصلي ممكن.
    if (
      req &&
      req.body &&
      typeof req.body ===
        "object" &&
      !Buffer.isBuffer(
        req.body
      )
    ) {
      try {
        bodyCandidates.push(
          JSON.stringify(
            req.body
          )
        );
      } catch (_) {}
    }

    const uniqueBodies =
      Array.from(
        new Set(
          bodyCandidates.filter(
            Boolean
          )
        )
      );

    if (
      uniqueBodies.length ===
      0
    ) {
      return false;
    }

    const algorithm =
      signature.length ===
      64
        ? "sha256"
        : "sha1";

    const signatureBuffer =
      Buffer.from(
        signature.toLowerCase(),
        "utf8"
      );

    for (
      const rawBody
      of uniqueBodies
    ) {
      const expected =
        crypto
          .createHash(
            algorithm
          )
          .update(
            rawBody +
            timestampRaw +
            CLOUDINARY_API_SECRET,
            "utf8"
          )
          .digest("hex")
          .toLowerCase();

      const expectedBuffer =
        Buffer.from(
          expected,
          "utf8"
        );

      if (
        expectedBuffer.length !==
        signatureBuffer.length
      ) {
        continue;
      }

      if (
        crypto.timingSafeEqual(
          expectedBuffer,
          signatureBuffer
        )
      ) {
        return true;
      }
    }

    return false;
  }

  function extractWebhookPublicId(
    body,
    seen = new Set()
  ) {
    if (
      !body ||
      typeof body !==
        "object"
    ) {
      return "";
    }

    if (
      seen.has(body)
    ) {
      return "";
    }

    seen.add(
      body
    );

    const direct =
      safeString(
        body.public_id,
        500
      );

    if (direct)
      return direct;

    for (
      const child
      of Object.values(
        body
      )
    ) {
      if (
        child &&
        typeof child ===
          "object"
      ) {
        const nested =
          extractWebhookPublicId(
            child,
            seen
          );

        if (nested)
          return nested;
      }
    }

    return "";
  }

  // ========================================================================
  // REPORTS -> PLAYFAB TITLE INTERNAL DATA
  // ========================================================================

  async function loadReports() {
    if (reportsLoaded)
      return reports;

    if (reportsLoadPromise)
      return reportsLoadPromise;

    reportsLoadPromise =
      (async () => {
        const data =
          await playFabServerCall(
            "GetTitleInternalData",
            {
              Keys: [
                REPORTS_KEY,
              ],
            }
          );

        const raw =
          data &&
          data.Data &&
          data.Data[
            REPORTS_KEY
          ]
            ? String(
                data.Data[
                  REPORTS_KEY
                ]
              )
            : "";

        let loaded = [];

        if (raw) {
          try {
            const parsed =
              JSON.parse(
                raw
              );

            if (
              Array.isArray(
                parsed
              )
            ) {
              loaded =
                parsed;
            } else if (
              parsed &&
              Array.isArray(
                parsed.reports
              )
            ) {
              loaded =
                parsed.reports;
            }
          } catch (_) {
            loaded = [];
          }
        }

        reports =
          loaded
            .filter(
              (item) =>
                item &&
                typeof item ===
                  "object"
            )
            .map(
              (item) =>
                sanitizeJsonForUnity(
                  item
                )
            )
            .slice(
              -MAX_REPORTS_IN_KEY
            );

        reportsLoaded =
          true;

        reportsLoadPromise =
          null;

        return reports;
      })().catch(
        (error) => {
          reportsLoaded =
            false;

          reportsLoadPromise =
            null;

          throw error;
        }
      );

    return reportsLoadPromise;
  }

  function saveReports() {
    reportsWriteChain =
      reportsWriteChain
        .catch(
          () => {}
        )
        .then(
          async () => {
            const payload =
              sanitizeJsonForUnity({
                version:
                  3,

                updatedAtUnixMs:
                  nowMs(),

                reports:
                  reports.slice(
                    -MAX_REPORTS_IN_KEY
                  ),
              });

            await playFabAdminCall(
              "SetTitleInternalData",
              {
                Key:
                  REPORTS_KEY,

                Value:
                  safeJsonStringify(
                    payload
                  ),
              }
            );
          }
        );

    return reportsWriteChain;
  }

  function reportItemKey(
    reporterId,
    messageId
  ) {
    const digest =
      crypto
        .createHash(
          "sha256"
        )
        .update(
          `${
            safeString(
              reporterId,
              100
            )
          }|${
            safeString(
              messageId,
              100
            )
          }`,
          "utf8"
        )
        .digest("hex");

    return `${REPORTS_KEY}_ITEM_${digest.slice(
      0,
      40
    )}`;
  }

  async function createReport(
    reporterId,
    roomId,
    message,
    reason
  ) {
    const itemKey =
      reportItemKey(
        reporterId,
        message.id
      );

    try {
      const existingData =
        await playFabServerCall(
          "GetTitleInternalData",
          {
            Keys: [
              itemKey,
            ],
          }
        );

      const rawExisting =
        existingData &&
        existingData.Data &&
        existingData.Data[
          itemKey
        ]
          ? String(
              existingData.Data[
                itemKey
              ]
            )
          : "";

      if (rawExisting) {
        try {
          const existingReport =
            sanitizeJsonForUnity(
              JSON.parse(
                rawExisting
              )
            );

          if (
            existingReport &&
            existingReport.reportId
          ) {
            return {
              report:
                existingReport,

              duplicate:
                true,
            };
          }
        } catch (_) {}
      }
    } catch (_) {}

    const kind =
      normalizeKind(
        message.kind ||
        message.mediaType
      );

    const deterministicReportId =
      crypto
        .createHash(
          "sha256"
        )
        .update(
          `${
            safeString(
              reporterId,
              100
            )
          }|${
            safeString(
              message.id,
              100
            )
          }`,
          "utf8"
        )
        .digest("hex")
        .slice(
          0,
          48
        );

    const report =
      sanitizeJsonForUnity({
        reportId:
          `r_${deterministicReportId}`,

        createdAtUnixMs:
          nowMs(),

        room:
          cleanRoom(
            roomId
          ),

        reporterId:
          safeString(
            reporterId,
            100
          ),

        messageId:
          safeString(
            message.id,
            100
          ),

        messageSeq:
          Math.max(
            0,
            Number(
              message.seq
            ) || 0
          ),

        messageSentUnixMs:
          Math.max(
            0,
            Number(
              message.sentUnixMs
            ) || 0
          ),

        reportedSenderId:
          safeString(
            message.senderId,
            100
          ),

        reportedSenderName:
          safeString(
            message.senderName,
            64
          ) ||
          "لاعب",

        reportedSenderAvatarUrl:
          safeString(
            message.senderAvatarUrl,
            1000
          ),

        reportedSenderAvatarVersion:
          safeString(
            message.senderAvatarVersion,
            100
          ) ||
          "0",

        kind,

        text:
          kind === "text"
            ? cleanText(
                message.text
              )
            : "",

        voiceUrl:
          kind === "voice"
            ? safeString(
                message.voiceUrl,
                1200
              )
            : "",

        voiceDuration:
          kind === "voice"
            ? Math.min(
                180,
                Math.max(
                  0,
                  Number(
                    message.voiceDuration
                  ) || 0
                )
              )
            : 0,

        mediaType:
          kind === "image" ||
          kind === "video"
            ? kind
            : "",

        mediaUrl:
          kind === "image" ||
          kind === "video"
            ? safeString(
                message.mediaUrl,
                1600
              )
            : "",

        mediaThumbnailUrl:
          kind === "image" ||
          kind === "video"
            ? safeString(
                message.mediaThumbnailUrl,
                1600
              )
            : "",

        mediaFileName:
          kind === "image" ||
          kind === "video"
            ? safeString(
                message.mediaFileName,
                180
              )
            : "",

        replyToId:
          safeString(
            message.replyToId,
            100
          ),

        replyToSenderId:
          safeString(
            message.replyToSenderId,
            100
          ),

        replyToName:
          safeString(
            message.replyToName,
            64
          ),

        replyToPreview:
          safeString(
            message.replyToPreview,
            120
          ),

        reason:
          cleanReason(
            reason
          ) ||
          "بلاغ من داخل الشات",
      });

    await playFabAdminCall(
      "SetTitleInternalData",
      {
        Key:
          itemKey,

        Value:
          safeJsonStringify(
            report
          ),
      }
    );

    try {
      await loadReports();

      const existingIndex =
        reports.findIndex(
          (item) =>
            item &&
            item.reportId ===
              report.reportId
        );

      if (
        existingIndex <
        0
      ) {
        reports.push(
          report
        );
      }

      if (
        reports.length >
        MAX_REPORTS_IN_KEY
      ) {
        reports =
          reports.slice(
            -MAX_REPORTS_IN_KEY
          );
      }

      await saveReports();
    } catch (error) {
      console.warn(
        "[LuxuryChat][REPORT][AGGREGATE_COMPAT_FAILED]",
        {
          reportId:
            report.reportId,

          error:
            error &&
            error.message
              ? sanitizeUnicodeString(
                  error.message
                )
              : error,
        }
      );
    }

    return {
      report,
      duplicate:
        false,
    };
  }

  function buildHistoryResponseWindow(
    room,
    limit,
    afterSeq = 0
  ) {
    const all = [];

    for (const message of room.messages || []) {
      if (!message) continue;

      const normalized = normalizeMessage(message, room.id);
      if (!normalized) continue;
      all.push(normalized);
    }

    all.sort(compareMessages);

    // Incremental: لا نعيد آخر 100 رسالة مع كل Poll.
    // نعيد فقط الأحداث بعد الـcursor، بما فيها reaction events.
    if (afterSeq > 0) {
      const newer = all.filter(
        (m) => Math.max(0, Number(m && m.seq) || 0) > afterSeq
      );

      const page = newer.slice(0, Math.max(1, limit));
      const cursorSeq = page.length > 0
        ? Math.max(
            afterSeq,
            ...page.map((m) => Math.max(0, Number(m && m.seq) || 0))
          )
        : Math.max(afterSeq, Math.max(0, Number(room.seq) || 0));

      return {
        messages: sanitizeJsonForUnity(page),
        hasMore: newer.length > page.length,
        cursorSeq,
      };
    }

    // Full snapshot: آخر N رسائل فعلية + أحدث reaction state للرسائل الظاهرة.
    const normalMessages = all.filter((m) => !isReactionMessageServer(m));
    const reactionMessages = all.filter((m) => isReactionMessageServer(m));

    const normalWindow = normalMessages.slice(
      Math.max(0, normalMessages.length - limit)
    );

    const visibleIds = new Set(
      normalWindow
        .map((m) => safeString(m && m.id, 100))
        .filter(Boolean)
    );

    const latestReactionByOwner = new Map();

    for (const reaction of reactionMessages) {
      if (!reaction || !visibleIds.has(reaction.replyToId)) continue;

      const key = `${reaction.replyToId}|${safeString(reaction.senderId, 100)}`;
      const previous = latestReactionByOwner.get(key);

      if (!previous || compareMessages(previous, reaction) < 0)
        latestReactionByOwner.set(key, reaction);
    }

    const reactionStates = Array.from(latestReactionByOwner.values())
      .sort(compareMessages)
      .slice(-MAX_REACTION_FETCH_LIMIT);

    return {
      messages: sanitizeJsonForUnity(
        normalWindow.concat(reactionStates).sort(compareMessages)
      ),
      hasMore: normalMessages.length > limit,
      cursorSeq: Math.max(0, Number(room.seq) || 0),
    };
  }

  // ========================================================================
  // PRIVATE INBOX INDEX - LAST 24 HOURS
  // ========================================================================

  app.post(
    "/chat/private-inbox",
    async (
      req,
      res
    ) => {
      try {
        const playFabId =
          await authenticateSessionTicket(
            req.body &&
            req.body.sessionTicket
          );

        touchPrivatePresence(
          playFabId
        );

        const inboxRoom =
          buildPrivateInboxRoomId(
            playFabId
          );

        if (!inboxRoom) {
          return res
            .status(400)
            .json({
              ok:
                false,
              error:
                "تعذر تحديد صندوق الدردشات الخاصة",
            });
        }

        const wantsRepair =
          !!(
            req.body &&
            req.body.repairFromPrivateHistory
          );

        // V16:
        // أول Snapshot بعد دخول Unity يجبر مزامنة inbox_ من Cloudinary.
        // الطلبات العادية التالية تبقى خفيفة.
        const room =
          await ensureRoomLoaded(
            inboxRoom,
            {
              forceStorageRefresh:
                wantsRepair,
            }
          );

        pruneExpired(room);
        dedupeClientMessages(room);
        repairSequenceCollisions(room);

        const snapshot =
          buildPrivateInbox24HourSnapshot(
            room,
            playFabId,
            req.body &&
            req.body.lifetimeHours,
            req.body &&
            req.body.maxConversations
          );

        // V17: المصدر الدائم الأساسي لقائمة آخر 24 ساعة.
        const indexed =
          await loadPrivateConversationIndex(
            playFabId,
            snapshot.maxConversations
          );

        let repairCompleted =
          !wantsRepair;

        let recovered =
          [];

        if (wantsRepair) {
          const repair =
            await repairPrivateInboxFromRealHistory(
              playFabId,
              req.body &&
              req.body.maxConversations
            );

          repairCompleted =
            !!(
              repair &&
              repair.ok
            );

          recovered =
            repair &&
            Array.isArray(
              repair.conversations
            )
              ? repair.conversations
              : [];

          // أي محادثة قديمة استعدناها من تاريخ الخاص نثبتها في V17
          // حتى لا نحتاج مسح تاريخ Cloudinary مرة أخرى في الدخول التالي.
          if (
            repairCompleted &&
            recovered.length > 0
          ) {
            try {
              await backfillPrivateConversationIndex(
                playFabId,
                recovered
              );
            } catch (error) {
              console.warn(
                "[LuxuryChat][PRIVATE_INDEX][BACKFILL_FAILED]",
                {
                  playFabId:

                    canonicalPrivatePlayerId(
                      playFabId
                    ),

                  error:
                    error &&
                    error.message
                      ? sanitizeUnicodeString(
                          error.message
                        )
                      : error,
                }
              );
            }
          }
        }

        const snapshotPlusIndex =
          mergePrivateInboxConversationLists(
            snapshot.conversations,
            indexed,
            snapshot.maxConversations
          );

        const mergedConversations =
          mergePrivateInboxConversationLists(
            snapshotPlusIndex,
            recovered,
            snapshot.maxConversations
          );

        const conversations =
          decoratePrivateInboxWithPresence(
            mergedConversations,
            snapshot.serverNowUnixMs
          );

        console.log(
          "[LuxuryChat][PRIVATE_INBOX][SNAPSHOT]",
          {
            ownerId: canonicalPrivatePlayerId(playFabId),
            count: conversations.length,
            fromInboxEvents: snapshot.conversations.length,
            fromPersistentIndex: indexed.length,
            recoveredFromHistory: recovered.length,
            repairCompleted,
            build: SERVER_BUILD,
          }
        );

        return res.json(
          sanitizeJsonForUnity({
            ok:
              true,

            conversations,

            serverNowUnixMs:
              snapshot.serverNowUnixMs,

            lifetimeHours:
              snapshot.lifetimeHours,

            maxConversations:
              snapshot.maxConversations,

            count:
              conversations.length,

            repairCompleted,

            recoveredFromPrivateHistory:
              recovered.length,

            indexedFromPersistentPairMarkers:
              indexed.length,

            source:
              wantsRepair
                ? "private-inbox-24h-persistent-pair-index-v17-repair"
                : "private-inbox-24h-persistent-pair-index-v17",

            build:
              SERVER_BUILD,
          })
        );
      } catch (error) {
        console.error(
          "/chat/private-inbox",
          error
        );

        return res
          .status(500)
          .json(
            sanitizeJsonForUnity({
              ok:
                false,

              repairCompleted:
                false,

              recoveredFromPrivateHistory:
                0,

              error:
                "تعذر تحميل قائمة الدردشات الخاصة",

              build:
                SERVER_BUILD,
            })
          );
      }
    }
  );

  // ========================================================================
  // V19 - PRIVATE INBOX READ RECEIPT
  // ========================================================================

  app.post(
    "/chat/private-inbox/read",
    async (
      req,
      res
    ) => {
      try {
        const playFabId =
          await authenticateSessionTicket(
            req.body &&
            req.body.sessionTicket
          );

        touchPrivatePresence(
          playFabId
        );

        const ownerId =
          canonicalPrivatePlayerId(
            playFabId
          );

        const peerId =
          canonicalPrivatePlayerId(
            req.body &&
            req.body.peerId
          );

        if (
          !ownerId ||
          !peerId ||
          ownerId === peerId
        ) {
          return res
            .status(400)
            .json({
              ok: false,
              error:
                "معرف المحادثة الخاصة غير صالح",
            });
        }

        const inboxRoom =
          buildPrivateInboxRoomId(
            ownerId
          );

        const room =
          await ensureRoomLoaded(
            inboxRoom,
            {
              forceStorageRefresh:
                true,
            }
          );

        pruneExpired(room);
        dedupeClientMessages(room);
        repairSequenceCollisions(room);

        const snapshot =
          buildPrivateInbox24HourSnapshot(
            room,
            ownerId,
            PRIVATE_INBOX_ACTIVE_HOURS,
            MAX_PRIVATE_INBOX_CONVERSATIONS
          );

        const current =
          (
            Array.isArray(
              snapshot.conversations
            )
              ? snapshot.conversations
              : []
          ).find(
            (item) =>
              canonicalPrivatePlayerId(
                item &&
                item.peerId
              ) === peerId
          ) || null;

        const indexed =
          await loadPrivateConversationIndex(
            ownerId,
            MAX_PRIVATE_INBOX_CONVERSATIONS
          );

        const indexedCurrent =
          (
            Array.isArray(
              indexed
            )
              ? indexed
              : []
          ).find(
            (item) =>
              canonicalPrivatePlayerId(
                item &&
                item.peerId
              ) === peerId
          ) || null;

        const best =
          (
            current &&
            indexedCurrent
          )
            ? (
                Number(
                  current.lastActivityUnixMs
                ) >=
                Number(
                  indexedCurrent.lastActivityUnixMs
                )
                  ? current
                  : indexedCurrent
              )
            : (
                current ||
                indexedCurrent
              );

        if (best) {
          await enqueuePrivateConversationIndexMarker(
            ownerId,
            peerId,
            {
              playerName:
                best.peerName,
              avatarUrl:
                best.peerAvatarUrl,
              avatarVersion:
                best.peerAvatarVersion,
            },
            best.kind,
            best.preview,
            best.lastActivityUnixMs,
            !!best.lastMessageMine,
            "",
            0
          );
        }

        const upToSeq =
          Math.max(
            0,
            Number(
              current &&
              current.lastInboxEventSeq
            ) || 0
          );

        if (
          inboxRoom &&
          upToSeq > 0
        ) {
          const profile =
            await getPlayerProfile(
              ownerId,
              false
            );

          let readMessage =
            makeMessage({
              roomId:
                inboxRoom,
              senderId:
                ownerId,
              profile,
              kind:
                "text",
              reply:
                null,
              clientMessageId:
                `lpir_srv_${stablePrivateInboxToken(
                  `${ownerId}|${peerId}|${upToSeq}`
                )}`,
            });

          readMessage.sentUnixMs =
            nowMs();

          readMessage.text =
            [
              PRIVATE_INBOX_READ_TOKEN,
              peerId,
              String(
                upToSeq
              ),
            ].join("|");

          await pushPrivateInboxEventWithRetry(
            inboxRoom,
            readMessage
          );
        }

        privateConversationIndexCache.delete(
          ownerId
        );

        console.log(
          "[LuxuryChat][PRIVATE_INBOX][READ_ZERO]",
          {
            ownerId,
            peerId,
            upToSeq,
            build:
              SERVER_BUILD,
          }
        );

        return res.json({
          ok:
            true,
          peerId,
          unreadCount:
            0,
          serverNowUnixMs:
            nowMs(),
          build:
            SERVER_BUILD,
        });
      } catch (error) {
        console.error(
          "/chat/private-inbox/read",
          error
        );

        return res
          .status(500)
          .json({
            ok:
              false,
            error:
              "تعذر تثبيت قراءة المحادثة الخاصة",
            build:
              SERVER_BUILD,
          });
      }
    }
  );

  // ========================================================================
  // PRIVATE RELATIONSHIP STATE - SERVER AUTHORITATIVE
  // ========================================================================

  function normalizePrivateRelationshipState(raw) {
    const state = {
      version: 1,
      updatedUnixMs: Math.max(0, Number(raw && raw.updatedUnixMs) || 0),
      relations: {},
    };

    const source =
      raw && raw.relations && typeof raw.relations === "object"
        ? raw.relations
        : {};

    let count = 0;
    for (const [rawPeer, rawItem] of Object.entries(source)) {
      if (count >= 2000) break;

      const peerId = canonicalPrivatePlayerId(rawPeer);
      if (!peerId || !rawItem || typeof rawItem !== "object") continue;

      const item = {
        blockedByMeUnixMs: Math.max(0, Number(rawItem.blockedByMeUnixMs) || 0),
        blockedMeUnixMs: Math.max(0, Number(rawItem.blockedMeUnixMs) || 0),
        deletedCutoffUnixMs: Math.max(0, Number(rawItem.deletedCutoffUnixMs) || 0),
      };

      if (item.blockedByMeUnixMs > 0 ||
          item.blockedMeUnixMs > 0 ||
          item.deletedCutoffUnixMs > 0) {
        state.relations[peerId] = item;
        count++;
      }
    }

    return state;
  }

  async function readPrivateRelationshipState(playFabId) {
    const data = await playFabServerCall(
      "GetUserData",
      {
        PlayFabId: playFabId,
        Keys: [PRIVATE_RELATIONSHIP_STATE_KEY],
      }
    );

    const record =
      data && data.Data
        ? data.Data[PRIVATE_RELATIONSHIP_STATE_KEY]
        : null;

    if (!record || !record.Value)
      return normalizePrivateRelationshipState(null);

    let parsed = null;
    try {
      parsed = JSON.parse(String(record.Value));
    } catch (_) {
      parsed = null;
    }

    return normalizePrivateRelationshipState(parsed);
  }

  async function savePrivateRelationshipState(playFabId, state) {
    const normalized = normalizePrivateRelationshipState(state);
    normalized.updatedUnixMs = nowMs();

    await playFabServerCall(
      "UpdateUserData",
      {
        PlayFabId: playFabId,
        Data: {
          [PRIVATE_RELATIONSHIP_STATE_KEY]: safeJsonStringify(normalized),
        },
        Permission: "Private",
      }
    );

    return normalized;
  }

  function privateRelationshipStateResponse(state) {
    const items = [];

    for (const [peerId, relation] of Object.entries(
      state && state.relations ? state.relations : {}
    )) {
      items.push({
        peerId,
        blockedByMeUnixMs: Math.max(0, Number(relation.blockedByMeUnixMs) || 0),
        blockedMeUnixMs: Math.max(0, Number(relation.blockedMeUnixMs) || 0),
        deletedCutoffUnixMs: Math.max(0, Number(relation.deletedCutoffUnixMs) || 0),
      });
    }

    return sanitizeJsonForUnity({
      ok: true,
      items,
      serverNowUnixMs: nowMs(),
      build: SERVER_BUILD,
    });
  }

  app.post(
    "/chat/private-state",
    async (req, res) => {
      try {
        const playFabId = await authenticateSessionTicket(
          req.body && req.body.sessionTicket
        );

        touchPrivatePresence(playFabId);
        const state = await readPrivateRelationshipState(playFabId);
        return res.json(privateRelationshipStateResponse(state));
      } catch (error) {
        console.error("/chat/private-state", error);
        return res.status(500).json({
          ok: false,
          error: "تعذر تحميل حالة الخاص",
          build: SERVER_BUILD,
        });
      }
    }
  );

  app.post(
    "/chat/private-state/update",
    async (req, res) => {
      try {
        const playFabId = await authenticateSessionTicket(
          req.body && req.body.sessionTicket
        );

        touchPrivatePresence(playFabId);

        const owner = canonicalPrivatePlayerId(playFabId);
        const peerId = canonicalPrivatePlayerId(req.body && req.body.peerId);
        const action = safeString(req.body && req.body.action, 40).toLowerCase();
        const value = Math.max(0, Number(req.body && req.body.value) || 0);

        if (!peerId || peerId === owner) {
          return res.status(400).json({
            ok: false,
            error: "معرف اللاعب غير صالح",
            build: SERVER_BUILD,
          });
        }

        const allowed = new Set([
          "block",
          "unblock",
          "blocked_me",
          "unblocked_me",
          "delete",
        ]);

        if (!allowed.has(action)) {
          return res.status(400).json({
            ok: false,
            error: "عملية الخاص غير صالحة",
            build: SERVER_BUILD,
          });
        }

        const state = await readPrivateRelationshipState(playFabId);
        const relation =
          state.relations[peerId] || {
            blockedByMeUnixMs: 0,
            blockedMeUnixMs: 0,
            deletedCutoffUnixMs: 0,
          };

        if (action === "block")
          relation.blockedByMeUnixMs = value > 0 ? value : nowMs();
        else if (action === "unblock")
          relation.blockedByMeUnixMs = 0;
        else if (action === "blocked_me")
          relation.blockedMeUnixMs = value > 0 ? value : nowMs();
        else if (action === "unblocked_me")
          relation.blockedMeUnixMs = 0;
        else if (action === "delete")
          relation.deletedCutoffUnixMs = value > 0 ? value : nowMs();

        if (relation.blockedByMeUnixMs > 0 ||
            relation.blockedMeUnixMs > 0 ||
            relation.deletedCutoffUnixMs > 0) {
          state.relations[peerId] = relation;
        } else {
          delete state.relations[peerId];
        }

        const saved = await savePrivateRelationshipState(playFabId, state);
        return res.json(privateRelationshipStateResponse(saved));
      } catch (error) {
        console.error("/chat/private-state/update", error);
        return res.status(500).json({
          ok: false,
          error: "تعذر حفظ حالة الخاص",
          build: SERVER_BUILD,
        });
      }
    }
  );

  // ========================================================================
  // PROFILE REFRESH - SERVER AUTHORITATIVE
  // ========================================================================

  app.post(
    "/chat/profile-refresh",
    async (req, res) => {
      try {
        const playFabId = await authenticateSessionTicket(
          req.body && req.body.sessionTicket
        );

        touchPrivatePresence(playFabId);

        // force=true: الاسم/الصورة بعد التغيير تأتي من PlayFab لا من Cache قديم.
        const profile = await getPlayerProfile(playFabId, true);

        return res.json(
          sanitizeJsonForUnity({
            ok: true,
            playerName: safeString(profile && profile.playerName, 64) || "لاعب",
            avatarUrl: safeString(profile && profile.avatarUrl, 1000),
            avatarVersion: safeString(profile && profile.avatarVersion, 100) || "0",
            build: SERVER_BUILD,
          })
        );
      } catch (error) {
        console.error("/chat/profile-refresh", error);
        return res.status(500).json({
          ok: false,
          error: "تعذر تحديث ملف اللاعب",
          build: SERVER_BUILD,
        });
      }
    }
  );

  // ========================================================================
  // HISTORY
  // ========================================================================

  app.post(
    "/chat/messages",
    async (
      req,
      res
    ) => {
      try {
        const playFabId =
          await authenticateSessionTicket(
            req.body &&
            req.body.sessionTicket
          );

        touchPrivatePresence(
          playFabId
        );

        const roomId =
          cleanRoom(
            req.body &&
            req.body.room
          );

        const afterSeq =
          Math.max(
            0,
            Number(
              req.body &&
              req.body.afterSeq
            ) || 0
          );

        const refreshProfiles =
          !!(
            req.body &&
            req.body.refreshProfiles
          );

        const limit =
          Math.min(
            MAX_FETCH_LIMIT,

            Math.max(
              1,
              Number(
                req.body &&
                req.body.limit
              ) || 50
            )
          );

        const room =
          await ensureRoomLoaded(
            roomId,
            {
              forceStorageRefresh:
                afterSeq ===
                0,
            }
          );

        pruneExpired(room);
        dedupeClientMessages(room);
        repairSequenceCollisions(room);

        const window =
          buildHistoryResponseWindow(
            room,
            limit,
            afterSeq
          );

        const hydratedMessages =
          await hydrateProfilesForResponse(
            window.messages,
            refreshProfiles ||
              isPrivateInboxRoom(
                roomId
              )
          );

        const responseMessages =
          sanitizeJsonForUnity(
            hydratedMessages
          );

        const cursorLatestSeq =
          Math.max(
            afterSeq,
            Math.max(0, Number(window.cursorSeq) || 0)
          );

        return res.json({
          ok:
            true,

          messages:
            responseMessages,

          latestSeq:
            cursorLatestSeq,

          serverLatestSeq:
            Math.max(
              0,
              Number(
                room.seq
              ) || 0
            ),

          hasMore:
            window.hasMore,

          retentionDays:
            RETENTION_DAYS,

          source:
            "cloudinary-sharded-v13-unity-utf16-safe-private-inbox",

          build:
            SERVER_BUILD,
        });
      } catch (error) {
        console.error(
          "/chat/messages",
          error
        );

        return res
          .status(500)
          .json({
            ok:
              false,

            error:
              "تعذر تحميل رسائل الشات",
          });
      }
    }
  );

  // ========================================================================
  // SEND TEXT
  // ========================================================================

  app.post(
    "/chat/send",
    async (
      req,
      res
    ) => {
      try {
        const playFabId =
          await authenticateSessionTicket(
            req.body &&
            req.body.sessionTicket
          );

        touchPrivatePresence(
          playFabId
        );

        const roomId =
          cleanRoom(
            req.body &&
            req.body.room
          );

        const text =
          cleanText(
            req.body &&
            req.body.text
          );

        if (!text) {
          return res
            .status(400)
            .json({
              ok:
                false,

              error:
                "الرسالة فارغة",
            });
        }

        const clientMessageId =
          cleanClientMessageId(
            req.body &&
            req.body.clientMessageId
          );

        const room =
          await ensureRoomLoaded(
            roomId,
            {
              forceStorageRefresh:
                true,
            }
          );

        if (clientMessageId) {
          const duplicate =
            findClientMessage(
              room,
              playFabId,
              clientMessageId
            );

          if (duplicate) {
            // إذا كانت الرسالة الأصلية موجودة لكن Inbox فشل سابقاً،
            // Retry لن يكرر الرسالة؛ فقط يعيد ضمان Inbox للطرفين.
            const privateInboxMirror =
              await ensurePrivateInboxForMessageSafe(
                roomId,
                duplicate
              );

            return res.json({
              ok:
                true,

              duplicate:
                true,

              message:
                sanitizeJsonForUnity(
                  duplicate
                ),

              privateInboxMirror:
                sanitizeJsonForUnity(
                  privateInboxMirror
                ),
            });
          }
        }

        if (
          !checkRate(
            sendRate,
            playFabId,
            500
          )
        ) {
          return res
            .status(429)
            .json({
              ok:
                false,

              error:
                "أرسل بهدوء قليلاً",
            });
        }

        const profile =
          await getPlayerProfile(
            playFabId,
            true
          );

        const reply =
          await replySnapshot(
            roomId,
            req.body &&
            req.body.replyToMessageId
          );

        let message =
          makeMessage({
            roomId,

            senderId:
              playFabId,

            profile,

            kind:
              "text",

            reply,

            clientMessageId,
          });

        message.text =
          text;

        message =
          await pushMessage(
            roomId,
            message
          );

        // المصدر الرسمي لقائمة الخاص الآن هو السيرفر نفسه.
        const privateInboxMirror =
          await ensurePrivateInboxForMessageSafe(
            roomId,
            message
          );

        if (isPrivateConversationRoom(roomId)) {
          console.log(
            "[LuxuryChat][PRIVATE_INBOX][SEND_RESULT]",
            {
              room: roomId,
              senderId: canonicalPrivatePlayerId(playFabId),
              messageId: safeString(message && message.id, 100),
              mirror: privateInboxMirror,
              build: SERVER_BUILD,
            }
          );
        }

        return res.json({
          ok:
            true,

          message:
            sanitizeJsonForUnity(
              message
            ),

          privateInboxMirror:
            sanitizeJsonForUnity(
              privateInboxMirror
            ),
        });
      } catch (error) {
        console.error(
          "/chat/send",
          error
        );

        return res
          .status(500)
          .json({
            ok:
              false,

            error:
              "تعذر إرسال الرسالة",
          });
      }
    }
  );

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

    async (
      req,
      res
    ) => {
      let uploaded =
        null;

      try {
        const playFabId =
          await authenticateSessionTicket(
            req.body &&
            req.body.sessionTicket
          );

        if (
          !req.file ||
          !req.file.buffer ||
          !req.file.buffer.length
        ) {
          return res
            .status(400)
            .json({
              ok:
                false,

              error:
                "ملف الصوت غير موجود",
            });
        }

        const roomId =
          cleanRoom(
            req.body &&
            req.body.room
          );

        const clientMessageId =
          cleanClientMessageId(
            req.body &&
            req.body.clientMessageId
          );

        const room =
          await ensureRoomLoaded(
            roomId,
            {
              forceStorageRefresh:
                true,
            }
          );

        if (clientMessageId) {
          const duplicate =
            findClientMessage(
              room,
              playFabId,
              clientMessageId
            );

          if (duplicate) {
            await ensurePrivateInboxForMessageSafe(
              roomId,
              duplicate
            );

            return res.json({
              ok:
                true,

              duplicate:
                true,

              message:
                sanitizeJsonForUnity(
                  duplicate
                ),
            });
          }
        }

        if (
          !checkRate(
            sendRate,
            playFabId,
            900
          )
        ) {
          return res
            .status(429)
            .json({
              ok:
                false,

              error:
                "انتظر قليلاً قبل الإرسال",
            });
        }

        const duration =
          Math.min(
            180,

            Math.max(
              0,
              Number(
                req.body &&
                req.body.duration
              ) || 0
            )
          );

        const profile =
          await getPlayerProfile(
            playFabId,
            true
          );

        const reply =
          await replySnapshot(
            roomId,
            req.body &&
            req.body.replyToMessageId
          );

        uploaded =
          await uploadAudioBuffer(
            req.file.buffer,
            playFabId,
            clientMessageId
          );

        let attemptedMessage =
          makeMessage({
            roomId,

            senderId:
              playFabId,

            profile,

            kind:
              "voice",

            reply,

            clientMessageId,
          });

        attemptedMessage.voiceUrl =
          safeString(
            uploaded.url,
            1200
          );

        attemptedMessage.voiceDuration =
          duration;

        const message =
          await pushMessage(
            roomId,
            attemptedMessage
          );

        await ensurePrivateInboxForMessageSafe(
          roomId,
          message
        );

        if (
          uploaded.publicId &&
          message &&
          message.voiceUrl &&
          message.voiceUrl !==
            uploaded.url
        ) {
          if (
            !uploaded.deterministic
          ) {
            await destroyCloudinaryAsset(
              uploaded.publicId,
              "video"
            );
          }

          uploaded =
            null;
        }

        return res.json({
          ok:
            true,

          message:
            sanitizeJsonForUnity(
              message
            ),
        });
      } catch (error) {
        if (
          uploaded &&
          uploaded.publicId &&
          !uploaded.deterministic
        ) {
          await destroyCloudinaryAsset(
            uploaded.publicId,
            "video"
          );
        }

        console.error(
          "/chat/voice",
          error
        );

        return res
          .status(500)
          .json({
            ok:
              false,

            error:
              "تعذر رفع الملاحظة الصوتية",
          });
      }
    }
  );

  // ========================================================================
  // CLOUDINARY VIDEO MODERATION WEBHOOK
  // ========================================================================

  app.post(
    VIDEO_MODERATION_WEBHOOK_PATH,
    async (
      req,
      res
    ) => {
      try {
        if (
          !verifyCloudinaryWebhook(
            req
          )
        ) {
          console.warn(
            "[LuxuryChat][VIDEO_WEBHOOK] invalid signature"
          );

          return res
            .status(401)
            .json({
              ok:
                false,

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

          return res.json({
            ok:
              true,

            ignored:
              true,
          });
        }

        const result =
          await applyVideoModerationResult(
            publicId,
            req.body
          );

        return res.json({
          ok:
            true,

          publicId,

          status:
            result &&
            result.status
              ? safeString(
                  result.status,
                  30
                )
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
            ok:
              false,

            error:
              "video_moderation_webhook_failed",
          });
      }
    }
  );

  // ========================================================================
  // VIDEO STATUS FOR UNITY
  // ========================================================================

  app.post(
    "/chat/video-status",
    async (
      req,
      res
    ) => {
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
              ok:
                false,

              error:
                "clientMessageId مطلوب",
            });
        }

        await ensureVideoJobsLoaded(
          true
        );

        const job =
          findVideoJobByClient(
            playFabId,
            clientMessageId
          );

        if (!job) {
          return res
            .status(404)
            .json({
              ok:
                false,

              status:
                "not_found",

              error:
                "حالة الفيديو غير موجودة",
            });
        }

        if (
          (
            job.status ===
              "pending" ||
            job.status ===
              "uploading"
          ) &&
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
                ? sanitizeUnicodeString(
                    error.message
                  )
                : error
            );
          }
        }

        const fresh =
          videoJobs.get(
            job.publicId
          ) ||
          job;

        return res.json({
          ok:
            true,

          clientMessageId:
            safeString(
              fresh.clientMessageId,
              100
            ),

          status:
            safeString(
              fresh.status,
              30
            ),

          moderationStatus:
            safeString(
              fresh.moderationStatus,
              30
            ),

          rejectReason:
            fresh.status ===
              "rejected"
              ? safeString(
                  fresh.rejectReason,
                  300
                )
              : "",

          messageId:
            fresh.status ===
              "approved"
              ? safeString(
                  fresh.messageId,
                  100
                )
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
            ok:
              false,

            error:
              "تعذر قراءة حالة الفيديو",
          });
      }
    }
  );

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

    async (
      req,
      res
    ) => {
      let uploadedImage =
        null;

      try {
        const playFabId =
          await authenticateSessionTicket(
            req.body &&
            req.body.sessionTicket
          );

        if (
          !req.file ||
          !req.file.buffer ||
          !req.file.buffer.length
        ) {
          return res
            .status(400)
            .json({
              ok:
                false,

              error:
                "الملف غير موجود",
            });
        }

        const roomId =
          cleanRoom(
            req.body &&
            req.body.room
          );

        const requestedType =
          safeString(
            (
              req.body &&
              req.body.mediaType
            ) ||
            "",
            30
          ).toLowerCase();

        if (
          requestedType !==
            "image" &&
          requestedType !==
            "video"
        ) {
          return res
            .status(400)
            .json({
              ok:
                false,

              error:
                "نوع الملف غير مدعوم",
            });
        }

        const mime =
          safeString(
            req.file.mimetype ||
            "",
            100
          ).toLowerCase();

        const fileSize =
          Number(
            req.file.size ||
            req.file.buffer.length ||
            0
          );

        if (
          requestedType ===
          "image"
        ) {
          if (
            !ALLOWED_IMAGE_MIME_TYPES.has(
              mime
            )
          ) {
            return res
              .status(400)
              .json({
                ok:
                  false,

                error:
                  "نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WEBP",
              });
          }

          if (
            fileSize >
            MAX_IMAGE_BYTES
          ) {
            return res
              .status(413)
              .json({
                ok:
                  false,

                error:
                  "حجم الصورة أكبر من 8 ميجابايت",
              });
          }
        }

        if (
          requestedType ===
          "video"
        ) {
          if (
            !mime.startsWith(
              "video/"
            )
          ) {
            return res
              .status(400)
              .json({
                ok:
                  false,

                error:
                  "الملف المختار ليس فيديو",
              });
          }

          if (
            fileSize >
            MAX_VIDEO_BYTES
          ) {
            return res
              .status(413)
              .json({
                ok:
                  false,

                error:
                  "حجم الفيديو أكبر من 50 ميجابايت",
              });
          }
        }

        const clientMessageId =
          cleanClientMessageId(
            req.body &&
            req.body.clientMessageId
          );

        const room =
          await ensureRoomLoaded(
            roomId,
            {
              forceStorageRefresh:
                true,
            }
          );

        if (clientMessageId) {
          const duplicate =
            findClientMessage(
              room,
              playFabId,
              clientMessageId
            );

          if (duplicate) {
            await ensurePrivateInboxForMessageSafe(
              roomId,
              duplicate
            );

            return res.json({
              ok:
                true,

              duplicate:
                true,

              message:
                sanitizeJsonForUnity(
                  duplicate
                ),
            });
          }
        }

        if (
          !checkRate(
            sendRate,
            playFabId,
            900
          )
        ) {
          return res
            .status(429)
            .json({
              ok:
                false,

              error:
                "انتظر قليلاً قبل إرسال ملف آخر",
            });
        }

        const profile =
          await getPlayerProfile(
            playFabId,
            true
          );

        const reply =
          await replySnapshot(
            roomId,
            req.body &&
            req.body.replyToMessageId
          );

        // ------------------------------------------------------------------
        // VIDEO
        // ------------------------------------------------------------------

        if (
          requestedType ===
          "video"
        ) {
          await ensureVideoJobsLoaded(
            true
          );

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
              ok:
                true,

              pending:
                existingJob.status !==
                  "approved" &&
                existingJob.status !==
                  "rejected",

              status:
                safeString(
                  existingJob.status,
                  30
                ),

              moderationStatus:
                safeString(
                  existingJob.moderationStatus,
                  30
                ),

              clientMessageId:
                safeString(
                  existingJob.clientMessageId,
                  100
                ),

              rejectReason:
                existingJob.status ===
                  "rejected"
                  ? safeString(
                      existingJob.rejectReason,
                      300
                    )
                  : "",

              messageId:
                existingJob.status ===
                  "approved"
                  ? safeString(
                      existingJob.messageId,
                      100
                    )
                  : "",
            });
          }

          const videoPublicId =
            mediaPublicId(
              VIDEO_FOLDER,
              playFabId,
              effectiveClientMessageId,
              "video"
            );

          const job =
            sanitizeJsonForUnity({
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
                cleanRoom(
                  roomId
                ),

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
                  ) ||
                  "لاعب",

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
                  ) ||
                  "0",
              },

              reply: {
                replyToId:
                  safeString(
                    reply &&
                    reply.replyToId,
                    100
                  ),

                replyToSenderId:
                  safeString(
                    reply &&
                    reply.replyToSenderId,
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
            });

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
            try {
              await ensureVideoJobsLoaded(
                true
              );
            } catch (_) {}

            const current =
              videoJobs.get(
                videoPublicId
              ) ||
              job;

            if (
              current.status !==
                "approved" &&
              current.status !==
                "rejected"
            ) {
              current.status =
                "failed";

              current.moderationStatus =
                "failed";

              current.rejectReason =
                "تعذر رفع الفيديو للفحص";

              current.updatedAtUnixMs =
                nowMs();

              videoJobs.set(
                videoPublicId,
                current
              );

              try {
                await enqueueVideoJobsSave();
              } catch (_) {}

              if (
                !clientMessageId
              ) {
                await destroyCloudinaryAsset(
                  videoPublicId,
                  "video"
                );
              }

              throw error;
            }

            return res.json({
              ok:
                true,

              pending:
                false,

              status:
                safeString(
                  current.status,
                  30
                ),

              moderationStatus:
                safeString(
                  current.moderationStatus,
                  30
                ),

              clientMessageId:
                safeString(
                  current.clientMessageId,
                  100
                ),

              rejectReason:
                current.status ===
                  "rejected"
                  ? safeString(
                      current.rejectReason,
                      300
                    )
                  : "",

              messageId:
                current.status ===
                  "approved"
                  ? safeString(
                      current.messageId,
                      100
                    )
                  : "",
            });
          }

          try {
            await ensureVideoJobsLoaded(
              true
            );
          } catch (error) {
            console.warn(
              "[LuxuryChat][VIDEO_UPLOAD][POST_UPLOAD_SYNC_FAILED]",
              {
                publicId:
                  videoPublicId,

                error:
                  error &&
                  error.message
                    ? sanitizeUnicodeString(
                        error.message
                      )
                    : error,
              }
            );
          }

          const activeJob =
            videoJobs.get(
              videoPublicId
            ) ||
            job;

          const uploadModerationStatus =
            safeString(
              uploadedVideo.moderationStatus,
              30
            ) ||
            "pending";

          activeJob.uploadCompleted =
            true;

          activeJob.mediaUrl =
            safeString(
              uploadedVideo.url,
              1600
            );

          activeJob.mediaThumbnailUrl =
            safeString(
              uploadedVideo.thumbnailUrl,
              1600
            );

          activeJob.mediaFileName =
            safeString(
              activeJob.mediaFileName,
              180
            ) ||
            "chat_video.mp4";

          if (
            !isTerminalVideoStatus(
              activeJob.status
            )
          ) {
            activeJob.status =
              "pending";
          }

          if (
            activeJob.moderationStatus !==
              "approved" &&
            activeJob.moderationStatus !==
              "rejected"
          ) {
            activeJob.moderationStatus =
              uploadModerationStatus;
          }

          activeJob.updatedAtUnixMs =
            nowMs();

          videoJobs.set(
            videoPublicId,
            activeJob
          );

          await enqueueVideoJobsSave();

          console.log(
            "[LuxuryChat][VIDEO_MODERATION][UPLOADED]",
            {
              publicId:
                activeJob.publicId,

              senderId:
                activeJob.senderId,

              clientMessageId:
                activeJob.clientMessageId,

              moderationStatus:
                activeJob.moderationStatus,

              webhook:
                VIDEO_MODERATION_WEBHOOK_URL,
            }
          );

          if (
            activeJob.status ===
            "rejected"
          ) {
            await destroyCloudinaryAsset(
              activeJob.publicId,
              "video"
            );
          } else if (
            activeJob.status !==
              "approved" &&
            (
              activeJob.moderationStatus ===
                "approved" ||
              activeJob.moderationStatus ===
                "rejected" ||
              uploadModerationStatus ===
                "approved" ||
              uploadModerationStatus ===
                "rejected"
            )
          ) {
            await applyVideoModerationResult(
              activeJob.publicId,
              uploadedVideo.raw
            );
          } else if (
            activeJob.status ===
              "approved" &&
            !activeJob.messageId
          ) {
            await finalizeApprovedVideoJob(
              activeJob,
              uploadedVideo.raw
            );
          }

          const fresh =
            videoJobs.get(
              activeJob.publicId
            ) ||
            activeJob;

          return res.json({
            ok:
              true,

            pending:
              fresh.status !==
                "approved" &&
              fresh.status !==
                "rejected",

            status:
              safeString(
                fresh.status,
                30
              ),

            moderationStatus:
              safeString(
                fresh.moderationStatus,
                30
              ),

            clientMessageId:
              safeString(
                fresh.clientMessageId,
                100
              ),

            rejectReason:
              fresh.status ===
                "rejected"
                ? safeString(
                    fresh.rejectReason,
                    300
                  )
                : "",

            messageId:
              fresh.status ===
                "approved"
                ? safeString(
                    fresh.messageId,
                    100
                  )
                : "",
          });
        }

        // ------------------------------------------------------------------
        // IMAGE
        // ------------------------------------------------------------------

        uploadedImage =
          await uploadImageBuffer(
            req.file.buffer,
            playFabId,
            clientMessageId
          );

        if (
          safeString(
            uploadedImage &&
            uploadedImage.moderationStatus,
            30
          ).toLowerCase() !==
          "approved"
        ) {
          if (
            uploadedImage &&
            uploadedImage.publicId
          ) {
            await destroyCloudinaryAsset(
              uploadedImage.publicId,
              "image"
            );

            uploadedImage =
              null;
          }

          return res
            .status(503)
            .json({
              ok:
                false,

              error:
                "تعذر اعتماد الصورة من نظام الحماية، حاول مرة أخرى",
            });
        }

        let attemptedMessage =
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

        attemptedMessage.mediaType =
          "image";

        attemptedMessage.mediaUrl =
          safeString(
            uploadedImage.url,
            1600
          );

        attemptedMessage.mediaThumbnailUrl =
          safeString(
            uploadedImage.thumbnailUrl,
            1600
          );

        attemptedMessage.mediaFileName =
          sanitizeFileName(
            req.file.originalname,
            "chat_image.jpg"
          );

        const message =
          await pushMessage(
            roomId,
            attemptedMessage
          );

        await ensurePrivateInboxForMessageSafe(
          roomId,
          message
        );

        if (
          uploadedImage.publicId &&
          message &&
          message.mediaUrl &&
          message.mediaUrl !==
            uploadedImage.url
        ) {
          if (
            !uploadedImage.deterministic
          ) {
            await destroyCloudinaryAsset(
              uploadedImage.publicId,
              "image"
            );
          }

          uploadedImage =
            null;
        }

        return res.json({
          ok:
            true,

          message:
            sanitizeJsonForUnity(
              message
            ),
        });
      } catch (error) {
        if (
          uploadedImage &&
          uploadedImage.publicId &&
          !uploadedImage.deterministic
        ) {
          await destroyCloudinaryAsset(
            uploadedImage.publicId,
            "image"
          );
        }

        console.error(
          "/chat/media",
          error
        );

        if (
          error &&
          error.code ===
            "IMAGE_MODERATION_REJECTED"
        ) {
          return res
            .status(422)
            .json({
              ok:
                false,

              moderationRejected:
                true,

              error:
                "تم رفض الصورة لأنها تخالف قوانين الشات",
            });
        }

        if (
          error &&
          error.code ===
            "IMAGE_MODERATION_NOT_APPROVED"
        ) {
          return res
            .status(503)
            .json({
              ok:
                false,

              moderationRejected:
                false,

              error:
                "تعذر فحص الصورة الآن، حاول مرة أخرى بعد قليل",
            });
        }

        if (
          error &&
          (
            error.code ===
              "IMAGE_UPLOAD_NO_RESULT" ||
            error.code ===
              "IMAGE_UPLOAD_NO_URL"
          )
        ) {
          return res
            .status(502)
            .json({
              ok:
                false,

              error:
                "تعذر اعتماد الصورة بعد رفعها",
            });
        }

        if (
          error &&
          error.code ===
            "VIDEO_UPLOAD_NO_RESULT"
        ) {
          return res
            .status(502)
            .json({
              ok:
                false,

              error:
                "تعذر رفع الفيديو للفحص",
            });
        }

        return res
          .status(500)
          .json({
            ok:
              false,

            error:
              "تعذر رفع الصورة أو الفيديو",
          });
      }
    }
  );

  // ========================================================================
  // REPORT MESSAGE
  // ========================================================================

  app.post(
    "/chat/report",
    async (
      req,
      res
    ) => {
      try {
        const reporterId =
          await authenticateSessionTicket(
            req.body &&
            req.body.sessionTicket
          );

        if (
          !checkRate(
            reportRate,
            reporterId,
            1500
          )
        ) {
          return res
            .status(429)
            .json({
              ok:
                false,

              error:
                "انتظر قليلاً قبل إرسال بلاغ آخر",
            });
        }

        const roomId =
          cleanRoom(
            req.body &&
            req.body.room
          );

        const messageId =
          safeString(
            req.body &&
            req.body.messageId,
            100
          );

        if (!messageId) {
          return res
            .status(400)
            .json({
              ok:
                false,

              error:
                "معرف الرسالة غير موجود",
            });
        }

        const room =
          await ensureRoomLoaded(
            roomId,
            {
              forceStorageRefresh:
                true,
            }
          );

        const pruned =
          pruneExpired(
            room
          );

        if (pruned) {
          enqueueRoomSave(
            roomId
          ).catch(
            (error) => {
              console.warn(
                "[LuxuryChat][HISTORY][PRUNE_SAVE_FAILED]",
                {
                  room:
                    roomId,

                  error:
                    error &&
                    error.message
                      ? sanitizeUnicodeString(
                          error.message
                        )
                      : error,
                }
              );
            }
          );
        }

        const message =
          findMessage(
            room,
            messageId
          );

        if (!message) {
          return res
            .status(404)
            .json({
              ok:
                false,

              error:
                "الرسالة غير موجودة على السيرفر",
            });
        }

        if (
          message.senderId ===
          reporterId
        ) {
          return res
            .status(400)
            .json({
              ok:
                false,

              error:
                "لا يمكنك الإبلاغ عن رسالتك",
            });
        }

        const result =
          await createReport(
            reporterId,
            roomId,
            message,
            req.body &&
            req.body.reason
          );

        console.log(
          "[LuxuryChat][REPORT]",
          {
            reportId:
              result.report.reportId,

            reporterId:
              result.report.reporterId,

            messageId:
              result.report.messageId,

            reportedSenderId:
              result.report.reportedSenderId,

            kind:
              result.report.kind,

            duplicate:
              result.duplicate,
          }
        );

        return res.json({
          ok:
            true,

          duplicate:
            result.duplicate,

          reportId:
            safeString(
              result.report.reportId,
              100
            ),

          reportKey:
            REPORTS_KEY,
        });
      } catch (error) {
        console.error(
          "/chat/report",
          error
        );

        return res
          .status(500)
          .json({
            ok:
              false,

            error:
              "تعذر إرسال البلاغ",
          });
      }
    }
  );

  // ========================================================================
  // READY LOG
  // ========================================================================

  console.log(
    "[LuxuryChat] installed",
    {
      version:
        21,

      build:
        SERVER_BUILD,

      unityJsonSurrogateProtection:
        true,

      brokenUtf16Protection:
        true,

      emojiSafeTruncation:
        true,

      historyResponseSanitizedForUnity:
        true,

      historyStorageSanitized:
        true,

      imageModeration:
        IMAGE_MODERATION_KIND,

      imageModerationFailClosed:
        true,

      videoModeration:
        VIDEO_MODERATION_KIND,

      videoModerationWebhook:
        VIDEO_MODERATION_WEBHOOK_URL,

      videoPendingPersistence:
        "Cloudinary encrypted per-process daily shards - terminal-state hardened",

      persistentHistory:
        "Cloudinary raw JSON - per-process daily shards + Unity UTF16 safe",

      historyCacheRole:
        "runtime cache + throttled Admin discovery + send-safe fallback + direct raw delivery refresh",

      historyShardDiscoveryMs:
        HISTORY_SHARD_DISCOVERY_MS,

      videoJobShardDiscoveryMs:
        VIDEO_JOB_SHARD_DISCOVERY_MS,

      deterministicMediaPublicIds:
        true,

      privateInbox24HourIndex:
        true,

      privateInboxSelfHealFromRealHistory:
        true,

      privateInboxPersistentPairIndexV17:
        true,

      privateInboxMaxConversations:
        MAX_PRIVATE_INBOX_CONVERSATIONS,

      retentionDays:
        RETENTION_DAYS,

      fetchLimit:
        MAX_FETCH_LIMIT,

      maxTextLength:
        MAX_TEXT_LENGTH,

      voiceLimitMB:
        MAX_VOICE_BYTES /
        1024 /
        1024,

      imageLimitMB:
        MAX_IMAGE_BYTES /
        1024 /
        1024,

      videoLimitMB:
        MAX_VIDEO_BYTES /
        1024 /
        1024,

      reportsKey:
        REPORTS_KEY,

      routes: [
        "/chat/private-inbox",
        "/chat/private-state",
        "/chat/private-state/update",
        "/chat/profile-refresh",
        "/chat/messages",
        "/chat/send",
        "/chat/voice",
        "/chat/media",
        "/chat/video-status",
        VIDEO_MODERATION_WEBHOOK_PATH,
        "/chat/report",
      ],
    }
  );
};
