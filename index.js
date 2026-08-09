"use strict";

// ============================================================================
// Main Server - Hardened
// Render / Node 18+ / Express / PlayFab / Cloudinary / Google OAuth
//
// BUILD:
// 2026-08-10-SERVER-HARDENED-V2-SESSION-OAUTH-RATE-TIMEOUT-UTF8
//
// أهم الإصلاحات:
// - حفظ rawBody الحقيقي قبل Luxury Chat للتحقق من Cloudinary Webhook.
// - جميع طلبات PlayFab وGoogle لها Timeout.
// - /account/set-password لا يثق بـ playFabId القادم من العميل؛ يعتمد SessionTicket.
// - حماية تسجيل الدخول بكلمة المرور من المحاولات المتكررة.
// - Google Link صار يستخدم One-Time OAuth intent محفوظاً على السيرفر بدل playFabId داخل state.
// - Google Login state صار One-Time أيضاً لمنع التلاعب وإعادة الاستخدام.
// - تنظيف جلسات Google بعد قراءتها/انتهائها قدر الإمكان.
// - Escape لمخرجات HTML القادمة من Google.
// - فحص أقوى للمدخلات مع المحافظة على نفس الردود العربية قدر الإمكان.
// - Avatar moderation يدعم moderation و moderations ويعمل Fail Closed.
// ============================================================================

const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const { v2: cloudinary } = require("cloudinary");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

// ============================================================================
// JSON / RAW BODY
// ============================================================================

app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buffer) => {
      // Cloudinary Webhook Signature يحتاج النص الخام كما وصل بالضبط.
      req.rawBody = buffer && buffer.length ? Buffer.from(buffer) : Buffer.alloc(0);
    },
  })
);

// ============================================================================
// CONFIG
// ============================================================================

const SERVER_BUILD =
  "2026-08-10-SERVER-HARDENED-V2-SESSION-OAUTH-RATE-TIMEOUT-UTF8";

const SERVER_URL = String(
  process.env.PUBLIC_SERVER_URL ||
    process.env.CHAT_PUBLIC_SERVER_URL ||
    "https://my-server-i40i.onrender.com"
)
  .trim()
  .replace(/\/+$/, "");

const GAME_DEEP_LINK =
  String(process.env.GAME_DEEP_LINK || "pirateclash://google-login-success").trim() ||
  "pirateclash://google-login-success";

const EXTERNAL_FETCH_TIMEOUT_MS = 15 * 1000;
const GOOGLE_OAUTH_INTENT_TTL_MS = 10 * 60 * 1000;
const GOOGLE_LOGIN_SESSION_TTL_MS = 10 * 60 * 1000;

const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_MAX_ATTEMPTS = 6;
const LOGIN_RATE_BLOCK_MS = 15 * 60 * 1000;
const RATE_MAP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const loginRateMap = new Map();
let lastRateCleanupMs = 0;

// ============================================================================
// CLOUDINARY
// ============================================================================

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// ============================================================================
// BASIC HELPERS
// ============================================================================

function nowMs() {
  return Date.now();
}

function safeString(value, maxLength) {
  const text = String(value == null ? "" : value).trim();
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase().slice(0, 254);
}

function cleanPassword(password) {
  // نحافظ على السلوك القديم: trim قبل hash/compare.
  return String(password || "").trim();
}

