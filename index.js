// index.js
import express from "express";
import * as line from "@line/bot-sdk";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { loadCredentialsFromDB } from "./credentials.js";
import * as crypto from "crypto";
import { handleEvent } from "./handlers/handleEvent.js";
import { loadSettings, saveSettings, reloadSettings } from './utils/settingsManager.js';
import BankAccount from "./models/BankAccount.js";
import dotenv from "dotenv";
import sharp from "sharp";
import UploadedImage from "./models/lineSendingImage.js";
import SlipResult from "./models/SlipResult.js";
import Phone from './models/Phone.js';
import PrefixForshop from "./models/Prefix.js";
import moment from "moment-timezone";
import { connectDB } from "./mongo.js";
import Shop from "./models/Shop.js";
import { checkAndSavePhoneNumber, checkAndUpdatePhoneNumber } from "./utils/savePhoneNumber.js";
import multer from "multer";

const upload = multer();
const uploadsendimage  = multer();

const envPath = path.join(process.cwd(), "info.env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;
const baseURL = process.env.URL || `http://localhost:${PORT}`;

const app = express();
const clients = [];
const MAX_LOGS = 200;
const logHistory = [];
const logClients = [];

// ตั้ง session ไว้ก่อนเสมอ
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 ชั่วโมง
}));

// ป้องกัน cache
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

// Static ที่ไม่ต้อง login
app.use(express.static("public")); // สำหรับ login.html
app.use("/views/css", express.static(path.join(__dirname, "views/css")));
app.use("/views/js", express.static(path.join(__dirname, "views/js")));

// Body parser
app.use("/webhook", express.raw({ type: "application/json" })); // อยู่บนสุด
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let shopData = [];

// Endpoint สำหรับส่ง Logs แบบเรียลไทม์
app.get("/api/logs", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // ส่ง logs ที่มีอยู่ทั้งหมดให้ client ใหม่
  const currentLogs = logHistory.slice(-MAX_LOGS);
  currentLogs.forEach(log => {
    res.write(`data: ${log}\n\n`);
  });

  logClients.push(res);

  req.on("close", () => {
    const index = logClients.indexOf(res);
    if (index > -1) {
      logClients.splice(index, 1);
    }
  });
});

process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET') {
    console.warn('⚠️ [uncaughtException] Connection reset by peer (ignored)');
    // ไม่ต้องปิดแอพ
  } else {
    console.error('❌ [uncaughtException]', err);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason.code === 'ECONNRESET') {
    console.warn('⚠️ [unhandledRejection] ECONNRESET (ignored)');
    // ไม่ crash
  } else {
    console.error('❌ [unhandledRejection]', reason);
  }
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.push(res);

  req.on("close", () => {
    clients.splice(clients.indexOf(res), 1);
  });
});

let bankAccounts = {};

export async function loadBankAccounts() {
  try {
    const all = await BankAccount.find();
    const grouped = {};
    for (const entry of all) {
      if (!grouped[entry.prefix]) grouped[entry.prefix] = [];
      grouped[entry.prefix].push({
        name: entry.name,
        account: entry.account,
        status: entry.status
      });
    }
    bankAccounts = grouped;
  } catch (err) {
    console.error("❌ โหลดบัญชีธนาคารล้มเหลว:", err.message);
    bankAccounts = {};
  }
}

// ให้เรียกใช้ตัวแปร global
export function getBankAccounts() {
  return bankAccounts;
}

app.get("/api/bank-accounts", (req, res) => {
  try {
    res.json({ accounts: bankAccounts });
  } catch (err) {
    console.error("❌ โหลดบัญชีล้มเหลว:", err.message);
    res.status(500).json({ error: "โหลดบัญชีไม่สำเร็จ" });
  }
});

app.post("/api/add-bank", async (req, res) => {
  const { prefix, name, number } = req.body;

  if (!prefix || !name || !number) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบ" });
  }

  try {
    await BankAccount.create({
      prefix,
      name,
      account: number,
      status: false
    });

    await loadBankAccounts(); // Reload global variable
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ไม่สามารถเพิ่มบัญชี:", err.message);
    res.status(500).json({ success: false, message: "ไม่สามารถบันทึกข้อมูล" });
  }
});

app.post("/api/edit-bank", async (req, res) => {
  const { prefix, index, name, number } = req.body;

  if (
    typeof prefix !== "string" ||
    typeof index !== "number" ||
    typeof name !== "string" ||
    typeof number !== "string"
  ) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบหรือไม่ถูกต้อง" });
  }

  try {
    const accounts = await BankAccount.find({ prefix });
    if (!accounts[index]) {
      return res.status(404).json({ success: false, message: "ไม่พบบัญชีธนาคารที่ต้องการแก้ไข" });
    }

    accounts[index].name = name;
    accounts[index].account = number;
    await accounts[index].save();
    restartWebhooks(); // รีโหลด Webhook ใหม่
    res.json({ success: true });
  } catch (err) {
    console.error("❌ แก้ไขบัญชีล้มเหลว:", err.message);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการบันทึก" });
  }
});

