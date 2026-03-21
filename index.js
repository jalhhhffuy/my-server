const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server is working 🔥");
});

// تسجيل زائر
app.post("/guest", (req, res) => {
  const guestId = "guest_" + Math.floor(Math.random() * 9999999);
  
  res.json({
    success: true,
    guestId: guestId
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
