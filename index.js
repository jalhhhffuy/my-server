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