app.post("/api/update-bank-status", async (req, res) => {
  const { prefix, index, status } = req.body;

  try {
    const accounts = await BankAccount.find({ prefix });
    if (!accounts[index]) {
      return res.status(404).json({ success: false, message: "ไม่พบบัญชีธนาคาร" });
    }

    accounts[index].status = status;
    await accounts[index].save(); // สำคัญมาก ต้อง save หลังเปลี่ยนค่า

    await loadBankAccounts();     // รีโหลด global variable ให้บอทเห็นค่าที่เปลี่ยน
    await setupWebhooks();        // รีโหลด webhook
    res.json({ success: true });
  } catch (err) {
    console.error("❌ ไม่สามารถอัปเดตสถานะบัญชีได้:", err.message);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
  }
});

app.post("/api/delete-bank", async (req, res) => {
  const { prefix, index } = req.body;

  if (typeof prefix !== "string" || typeof index !== "number") {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบหรือรูปแบบไม่ถูกต้อง" });
  }

  try {
    const accounts = await BankAccount.find({ prefix });
    if (!accounts[index]) {
      return res.status(404).json({ success: false, message: "ไม่พบบัญชีธนาคารในตำแหน่งนี้" });
    }

    const accountToDelete = accounts[index];
    await BankAccount.deleteOne({ _id: accountToDelete._id });

    res.json({ success: true, message: "ลบบัญชีสำเร็จ" });
  } catch (err) {
    console.error("❌ ลบบัญชีล้มเหลว:", err.message);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการลบบัญชี" });
  }
});


// POST: รับ slip ใหม่ + บันทึก MongoDB + broadcast
app.post("/api/slip-results", async (req, res) => {
  try {
    const now = moment().tz('Asia/Bangkok').toDate();

    const newSlip = {
      shop: req.body.shop,
      lineName: req.body.lineName,
      phoneNumber: req.body.phoneNumber,
      userId: req.body.userId,
      text: req.body.text,
      status: req.body.status,
      response: req.body.response,
      prefix: req.body.prefix,
      amount: req.body.amount,
      ref: req.body.ref,
      reply: req.body.reply,
      time: req.body.time,
      createdAt: now,
    };
    
    await SlipResult.create(newSlip);

    // ส่งผ่าน SSE
    const data = `data: ${JSON.stringify(newSlip)}\n\n`;
    clients.forEach(client => client.write(data));

    res.status(201).json({ message: "บันทึกแล้ว" });
  } catch (err) {
    console.error("❌ บันทึก SlipResult ล้มเหลว:", err.message);
    res.status(500).json({ message: "เกิดข้อผิดพลาด" });
  }
});

// GET: ดึง slip ล่าสุด 100 รายการ (ภายใน 24 ชม.)
app.get("/api/slip-results", async (req, res) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

    const results = await SlipResult.find({
      createdAt: { $gte: oneDayAgo }
    })
      .sort({ createdAt: -1 })
      .limit(100);

    res.json(results);
  } catch (err) {
    console.error("❌ โหลด slip results ล้มเหลว:", err.message);
    res.status(500).json({ message: "โหลดข้อมูลไม่สำเร็จ" });
  }
});

export async function loadShopData() {
  try {
    shopData = await Shop.find().lean(); // ดึงจาก MongoDB แล้วเก็บในตัวแปร global
    console.log(`✅ โหลดร้านค้าสำเร็จ ${shopData.length} ร้าน`);
  } catch (error) {
    console.error("❌ ไม่สามารถโหลดร้านค้าจาก MongoDB:", error?.stack || error);
    shopData = [];
  }
}

// Auth middleware
function isAuthenticated(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect("/login");
}

// Route: หน้า login
app.get("/login", (req, res) => {
  if (req.session?.user) return res.redirect("/"); // 👈 เปลี่ยนเป็น /
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const { owner, admins, marketing } = await loadCredentialsFromDB();

  let role = null;

  // ✅ ตรวจสอบสิทธิ์
  if (owner.username === username && owner.password === password) {
    role = "OWNER";
  } else if (admins.some(a => a.username === username && a.password === password)) {
    role = "ADMIN";
  } else if (marketing.some(m => m.username === username && m.password === password)) {
    role = "MARKETING";
  }

  if (role) {
    // ✅ เก็บข้อมูล session เฉพาะที่จำเป็น
    req.session.user = {
      username,
      role,
      loginAt: Date.now()
    };

    console.log(`✅ Login สำเร็จ: ${username} (${role}) → sessionID: ${req.sessionID}`);
    return res.redirect("/");
  }

  return res.redirect("/login?error=1");
});

// Route: logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// เข้าหน้าหลัก index ต้อง login
app.get("/", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});