function isReasonableEmail(email) {
  const value = cleanEmail(email);
  if (!value || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.lastIndexOf("@");
  return at > 0 && at < value.length - 3 && value.includes(".", at + 2);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getRequestIp(req) {
  return safeString((req && req.ip) || "unknown", 120) || "unknown";
}

function getSessionTicketFromRequest(req) {
  const authorizationHeader = String(
    (req && req.headers && req.headers.authorization) || ""
  ).trim();

  const bearerTicket = authorizationHeader.toLowerCase().startsWith("bearer ")
    ? authorizationHeader.substring(7).trim()
    : "";

  return String(
    (req && req.headers && req.headers["x-authorization"]) ||
      bearerTicket ||
      (req && req.body && req.body.sessionTicket) ||
      ""
  ).trim();
}

async function fetchWithTimeout(url, options, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(timeoutMs) || EXTERNAL_FETCH_TIMEOUT_MS)
  );

  try {
    return await fetch(url, {
      ...(options || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function hashKey(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function maybeCleanupLoginRates() {
  const current = nowMs();
  if (current - lastRateCleanupMs < RATE_MAP_CLEANUP_INTERVAL_MS) return;

  lastRateCleanupMs = current;
  const staleCutoff = current - Math.max(LOGIN_RATE_WINDOW_MS, LOGIN_RATE_BLOCK_MS) * 2;

  for (const [key, value] of loginRateMap.entries()) {
    if (!value || Number(value.lastAttemptMs || 0) < staleCutoff) {
      loginRateMap.delete(key);
    }
  }
}

function loginRateKey(req, email) {
  return `${getRequestIp(req)}|${hashKey(cleanEmail(email)).slice(0, 24)}`;
}

function checkLoginRate(req, email) {
  maybeCleanupLoginRates();

  const key = loginRateKey(req, email);
  const current = nowMs();
  let state = loginRateMap.get(key);

  if (!state) {
    state = {
      windowStartMs: current,
      attempts: 0,
      blockedUntilMs: 0,
      lastAttemptMs: current,
    };
  }

  if (Number(state.blockedUntilMs || 0) > current) {
    loginRateMap.set(key, state);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((state.blockedUntilMs - current) / 1000)
      ),
    };
  }

  if (current - Number(state.windowStartMs || 0) > LOGIN_RATE_WINDOW_MS) {
    state.windowStartMs = current;
    state.attempts = 0;
    state.blockedUntilMs = 0;
  }

  state.attempts += 1;
  state.lastAttemptMs = current;

  if (state.attempts > LOGIN_RATE_MAX_ATTEMPTS) {
    state.blockedUntilMs = current + LOGIN_RATE_BLOCK_MS;
    loginRateMap.set(key, state);

    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(LOGIN_RATE_BLOCK_MS / 1000),
    };
  }

  loginRateMap.set(key, state);
  return { allowed: true, retryAfterSeconds: 0 };
}

function clearLoginRate(req, email) {
  loginRateMap.delete(loginRateKey(req, email));
}

// ============================================================================
// AVATAR IMAGE MODERATION
// Amazon Rekognition AI Moderation via Cloudinary
// ============================================================================

const AVATAR_IMAGE_MODERATION_KIND = "aws_rek";

function getCloudinaryModerationStatus(uploadResult, kind) {
  let moderation = [];

  if (uploadResult && Array.isArray(uploadResult.moderation)) {
    moderation = uploadResult.moderation;
  } else if (uploadResult && Array.isArray(uploadResult.moderations)) {
    moderation = uploadResult.moderations;
  }

  const wantedKind = String(kind || "").trim().toLowerCase();

  for (const item of moderation) {
    if (!item || typeof item !== "object") continue;

    const itemKind = String(item.kind || "").trim().toLowerCase();
    if (itemKind === wantedKind) {
      return String(item.status || "").trim().toLowerCase();
    }
  }

  return "";
}

async function deleteCloudinaryImage(publicId) {
  const id = String(publicId || "").trim();
  if (!id) return false;

  try {
    const result = await cloudinary.uploader.destroy(id, {
      resource_type: "image",
      type: "upload",
      invalidate: true,
    });

    console.log(
      "CLOUDINARY IMAGE DELETE:",
      id,
      result && result.result ? result.result : result
    );

    return true;
  } catch (error) {
    console.log(
      "CLOUDINARY IMAGE DELETE ERROR:",
      id,
      error && error.message ? error.message : error
    );
    return false;
  }
}

// ============================================================================
// LUXURY GLOBAL CHAT
// IMPORTANT: rawBody middleware above must stay BEFORE this installation.
// ============================================================================

const installLuxuryChat = require("./luxury-chat-server");
installLuxuryChat(app, cloudinary);

// ============================================================================
// AVATAR UPLOAD CONFIGURATION
// ============================================================================

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 4 * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, callback) => {
    const allowedTypes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/webp",
    ];

    if (!file || !allowedTypes.includes(String(file.mimetype || "").toLowerCase())) {
      return callback(new Error("نوع الصورة غير مدعوم"));
    }

    callback(null, true);
  },
});

// ============================================================================
// PLAYFAB
// ============================================================================

function getPlayFabConfig() {
  return {
    titleId: safeString(process.env.PLAYFAB_TITLE_ID, 100),
    secretKey: String(process.env.PLAYFAB_SECRET_KEY || "").trim(),
  };
}

async function playFabPost(pathValue, body) {
  const { titleId, secretKey } = getPlayFabConfig();

  if (!titleId || !secretKey) {
    return {
      code: 0,
      error: "PLAYFAB_ENV_MISSING",
    };
  }

  const safePath = String(pathValue || "");
  if (!/^\/(Server|Admin)\/[A-Za-z0-9]+$/.test(safePath)) {
    return {
      code: 0,
      error: "INVALID_PLAYFAB_PATH",
    };
  }

  const url = `https://${titleId}.playfabapi.com${safePath}`;

  try {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SecretKey": secretKey,
      },
      body: JSON.stringify(body || {}),
    });

    const text = await response.text();

    if (!text) {
      return {
        code: response.status,
        error: "EMPTY_PLAYFAB_RESPONSE",
      };
    }

    try {
      return JSON.parse(text);
    } catch (_) {
      return {
        code: response.status,
        error: "INVALID_JSON_FROM_PLAYFAB",
      };
    }
  } catch (error) {
    return {
      code: 0,
      error:
        error && error.name === "AbortError"
          ? "PLAYFAB_REQUEST_TIMEOUT"
          : "PLAYFAB_REQUEST_FAILED",
      message: error && error.message ? error.message : "request_failed",
    };
  }
}

function isPlayFabSuccess(result) {
  return !!(result && result.code === 200 && result.data !== undefined);
}

async function authenticatePlayFabSession(sessionTicket) {
  const ticket = String(sessionTicket || "").trim();

  if (!ticket) {
    return {
      success: false,
      message: "SessionTicket غير موجود",
    };
  }

  const result = await playFabPost("/Server/AuthenticateSessionTicket", {
    SessionTicket: ticket,
  });

  if (
    result.code !== 200 ||
    !result.data ||
    !result.data.UserInfo ||
    !result.data.UserInfo.PlayFabId
  ) {
    return {
      success: false,
      message: "جلسة PlayFab غير صالحة",
    };
  }

  return {
    success: true,
    playFabId: String(result.data.UserInfo.PlayFabId),
  };
}

