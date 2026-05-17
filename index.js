const express = require("express");
const app = express();

app.use(express.json());

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.send("Server is working 🔥");
});

// فحص/إيقاظ السيرفر
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    message: "server awake"
  });
});

// تسجيل زائر
app.post("/guest", (req, res) => {
  const installId = req.body.installId;

  if (!installId) {
    return res.status(400).json({
      success: false,
      message: "installId required"
    });
  }

  const playerId = "guest_" + installId;

  return res.json({
    success: true,
    playerId: playerId
  });
});

// تشغيل السيرفر
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
// تسجيل دخول قوقل
app.get("/auth/google", (req, res) => {

    const clientId = "218711384600-6dc1biu2g1kmh9rk6n3bd9uvq8kpmsjs.apps.googleusercontent.com";

    const redirectUri =
        "https://my-server-i40i.onrender.com/auth/google/callback";

    const scope =
        "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

    const googleUrl =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        "?client_id=" + clientId +
        "&redirect_uri=" + encodeURIComponent(redirectUri) +
        "&response_type=code" +
        "&scope=" + encodeURIComponent(scope);

    res.redirect(googleUrl);
});

// رجوع قوقل بعد تسجيل الدخول
app.get("/auth/google/callback", async (req, res) => {

    const code = req.query.code;

    if (!code) {
        return res.send("Google login failed");
    }

    res.send("تم تسجيل الدخول بقوقل بنجاح");
});
// تسجيل دخول قوقل
app.get("/auth/google", (req, res) => {

    const clientId = "218711384600-6dc1biu2g1kmh9rk6n3bd9uvq8kpmsjs.apps.googleusercontent.com";

    const redirectUri =
        "https://my-server-i40i.onrender.com/auth/google/callback";

    const playFabId = req.query.playFabId || "";

    const scope =
        "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

    const googleUrl =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        "?client_id=" + clientId +
        "&redirect_uri=" + encodeURIComponent(redirectUri) +
        "&response_type=code" +
        "&scope=" + encodeURIComponent(scope) +
        "&state=" + encodeURIComponent(playFabId);

    res.redirect(googleUrl);
});