// สำหรับโหลดเนื้อหาย่อย เช่น main.html ฯลฯ
app.get("/page/:name", isAuthenticated, (req, res) => {
  const name = req.params.name;
  const allowed = ["main", "dashboard", "settings", "logs", "send-message"];
  if (!allowed.includes(name)) {
    return res.status(404).send("ไม่พบหน้านี้");
  }
  res.sendFile(path.join(__dirname, "views", `${name}.html`));
});

app.post('/api/save-phone', async (req, res) => {
  const { phoneNumber, userId, prefix } = req.body;

  if (!phoneNumber || !userId || !prefix) {
    return res.status(400).json({ message: 'ข้อมูลไม่ครบ' });
  }

  try {
    await checkAndSavePhoneNumber(phoneNumber, userId, prefix);
    await checkAndUpdatePhoneNumber(phoneNumber, userId, prefix);
    res.json({ message: 'บันทึกเบอร์โทรสำเร็จ' });
  } catch (err) {
    console.error('❌ บันทึกเบอร์โทรจาก Admin ล้มเหลว:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาด' });
  }
});

app.get("/api/env", (req, res) => {
  res.json({ URL: process.env.URL });
});

// 4) Endpoint สำหรับส่งข้อมูลร้านค้า
app.get("/api/shops", async (req, res) => {
  try {
    const shops = await Shop.find({}, { bonusImage: 0, passwordImage: 0 });
    res.json({ shops });
  } catch (error) {
    console.error("❌ ไม่สามารถโหลดข้อมูลร้านค้าจาก MongoDB:", error.message);
    res.status(500).json({ error: "ไม่สามารถโหลดข้อมูลร้านค้าได้" });
  }
});

app.post("/api/add-shop", async (req, res) => {
    const { name, prefix } = req.body;
  
    if (!name || !prefix) {
      return res.status(400).json({ success: false, message: "กรุณากรอกข้อมูลให้ครบ" });
    }  

    try {
      // ตรวจสอบว่ามี prefix ซ้ำหรือไม่
      const existingShop = await Shop.findOne({ prefix });
      if (existingShop) {
        return res.status(400).json({ success: false, message: "Prefix นี้ถูกใช้ไปแล้ว" });
      }
  
      const existingStat = await PrefixForshop.findOne({ Prefix: prefix });

      if (!existingStat) {
        return res.status(400).json({
          success: false,
          message: `ไม่สามารถเพิ่มร้านได้: prefix '${prefix}' ไม่อยู่ในระบบ`
        });
      }
  
      // บันทึกร้านค้าใหม่ลง MongoDB
      const newShop = new Shop({
        name,
        prefix,
        lines: [],
        status: false,
        slipCheckOption: "duplicate",
        statusBot: false,
        statusWithdraw: false,
        statusBonusTime: false,
        statusPassword: false,
      });
      await newShop.save();
  
      restartWebhooks(); // รีโหลด Webhook ใหม่
      res.json({ success: true });
    } catch (error) {
      console.error("Error adding shop:", error);
      res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการเพิ่มร้านค้า" });
    }
  });

// API สำหรับแก้ไขบัญชี LINE
app.post("/api/update-line", async (req, res) => {
  const { prefix, index, linename, access_token, secret_token, channel_id } = req.body;

  if (!prefix || index === undefined || !linename || !access_token || !secret_token || !channel_id) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
  }

  const shortChannelId = String(channel_id).slice(-4); // ใช้ 4 ตัวท้าย

  try {
    const shop = await Shop.findOne({ prefix });
    if (!shop) {
      return res.status(404).json({ success: false, message: "ไม่พบร้านค้านี้" });
    }

    if (!shop.lines || !shop.lines[index]) {
      return res.status(404).json({ success: false, message: "ไม่พบบัญชี LINE ที่ต้องการแก้ไข" });
    }

    // ตรวจสอบว่า shortChannelId นี้ซ้ำกับบัญชีอื่น (ยกเว้น index เดิม)
    const isDuplicate = shop.lines.some((line, i) => {
      const lineShortId = String(line.channel_id).slice(-4);
      return i !== index && lineShortId === shortChannelId;
    });

    if (isDuplicate) {
      return res.status(409).json({ success: false, message: "บัญชี LINE นี้มีอยู่แล้ว (Channel ID ซ้ำ)" });
    }

    // อัปเดตเฉพาะรายการนี้
    shop.lines[index] = {
      linename,
      access_token,
      secret_token,
      channel_id
    };

    await shop.save();
    return res.json({ success: true, message: "อัปเดตบัญชี LINE สำเร็จ!" });
  } catch (error) {
    console.error("❌ Error updating LINE account:", error);
    return res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการอัปเดตบัญชี LINE" });
  }
});

