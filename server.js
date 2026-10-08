import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
// Comma-separated list, e.g. "https://my-ledger.netlify.app,http://localhost:5173"
const FRONTEND_URL = process.env.FRONTEND_URL || "";

const app = express();
app.use(express.json());

/* ---------- CORS: only allow your frontend ---------- */
const allowed = FRONTEND_URL.split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
app.use(
  cors({
    // Unlisted origins get no CORS headers, so the browser blocks them
    origin: (origin, cb) =>
      cb(null, !origin || allowed.length === 0 || allowed.includes(origin)),
  })
);

/* ---------- Data layer: MongoDB, or in-memory for local testing ---------- */
const entrySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["sale", "stock"], required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    qty: { type: Number, required: true, min: 1 },
    token: { type: String, required: true, trim: true },
    rate: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true },
    party: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);
entrySchema.set("toJSON", {
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});
const Entry = mongoose.model("Entry", entrySchema);

let memory = []; // used only when MONGODB_URI is not set
const useMongo = Boolean(MONGODB_URI);

const store = {
  async list() {
    if (useMongo) return (await Entry.find().sort({ date: -1, createdAt: -1 })).map((d) => d.toJSON());
    return [...memory].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  },
  async create(data) {
    if (useMongo) return (await Entry.create(data)).toJSON();
    const e = { ...data, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString() };
    memory.push(e);
    return e;
  },
  async remove(id) {
    if (useMongo) {
      if (!mongoose.isValidObjectId(id)) return false;
      return Boolean(await Entry.findByIdAndDelete(id));
    }
    const before = memory.length;
    memory = memory.filter((e) => e.id !== id);
    return memory.length < before;
  },
};

/* ---------- Simple password protection ---------- */
function requirePassword(req, res, next) {
  if (!APP_PASSWORD) return next(); // no password set = open access
  if (req.get("x-app-password") === APP_PASSWORD) return next();
  res.status(401).json({ error: "Wrong or missing password" });
}

/* ---------- Validation ---------- */
function validate(body) {
  const type = body.type;
  const date = String(body.date || "");
  const qty = Number(body.qty);
  const rate = Number(body.rate);
  const token = String(body.token || "").trim();
  const party = String(body.party || "").trim();

  if (!["sale", "stock"].includes(type)) return { error: "Type must be sale or stock" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "Date must be YYYY-MM-DD" };
  if (!Number.isFinite(qty) || qty < 1) return { error: "Quantity must be at least 1" };
  if (!token) return { error: "Token / product is required" };
  if (!Number.isFinite(rate) || rate <= 0) return { error: "Price must be greater than 0" };

  return { data: { type, date, qty, token, rate, amount: qty * rate, party } };
}

/* ---------- Routes ---------- */
app.get("/", (_req, res) => res.json({ ok: true, service: "token-ledger-backend" }));
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, database: useMongo ? "mongodb" : "memory" })
);

app.post("/api/login", (req, res) => {
  if (!APP_PASSWORD || req.body?.password === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ error: "Wrong password" });
});

app.get("/api/entries", requirePassword, async (_req, res, next) => {
  try {
    res.json(await store.list());
  } catch (err) {
    next(err);
  }
});

app.post("/api/entries", requirePassword, async (req, res, next) => {
  try {
    const { data, error } = validate(req.body || {});
    if (error) return res.status(400).json({ error });
    res.status(201).json(await store.create(data));
  } catch (err) {
    next(err);
  }
});

app.delete("/api/entries/:id", requirePassword, async (req, res, next) => {
  try {
    const ok = await store.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: "Entry not found" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

/* ---------- Start ---------- */
async function start() {
  if (useMongo) {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");
  } else {
    console.warn("MONGODB_URI not set: using in-memory storage (data is lost on restart)");
  }
  app.listen(PORT, () => console.log(`API running on port ${PORT}`));
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
