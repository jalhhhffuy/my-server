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