// API อัปเดตชื่อร้าน และสถานะร้านค้า
app.post("/api/update-shop", async (req, res) => {
  const { prefix, name, status } = req.body;

  if (!prefix) {
    return res.status(400).json({ success: false, message: "กรุณาระบุ prefix ของร้านค้า" });
  }

  try {
    const shop = await Shop.findOne({ prefix });

    if (!shop) {
      return res.status(404).json({ success: false, message: "ไม่พบร้านค้านี้" });
    }

    if (name) shop.name = name;
    if (typeof status === "boolean") shop.status = status;

    await shop.save();
    restartWebhooks();

    res.json({ success: true, message: "อัปเดตร้านค้าเรียบร้อย" });
  } catch (error) {
    console.error("❌ Error updating shop:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการอัปเดตร้านค้า" });
  }
});


// เพิ่ม API สำหรับลบบัญชี LINE
app.post("/api/delete-line", async (req, res) => {
  const { prefix, index } = req.body;

  if (!prefix || index === undefined) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
  }

  try {
    const shop = await Shop.findOne({ prefix });
    if (!shop) {
      return res.status(404).json({ success: false, message: "ไม่พบร้านค้านี้" });
    }

    if (!shop.lines || shop.lines.length <= index) {
      return res.status(404).json({ success: false, message: "ไม่พบบัญชี LINE ที่ต้องการลบ" });
    }

    shop.lines.splice(index, 1);
    await shop.save();

    res.json({ success: true, message: "ลบบัญชี LINE สำเร็จ!" });
  } catch (error) {
    console.error("❌ Error deleting LINE account:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการลบบัญชี LINE" });
  }
});

// API สำหรับเพิ่มบัญชี LINE ใหม่เข้าไปในร้านค้า
app.post("/api/add-line", async (req, res) => {
  const { prefix, linename, access_token, secret_token, channel_id } = req.body;

  if (!prefix || !linename || !access_token || !secret_token || !channel_id) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน!" });
  }

  try {
    const shop = await Shop.findOne({ prefix });
    if (!shop) {
      return res.status(404).json({ success: false, message: "ไม่พบร้านค้านี้!" });
    }

    const isDuplicate = shop.lines.some(line => line.channel_id === channel_id);
    if (isDuplicate) {
      return res.status(409).json({ success: false, message: "บัญชี LINE นี้ถูกเพิ่มไว้แล้ว" });
    }

    shop.lines.push({
      linename,
      access_token,
      secret_token,
      channel_id    // เพิ่มตรงนี้
    });

    await shop.save();

    restartWebhooks();
    res.json({ success: true, message: "เพิ่มบัญชี LINE สำเร็จ!" });
  } catch (error) {
    console.error("❌ Error adding LINE account:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการเพิ่มบัญชี LINE" });
  }
});

app.post("/api/upload-bonus-image", upload.single("image"), async (req, res) => {
  try {
    const { prefix } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: "ไม่พบไฟล์ภาพที่อัปโหลด" });
    }

    // 🖼️ รับ buffer ที่อัปโหลดมา
    let imageBuffer = req.file.buffer;

    // แปลงเป็น JPEG เสมอ
    imageBuffer = await sharp(imageBuffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } }) // กัน transparency เป็นพื้นหลังขาว
      .jpeg() // ไม่มีการกำหนด quality → ใช้ default เต็ม ๆ
      .toBuffer();

    await Shop.findOneAndUpdate(
      { prefix },
      {
        bonusImage: {
          data: imageBuffer,
          contentType: "image/jpeg",
        },
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: "บันทึกภาพ BonusTime เรียบร้อย" });
  } catch (err) {
    console.error("❌ Upload Error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get('/api/get-bonus-image-original', async (req, res) => {
  const { prefix } = req.query;

  const shop = await Shop.findOne({ prefix });
  if (!shop || !shop.bonusImage) return res.sendStatus(404);

  const imageBuffer = shop.bonusImage.data;
  const contentType = shop.bonusImage.contentType || 'image/png';

  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'no-store'); // 🔒 ป้องกัน cache
  res.send(imageBuffer); // ต้องส่ง raw buffer ตรง ๆ
});

// เสิร์ฟรูป BonusTime จริง
app.get("/api/get-bonus-image", async (req, res) => {
  const { prefix } = req.query;
  const shop = await Shop.findOne({ prefix });

  if (!shop || !shop.bonusImage?.data) {
    return res.status(404).json({ success: false, message: "ยังไม่ได้อัปโหลดรูป BonusTime" });
  }

  try {
    const optimized = await sharp(shop.bonusImage.data)
      .resize(600) // จำกัดความกว้าง
      .jpeg({ quality: 70 }) // ลดคุณภาพลง
      .toBuffer();

    res.set("Content-Type", "image/jpeg");
    res.send(optimized);
  } catch (err) {
    console.error("❌ Sharp Error:", err);
    res.status(500).send("Server error");
  }
});