async function getTitleInternalValue(key) {
  const safeKey = safeString(key, 300);
  if (!safeKey) return "";

  const result = await playFabPost("/Server/GetTitleInternalData", {
    Keys: [safeKey],
  });

  if (!isPlayFabSuccess(result)) return "";

  return result.data && result.data.Data && result.data.Data[safeKey]
    ? String(result.data.Data[safeKey])
    : "";
}

async function setTitleInternalValue(key, value) {
  const safeKey = safeString(key, 300);
  if (!safeKey) return false;

  const result = await playFabPost("/Server/SetTitleInternalData", {
    Key: safeKey,
    // PlayFab: Value=null يحذف المفتاح فعلياً بدل ترك قيمة فارغة متراكمة.
    Value: value === null ? null : String(value == null ? "" : value),
  });

  return isPlayFabSuccess(result);
}

// ============================================================================
// GOOGLE OAUTH INTENTS
// ============================================================================

function oauthIntentKey(token) {
  return `google_oauth_intent_${hashKey(token).slice(0, 48)}`;
}

async function createOAuthIntent(payload) {
  const token = randomToken(32);
  const expiresAtUnixMs = nowMs() + GOOGLE_OAUTH_INTENT_TTL_MS;

  const intent = {
    version: 1,
    createdAtUnixMs: nowMs(),
    expiresAtUnixMs,
    used: false,
    purpose: safeString(payload && payload.purpose, 30),
    playFabId: safeString(payload && payload.playFabId, 100),
    session: safeString(payload && payload.session, 180),
  };

  if (!intent.purpose) throw new Error("oauth_intent_purpose_missing");

  const saved = await setTitleInternalValue(
    oauthIntentKey(token),
    JSON.stringify(intent)
  );

  if (!saved) throw new Error("oauth_intent_save_failed");

  return { token, intent };
}

async function readOAuthIntent(token, expectedPurpose) {
  const safeToken = safeString(token, 300);
  if (!safeToken) return null;

  const raw = await getTitleInternalValue(oauthIntentKey(safeToken));
  if (!raw) return null;

  let intent;
  try {
    intent = JSON.parse(raw);
  } catch (_) {
    return null;
  }

  if (!intent || typeof intent !== "object") return null;
  if (intent.used) return null;

  const purpose = safeString(intent.purpose, 30);
  if (expectedPurpose && purpose !== expectedPurpose) return null;

  const expiresAtUnixMs = Number(intent.expiresAtUnixMs || 0);
  if (!expiresAtUnixMs || expiresAtUnixMs <= nowMs()) {
    // تنظيف best effort.
    setTitleInternalValue(oauthIntentKey(safeToken), null).catch(() => {});
    return null;
  }

  return {
    token: safeToken,
    intent: {
      purpose,
      playFabId: safeString(intent.playFabId, 100),
      session: safeString(intent.session, 180),
      expiresAtUnixMs,
    },
  };
}

async function consumeOAuthIntent(token, expectedPurpose) {
  const loaded = await readOAuthIntent(token, expectedPurpose);
  if (!loaded) return null;

  // نحذف/نفرّغ الـintent قبل تبادل code حتى لا يعاد استخدامه.
  const cleared = await setTitleInternalValue(oauthIntentKey(loaded.token), null);
  if (!cleared) {
    // إذا فشل التنظيف لا نكمل؛ Fail Closed ضد replay.
    return null;
  }

  return loaded.intent;
}

// ============================================================================
// GOOGLE USER
// ============================================================================

async function getGoogleUser(code, redirectUri) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) return null;

  try {
    const tokenRes = await fetchWithTimeout(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body:
          "code=" +
          encodeURIComponent(code) +
          "&client_id=" +
          encodeURIComponent(clientId) +
          "&client_secret=" +
          encodeURIComponent(clientSecret) +
          "&redirect_uri=" +
          encodeURIComponent(redirectUri) +
          "&grant_type=authorization_code",
      },
      EXTERNAL_FETCH_TIMEOUT_MS
    );

    if (!tokenRes.ok) return null;

    const tokenData = await tokenRes.json().catch(() => null);
    if (!tokenData || !tokenData.access_token) return null;

    const userRes = await fetchWithTimeout(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: "Bearer " + tokenData.access_token,
        },
      },
      EXTERNAL_FETCH_TIMEOUT_MS
    );

    if (!userRes.ok) return null;

    const user = await userRes.json().catch(() => null);
    return user && typeof user === "object" ? user : null;
  } catch (error) {
    console.log(
      "GOOGLE USER ERROR:",
      error && error.message ? error.message : error
    );
    return null;
  }
}

function buildGoogleAuthorizationUrl(redirectUri, stateToken) {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  if (!clientId) return "";

  const scope =
    "https://www.googleapis.com/auth/userinfo.email " +
    "https://www.googleapis.com/auth/userinfo.profile";

  return (
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" +
    encodeURIComponent(clientId) +
    "&redirect_uri=" +
    encodeURIComponent(redirectUri) +
    "&response_type=code" +
    "&scope=" +
    encodeURIComponent(scope) +
    "&state=" +
    encodeURIComponent(stateToken) +
    "&prompt=select_account"
  );
}

