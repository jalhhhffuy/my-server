const express = require("express");
const app = express();

app.use(express.json());

// الصفحة الرئيسية
app.get("/", (req, res) => {
  res.send("Server is working 🔥");
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

  res.json({
    success: true,
    playerId: playerId
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running...");
});