app.post("/api/update-bonusTime-status", async (req, res) => {
  const { prefix, statusBonusTime } = req.body;

  try {
    const shop = await Shop.findOneAndUpdate(
      { prefix },
      { statusBonusTime },
      { new: true }
    );

    if (!shop) return res.json({ success: false, message: "ไม่พบร้านค้า" });

    res.json({ success: true, message: "อัปเดตสถานะ BonusTime เรียบร้อย" });
  } catch (err) {
    console.error("❌ Error updating BonusTime status:", err);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
  }
});

app.post("/api/delete-bonus-image", async (req, res) => {
  try {
    const { prefix } = req.body;
    const shop = await Shop.findOne({ prefix });
    if (!shop) return res.status(404).json({ success: false, message: "ไม่พบร้านค้า" });

    shop.bonusImage = undefined; // ลบค่าออก
    await shop.save();

    res.json({ success: true, message: "ลบรูป BonusTime สำเร็จ" });
  } catch (err) {
    console.error("❌ Error deleting bonus image:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get('/api/get-password-image-original', async (req, res) => {
  const { prefix } = req.query;

  const shop = await Shop.findOne({ prefix });
  if (!shop || !shop.passwordImage) return res.sendStatus(404);

  const imageBuffer = shop.passwordImage.data;
  const contentType = shop.passwordImage.contentType || 'image/png';

  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'no-store'); // 🔒 ป้องกัน cache
  res.send(imageBuffer); // ต้องส่ง raw buffer ตรง ๆ
});



app.post("/api/upload-password-image", upload.single("image"), async (req, res) => {
  try {
    const { prefix } = req.body;

    let imageBuffer = req.file.buffer;

    // แปลงเป็น JPEG เสมอ
    imageBuffer = await sharp(imageBuffer)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg()
      .toBuffer();

    await Shop.findOneAndUpdate(
      { prefix },
      {
        passwordImage: {
          data: imageBuffer,
          contentType: "image/jpeg",
        },
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: "บันทึกภาพ ลืม Password เรียบร้อย" });
  } catch (error) {
    console.error("❌ upload error:", error);
    res.status(500).json({ error: "ไม่สามารถอัปโหลดรูปได้" });
  }
});

// เสิร์ฟรูป password จริง
app.get("/api/get-password-image", async (req, res) => {
  const { prefix } = req.query;
  const shop = await Shop.findOne({ prefix });

  if (!shop || !shop.passwordImage?.data) {
    return res.status(404).json({ success: false, message: "ยังไม่ได้อัปโหลดรูป ลืม Password" });
  }

  try {
    const optimized = await sharp(shop.passwordImage.data)
      .resize(600) // จำกัดความกว้าง
      .jpeg({ quality: 70 }) // ลดคุณภาพลง
      .toBuffer();

    res.set("Content-Type", "image/jpeg");
    res.send(optimized);
  } catch (err) {
    console.error("❌ Sharp Error:", err);
    res.status(500).send("Server error");
  }
});

app.post("/api/update-password-status", async (req, res) => {
  const { prefix, statusPassword } = req.body;

  try {
    const shop = await Shop.findOneAndUpdate(
      { prefix },
      { statusPassword },
      { new: true }
    );

    if (!shop) return res.json({ success: false, message: "ไม่พบร้านค้า" });

    res.json({ success: true, message: "อัปเดตสถานะ Password เรียบร้อย" });
  } catch (err) {
    console.error("❌ Error updating Password status:", err);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
  }
});

app.post("/api/delete-password-image", async (req, res) => {
  try {
    const { prefix } = req.body;
    const shop = await Shop.findOne({ prefix });
    if (!shop) return res.status(404).json({ success: false, message: "ไม่พบร้านค้า" });

    shop.passwordImage = undefined; // ลบค่าออก
    await shop.save();

    res.json({ success: true, message: "ลบรูป Password สำเร็จ" });
  } catch (err) {
    console.error("❌ Error deleting password image:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post('/api/update-textbot-status', async (req, res) => {
  const { prefix, statusBot } = req.body;

  try {
    const shop = await Shop.findOneAndUpdate(
      { prefix },
      { statusBot },
      { new: true }
    );

    if (!shop) {
      return res.json({ success: false, message: "ไม่พบร้านค้า" });
    }

    res.json({ success: true, message: "อัปเดตสถานะบอทข้อความเรียบร้อย" });
  } catch (err) {
    console.error("❌ Error updating text bot status:", err);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
  }
});

app.post('/api/update-withdraw-status', async (req, res) => {
  const { prefix, statusWithdraw } = req.body;

  try {
    const shop = await Shop.findOneAndUpdate(
      { prefix },
      { statusWithdraw },
      { new: true }
    );

    if (!shop) {
      return res.json({ success: false, message: "ไม่พบร้านค้า" });
    }

    res.json({ success: true, message: "อัปเดตสถานะ ปิด/เปิด การถอน เรียบร้อย" });
  } catch (err) {
    console.error("❌ Error updating withdraw status:", err);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
  }
});

app.post("/api/update-slip-option", async (req, res) => {
  const { prefix, slipCheckOption } = req.body;

  if (!prefix || !slipCheckOption) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
  }
  try {
    const shop = await Shop.findOne({ prefix });
    if (!shop) {
      return res.status(404).json({ success: false, message: "ไม่พบร้านค้านี้" });
    }

    shop.status = false;
    shop.slipCheckOption = slipCheckOption;
    await shop.save();

    res.json({ success: true, message: "บันทึกการเปลี่ยนแปลงสำเร็จ" });
  } catch (error) {
    console.error("❌ Error updating slip check option:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการอัปเดตตัวเลือกตรวจสลิป" });
  }
});


app.get('/api/settings', async (req, res) => {
  try {
    const settings = await loadSettings(); // 👉 โหลดจาก MongoDB
    if (!settings) throw new Error("ไม่พบ settings");

    // แปลง ms → s สำหรับ frontend
    res.json({
      ...settings,
      timeLimit: settings.timeLimit / 1000,
      sameQrTimeLimit: settings.sameQrTimeLimit / 1000
    });
  } catch (err) {
    console.error("❌ โหลด settings ไม่สำเร็จ:", err.message);
    res.status(500).json({ error: "โหลด settings ไม่สำเร็จ" });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    await saveSettings(req.body); // 👉 บันทึกลง MongoDB
    await reloadSettings(); // 👉 โหลดใหม่เข้าตัวแปร global
    restartWebhooks();     // 👉 ถ้าจำเป็นต้องใช้ settings กับ webhook
    res.json({ success: true });
  } catch (err) {
    console.error("❌ บันทึก settings ไม่สำเร็จ:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Endpoint สำหรับลบร้านค้า
app.post("/api/delete-shop", async (req, res) => {
  const { prefix } = req.body;

  try {
    const result = await Shop.deleteOne({ prefix });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "ไม่พบร้านค้าด้วย prefix นี้" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("❌ Error deleting shop:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการลบร้านค้า" });
  }
});

app.post("/api/get-access-token", async (req, res) => {
  const { channelId, secretToken } = req.body;

  if (!channelId || !secretToken) {
    return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
  }

  try {
    // 1. ขอ access_token
    const tokenRes = await fetch("https://api.line.me/v2/oauth/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: channelId,
        client_secret: secretToken,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).json({ success: false, message: "ขอ access_token ไม่สำเร็จ" });
    }

    const access_token = tokenData.access_token;

    // 2. ดึงชื่อ LINE OA จาก /v2/bot/info
    const infoRes = await fetch("https://api.line.me/v2/bot/info", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    const infoData = await infoRes.json();

    const display_name = infoData.displayName || "LINE";

    // ส่งทั้ง access_token และ display_name กลับไป
    res.json({
      success: true,
      access_token,
      display_name,
    });
  } catch (error) {
    console.error("❌ Error in /api/get-access-token:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาด" });
  }
});

app.post('/api/set-webhook', async (req, res) => {
  const { accessToken, webhookURL } = req.body;

  if (!accessToken || !webhookURL) {
    return res.status(400).json({ success: false, message: "ต้องระบุ accessToken และ webhookURL" });
  }

  try {
    const response = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ endpoint: webhookURL })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("❌ LINE API error:", result);
      return res.status(500).json({ success: false, message: "ตั้งค่า Webhook ไม่สำเร็จ", result });
    }

    return res.json({ success: true, result });

  } catch (err) {
    console.error("❌ set-webhook error:", err);
    return res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดขณะตั้งค่า Webhook", error: err.message });
  }
});