// ============================================================================
// ROOT / HEALTH
// ============================================================================

app.get("/", (req, res) => {
  res.send("Server is working 🔥");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "server awake",
    build: SERVER_BUILD,
  });
});

// ============================================================================
// GUEST
// ============================================================================

app.post("/guest", (req, res) => {
  const installId = safeString(req.body && req.body.installId, 180);

  if (!installId) {
    return res.status(400).json({
      success: false,
      message: "installId required",
    });
  }

  return res.json({
    success: true,
    playerId: "guest_" + installId,
  });
});

// ============================================================================
// SET GAME PASSWORD
// IMPORTANT: SessionTicket is authoritative. playFabId from body is optional
// compatibility data only and must match the authenticated owner.
// ============================================================================

app.post("/account/set-password", async (req, res) => {
  try {
    const sessionTicket = getSessionTicketFromRequest(req);
    const authResult = await authenticatePlayFabSession(sessionTicket);

    if (!authResult.success) {
      return res.status(401).json({
        ok: false,
        message: authResult.message || "جلسة PlayFab غير صالحة",
      });
    }

    const authenticatedPlayFabId = safeString(authResult.playFabId, 100);
    const bodyPlayFabId = safeString(req.body && req.body.playFabId, 100);
    const email = cleanEmail(req.body && req.body.email);
    const password = cleanPassword(req.body && req.body.password);

    if (bodyPlayFabId && bodyPlayFabId !== authenticatedPlayFabId) {
      return res.status(403).json({
        ok: false,
        message: "معرف اللاعب لا يطابق الجلسة الحالية",
      });
    }

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        message: "email / password مطلوب",
      });
    }

    if (!isReasonableEmail(email)) {
      return res.status(400).json({
        ok: false,
        message: "صيغة البريد غير صالحة",
      });
    }

    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({
        ok: false,
        message: "كلمة المرور لازم تكون من 6 إلى 128 حرف",
      });
    }

    const userData = await playFabPost("/Server/GetUserData", {
      PlayFabId: authenticatedPlayFabId,
      Keys: [
        "google_email",
        "account_email",
        "account_email_verified",
        "account_status",
        "google_custom_id",
      ],
    });

    if (!isPlayFabSuccess(userData)) {
      return res.status(502).json({
        ok: false,
        message: "فشل فحص الحساب",
      });
    }

    const data = userData.data && userData.data.Data ? userData.data.Data : {};

    const accountEmail =
      data.account_email && data.account_email.Value
        ? cleanEmail(data.account_email.Value)
        : "";

    const googleEmail =
      data.google_email && data.google_email.Value
        ? cleanEmail(data.google_email.Value)
        : "";

    const verified =
      !!data.account_email_verified &&
      String(data.account_email_verified.Value || "") === "1";

    const official =
      !!data.account_status &&
      String(data.account_status.Value || "") === "official";

    if (email !== accountEmail && email !== googleEmail) {
      return res.status(403).json({
        ok: false,
        message: "البريد لا يطابق الحساب",
      });
    }

    if (!verified || !official) {
      return res.status(403).json({
        ok: false,
        message: "الحساب غير موثق",
      });
    }

    const googleCustomId =
      data.google_custom_id && data.google_custom_id.Value
        ? safeString(data.google_custom_id.Value, 180)
        : "";

    if (!googleCustomId) {
      return res.status(400).json({
        ok: false,
        message: "google_custom_id غير موجود",
      });
    }

    const hash = await bcrypt.hash(password, 12);

    // سجل موحد جديد. نبقي المفاتيح القديمة أيضاً للتوافق مع البيانات الحالية.
    const recordKey = `email_password_record_${hashKey(email).slice(0, 48)}`;
    const record = {
      version: 2,
      email,
      passwordHash: hash,
      playFabId: authenticatedPlayFabId,
      customId: googleCustomId,
      updatedAtUnixMs: nowMs(),
    };

    const recordSaved = await setTitleInternalValue(recordKey, JSON.stringify(record));
    if (!recordSaved) {
      return res.status(502).json({
        ok: false,
        message: "فشل حفظ كلمة المرور",
      });
    }

    const legacyResults = await Promise.all([
      setTitleInternalValue("email_password_hash_" + email, hash),
      setTitleInternalValue(
        "email_password_playfab_" + email,
        authenticatedPlayFabId
      ),
      setTitleInternalValue("email_password_custom_" + email, googleCustomId),
    ]);

    if (legacyResults.some((ok) => !ok)) {
      console.warn("SET PASSWORD LEGACY COMPAT WRITE PARTIAL FAILURE", {
        playFabId: authenticatedPlayFabId,
      });
    }

    return res.json({
      ok: true,
      message: "تم حفظ كلمة مرور اللعبة",
    });
  } catch (error) {
    console.log("SET PASSWORD ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: "خطأ في السيرفر",
    });
  }
});

// ============================================================================
// LOGIN WITH EMAIL PASSWORD
// ============================================================================

