const express = require("express");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const app = express();

app.use(express.json());

const SERVER_URL = "https://my-server-i40i.onrender.com";

function getPlayFabConfig() {
    return {
        titleId: process.env.PLAYFAB_TITLE_ID,
        secretKey: process.env.PLAYFAB_SECRET_KEY
    };
}

function playFabUrl(titleId, path) {
    return "https://" + titleId + ".playfabapi.com" + path;
}

async function playFabPost(path, body) {
    const { titleId, secretKey } = getPlayFabConfig();

    const res = await fetch(playFabUrl(titleId, path), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-SecretKey": secretKey
        },
        body: JSON.stringify(body)
    });

    return await res.json();
}

function makeEmailTransporter() {
    return nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
}

app.get("/", (req, res) => {
    res.send("Server is working 🔥");
});

app.get("/health", (req, res) => {
    res.status(200).json({
        ok: true,
        message: "server awake"
    });
});

app.post("/guest", (req, res) => {
    const installId = req.body.installId;

    if (!installId) {
        return res.status(400).json({
            success: false,
            message: "installId required"
        });
    }

    return res.json({
        success: true,
        playerId: "guest_" + installId
    });
});

app.get("/test-google-log", (req, res) => {
    console.log("TEST GOOGLE LOG WORKING");
    res.send("test ok");
});

// ===============================
// تسجيل Google
// ===============================

app.get("/auth/google", (req, res) => {
    const playFabId = String(req.query.playFabId || "").trim();

    if (!playFabId) {
        return res.send("playFabId مفقود");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;

    if (!clientId) {
        return res.send("GOOGLE_CLIENT_ID ناقص في Render");
    }

    const redirectUri = SERVER_URL + "/auth/google/callback";

    const scope =
        "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

    const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        "?client_id=" + encodeURIComponent(clientId) +
        "&redirect_uri=" + encodeURIComponent(redirectUri) +
        "&response_type=code" +
        "&scope=" + encodeURIComponent(scope) +
        "&state=" + encodeURIComponent(playFabId) +
        "&prompt=select_account";

    console.log("GOOGLE LOGIN START:", playFabId);

    return res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => {
    try {
        console.log("GOOGLE CALLBACK HIT");
        console.log("QUERY:", req.query);

        const code = req.query.code;
        const playFabId = String(req.query.state || "").trim();

        if (!code || !playFabId) {
            return res.send("فشل تسجيل الدخول: بيانات ناقصة");
        }

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const titleId = process.env.PLAYFAB_TITLE_ID;
        const secretKey = process.env.PLAYFAB_SECRET_KEY;

        if (!clientId || !clientSecret || !titleId || !secretKey) {
            return res.send("إعدادات السيرفر ناقصة");
        }

        const redirectUri = SERVER_URL + "/auth/google/callback";

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body:
                "code=" + encodeURIComponent(code) +
                "&client_id=" + encodeURIComponent(clientId) +
                "&client_secret=" + encodeURIComponent(clientSecret) +
                "&redirect_uri=" + encodeURIComponent(redirectUri) +
                "&grant_type=authorization_code"
        });

        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.log("TOKEN ERROR:", JSON.stringify(tokenData));
            return res.send("فشل أخذ توكن Google");
        }

        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: {
                Authorization: "Bearer " + tokenData.access_token
            }
        });

        const user = await userRes.json();

        const email = String(user.email || "").trim().toLowerCase();
        const googleId = String(user.id || "").trim();

        if (!email || !googleId) {
            return res.send("فشل قراءة بيانات Google");
        }

        const googleIdMapKey = "google_id_map_" + googleId;
        const googleEmailMapKey = "google_email_map_" + email;

        const playerData = await playFabPost("/Server/GetUserData", {
            PlayFabId: playFabId,
            Keys: [
                "google_linked",
                "google_email",
                "google_id",
                "account_email",
                "account_email_verified",
                "account_status"
            ]
        });

        if (playerData.code !== 200) {
            return res.send("فشل فحص بيانات اللاعب");
        }

        const userData =
            playerData.data && playerData.data.Data
                ? playerData.data.Data
                : {};

        const oldEmail =
            userData.account_email && userData.account_email.Value
                ? String(userData.account_email.Value).trim().toLowerCase()
                : "";

        const oldGoogleLinked =
            userData.google_linked &&
            userData.google_linked.Value === "true";

        if (oldGoogleLinked || oldEmail) {
            return res.send("هذا الحساب مربوط مسبقاً ببريد: " + oldEmail);
        }

        const checkMapData = await playFabPost("/Server/GetTitleInternalData", {
            Keys: [googleIdMapKey, googleEmailMapKey]
        });

        if (checkMapData.code !== 200) {
            return res.send("فشل فحص الحساب من PlayFab");
        }

        const maps =
            checkMapData.data && checkMapData.data.Data
                ? checkMapData.data.Data
                : {};

        if (maps[googleIdMapKey]) {
            return res.send("هذا حساب Google مستخدم مسبقاً");
        }

        if (maps[googleEmailMapKey]) {
            return res.send("هذا البريد مستخدم مسبقاً");
        }

        const savePlayerData = await playFabPost("/Server/UpdateUserData", {
            PlayFabId: playFabId,
            Data: {
                google_email: email,
                google_id: googleId,
                google_linked: "true",
                account_email: email,
                account_email_verified: "1",
                account_status: "official",
                login_provider: "google"
            }
        });

        if (savePlayerData.code !== 200) {
            return res.send("فشل حفظ الحساب في PlayFab");
        }

        const saveGoogleIdMapData = await playFabPost("/Server/SetTitleInternalData", {
            Key: googleIdMapKey,
            Value: playFabId
        });

        const saveEmailMapData = await playFabPost("/Server/SetTitleInternalData", {
            Key: googleEmailMapKey,
            Value: playFabId
        });

        if (saveGoogleIdMapData.code !== 200 || saveEmailMapData.code !== 200) {
            return res.send("تم حفظ البريد لكن فشل حفظ منع التكرار");
        }

        return res.send(`
            <html>
            <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                <h2>تم ربط حساب Google بنجاح ✅</h2>
                <p>${email}</p>
                <p>ارجع إلى اللعبة</p>
            </body>
            </html>
        `);

    } catch (e) {
        console.log("CALLBACK ERROR:", e);
        return res.send("حدث خطأ في السيرفر");
    }
});