app.get('/api/uploaded-image', async (req, res) => {
  try {
    const { username, sessionId } = req.query;
    if (!username) return res.status(400).send('Missing params');

    const imageDoc = await UploadedImage.findOne({ username, sessionId });
    if (!imageDoc || !imageDoc.data) return res.status(404).send('Not found');

    res.set('Content-Type', imageDoc.contentType || 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(imageDoc.data);

  } catch (err) {
    console.error('❌ Error /uploaded-image:', err);
    res.status(500).send('Server error');
  }
});

app.delete("/api/delete-my-upload", async (req, res) => {
  const sessionId = req.sessionID;

  if (!sessionId) {
    return res.status(400).json({ success: false, error: "Session ไม่พบ" });
  }

  try {
    const result = await UploadedImage.deleteMany({ sessionId });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    console.error("❌ ลบรูปภาพล้มเหลว:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/user-lookup-batch', async (req, res) => {
  const { usernames } = req.body;
  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.json({ results: [] });
  }

  try {
    const phones = await Phone.find({ user: { $in: usernames } });
    const userMap = new Map();
    phones.forEach(p => userMap.set(p.user, p.userId));

    // ค้นหา prefix ที่จำเป็นทั้งหมดครั้งเดียว
    const uniquePrefixes = [...new Set(usernames.map(u => u.substring(0, 3)))];
    const shops = await Shop.find({ prefix: { $in: uniquePrefixes } });
    const prefixMap = new Map();
    shops.forEach(shop => {
      prefixMap.set(shop.prefix, shop.lines?.[0]?.access_token || null);
    });

    const results = usernames.map(username => {
      const userId = userMap.get(username);
      const prefix = username.substring(0, 3);
      return {
        username,
        found: !!userId,
        userId,
        accessToken: prefixMap.get(prefix) || null,
      };
    });

    return res.json({ results });

  } catch (err) {
    console.error("❌ batch lookup error:", err);
    return res.status(500).json({ results: [] });
  }
});

app.post('/api/send-message', uploadsendimage.fields([{ name: 'image', maxCount: 1 }]), async (req, res) => {
    const { userId, message } = req.body;
    const sessionId = req.sessionID;
    const username = req.session?.user?.username;

    if (!userId)
        return res.status(400).json({ success: false, error: "Missing userId" });

    if (!username || !sessionId)
        return res.status(400).json({ success: false, error: "Missing session or username" });

    try {
        const phone = await Phone.findOne({ userId });
        if (!phone || !phone.prefix)
            return res.status(404).json({ success: false, error: "User not found in database" });

        const shop = await Shop.findOne({ prefix: phone.prefix });
        if (!shop || !shop.lines || shop.lines.length === 0)
            return res.status(404).json({ success: false, error: "No LINE OA found for shop" });

        // เตรียมรูปภาพ (ถ้ามีรูปใหม่เท่านั้น)
        let imageUrl = null;
        let uploadedImage = null;
        
        // เช็คเฉพาะกรณีมีรูปใหม่ส่งมาเท่านั้น
        if (req.files?.image?.[0]) {
            uploadedImage = await UploadedImage.create({
                username,
                sessionId,
                data: req.files.image[0].buffer,
                contentType: req.files.image[0].mimetype,
                uploadedAt: new Date()
            });
            
            const timestamp = Date.now();
            imageUrl = `${baseURL}/api/uploaded-image?username=${encodeURIComponent(username)}&sessionId=${encodeURIComponent(sessionId)}&cache_bust=${timestamp}`;
        }

        if (!imageUrl && !message) {
            return res.status(400).json({ success: false, error: "Missing message and image" });
        }

        // ส่งข้อความและรูปภาพ
        for (const lineInfo of shop.lines) {
            const client = new line.Client({ channelAccessToken: lineInfo.access_token });

            try {
                // ส่งรูปก่อน (ถ้ามี)
                let imageSent = false;

                if (imageUrl) {
                    try {
                        await client.pushMessage(userId, {
                            type: "image",
                            originalContentUrl: imageUrl,
                            previewImageUrl: imageUrl
                        });
                        
                        // รอให้ LINE ดึงรูปไปก่อน
                        await UploadedImage.deleteOne({ username, sessionId });
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        imageSent = true;
                    } catch (error) {
                        console.error('❌ ไม่สามารถส่งรูปภาพ:', error);
                    }
                }
                
                // ส่งข้อความ (ถ้ามี)
                if (message) {
                    await client.pushMessage(userId, { 
                        type: "text", 
                        text: message 
                    });
                }

                // หลังส่งเสร็จทั้งหมด ถ้าส่งรูปสำเร็จให้ลบรูปจากฐานข้อมูล
                if (imageSent) {
                    try {
                        await UploadedImage.deleteMany({ sessionId });
                    } catch (error) {
                        console.error('❌ เกิดข้อผิดพลาดในการลบรูปภาพจากฐานข้อมูล:', error);
                    }
                }

                broadcastLog(
                    `📨 ส่ง ${imageSent ? 'ภาพ' : ''}${imageSent && message ? ' + ' : ''}${message ? 'ข้อความ' : ''} จาก ${username} ไปยัง ${userId} ผ่านร้าน ${lineInfo.linename}`
                );

                return res.json({
                    success: true,
                    usedLine: lineInfo.linename,
                    shopName: shop.name,
                    type: imageSent && message ? "image+text" : (imageSent ? "image" : "text")
                });

            } catch (err) {
                console.error(`❌ ไม่สามารถส่งผ่าน ${lineInfo.linename}:`, err);
                console.error('Error details:', err.response?.data || err.message);
                
                // ส่ง log ให้ admin ทราบ
                broadcastLog(
                    `❌ ส่งไม่สำเร็จ: ${userId} (${err.message}) - ลองส่งผ่าน ${lineInfo.linename} ไม่ได้`
                );
            }
        }

        return res.status(500).json({
            success: false,
            error: "ไม่สามารถส่งข้อความหรือภาพผ่าน LINE OA ใด ๆ ได้"
        });

    } catch (err) {
        console.error("❌ send-message error:", err);
        return res.status(500).json({ success: false, error: "Server error" });
    }
});

app.post("/api/upload-send-image-line", uploadsendimage.single("image"), async (req, res) => {
  try {
    // ปฏิเสธทันทีหากไม่มีไฟล์
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "ไม่พบไฟล์ภาพที่ส่งมา หรือไฟล์ไม่ถูกต้อง" });
    }

    // อนุญาตเฉพาะ mimetype ที่ LINE รองรับ
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: "รองรับเฉพาะไฟล์ภาพเท่านั้น" });
    }

    const username = req.session?.user?.username || "unknown";
    const sessionId = req.sessionID || "unknown";

    if (!sessionId || !username) {
      return res.status(400).json({ error: "ไม่มี session" });
    }

    const result = await UploadedImage.findOneAndUpdate(
    { username, sessionId },
    {
        $set: {
            data: req.file.buffer,
            contentType: req.file.mimetype,
            uploadedAt: new Date(),
        }
    },
    {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
    }
    );

    res.json({
      success: true,
      message: "✅ อัปโหลดรูปภาพสำเร็จ",
      fileId: result._id.toString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "เกิดข้อผิดพลาดระหว่างอัปโหลด" });
  }
});