app.get("/auth/google/callback", async (req, res) => {

    try {
        const code = req.query.code;
        const playFabId = req.query.state;

        if (!code || !playFabId) {
            return res.send("فشل تسجيل الدخول: بيانات ناقصة");
        }

        const clientId =
            "218711384600-6dc1biu2g1kmh9rk6n3bd9uvq8kpmsjs.apps.googleusercontent.com";

        const clientSecret =
            "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";

        const redirectUri =
            "https://my-server-i40i.onrender.com/auth/google/callback";

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
            console.log(tokenData);
            return res.send("فشل أخذ توكن Google");
        }

        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: {
                Authorization: "Bearer " + tokenData.access_token
            }
        });

        const user = await userRes.json();

        const email = user.email || "";
        const googleId = user.id || "";

        if (!email || !googleId) {
            return res.send("فشل قراءة بيانات Google");
        }

        const titleId = "172E29";
        const secretKey = "MWSIKS1CNGIAXCF9MRTHF1G7X4BZSZBXA1TUIBRGYK9HRMP5IH";

        const pfRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/UpdateUserData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    PlayFabId: playFabId,
                    Data: {
                        google_email: email,
                        google_id: googleId,
                        google_linked: "true"
                    }
                })
            }
        );

        const pfData = await pfRes.json();

        if (pfData.code !== 200) {
            console.log(pfData);
            return res.send("فشل حفظ الحساب في PlayFab");
        }

        res.send("تم ربط حساب Google بنجاح. ارجع للعبة.");

    } catch (e) {
        console.log(e);
        res.send("حدث خطأ في السيرفر");
    }
});
app.get("/auth/google", (req, res) => {
    const playFabId = String(req.query.playFabId || "").trim();

    if (!playFabId) {
        return res.send("playFabId مفقود");
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;

    const redirectUri =
        "https://my-server-i40i.onrender.com/auth/google/callback";

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
        const playFabId = req.query.state;

        if (!code || !playFabId) {
            return res.send("فشل تسجيل الدخول: بيانات ناقصة");
        }

        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        const titleId = process.env.PLAYFAB_TITLE_ID;
        const secretKey = process.env.PLAYFAB_SECRET_KEY;

        if (!clientId || !clientSecret || !titleId || !secretKey) {
            console.log("MISSING ENV", {
                clientId: !!clientId,
                clientSecret: !!clientSecret,
                titleId: !!titleId,
                secretKey: !!secretKey
            });
            return res.send("إعدادات السيرفر ناقصة");
        }

        const redirectUri =
            "https://my-server-i40i.onrender.com/auth/google/callback";

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body:
                "code=" + encodeURIComponent(code) +
                "&client_id=" + encodeURIComponent(clientId) +
                "&client_secret=" + encodeURIComponent(clientSecret) +
                "&redirect_uri=" + encodeURIComponent(redirectUri) +
                "&grant_type=authorization_code"
        });

        const tokenData = await tokenRes.json();

        if (!tokenData.access_token) {
            console.log("TOKEN ERROR:", tokenData);
            return res.send("فشل أخذ توكن Google");
        }

        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: "Bearer " + tokenData.access_token }
        });

        const user = await userRes.json();

        const email = String(user.email || "").trim().toLowerCase();
        const googleId = String(user.id || "").trim();

        console.log("GOOGLE USER:", { email: email, googleId: googleId });

        if (!email || !googleId) {
            return res.send("فشل قراءة بيانات Google");
        }

        const googleIdMapKey = "google_id_map_" + googleId;
        const googleEmailMapKey = "google_email_map_" + email;

        const checkMapRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/GetTitleInternalData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    Keys: [googleIdMapKey, googleEmailMapKey]
                })
            }
        );

        const checkMapData = await checkMapRes.json();
        console.log("CHECK MAP:", checkMapData);

        if (checkMapData.code !== 200) {
            return res.send("فشل فحص الحساب من PlayFab");
        }

        const maps =
            checkMapData.data && checkMapData.data.Data
                ? checkMapData.data.Data
                : {};

        const linkedByGoogleId = maps[googleIdMapKey] || "";
        const linkedByEmail = maps[googleEmailMapKey] || "";

        if (linkedByGoogleId && linkedByGoogleId !== playFabId) {
            return res.send("هذا حساب Google مربوط بحساب آخر");
        }

        if (linkedByEmail && linkedByEmail !== playFabId) {
            return res.send("هذا البريد مستخدم مسبقاً");
        }

        const savePlayerRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/UpdateUserData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
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
                })
            }
        );

        const savePlayerData = await savePlayerRes.json();
        console.log("SAVE PLAYER:", savePlayerData);

        if (savePlayerData.code !== 200) {
            return res.send("فشل حفظ الحساب في PlayFab");
        }

        const saveGoogleIdMapRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/SetTitleInternalData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    Key: googleIdMapKey,
                    Value: playFabId
                })
            }
        );

        const saveGoogleIdMapData = await saveGoogleIdMapRes.json();
        console.log("SAVE GOOGLE ID MAP:", saveGoogleIdMapData);

        const saveEmailMapRes = await fetch(
            "https://" + titleId + ".playfabapi.com/Server/SetTitleInternalData",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-SecretKey": secretKey
                },
                body: JSON.stringify({
                    Key: googleEmailMapKey,
                    Value: playFabId
                })
            }
        );

        const saveEmailMapData = await saveEmailMapRes.json();
        console.log("SAVE EMAIL MAP:", saveEmailMapData);

        if (saveGoogleIdMapData.code !== 200 || saveEmailMapData.code !== 200) {
            return res.send("تم حفظ البريد لكن فشل حفظ منع التكرار");
        }

        return res.send(`
            <html>
            <body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl;">
                <h2>تم ربط حساب Google بنجاح ✅</h2>
                <p>ارجع إلى اللعبة</p>
            </body>
            </html>
        `);

    } catch (e) {
        console.log("CALLBACK ERROR:", e);
        return res.send("حدث خطأ في السيرفر");
    }
});