// ===============================
// طلب إلغاء ربط Google
// ===============================

app.get("/auth/google/unlink/request", async (req, res) => {
    try {
        const playFabId = String(req.query.playFabId || "").trim();

        if (!playFabId) {
            return res.send("playFabId مفقود");
        }

        const playerData = await playFabPost("/Server/GetUserData", {
            PlayFabId: playFabId,
            Keys: [
                "google_email",
                "google_id",
                "google_linked",
                "account_email"
            ]
        });

        if (playerData.code !== 200) {
            return res.send("فشل قراءة بيانات اللاعب");
        }

        const data =
            playerData.data && playerData.data.Data
                ? playerData.data.Data
                : {};

        const googleLinked =
            data.google_linked &&
            data.google_linked.Value === "true";

        const email =
            data.google_email && data.google_email.Value
                ? String(data.google_email.Value).trim().toLowerCase()
                : "";

        const googleId =
            data.google_id && data.google_id.Value
                ? String(data.google_id.Value).trim()
                : "";

        if (!googleLinked || !email || !googleId) {
            return res.send("الحساب غير مربوط بـ Google");
        }

        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = Date.now() + 15 * 60 * 1000;

        const tokenKey = "unlink_google_token_" + token;

        const saveToken = await playFabPost("/Server/SetTitleInternalData", {
            Key: tokenKey,
            Value: JSON.stringify({
                playFabId: playFabId,
                email: email,
                googleId: googleId,
                expiresAt: expiresAt,
                used: false
            })
        });

        if (saveToken.code !== 200) {
            return res.send("فشل إنشاء رابط الإلغاء");
        }

        const confirmUrl =
            SERVER_URL + "/auth/google/unlink/confirm?token=" + encodeURIComponent(token);

        const transporter = makeEmailTransporter();

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: "تأكيد إلغاء ربط حساب Google",
            html: `
                <div style="font-family:Arial;text-align:right;direction:rtl;">
                    <h2>تأكيد إلغاء ربط حساب Google</h2>
                    <p>إذا كنت تريد إلغاء ربط هذا البريد من حساب اللعبة اضغط الرابط:</p>
                    <p><a href="${confirmUrl}">إلغاء الربط</a></p>
                    <p>الرابط صالح لمدة 15 دقيقة فقط.</p>
                    <p>إذا لم تطلب هذا الإجراء تجاهل الرسالة.</p>
                </div>
            `
        });

        return res.send("تم إرسال رابط إلغاء الربط إلى البريد: " + email);

    } catch (e) {
        console.log("UNLINK REQUEST ERROR:", e);
        return res.send("حدث خطأ أثناء إرسال رابط الإلغاء");
    }
});