app.post("/account/login-email-password", async (req, res) => {
  try {
    const email = cleanEmail(req.body && req.body.email);
    const password = cleanPassword(req.body && req.body.password);

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        message: "email / password مطلوب",
      });
    }

    if (!isReasonableEmail(email) || password.length > 128) {
      return res.status(401).json({
        ok: false,
        message: "البريد أو كلمة المرور غير صحيحة",
      });
    }

    const rate = checkLoginRate(req, email);
    if (!rate.allowed) {
      res.set("Retry-After", String(rate.retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        message: "محاولات كثيرة. انتظر قليلاً ثم حاول مرة أخرى",
        retryAfterSeconds: rate.retryAfterSeconds,
      });
    }

    const recordKey = `email_password_record_${hashKey(email).slice(0, 48)}`;
    const hashKeyLegacy = "email_password_hash_" + email;
    const playFabKeyLegacy = "email_password_playfab_" + email;
    const customKeyLegacy = "email_password_custom_" + email;

    const result = await playFabPost("/Server/GetTitleInternalData", {
      Keys: [
        recordKey,
        hashKeyLegacy,
        playFabKeyLegacy,
        customKeyLegacy,
      ],
    });

    if (!isPlayFabSuccess(result)) {
      return res.status(502).json({
        ok: false,
        message: "فشل فحص الحساب",
      });
    }

    const maps = result.data && result.data.Data ? result.data.Data : {};

    let passwordHash = "";
    let playFabId = "";
    let customId = "";

    const rawRecord = maps[recordKey] ? String(maps[recordKey]) : "";

    if (rawRecord) {
      try {
        const record = JSON.parse(rawRecord);
        if (record && typeof record === "object") {
          passwordHash = safeString(record.passwordHash, 200);
          playFabId = safeString(record.playFabId, 100);
          customId = safeString(record.customId, 180);
        }
      } catch (_) {}
    }

    if (!passwordHash) passwordHash = String(maps[hashKeyLegacy] || "");
    if (!playFabId) playFabId = safeString(maps[playFabKeyLegacy], 100);
    if (!customId) customId = safeString(maps[customKeyLegacy], 180);

    if (!passwordHash || !playFabId || !customId) {
      // لا نكشف إن كان البريد موجوداً أم لا.
      return res.status(401).json({
        ok: false,
        message: "البريد أو كلمة المرور غير صحيحة",
      });
    }

    const match = await bcrypt.compare(password, passwordHash).catch(() => false);

    if (!match) {
      return res.status(401).json({
        ok: false,
        message: "البريد أو كلمة المرور غير صحيحة",
      });
    }

    clearLoginRate(req, email);

    return res.json({
      ok: true,
      email,
      playFabId,
      customId,
    });
  } catch (error) {
    console.log("EMAIL PASSWORD LOGIN ERROR:", error);

    return res.status(500).json({
      ok: false,
      message: "خطأ في السيرفر",
    });
  }
});

// ============================================================================
// SECURE GOOGLE LINK START
// Unity sends SessionTicket here, receives a short-lived URL, then opens it.
// POST /auth/google/link/start
// Body/header: sessionTicket
// Response: { ok:true, url:"https://.../auth/google?token=..." }
// ============================================================================

app.post("/auth/google/link/start", async (req, res) => {
  try {
    const sessionTicket = getSessionTicketFromRequest(req);
    const authResult = await authenticatePlayFabSession(sessionTicket);

    if (!authResult.success) {
      return res.status(401).json({
        ok: false,
        message: authResult.message || "جلسة PlayFab غير صالحة",
      });
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(503).json({
        ok: false,
        message: "إعدادات Google ناقصة في السيرفر",
      });
    }

    const created = await createOAuthIntent({
      purpose: "link",
      playFabId: authResult.playFabId,
    });

    return res.json({
      ok: true,
      url: `${SERVER_URL}/auth/google?token=${encodeURIComponent(created.token)}`,
      expiresInSeconds: Math.floor(GOOGLE_OAUTH_INTENT_TTL_MS / 1000),
    });
  } catch (error) {
    console.log("GOOGLE LINK START ERROR:", error);
    return res.status(500).json({
      ok: false,
      message: "تعذر بدء ربط Google",
    });
  }
});

// ============================================================================
// GOOGLE LINK REDIRECT
// Legacy playFabId-only flow is intentionally rejected because it allowed
// linking Google to any PlayFabId supplied by the caller.
// ============================================================================