// ฟังก์ชันสำหรับส่ง Logs ไปยัง Clients
export function broadcastLog(message) {
  const timestamp = new Date().toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Bangkok"
  });

  const logEntry = `[ ${timestamp} ] ${message}`;

  // เก็บ log ลงในประวัติ
  logHistory.push(logEntry);
  if (logHistory.length > MAX_LOGS) {
    logHistory.splice(0, logHistory.length - MAX_LOGS);
  }

  // ส่ง log ไปยัง clients แบบ real-time
  const data = `data: ${logEntry}\n\n`;
  logClients.forEach(client => {
    try {
      client.write(data);
    } catch (error) {
      console.error("Error sending log to client:", error);
    }
  });
}

export function broadcastPhoneUpdate(userId, phoneNumber, lineName) {
  const phoneData = { userId, phoneNumber, lineName };
  const data = `event: phoneUpdate\ndata: ${JSON.stringify(phoneData)}\n\n`;

  let successCount = 0;

  clients.forEach((client, index) => {
    try {
      client.write(data);
      successCount++;
    } catch (error) {
      console.error(`❌ ส่งไม่สำเร็จกับ client[${index}]:`, error);
    }
  });
}

function setCorrectSignature(channelSecret) {
    return (req, res, next) => {
      if (!Buffer.isBuffer(req.body)) {
        console.error("❌ req.body ไม่ใช่ Buffer");
        return res.status(400).send("Invalid request format");
      }
  
      const computedSignature = crypto
        .createHmac("sha256", channelSecret)
        .update(req.body)
        .digest("base64");
  
      req.headers["x-line-signature"] = computedSignature;
      next();
    };
  }