// ===============================
// تأكيد إلغاء ربط Google
// ===============================

app.get("/auth/google/unlink/confirm", async (req, res) => {
    try {
        const token = String(req.query.token || "").trim();

        if (!token) {
            return res.send("رابط غير صالح");
        }

        const tokenKey = "unlink_google_token_" + token;

        const tokenData = await playFabPost("/Server/GetTitleInternalData", {
            Keys: [tokenKey]
        });

        if (tokenData.code !== 200) {
            return res.send("فشل قراءة رابط الإلغاء");
        }

        const raw =
            tokenData.data &&
            tokenData.data.Data &&
            tokenData.data.Data[tokenKey]
                ? tokenData.data.Data[tokenKey]
                : "";

        if (!raw) {
            return res.send("رابط الإلغاء غير موجود أو منتهي");
        }

        let info = null;

        try {
            info = JSON.parse(raw);
        } catch (e) {
            return res.send("بيانات الرابط غير صالحة");
        }

        if (info.used === true) {
            return res.send("تم استخدام الرابط مسبقاً");
        }

        if (Date.now() > parseInt(info.expiresAt || 0, 10)) {
            return res.send("انتهت صلاحية رابط الإلغاء");
        }

        const playFabId = String(info.playFabId || "").trim();
        const email = String(info.email || "").trim().toLowerCase();
        const googleId = String(info.googleId || "").trim();

        if (!playFabId || !email || !googleId) {
            return res.send("بيانات الإلغاء ناقصة");
        }

        const googleIdMapKey = "google_id_map_" + googleId;
        const googleEmailMapKey = "google_email_map_" + email;

        const removePlayerData = await playFabPost("/Server/UpdateUserData", {
            PlayFabId: playFabId,
            KeysToRemove: [
                "google_email",
                "google_id",
                "google_linked",
                "account_email",
                "account_email_verified",
                "account_status",
                "login_provider"
            ]
        });

        if (removePlayerData.code !== 200) {
            return res.send("فشل حذف بيانات الربط من اللاعب");
        }

        await playFabPost("/Server/SetTitleInternalData", {
            Key: googleIdMapKey,
            Value: ""
        });

        await playFabPost("/Server/SetTitleInternalData", {
            Key: googleEmailMapKey,
            Value: ""
        });

        await playFabPost("/Server/SetTitleInternalData", {
            Key: tokenKey,
            Value: JSON.stringify({
                playFabId: playFabId,
                email: email,
                googleId: googleId,
                expiresAt: info.expiresAt,
                used: true
            })
        });

        return res.send(`
            <html>
            <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                <h2>تم إلغاء ربط Google بنجاح ✅</h2>
                <p>يمكنك الآن الرجوع للعبة وربط بريد جديد.</p>
            </body>
            </html>
        `);

    } catch (e) {
        console.log("UNLINK CONFIRM ERROR:", e);
        return res.send("حدث خطأ أثناء إلغاء الربط");
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
