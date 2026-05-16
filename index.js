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