app.get("/auth/google", async (req, res) => {
  try {
    const token = safeString(req.query && req.query.token, 300);

    if (!token) {
      return res.status(400).send(
        "رابط ربط Google غير صالح. ابدأ الربط من داخل اللعبة مرة أخرى"
      );
    }

    const loaded = await readOAuthIntent(token, "link");
    if (!loaded || !loaded.intent.playFabId) {
      return res.status(400).send(
        "انتهت صلاحية طلب ربط Google. ارجع إلى اللعبة وحاول مرة أخرى"
      );
    }

    const redirectUri = SERVER_URL + "/auth/google/callback";
    const authUrl = buildGoogleAuthorizationUrl(redirectUri, token);

    if (!authUrl) {
      return res.status(503).send("GOOGLE_CLIENT_ID ناقص");
    }

    return res.redirect(authUrl);
  } catch (error) {
    console.log("GOOGLE LINK REDIRECT ERROR:", error);
    return res.status(500).send("حدث خطأ أثناء بدء ربط Google");
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = safeString(req.query && req.query.code, 4000);
    const stateToken = safeString(req.query && req.query.state, 300);

    if (!code || !stateToken) {
      return res.send("فشل الربط: بيانات ناقصة");
    }

    const intent = await consumeOAuthIntent(stateToken, "link");
    if (!intent || !intent.playFabId) {
      return res.send("فشل الربط: الطلب منتهي أو مستخدم مسبقًا");
    }

    const playFabId = intent.playFabId;
    const redirectUri = SERVER_URL + "/auth/google/callback";
    const user = await getGoogleUser(code, redirectUri);

    if (!user) {
      return res.send("فشل أخذ توكن Google");
    }

    const email = cleanEmail(user.email);
    const googleId = safeString(user.id, 200);

    if (!email || !googleId || !isReasonableEmail(email)) {
      return res.send("فشل قراءة بيانات Google");
    }

    const googleCustomId = "google_" + googleId;
    const googleIdMapKey = "google_id_map_" + googleId;
    const googleEmailMapKey = "google_email_map_" + email;
    const googleCustomMapKey = "google_custom_map_" + email;

    const checkMap = await playFabPost("/Server/GetTitleInternalData", {
      Keys: [googleIdMapKey, googleEmailMapKey, googleCustomMapKey],
    });

    if (!isPlayFabSuccess(checkMap)) {
      return res.send("فشل فحص ربط Google");
    }

    const maps = checkMap.data && checkMap.data.Data ? checkMap.data.Data : {};

    if (maps[googleIdMapKey] && String(maps[googleIdMapKey]) !== playFabId) {
      return res.send("هذا Google مربوط بحساب آخر");
    }

    if (
      maps[googleEmailMapKey] &&
      String(maps[googleEmailMapKey]) !== playFabId
    ) {
      return res.send("هذا البريد مربوط بحساب آخر");
    }

    const savePlayer = await playFabPost("/Server/UpdateUserData", {
      PlayFabId: playFabId,
      Data: {
        google_email: email,
        google_id: googleId,
        google_custom_id: googleCustomId,
        google_linked: "true",
        account_email: email,
        account_email_verified: "1",
        account_status: "official",
        login_provider: "google",
      },
    });

    if (!isPlayFabSuccess(savePlayer)) {
      return res.send("فشل حفظ الربط");
    }

    const mapWrites = await Promise.all([
      setTitleInternalValue(googleIdMapKey, playFabId),
      setTitleInternalValue(googleEmailMapKey, playFabId),
      setTitleInternalValue(googleCustomMapKey, googleCustomId),
      setTitleInternalValue("google_playfab_map_" + googleCustomId, playFabId),
    ]);

    if (mapWrites.some((ok) => !ok)) {
      console.warn("GOOGLE LINK MAP WRITE PARTIAL FAILURE", {
        playFabId,
        googleId,
      });

      return res.send(
        "تم ربط البيانات الأساسية لكن تعذر إكمال فهرسة الحساب. حاول مرة أخرى من اللعبة"
      );
    }

    return res.send(`
      <html>
      <head><meta charset="UTF-8"></head>
      <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
        <h2>تم ربط Google بنجاح ✅</h2>
        <p>${escapeHtml(email)}</p>
        <p>ارجع إلى اللعبة</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.log("GOOGLE LINK ERROR:", error);
    return res.send("حدث خطأ في السيرفر");
  }
});

// ============================================================================
// GOOGLE LOGIN FROM LOGIN SCREEN
// Existing public route remains, but state is now a server-side one-time token.
// ============================================================================

app.get("/auth/google/login", async (req, res) => {
  try {
    const session = safeString(req.query && req.query.session, 180);

    if (!session) {
      return res.send("session مفقود");
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.send("إعدادات Google ناقصة");
    }

    const created = await createOAuthIntent({
      purpose: "login",
      session,
    });

    const redirectUri = SERVER_URL + "/auth/google/login/callback";
    const authUrl = buildGoogleAuthorizationUrl(redirectUri, created.token);

    if (!authUrl) {
      return res.send("GOOGLE_CLIENT_ID ناقص");
    }

    return res.redirect(authUrl);
  } catch (error) {
    console.log("GOOGLE LOGIN START ERROR:", error);
    return res.send("حدث خطأ أثناء بدء تسجيل Google");
  }
});

app.get("/auth/google/login/callback", async (req, res) => {
  try {
    const code = safeString(req.query && req.query.code, 4000);
    const stateToken = safeString(req.query && req.query.state, 300);

    if (!code || !stateToken) {
      return res.send("فشل تسجيل الدخول: بيانات ناقصة");
    }

    const intent = await consumeOAuthIntent(stateToken, "login");
    if (!intent || !intent.session) {
      return res.send("فشل تسجيل الدخول: الطلب منتهي أو مستخدم مسبقًا");
    }

    const session = intent.session;
    const redirectUri = SERVER_URL + "/auth/google/login/callback";
    const user = await getGoogleUser(code, redirectUri);

    if (!user) {
      return res.send("فشل تسجيل Google");
    }

    const email = cleanEmail(user.email);
    const googleId = safeString(user.id, 200);

    if (!email || !googleId || !isReasonableEmail(email)) {
      return res.send("فشل قراءة بيانات Google");
    }

    const googleCustomId = "google_" + googleId;
    const emailMapKey = "google_email_map_" + email;
    const customMapKey = "google_custom_map_" + email;

    const mapResult = await playFabPost("/Server/GetTitleInternalData", {
      Keys: [emailMapKey, customMapKey],
    });

    if (!isPlayFabSuccess(mapResult)) {
      return res.send("فشل فحص الحساب");
    }

    const maps = mapResult.data && mapResult.data.Data ? mapResult.data.Data : {};
    const playFabId = safeString(maps[emailMapKey], 100);
    const savedCustomId = safeString(maps[customMapKey], 180) || googleCustomId;

    const sessionKey = "google_login_session_" + session;

    if (!playFabId) {
      const payload = {
        version: 2,
        ok: false,
        message: "هذا البريد غير مربوط بحساب",
        email,
        createdAtUnixMs: nowMs(),
        expiresAtUnixMs: nowMs() + GOOGLE_LOGIN_SESSION_TTL_MS,
      };

      const saved = await setTitleInternalValue(sessionKey, JSON.stringify(payload));
      if (!saved) {
        return res.send("تعذر حفظ نتيجة تسجيل Google");
      }

      return res.send(`
        <html>
        <head><meta charset="UTF-8"></head>
        <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
          <h2>هذا البريد غير مربوط بحساب ❌</h2>
          <p>${escapeHtml(email)}</p>
          <p>ارجع إلى اللعبة</p>
        </body>
        </html>
      `);
    }

    const customSaved = await setTitleInternalValue(customMapKey, savedCustomId);
    if (!customSaved) {
      return res.send("تعذر تحديث بيانات تسجيل Google");
    }

    const payload = {
      version: 2,
      ok: true,
      email,
      playFabId,
      customId: savedCustomId,
      createdAtUnixMs: nowMs(),
      expiresAtUnixMs: nowMs() + GOOGLE_LOGIN_SESSION_TTL_MS,
    };

    const sessionSaved = await setTitleInternalValue(
      sessionKey,
      JSON.stringify(payload)
    );

    if (!sessionSaved) {
      return res.send("تعذر حفظ نتيجة تسجيل Google");
    }

    return res.send(`
      <html>
      <head>
        <meta charset="UTF-8">
        <script>
          setTimeout(function () {
            window.location.href = ${JSON.stringify(GAME_DEEP_LINK)};
          }, 1500);
        </script>
      </head>
      <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
        <h2>تم تسجيل الدخول بنجاح ✅</h2>
        <p>${escapeHtml(email)}</p>
        <p>جاري الرجوع إلى اللعبة...</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.log("GOOGLE LOGIN ERROR:", error);
    return res.send("حدث خطأ أثناء تسجيل الدخول");
  }
});

// ============================================================================
// GOOGLE LOGIN STATUS
// ============================================================================

app.get("/auth/google/login/status", async (req, res) => {
  try {
    const session = safeString(req.query && req.query.session, 180);

    if (!session) {
      return res.json({
        ok: false,
        done: false,
        message: "session مفقود",
      });
    }

    const key = "google_login_session_" + session;
    const raw = await getTitleInternalValue(key);

    if (!raw) {
      return res.json({
        ok: false,
        done: false,
        message: "انتظار تسجيل Google",
      });
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      // تنظيف قيمة تالفة best effort.
      setTitleInternalValue(key, null).catch(() => {});
      return res.json({
        ok: false,
        done: true,
        message: "رد غير صالح",
      });
    }

    const expiresAtUnixMs = Number(data && data.expiresAtUnixMs ? data.expiresAtUnixMs : 0);

    if (expiresAtUnixMs > 0 && expiresAtUnixMs <= nowMs()) {
      setTitleInternalValue(key, null).catch(() => {});
      return res.json({
        ok: false,
        done: true,
        message: "انتهت صلاحية تسجيل Google. حاول مرة أخرى",
      });
    }

    // One-shot delivery: نعيد النتيجة ثم ننظفها.
    setTitleInternalValue(key, null).catch(() => {});

    return res.json({
      ok: !!data.ok,
      done: true,
      message: safeString(data.message, 300),
      email: safeString(data.email, 254),
      playFabId: safeString(data.playFabId, 100),
      customId: safeString(data.customId, 180),
    });
  } catch (error) {
    console.log("GOOGLE LOGIN STATUS ERROR:", error);
    return res.status(500).json({
      ok: false,
      done: false,
      message: "تعذر قراءة حالة تسجيل Google",
    });
  }
});

// ============================================================================
// AVATAR UPLOAD - DRAFT ONLY
// ============================================================================

app.post(
  "/upload-avatar",
  avatarUpload.single("avatar"),
  async (req, res) => {
    let uploadedPublicId = "";

    try {
      const sessionTicket = getSessionTicketFromRequest(req);

      if (!sessionTicket) {
        console.log("AVATAR UPLOAD: SESSION TICKET MISSING");

        return res.status(401).json({
          ok: false,
          success: false,
          message: "جلسة اللاعب غير موجودة",
        });
      }

      if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({
          ok: false,
          success: false,
          message: "لم يتم إرسال الصورة",
        });
      }

      const authResult = await authenticatePlayFabSession(sessionTicket);

      if (!authResult.success) {
        console.log("AVATAR SESSION ERROR:", authResult.message);

        return res.status(401).json({
          ok: false,
          success: false,
          message: authResult.message || "جلسة PlayFab غير صالحة",
        });
      }

      const playFabId = safeString(authResult.playFabId, 100);
      const safePlayFabId = playFabId.replace(/[^a-zA-Z0-9_-]/g, "");

      if (!safePlayFabId) {
        return res.status(400).json({
          ok: false,
          success: false,
          message: "معرف اللاعب غير صالح",
        });
      }

      const rawRequestId = safeString(req.body && req.body.requestId, 120);
      const safeRequestId = rawRequestId
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .substring(0, 100);

      const draftId =
        safeRequestId || `${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;

      const publicId =
        "player_avatar_drafts/" + safePlayFabId + "/" + draftId;

      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            public_id: publicId,
            overwrite: true,
            invalidate: true,
            resource_type: "image",
            format: "jpg",
            moderation: AVATAR_IMAGE_MODERATION_KIND,
            transformation: [
              {
                width: 512,
                height: 512,
                crop: "fill",
                gravity: "auto",
              },
              {
                quality: "auto:good",
              },
            ],
          },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        );

        uploadStream.end(req.file.buffer);
      });

      if (!uploadResult || !uploadResult.public_id) {
        return res.status(500).json({
          ok: false,
          success: false,
          message: "لم يتم إنشاء الصورة على Cloudinary",
        });
      }

      uploadedPublicId = String(uploadResult.public_id).trim();

      const moderationStatus = getCloudinaryModerationStatus(
        uploadResult,
        AVATAR_IMAGE_MODERATION_KIND
      );

      console.log(
        "AVATAR MODERATION:",
        playFabId,
        uploadedPublicId,
        moderationStatus || "missing"
      );

      // Fail Closed: لا نعتمد إلا approved الصريحة.
      if (moderationStatus !== "approved") {
        await deleteCloudinaryImage(uploadedPublicId);
        uploadedPublicId = "";

        if (moderationStatus === "rejected") {
          return res.status(422).json({
            ok: false,
            success: false,
            moderationRejected: true,
            moderationStatus: "rejected",
            message: "تم رفض الصورة لأنها تخالف قوانين الصور",
          });
        }

        return res.status(503).json({
          ok: false,
          success: false,
          moderationRejected: false,
          moderationStatus: moderationStatus || "missing",
          message: "تعذر فحص الصورة الآن، حاول مرة أخرى بعد قليل",
        });
      }

      if (!uploadResult.secure_url) {
        await deleteCloudinaryImage(uploadedPublicId);
        uploadedPublicId = "";

        return res.status(500).json({
          ok: false,
          success: false,
          message: "لم يتم إنشاء رابط الصورة",
        });
      }

      const avatarUrl = String(uploadResult.secure_url).trim();
      const avatarVersion = uploadResult.version
        ? String(uploadResult.version)
        : String(Date.now());
      const updatedUnix = Math.floor(Date.now() / 1000);

      console.log(
        "AVATAR DRAFT APPROVED AND UPLOADED:",
        playFabId,
        draftId,
        avatarVersion,
        avatarUrl
      );

      // بعد هذه النقطة الملف مقصود أن يبقى Draft حتى يعتمد CloudScript التغيير.
      uploadedPublicId = "";

      return res.status(200).json({
        ok: true,
        success: true,
        message: "تم رفع الصورة مؤقتًا",
        draft: true,
        moderationApproved: true,
        moderationStatus: "approved",
        playFabId,
        requestId: safeRequestId,
        draftId,
        draftPublicId: String(uploadResult.public_id).trim(),
        avatarUrl,
        imageUrl: avatarUrl,
        secureUrl: avatarUrl,
        secure_url: avatarUrl,
        url: avatarUrl,
        avatarVersion,
        version: avatarVersion,
        avatarUpdatedUnix: updatedUnix,
      });
    } catch (error) {
      if (uploadedPublicId) {
        await deleteCloudinaryImage(uploadedPublicId);
      }

      console.log("UPLOAD AVATAR ERROR:", error);

      return res.status(500).json({
        ok: false,
        success: false,
        message: "تعذر رفع أو فحص الصورة، حاول مرة أخرى",
      });
    }
  }
);

// ============================================================================
// ERROR HANDLER
// ============================================================================

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        ok: false,
        success: false,
        message: "حجم الصورة أكبر من 4 ميجابايت",
      });
    }

    return res.status(400).json({
      ok: false,
      success: false,
      message: "فشل استقبال الملف",
    });
  }

  if (error) {
    console.log(
      "SERVER MIDDLEWARE ERROR:",
      error && error.message ? error.message : error
    );

    return res.status(400).json({
      ok: false,
      success: false,
      message: "حدث خطأ أثناء استقبال الطلب",
    });
  }

  next();
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT, {
    build: SERVER_BUILD,
    serverUrl: SERVER_URL,
    luxuryChat: true,
    rawBodyForCloudinaryWebhook: true,
    secureGoogleLinkStartRoute: "/auth/google/link/start",
  });
});