const setupWebhooks = async () => {
    // ลบเฉพาะ route ที่ขึ้นต้นด้วย "/webhook"
    app._router.stack = app._router.stack.filter((layer) => {
      return !(
        layer.route &&
        layer.route.path &&
        layer.route.path.startsWith("/webhook")
      );
    });

    await loadShopData(); // ใช้ async version

    shopData.forEach((shop) => {
      shop.lines.forEach((lineAccount) => {
        const prefix = shop.prefix;
        const lineName = lineAccount.linename;
        const channelID = String(lineAccount.channel_id).slice(-4);
        const lineConfig = {
          channelAccessToken: String(lineAccount.access_token),
          channelSecret: String(lineAccount.secret_token),
        };
            const accessToken = lineConfig.channelAccessToken
            const client = new line.Client(lineConfig);
            const route = `/webhook/${shop.prefix}/${channelID}.bot`;

            // กำหนด Middleware ให้ใช้ `express.raw()` เฉพาะ Webhook เท่านั้น
            app.post(
              route, // ใช้ route จากข้างบนตรง ๆ เลย
              setCorrectSignature(lineConfig.channelSecret),
              line.middleware(lineConfig),
              async (req, res) => {
                const events = req.body.events || [];
                await Promise.all(
                  events.map(async (event) => await handleEvent(event, client, prefix, lineName, accessToken, baseURL))
                );
                res.status(200).send("OK");
              }
          );
      });
  });
};

export const restartWebhooks = async () => {
  console.log("พบการแก้ไขข้อมูล รีสตาร์ทบอทแล้ว...");
  broadcastLog("พบการแก้ไขข้อมูล รีสตาร์ทบอทแล้ว...");
  await loadBankAccounts();        // รอโหลดให้เสร็จจริง ๆ ก่อนใช้
  await setupWebhooks();           // รีเซ็ต webhook
};

app.listen(PORT, async () => {
  console.log(`🟢 Server started at port ${PORT}`);
  broadcastLog(`🟢 Server started at port ${PORT}`);

  try {
    await connectDB();
    await loadBankAccounts();
    await setupWebhooks();
    console.log("All services initialized");
  } catch (err) {
    console.error("Initialization failed:", err);
  }
});
