import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";
import ical from "node-ical";
import crypto from "crypto";

const { Pool } = pg;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const BRAND = "Tenario";
const ALERT_EMAIL = "wyatt@tenario.com";

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hosts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      twilio_number TEXT UNIQUE NOT NULL,
      host_phone TEXT NOT NULL,
      dashboard_password TEXT NOT NULL,
      plan TEXT DEFAULT 'starter',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
      name TEXT,
      address TEXT NOT NULL,
      ical_url TEXT,
      ical_url_2 TEXT,
      wifi_name TEXT,
      wifi_password TEXT,
      door_code TEXT,
      checkin_time TEXT DEFAULT '3:00 PM',
      checkout_time TEXT DEFAULT '11:00 AM',
      parking_instructions TEXT,
      key_dropoff TEXT,
      thermostat_instructions TEXT,
      washer_dryer_instructions TEXT,
      tv_instructions TEXT,
      trash_instructions TEXT,
      house_rules TEXT,
      quiet_hours_start INTEGER DEFAULT 22,
      quiet_hours_end INTEGER DEFAULT 8,
      breaker_location TEXT,
      water_shutoff TEXT,
      nearest_urgent_care TEXT,
      local_restaurants TEXT,
      local_grocery TEXT,
      local_coffee TEXT,
      local_activities TEXT,
      extra_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Allow self-signup hosts (no Twilio number yet)
  await pool.query(`ALTER TABLE hosts ALTER COLUMN twilio_number DROP NOT NULL`).catch(() => {});


  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
      host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
      checkin_date DATE NOT NULL,
      checkout_date DATE NOT NULL,
      guest_name TEXT,
      ical_uid TEXT,
      status TEXT DEFAULT 'upcoming',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(property_id, ical_uid)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guests (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
      property_id INTEGER REFERENCES properties(id),
      booking_id INTEGER REFERENCES bookings(id),
      onboarding_state TEXT DEFAULT 'awaiting_address',
      pending_property_id INTEGER,
      pending_booking_id INTEGER,
      opted_out BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(phone, host_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      guest_phone TEXT NOT NULL,
      host_id INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
      property_id INTEGER REFERENCES properties(id),
      messages JSONB DEFAULT '[]',
      escalated BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(guest_phone, host_id)
    );
  `);

  // Structured message logging (privacy-safe: last 4 digits only)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      guest_phone_last4 TEXT,
      guest_phone_hash TEXT,
      host_id INTEGER,
      property_id INTEGER,
      action TEXT,
      latency_ms INTEGER
    );
  `);

  // Rate-limit overage tracking (for email alerts when exceeded twice/day)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rate_limit_overages (
      id SERIAL PRIMARY KEY,
      overage_type TEXT NOT NULL,
      key_value TEXT NOT NULL,
      overage_date DATE NOT NULL DEFAULT NOW()::DATE,
      count INTEGER DEFAULT 1,
      email_sent BOOLEAN DEFAULT false,
      last_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(overage_type, key_value, overage_date)
    );
  `);

  console.log("[DB] All tables ready");
}

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────
async function logMessage(phone, hostId, propertyId, action, latencyMs) {
  try {
    const last4 = (phone || "").slice(-4);
    const hash = crypto.createHash("sha256").update(phone || "").digest("hex").slice(0, 16);
    await pool.query(
      `INSERT INTO message_logs (guest_phone_last4, guest_phone_hash, host_id, property_id, action, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [last4, hash, hostId || null, propertyId || null, action, latencyMs || null]
    );
  } catch (err) {
    console.error("[LOG ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────
async function checkGuestRateLimit(phone, hostId) {
  try {
    const hash = crypto.createHash("sha256").update(phone || "").digest("hex").slice(0, 16);
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await pool.query(
      `SELECT COUNT(*) FROM message_logs WHERE guest_phone_hash = $1 AND host_id = $2 AND ts > $3`,
      [hash, hostId, oneHourAgo]
    );
    const count = parseInt(res.rows[0].count);
    if (count >= 20) {
      console.warn(`[RATE LIMIT] Guest ${phone.slice(-4)} exceeded 20 msg/hr for host ${hostId}`);
      await recordRateLimitOverage("guest_hourly", `${hash}:${hostId}`);
      return true; // rate limited
    }
    return false;
  } catch (err) {
    console.error("[RATE LIMIT CHECK ERROR]", err.message);
    return false;
  }
}

async function checkHostSmsRateLimit(hostId) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const res = await pool.query(
      `SELECT COUNT(*) FROM message_logs WHERE host_id = $1 AND ts > $2 AND action LIKE 'sms_out%'`,
      [hostId, todayStart.toISOString()]
    );
    const count = parseInt(res.rows[0].count);
    if (count >= 500) {
      console.warn(`[RATE LIMIT] Host ${hostId} exceeded 500 outbound SMS/day`);
      await recordRateLimitOverage("host_daily_sms", String(hostId));
      return true; // rate limited
    }
    return false;
  } catch (err) {
    console.error("[HOST RATE LIMIT CHECK ERROR]", err.message);
    return false;
  }
}

async function recordRateLimitOverage(type, key) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const res = await pool.query(`
      INSERT INTO rate_limit_overages (overage_type, key_value, overage_date, count, last_at)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (overage_type, key_value, overage_date)
      DO UPDATE SET count = rate_limit_overages.count + 1, last_at = NOW()
      RETURNING count, email_sent
    `, [type, key, today]);

    const { count, email_sent } = res.rows[0];
    if (count >= 2 && !email_sent) {
      await sendEmailAlert(
        ALERT_EMAIL,
        `[Tenario] Rate limit exceeded: ${type}`,
        `Rate limit type "${type}" for key "${key}" has been exceeded ${count} times today (${today}).`
      );
      await pool.query(
        `UPDATE rate_limit_overages SET email_sent = true WHERE overage_type=$1 AND key_value=$2 AND overage_date=$3`,
        [type, key, today]
      );
    }
  } catch (err) {
    console.error("[RATE LIMIT OVERAGE ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// DATA RETENTION CRON
// ─────────────────────────────────────────────
async function runDataRetention() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffDate = cutoff.toISOString().split("T")[0];

    const old = await pool.query(`
      SELECT b.id, b.host_id FROM bookings b
      WHERE b.status = 'completed' AND b.checkout_date < $1
        AND b.guest_name IS NOT NULL
    `, [cutoffDate]);

    let cleaned = 0;
    for (const booking of old.rows) {
      const guestRes = await pool.query(
        "SELECT phone FROM guests WHERE booking_id = $1",
        [booking.id]
      );
      if (guestRes.rows[0]) {
        const { phone } = guestRes.rows[0];
        await pool.query(
          "DELETE FROM conversations WHERE guest_phone = $1 AND host_id = $2",
          [phone, booking.host_id]
        );
        await pool.query(
          "DELETE FROM guests WHERE booking_id = $1",
          [booking.id]
        );
      }
      await pool.query(
        "UPDATE bookings SET guest_name = NULL WHERE id = $1",
        [booking.id]
      );
      cleaned++;
    }

    if (cleaned > 0) {
      console.log(`[DATA RETENTION] Cleaned ${cleaned} expired booking records`);
    }
  } catch (err) {
    console.error("[DATA RETENTION ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// TWILIO
// ─────────────────────────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

async function sendSms(to, message, fromNumber, hostId = null) {
  if (!fromNumber) { console.error("[SMS] Missing from number"); return; }

  // Host-level daily rate limit
  if (hostId) {
    const limited = await checkHostSmsRateLimit(hostId);
    if (limited) {
      console.warn(`[SMS BLOCKED] Host ${hostId} daily limit reached, dropping message to ${to}`);
      return;
    }
  }

  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ To: to, From: fromNumber, Body: message });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await response.json();
    if (!response.ok) console.error("[TWILIO ERROR]", data);
    else {
      console.log(`[SMS SENT] to ${to} from ${fromNumber}`);
      // Log outbound for rate limiting
      if (hostId) {
        await logMessage(to, hostId, null, "sms_out", null);
      }
    }
  } catch (err) {
    console.error("[TWILIO EXCEPTION]", err.message);
  }
}

// ─────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

let transporter = null;
if (GMAIL_USER && GMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  console.log("[EMAIL CONFIGURED]");
}

async function sendEmailAlert(to, subject, text) {
  if (!transporter) {
    console.warn("[EMAIL] Not configured — skipping alert:", subject);
    return;
  }
  try {
    await transporter.sendMail({ from: GMAIL_USER, to, subject, text });
    console.log(`[EMAIL SENT] ${subject} → ${to}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// ICAL SYNC
// ─────────────────────────────────────────────
async function syncIcalForProperty(property) {
  const urls = [property.ical_url, property.ical_url_2].filter(Boolean);
  if (urls.length === 0) return;

  for (const url of urls) {
    try {
      const events = await ical.async.fromURL(url);
      let count = 0;
      for (const key of Object.keys(events)) {
        const ev = events[key];
        if (ev.type !== "VEVENT") continue;
        const checkin  = ev.start ? new Date(ev.start).toISOString().split("T")[0] : null;
        const checkout = ev.end   ? new Date(ev.end).toISOString().split("T")[0]   : null;
        if (!checkin || !checkout) continue;
        const guestName = ev.summary || null;
        const uid = ev.uid || `${property.id}-${checkin}-${checkout}`;
        await pool.query(`
          INSERT INTO bookings (property_id, host_id, checkin_date, checkout_date, guest_name, ical_uid, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'upcoming')
          ON CONFLICT (property_id, ical_uid) DO UPDATE SET
            checkin_date = $3, checkout_date = $4, guest_name = $5,
            status = CASE
              WHEN NOW()::DATE > $4::DATE THEN 'completed'
              WHEN NOW()::DATE >= $3::DATE THEN 'active'
              ELSE 'upcoming'
            END
        `, [property.id, property.host_id, checkin, checkout, guestName, uid]);
        count++;
      }
      console.log(`[ICAL] Property ${property.id} synced ${count} events`);
    } catch (err) {
      console.error(`[ICAL ERROR] Property ${property.id}:`, err.message);
    }
  }
}

async function syncAllIcal() {
  try {
    const res = await pool.query("SELECT * FROM properties WHERE ical_url IS NOT NULL OR ical_url_2 IS NOT NULL");
    for (const property of res.rows) await syncIcalForProperty(property);
  } catch (err) {
    console.error("[ICAL SYNC ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// CHECKOUT REMINDER CRON
// ─────────────────────────────────────────────
async function sendCheckoutReminders() {
  try {
    const hour = new Date().getHours();
    if (hour < 8 || hour > 10) return;
    const today = new Date().toISOString().split("T")[0];
    const res = await pool.query(`
      SELECT b.*, p.address, p.checkout_time, p.key_dropoff, h.twilio_number, h.id as host_id
      FROM bookings b
      JOIN properties p ON b.property_id = p.id
      JOIN hosts h ON b.host_id = h.id
      WHERE b.checkout_date = $1 AND b.status = 'active'
    `, [today]);

    for (const booking of res.rows) {
      const guest = await pool.query("SELECT * FROM guests WHERE booking_id = $1", [booking.id]);
      if (!guest.rows[0]?.phone) continue;
      const guestPhone = guest.rows[0].phone;
      const msg = `Good morning! Just a reminder that checkout today is at ${booking.checkout_time || "11:00 AM"}. ` +
        `${booking.key_dropoff ? `Please leave the key at: ${booking.key_dropoff}. ` : ""}` +
        `It was a pleasure having you — safe travels!`;
      await sendSms(guestPhone, msg, booking.twilio_number, booking.host_id);
      setTimeout(async () => {
        await sendSms(
          guestPhone,
          `Hope you enjoyed your stay! If you have a moment we'd love a review. Thank you! — Tenario`,
          booking.twilio_number,
          booking.host_id
        );
      }, 2 * 60 * 60 * 1000);
      await pool.query("UPDATE bookings SET status = 'completed' WHERE id = $1", [booking.id]);
    }
  } catch (err) {
    console.error("[CHECKOUT CRON ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// DB HELPERS
// ─────────────────────────────────────────────
async function getHostByTwilioNumber(number) {
  const res = await pool.query("SELECT * FROM hosts WHERE twilio_number = $1", [number]);
  return res.rows[0] || null;
}
async function getHostById(id) {
  const res = await pool.query("SELECT * FROM hosts WHERE id = $1", [id]);
  return res.rows[0] || null;
}
async function getPropertyById(id) {
  const res = await pool.query("SELECT * FROM properties WHERE id = $1", [id]);
  return res.rows[0] || null;
}
async function getPropertiesByHost(hostId) {
  const res = await pool.query("SELECT * FROM properties WHERE host_id = $1 ORDER BY created_at DESC", [hostId]);
  return res.rows;
}
async function getGuest(phone, hostId) {
  const res = await pool.query("SELECT * FROM guests WHERE phone = $1 AND host_id = $2", [phone, hostId]);
  return res.rows[0] || null;
}
async function upsertGuest(phone, hostId, data) {
  await pool.query(`
    INSERT INTO guests (phone, host_id, property_id, booking_id, onboarding_state, pending_property_id, pending_booking_id, opted_out)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (phone, host_id) DO UPDATE SET
      property_id = COALESCE($3, guests.property_id),
      booking_id = COALESCE($4, guests.booking_id),
      onboarding_state = COALESCE($5, guests.onboarding_state),
      pending_property_id = $6,
      pending_booking_id = $7,
      opted_out = COALESCE($8, guests.opted_out)
  `, [phone, hostId, data.property_id ?? null, data.booking_id ?? null,
      data.onboarding_state ?? 'awaiting_address',
      data.pending_property_id ?? null, data.pending_booking_id ?? null,
      data.opted_out ?? false]);
}
async function resetGuest(phone, hostId) {
  await pool.query(`
    UPDATE guests SET property_id=NULL, booking_id=NULL,
      pending_property_id=NULL, pending_booking_id=NULL,
      onboarding_state='awaiting_address'
    WHERE phone = $1 AND host_id = $2
  `, [phone, hostId]);
}

// ─────────────────────────────────────────────
// ADDRESS MATCHING
// ─────────────────────────────────────────────
function normalizeAddress(addr) {
  return (addr || "").toLowerCase()
    .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr").replace(/\bboulevard\b/g, "blvd")
    .replace(/\blane\b/g, "ln").replace(/\broad\b/g, "rd")
    .replace(/\bapartment\b/g, "apt").replace(/\bunit\b/g, "apt")
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
function addressSimilarity(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (!na || !nb) return 0;
  if (na.includes(nb) || nb.includes(na)) return 1.0;
  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}
async function findActiveBookingByAddress(hostId, guestAddress) {
  const today = new Date().toISOString().split("T")[0];
  const res = await pool.query(`
    SELECT b.*, p.address, p.id as prop_id
    FROM bookings b JOIN properties p ON b.property_id = p.id
    WHERE b.host_id = $1 AND b.checkin_date <= $2 AND b.checkout_date >= $2
      AND b.status IN ('upcoming', 'active')
  `, [hostId, today]);
  let best = null, bestScore = 0;
  for (const booking of res.rows) {
    const score = addressSimilarity(guestAddress, booking.address);
    if (score > bestScore) { bestScore = score; best = booking; }
  }
  return bestScore >= 0.4 ? best : null;
}

// ─────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────
async function getConversation(phone, hostId) {
  const res = await pool.query("SELECT * FROM conversations WHERE guest_phone = $1 AND host_id = $2", [phone, hostId]);
  if (res.rows[0]) return res.rows[0];
  await pool.query(`
    INSERT INTO conversations (guest_phone, host_id, messages) VALUES ($1, $2, '[]')
    ON CONFLICT (guest_phone, host_id) DO NOTHING
  `, [phone, hostId]);
  return { guest_phone: phone, host_id: hostId, messages: [], escalated: false };
}
async function addMessage(phone, hostId, role, content) {
  await pool.query(`
    UPDATE conversations SET messages = messages || $1::jsonb, updated_at = NOW()
    WHERE guest_phone = $2 AND host_id = $3
  `, [JSON.stringify([{ role, content }]), phone, hostId]);
}
async function clearConversation(phone, hostId) {
  await pool.query(
    "UPDATE conversations SET messages = '[]', escalated = false WHERE guest_phone = $1 AND host_id = $2",
    [phone, hostId]);
}

// ─────────────────────────────────────────────
// CLAUDE AI
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function buildPropertyContext(property, booking) {
  const lines = [
    `Property address: ${property.address}`,
    `Check-in time: ${property.checkin_time || "3:00 PM"}`,
    `Check-out time: ${property.checkout_time || "11:00 AM"}`,
  ];
  const fields = [
    ["door_code", "Door code"], ["wifi_name", "WiFi network"], ["wifi_password", "WiFi password"],
    ["parking_instructions", "Parking"], ["key_dropoff", "Key drop-off"],
    ["thermostat_instructions", "Thermostat"], ["washer_dryer_instructions", "Washer/dryer"],
    ["tv_instructions", "TV/streaming"], ["trash_instructions", "Trash"],
    ["house_rules", "House rules"], ["breaker_location", "Breaker box"],
    ["water_shutoff", "Water shutoff"], ["nearest_urgent_care", "Nearest urgent care"],
    ["local_restaurants", "Local restaurants"], ["local_grocery", "Grocery store"],
    ["local_coffee", "Coffee shop"], ["local_activities", "Things to do"],
    ["extra_notes", "Additional notes"]
  ];
  for (const [key, label] of fields) {
    if (property[key]) lines.push(`${label}: ${property[key]}`);
  }
  if (booking?.checkout_date) lines.push(`Guest checkout date: ${booking.checkout_date}`);
  return lines.join("\n");
}

function buildSystemPrompt(property, booking) {
  return `You are an AI guest services assistant for a short-term rental, powered by Tenario Guest Services. You help guests via SMS. Keep replies SHORT (1-3 sentences max — this is SMS).

PROPERTY KNOWLEDGE BASE:
${buildPropertyContext(property, booking)}

RESOLUTION APPROACH:
1. FIRST check the knowledge base above. If the answer is there, give it directly.
2. If not in knowledge base, troubleshoot using general knowledge (appliance fixes, common issues, local recommendations).
3. If you can't resolve after trying, escalate by ending your reply with exactly: ESCALATE|<one sentence summary>
4. For EMERGENCIES (gas leak, fire, flooding, carbon monoxide, break-in), give safety instructions AND end with: EMERGENCY|<summary>

TONE: Warm, helpful, like a knowledgeable friend.
LANGUAGE: Auto-detect and reply in the guest's language.

Never make up facts not in the knowledge base. If unsure, escalate.`;
}

function isQuietHours(property) {
  const hour = new Date().getHours();
  const start = property.quiet_hours_start ?? 22;
  const end   = property.quiet_hours_end   ?? 8;
  if (start > end) return hour >= start || hour < end;
  return hour >= start && hour < end;
}
function isEmergency(text) {
  const lower = (text || "").toLowerCase();
  return ["gas leak", "gas smell", "smell gas", "fire", "flooding", "flood", "smoke",
    "carbon monoxide", "break in", "broken in", "intruder", "burglar"].some(k => lower.includes(k));
}
function getMillisUntilHour(targetHour) {
  const now    = new Date();
  const target = new Date();
  target.setHours(targetHour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

async function escalateToHost(host, guestPhone, property, issue, isEmerg) {
  const msg = `GUEST ALERT${isEmerg ? " — EMERGENCY" : ""}\n` +
    `Property: ${property.address}\nGuest: ${guestPhone}\nIssue: ${issue}\n\n` +
    `Reply to this message — your response will be forwarded to the guest.`;
  await sendSms(host.host_phone, msg, host.twilio_number, host.id);
  await pool.query("UPDATE conversations SET escalated = true WHERE guest_phone = $1 AND host_id = $2",
    [guestPhone, host.id]);
  console.log(`[ESCALATE] ${isEmerg ? "EMERGENCY " : ""}${host.name} → ${guestPhone}`);

  if (!isEmerg) {
    setTimeout(async () => {
      try {
        const convo = await getConversation(guestPhone, host.id);
        if (convo.escalated) {
          await sendSms(
            guestPhone,
            "We've passed your request to the host. We'll update you as soon as we hear back.",
            host.twilio_number,
            host.id
          );
        }
      } catch (e) { console.error("[TIMEOUT NOTIFY ERROR]", e.message); }
    }, 30 * 60 * 1000);
  }
}

async function processGuestMessage(host, guestPhone, message, property, booking) {
  const startTime = Date.now();
  try {
    const convo = await getConversation(guestPhone, host.id);
    await addMessage(guestPhone, host.id, "user", message);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: buildSystemPrompt(property, booking),
        messages: [...convo.messages, { role: "user", content: message }],
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      }),
    });

    const data = await response.json();
    const latency = Date.now() - startTime;

    // Log web search activity (Bug 3 fix)
    if (Array.isArray(data.content)) {
      const searchBlocks = data.content.filter(b => b.type === 'server_tool_use' && b.name === 'web_search');
      for (const block of searchBlocks) {
        console.log(`[WEB SEARCH] query="${block.input?.query}" guest=${guestPhone?.slice(-4)} property=${property?.id}`);
      }
      if (searchBlocks.length > 0) {
        const resultCount = data.content.filter(b => b.type === 'web_search_tool_result').length;
        console.log(`[WEB SEARCH RESULT] ${resultCount} results returned`);
      }
    }

    if (!response.ok) {
      console.error("[CLAUDE ERROR]", data);
      await logMessage(guestPhone, host.id, property?.id, "claude_error", latency);
      await sendSms(guestPhone, "Sorry, I ran into an issue. Let me get the host for you.", host.twilio_number, host.id);
      await escalateToHost(host, guestPhone, property, "System error", false);
      return;
    }

    const rawReply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("") || "";
    await addMessage(guestPhone, host.id, "assistant", rawReply);

    const emergMatch    = rawReply.match(/EMERGENCY\|(.+)/);
    const escalateMatch = rawReply.match(/ESCALATE\|(.+)/);

    const cleanReply = rawReply
      .replace(/EMERGENCY\|[^\n]*/g, "")
      .replace(/ESCALATE\|[^\n]*/g, "")
      .trim();

    if (cleanReply) await sendSms(guestPhone, cleanReply, host.twilio_number, host.id);

    if (emergMatch) {
      await logMessage(guestPhone, host.id, property?.id, "emergency_escalation", latency);
      await escalateToHost(host, guestPhone, property, emergMatch[1].trim(), true);
    } else if (escalateMatch) {
      if (isQuietHours(property)) {
        await logMessage(guestPhone, host.id, property?.id, "quiet_hours_queue", latency);
        await sendSms(
          guestPhone,
          `The host has been notified and will follow up first thing in the morning. If urgent, call ${host.host_phone} directly.`,
          host.twilio_number,
          host.id
        );
        const ms = getMillisUntilHour(property.quiet_hours_end ?? 8);
        setTimeout(() => escalateToHost(host, guestPhone, property, escalateMatch[1].trim(), false), ms);
      } else {
        await logMessage(guestPhone, host.id, property?.id, "escalation", latency);
        await escalateToHost(host, guestPhone, property, escalateMatch[1].trim(), false);
      }
    } else {
      await logMessage(guestPhone, host.id, property?.id, "ai_response", latency);
    }
  } catch (err) {
    const latency = Date.now() - startTime;
    console.error("[PROCESS EXCEPTION]", err);
    await logMessage(guestPhone, host.id, property?.id, "exception", latency);
    await sendSms(guestPhone, "Sorry, something went wrong. The host will reach out directly.", host.twilio_number, host.id);
  }
}

// ─────────────────────────────────────────────
// HOST REPLY HANDLER
// ─────────────────────────────────────────────
async function handleHostReply(host, body) {
  const res = await pool.query(`
    SELECT guest_phone FROM conversations
    WHERE host_id = $1 AND escalated = true
    ORDER BY updated_at DESC LIMIT 1
  `, [host.id]);
  if (!res.rows[0]) {
    await sendSms(host.host_phone, "No open escalations.", host.twilio_number, host.id);
    return;
  }
  const guestPhone = res.rows[0].guest_phone;
  await sendSms(guestPhone, body, host.twilio_number, host.id);
  await pool.query("UPDATE conversations SET escalated = false WHERE guest_phone = $1 AND host_id = $2",
    [guestPhone, host.id]);
  await sendSms(host.host_phone, `Forwarded to guest at ${guestPhone}.`, host.twilio_number, host.id);
}

// ─────────────────────────────────────────────
// MAIN SMS HANDLER
// ─────────────────────────────────────────────
async function handleSms(host, from, body) {
  const lower = body.toLowerCase().trim();

  if (["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(lower)) {
    await pool.query("UPDATE guests SET opted_out = true WHERE phone = $1 AND host_id = $2", [from, host.id]);
    return;
  }

  if (from === host.host_phone) {
    await handleHostReply(host, body);
    return;
  }

  // Guest rate limit check
  const rateLimited = await checkGuestRateLimit(from, host.id);
  if (rateLimited) {
    console.warn(`[RATE LIMIT] Dropping message from ${from.slice(-4)} to host ${host.id}`);
    // Silent drop — do not reply to guest
    return;
  }

  let guest = await getGuest(from, host.id);

  if (!guest) {
    await upsertGuest(from, host.id, { onboarding_state: "awaiting_address" });
    await logMessage(from, host.id, null, "new_guest", null);
    await sendSms(
      from,
      `Hi! I'm your AI guest services assistant. To get started, what's the address of the property you're staying at?`,
      host.twilio_number,
      host.id
    );
    return;
  }

  if (guest.opted_out) return;

  // Linked guest — check if their booking has ended
  if (guest.onboarding_state === "linked" && guest.booking_id) {
    const bookingRes = await pool.query("SELECT * FROM bookings WHERE id = $1", [guest.booking_id]);
    const booking    = bookingRes.rows[0];
    const today      = new Date().toISOString().split("T")[0];

    if (booking && booking.checkout_date < today) {
      const property    = await getPropertyById(guest.property_id);
      const newBooking  = property ? await findActiveBookingByAddress(host.id, property.address) : null;
      if (newBooking) {
        await upsertGuest(from, host.id, {
          booking_id: newBooking.id, property_id: newBooking.prop_id, onboarding_state: "linked"
        });
        await clearConversation(from, host.id);
        guest = await getGuest(from, host.id);
      } else {
        await resetGuest(from, host.id);
        await sendSms(
          from,
          `Your previous stay has ended. If you have a new booking, just text the address you're staying at!`,
          host.twilio_number,
          host.id
        );
        return;
      }
    }

    if (guest.onboarding_state === "linked") {
      const property = await getPropertyById(guest.property_id);
      const bk       = await pool.query("SELECT * FROM bookings WHERE id = $1", [guest.booking_id]);
      if (isEmergency(body)) {
        await logMessage(from, host.id, property?.id, "emergency_direct", null);
        await sendSms(
          from,
          `This sounds like an emergency. If you're in immediate danger call 911 first. I'm alerting your host now.`,
          host.twilio_number,
          host.id
        );
        await escalateToHost(host, from, property, body, true);
        return;
      }
      processGuestMessage(host, from, body, property, bk.rows[0]);
      return;
    }
  }

  if (guest.onboarding_state === "awaiting_address") {
    const match = await findActiveBookingByAddress(host.id, body);
    if (!match) {
      await logMessage(from, host.id, null, "address_no_match", null);
      await sendSms(
        from,
        `I couldn't find an active booking at that address. Double-check the address or contact your host directly. What address are you staying at?`,
        host.twilio_number,
        host.id
      );
      return;
    }
    await upsertGuest(from, host.id, {
      onboarding_state: "awaiting_confirmation",
      pending_property_id: match.prop_id,
      pending_booking_id: match.id
    });
    const property = await getPropertyById(match.prop_id);
    await logMessage(from, host.id, match.prop_id, "address_matched", null);
    await sendSms(
      from,
      `Just to confirm — are you staying at ${property.address}? Reply YES or NO.`,
      host.twilio_number,
      host.id
    );

    // 10-min timeout if no response
    setTimeout(async () => {
      try {
        const g = await getGuest(from, host.id);
        if (g?.onboarding_state === "awaiting_confirmation") {
          await resetGuest(from, host.id);
          await sendSms(from, `We didn't hear back. Just text the address whenever you're ready!`, host.twilio_number, host.id);
        }
      } catch (e) { console.error("[TIMEOUT]", e.message); }
    }, 10 * 60 * 1000);
    return;
  }

  if (guest.onboarding_state === "awaiting_confirmation") {
    const answer = lower.replace(/[^a-z]/g, "");
    if (["yes", "yeah", "yep", "yup", "correct", "right", "y", "ya"].includes(answer)) {
      await upsertGuest(from, host.id, {
        onboarding_state: "linked",
        property_id: guest.pending_property_id,
        booking_id:  guest.pending_booking_id,
        pending_property_id: null,
        pending_booking_id:  null
      });
      const property = await getPropertyById(guest.pending_property_id);
      await logMessage(from, host.id, guest.pending_property_id, "guest_linked", null);
      await sendSms(
        from,
        `Perfect, you're all set! I'm your AI guest services assistant for ${property.address}. Ask me anything — WiFi, checkout info, local spots, or if something needs fixing. I'm here 24/7!`,
        host.twilio_number,
        host.id
      );
      console.log(`[LINKED] ${from} → property ${guest.pending_property_id}`);
    } else if (["no", "nope", "n", "wrong", "incorrect"].includes(answer)) {
      await resetGuest(from, host.id);
      await sendSms(from, `No problem! What's the address you're staying at?`, host.twilio_number, host.id);
    } else {
      await sendSms(from, `Sorry, I didn't catch that. Reply YES or NO.`, host.twilio_number, host.id);
    }
    return;
  }

  await sendSms(from, `Hi! What's the address of the property you're staying at?`, host.twilio_number, host.id);
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function emptyTwiml() { return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'; }
function timeAgo(date) {
  const s = Math.floor((new Date() - new Date(date)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) h.split(";").forEach(c => { const [k, v] = c.trim().split("="); req.cookies[k] = v; });
  next();
});
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "F@tboyPenny2005";
function checkAdminAuth(req, res, next) {
  if (req.cookies?.admin_auth === ADMIN_PASSWORD) return next();
  res.redirect("/admin/login");
}
async function checkHostAuth(req, res, next) {
  const hostId   = req.cookies?.host_id;
  const hostPass = req.cookies?.host_pass;
  if (!hostId) return res.redirect("/login");
  const host = await getHostById(parseInt(hostId));
  if (!host || host.dashboard_password !== hostPass) return res.redirect("/login");
  req.currentHost = host;
  next();
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// ONBOARDING
// ─────────────────────────────────────────────

app.get("/onboarding", (req, res) => {
  const error = req.query.error ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#dc2626;font-size:14px;">${decodeURIComponent(req.query.error)}</div>` : "";
  res.send(`<!DOCTYPE html><html><head><title>Set Up Your Account &mdash; ${BRAND}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#eceff4;min-height:100vh;padding:24px 16px 48px}.ob-wrap{max-width:600px;margin:0 auto}.ob-header{text-align:center;padding:32px 0 24px}.ob-logo{font-size:22px;font-weight:700;color:#1a2332}.ob-tagline{font-size:14px;color:#64748b;margin-top:4px}.ob-progress{display:flex;align-items:center;margin-bottom:28px;background:#fff;border-radius:12px;padding:16px 20px;box-shadow:0 1px 4px rgba(0,0,0,.06)}.ob-dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0}.ob-dot.done{background:#22c55e;color:#fff}.ob-dot.active{background:#1a2332;color:#fff}.ob-dot.pending{background:#e5e7eb;color:#9ca3af}.ob-line{flex:1;height:3px;background:#e5e7eb;margin:0 4px}.ob-line.done{background:#22c55e}.ob-card{background:#fff;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.07);padding:28px;margin-bottom:20px}.ob-step{display:none}.ob-step.active{display:block}.ob-title{font-size:20px;font-weight:700;color:#1a2332;margin-bottom:4px}.ob-sub{font-size:14px;color:#64748b;margin-bottom:24px}.ob-field{margin-bottom:18px}.ob-label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}.ob-opt{font-weight:400;color:#9ca3af;font-size:12px;margin-left:4px}.ob-input,.ob-select,.ob-textarea{width:100%;padding:10px 14px;border:1.5px solid #d1d5db;border-radius:8px;font-size:14px;color:#1a2332;background:#fff;outline:none}.ob-input:focus,.ob-textarea:focus{border-color:#1a2332}.ob-select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%239ca3af' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;cursor:pointer}.ob-textarea{resize:vertical;min-height:80px;font-family:inherit}.ob-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:480px){.ob-row{grid-template-columns:1fr}}.ob-nav{display:flex;justify-content:space-between;align-items:center;margin-top:24px;padding-top:20px;border-top:1px solid #f3f4f6}.ob-btn{padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:none}.ob-primary{background:#1a2332;color:#fff}.ob-primary:hover{background:#0f172a}.ob-secondary{background:#f3f4f6;color:#374151}.ob-rv-head{font-size:13px;font-weight:700;color:#1a2332;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #f3f4f6}.ob-rv-row{display:flex;gap:8px;font-size:13px;padding:4px 0}.ob-rv-k{color:#64748b;min-width:140px;flex-shrink:0}.ob-rv-v{color:#1a2332;font-weight:500}.ob-spinner{display:none;text-align:center;padding:20px}.ob-spin{width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:#1a2332;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 8px}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><div class="ob-wrap"><div class="ob-header"><div class="ob-logo">${BRAND}</div><div class="ob-tagline">Set up your host account &mdash; takes about 5 minutes</div></div><div class="ob-progress"><div class="ob-dot active" id="dot1">1</div><div class="ob-line" id="line1"></div><div class="ob-dot pending" id="dot2">2</div><div class="ob-line" id="line2"></div><div class="ob-dot pending" id="dot3">3</div><div class="ob-line" id="line3"></div><div class="ob-dot pending" id="dot4">4</div><div class="ob-line" id="line4"></div><div class="ob-dot pending" id="dot5">5</div></div>${error}<form method="POST" action="/onboarding/submit"><div class="ob-card"><div class="ob-step active" id="step1"><div class="ob-title">Your Account</div><div class="ob-sub">Step 1 of 5 &mdash; Create your host login</div><div class="ob-field"><label class="ob-label">Full Name</label><input class="ob-input" type="text" name="name" id="f_name" placeholder="Jane Smith" required></div><div class="ob-field"><label class="ob-label">Email Address</label><input class="ob-input" type="email" name="email" id="f_email" placeholder="jane@example.com" required></div><div class="ob-field"><label class="ob-label">Phone <span class="ob-opt">(cell for escalation texts)</span></label><input class="ob-input" type="tel" name="phone" id="f_phone" placeholder="+15551234567" required></div><div class="ob-field"><label class="ob-label">Your Twilio Number <span class="req">*</span></label><p style="font-size:12px;color:#888;margin:4px 0 8px">The number guests text. Get one at twilio.com.</p><input type="tel" class="ob-input" id="f_twilioNumber" name="twilioNumber" placeholder="+15139518826" required></div><div class="ob-field"><label class="ob-label">Password <span class="ob-opt">(min 8 chars)</span></label><input class="ob-input" type="password" name="password" id="f_password" minlength="8" required></div><div class="ob-field"><label class="ob-label">Confirm Password</label><input class="ob-input" type="password" name="confirmPassword" id="f_confirmPassword" minlength="8" required></div><div class="ob-nav"><span style="font-size:13px;color:#64748b;">Have an account? <a href="/login" style="color:#1a2332;font-weight:600;">Sign in</a></span><button type="button" class="ob-btn ob-primary" onclick="nextStep(1)">Next &rarr;</button></div></div><div class="ob-step" id="step2"><div class="ob-title">Your Property</div><div class="ob-sub">Step 2 of 5 &mdash; Tell us about your rental</div><div class="ob-field"><label class="ob-label">Property Nickname</label><input class="ob-input" type="text" name="propertyName" id="f_propertyName" placeholder="The Lakehouse" required></div><div class="ob-field"><label class="ob-label">Property Address</label><input class="ob-input" type="text" name="address" id="f_address" placeholder="123 Main St, Lima OH 45801" required></div><div class="ob-field"><label class="ob-label">Listing Platform</label><select class="ob-select" name="platform" id="f_platform" required><option value="">— Select —</option><option value="Airbnb">Airbnb</option><option value="VRBO">VRBO</option><option value="Both">Both (Airbnb + VRBO)</option><option value="Direct">Direct bookings only</option></select></div><div class="ob-field"><label class="ob-label">iCal URL <span class="ob-opt">(optional)</span></label><input class="ob-input" type="url" name="icalUrl" id="f_icalUrl" placeholder="https://www.airbnb.com/calendar/ical/..."></div><div class="ob-nav"><button type="button" class="ob-btn ob-secondary" onclick="prevStep(2)">&larr; Back</button><button type="button" class="ob-btn ob-primary" onclick="nextStep(2)">Next &rarr;</button></div></div><div class="ob-step" id="step3"><div class="ob-title">Guest Access</div><div class="ob-sub">Step 3 of 5 &mdash; How guests get in</div><div class="ob-row"><div class="ob-field"><label class="ob-label">WiFi Network Name</label><input class="ob-input" type="text" name="wifiName" id="f_wifiName" placeholder="MyHomeWiFi" required></div><div class="ob-field"><label class="ob-label">WiFi Password</label><input class="ob-input" type="text" name="wifiPassword" id="f_wifiPassword" placeholder="password123" required></div></div><div class="ob-field"><label class="ob-label">Door / Lockbox Code</label><input class="ob-input" type="text" name="doorCode" id="f_doorCode" placeholder="1234" required></div><div class="ob-field"><label class="ob-label">Parking <span class="ob-opt">(optional)</span></label><input class="ob-input" type="text" name="parkingInstructions" id="f_parkingInstructions" placeholder="Park in driveway, 2 car limit"></div><div class="ob-field"><label class="ob-label">Trash Day <span class="ob-opt">(optional)</span></label><input class="ob-input" type="text" name="trashInstructions" id="f_trashInstructions" placeholder="Tuesdays — bins at end of driveway"></div><div class="ob-nav"><button type="button" class="ob-btn ob-secondary" onclick="prevStep(3)">&larr; Back</button><button type="button" class="ob-btn ob-primary" onclick="nextStep(3)">Next &rarr;</button></div></div><div class="ob-step" id="step4"><div class="ob-title">House Policies</div><div class="ob-sub">Step 4 of 5 &mdash; Rules and check-in details</div><div class="ob-row"><div class="ob-field"><label class="ob-label">Check-in Time</label><input class="ob-input" type="time" name="checkinTime" id="f_checkinTime" value="15:00" required></div><div class="ob-field"><label class="ob-label">Checkout Time</label><input class="ob-input" type="time" name="checkoutTime" id="f_checkoutTime" value="11:00" required></div></div><div class="ob-field"><label class="ob-label">House Rules</label><textarea class="ob-textarea" name="houseRules" id="f_houseRules" placeholder="No smoking, no parties, no pets." required></textarea></div><div class="ob-row"><div class="ob-field"><label class="ob-label">Quiet Hours <span class="ob-opt">(optional)</span></label><input class="ob-input" type="text" name="quietHours" id="f_quietHours" placeholder="10pm to 8am"></div><div class="ob-field"><label class="ob-label">Max Guests <span class="ob-opt">(optional)</span></label><input class="ob-input" type="number" name="maxGuests" id="f_maxGuests" placeholder="6" min="1"></div></div><div class="ob-field"><label class="ob-label">Pet Policy <span class="ob-opt">(optional)</span></label><input class="ob-input" type="text" name="petPolicy" id="f_petPolicy" placeholder="No pets allowed"></div><div class="ob-nav"><button type="button" class="ob-btn ob-secondary" onclick="prevStep(4)">&larr; Back</button><button type="button" class="ob-btn ob-primary" onclick="nextStep(4)">Next &rarr;</button></div></div><div class="ob-step" id="step5"><div class="ob-title">Local Knowledge</div><div class="ob-sub">Step 5 of 5 &mdash; Help guests explore (all optional)</div><div class="ob-field"><label class="ob-label">Nearest Grocery <span class="ob-opt">(optional)</span></label><input class="ob-input" type="text" name="nearestGrocery" id="f_nearestGrocery" placeholder="Kroger at 500 Elm St"></div><div class="ob-field"><label class="ob-label">Best Local Restaurants <span class="ob-opt">(optional)</span></label><textarea class="ob-textarea" name="localRestaurants" id="f_localRestaurants" placeholder="Marco's Pizza on Main St"></textarea></div><div class="ob-field"><label class="ob-label">Nearest Hospital / Urgent Care <span class="ob-opt">(optional)</span></label><input class="ob-input" type="text" name="nearestHospital" id="f_nearestHospital" placeholder="St. Rita's Medical, 730 W Market St"></div><div class="ob-field"><label class="ob-label">Other Local Tips <span class="ob-opt">(optional)</span></label><textarea class="ob-textarea" name="otherTips" id="f_otherTips" placeholder="Farmers market Saturdays 8am-noon"></textarea></div><div class="ob-field"><label class="ob-label">Emergency Contact <span class="ob-opt">(optional)</span></label><input class="ob-input" type="text" name="emergencyContact" id="f_emergencyContact" placeholder="Property manager: John Smith 555-1234"></div><div style="margin:28px 0 4px;padding:20px;background:#f8fafc;border-radius:10px;border:1px solid #e5e7eb"><div style="font-size:14px;font-weight:700;color:#1a2332;margin-bottom:14px">Review Your Info</div><div style="margin-bottom:12px"><div class="ob-rv-head">Account</div><div class="ob-rv-row"><span class="ob-rv-k">Name</span><span class="ob-rv-v" id="rv_name">&mdash;</span></div><div class="ob-rv-row"><span class="ob-rv-k">Email</span><span class="ob-rv-v" id="rv_email">&mdash;</span></div><div class="ob-rv-row"><span class="ob-rv-k">Phone</span><span class="ob-rv-v" id="rv_phone">&mdash;</span></div></div><div style="margin-bottom:12px"><div class="ob-rv-head">Property</div><div class="ob-rv-row"><span class="ob-rv-k">Name</span><span class="ob-rv-v" id="rv_prop">&mdash;</span></div><div class="ob-rv-row"><span class="ob-rv-k">Address</span><span class="ob-rv-v" id="rv_addr">&mdash;</span></div><div class="ob-rv-row"><span class="ob-rv-k">Platform</span><span class="ob-rv-v" id="rv_plat">&mdash;</span></div></div><div><div class="ob-rv-head">Access &amp; Policies</div><div class="ob-rv-row"><span class="ob-rv-k">WiFi</span><span class="ob-rv-v" id="rv_wifi">&mdash;</span></div><div class="ob-rv-row"><span class="ob-rv-k">Door Code</span><span class="ob-rv-v" id="rv_door">&mdash;</span></div><div class="ob-rv-row"><span class="ob-rv-k">Check-in</span><span class="ob-rv-v" id="rv_ci">&mdash;</span></div><div class="ob-rv-row"><span class="ob-rv-k">Checkout</span><span class="ob-rv-v" id="rv_co">&mdash;</span></div></div></div><div class="ob-nav"><button type="button" class="ob-btn ob-secondary" onclick="prevStep(5)">&larr; Back</button><button type="submit" class="ob-btn ob-primary" id="subBtn" style="background:#22c55e;font-size:15px;padding:12px 28px" onclick="showSpinner()">Set Up My Account &rarr;</button></div></div><div class="ob-spinner" id="spinner"><div class="ob-spin"></div><div style="font-size:13px;color:#64748b">Creating your account&hellip;</div></div></div></form></div><script>function showStep(n){for(var i=1;i<=5;i++){document.getElementById('step'+i).classList.remove('active');var d=document.getElementById('dot'+i);if(i<n){d.className='ob-dot done';d.innerHTML='&#10003;'}else if(i===n){d.className='ob-dot active';d.innerHTML=i}else{d.className='ob-dot pending';d.innerHTML=i}if(i<5){var l=document.getElementById('line'+i);l.className='ob-line'+(i<n?' done':'')}}document.getElementById('step'+n).classList.add('active');window.scrollTo({top:0,behavior:'smooth'})}function validateStep(n){var s=document.getElementById('step'+n);var req=s.querySelectorAll('[required]');for(var i=0;i<req.length;i++){if(!req[i].value.trim()){req[i].focus();req[i].style.borderColor='#ef4444';setTimeout((function(e){return function(){e.style.borderColor=''}})(req[i]),2000);return false}}if(n===1){var p=document.getElementById('f_password').value,c=document.getElementById('f_confirmPassword').value;if(p!==c){alert('Passwords do not match');return false}if(p.length<8){alert('Password must be at least 8 characters');return false}}return true}function nextStep(n){if(!validateStep(n))return;if(n===4)updateReview();showStep(n+1)}function prevStep(n){showStep(n-1)}function updateReview(){var g=function(id){var e=document.getElementById(id);return e?e.value||'—':'—'};document.getElementById('rv_name').textContent=g('f_name');document.getElementById('rv_email').textContent=g('f_email');document.getElementById('rv_phone').textContent=g('f_phone');document.getElementById('rv_prop').textContent=g('f_propertyName');document.getElementById('rv_addr').textContent=g('f_address');document.getElementById('rv_plat').textContent=g('f_platform');var wn=g('f_wifiName'),wp=g('f_wifiPassword');document.getElementById('rv_wifi').textContent=wn!=='—'?wn+' / '+wp:'—';document.getElementById('rv_door').textContent=g('f_doorCode');function ft(t){if(!t||t==='—')return t;var p=t.split(':'),h=+p[0],m=+p[1],ampm=h>=12?'PM':'AM',h12=h%12||12;return h12+':'+('0'+m).slice(-2)+' '+ampm}document.getElementById('rv_ci').textContent=ft(g('f_checkinTime'));document.getElementById('rv_co').textContent=ft(g('f_checkoutTime'))}function showSpinner(){setTimeout(function(){document.getElementById('subBtn').style.display='none';document.getElementById('spinner').style.display='block'},50)}</script></body></html>`);
});

app.post("/onboarding/submit", async (req, res) => {
  try {
    const { name, email, phone, password, confirmPassword, propertyName, address, platform, icalUrl,
      wifiName, wifiPassword, doorCode, parkingInstructions, trashInstructions,
      checkinTime, checkoutTime, houseRules, quietHours, maxGuests, petPolicy,
      nearestGrocery, localRestaurants, nearestHospital, otherTips, emergencyContact, twilioNumber } = req.body;
    if (!name || !email || !phone || !password || !propertyName || !address || !platform ||
        !wifiName || !wifiPassword || !doorCode || !checkinTime || !checkoutTime || !houseRules) {
      return res.redirect("/onboarding?error=" + encodeURIComponent("Please fill in all required fields."));
    }
    if (password !== confirmPassword) {
      return res.redirect("/onboarding?error=" + encodeURIComponent("Passwords do not match."));
    }
    if (password.length < 8) {
      return res.redirect("/onboarding?error=" + encodeURIComponent("Password must be at least 8 characters."));
    }
    const existing = await pool.query("SELECT id FROM hosts WHERE LOWER(email) = LOWER($1)", [email.trim()]);
    if (existing.rows.length > 0) {
      return res.redirect("/onboarding?error=" + encodeURIComponent("An account with that email already exists. Log in instead."));
    }
    const fmtTime = t => { if (!t) return t; const [h, m] = t.split(':').map(Number); const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 || 12; return h12 + ':' + String(m).padStart(2,'0') + ' ' + ampm; };
    const extraParts = [];
    if (platform)         extraParts.push('Platform: ' + platform);
    if (quietHours)       extraParts.push('Quiet hours: ' + quietHours);
    if (maxGuests)        extraParts.push('Max guests: ' + maxGuests);
    if (petPolicy)        extraParts.push('Pet policy: ' + petPolicy);
    if (emergencyContact) extraParts.push('Emergency contact: ' + emergencyContact);
    if (otherTips)        extraParts.push('Local tips: ' + otherTips);
    const extraNotes = extraParts.length ? extraParts.join('\n') : null;
    const hostRes = await pool.query(
      `INSERT INTO hosts (name, email, host_phone, dashboard_password, twilio_number, plan) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name.trim(), email.trim().toLowerCase(), (twilioNumber||'').trim(), 'starter']
    );
    const newHost = hostRes.rows[0];
    const propRes = await pool.query(
      `INSERT INTO properties (host_id, name, address, ical_url, wifi_name, wifi_password, door_code, checkin_time, checkout_time, parking_instructions, trash_instructions, house_rules, nearest_urgent_care, local_restaurants, local_grocery, extra_notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [newHost.id, propertyName.trim(), address.trim(), icalUrl||null, wifiName.trim(), wifiPassword.trim(), doorCode.trim(), fmtTime(checkinTime)||'3:00 PM', fmtTime(checkoutTime)||'11:00 AM', parkingInstructions||null, trashInstructions||null, houseRules.trim(), nearestHospital||null, localRestaurants||null, nearestGrocery||null, extraNotes]
    );
    const newProperty = propRes.rows[0];
    if (icalUrl && icalUrl.trim()) syncIcalForProperty(newProperty).catch(e => console.error('[ONBOARDING] iCal error:', e.message));
    res.setHeader("Set-Cookie", [`host_id=${newHost.id}; Path=/; HttpOnly; Max-Age=86400`, `host_pass=${password}; Path=/; HttpOnly; Max-Age=86400`]);
    console.log(`[ONBOARDING] New host: ${name} <${email}>`);
    res.redirect("/dashboard?welcome=1");
  } catch (err) {
    console.error("[ONBOARDING ERROR]", err.message);
    res.redirect("/onboarding?error=" + encodeURIComponent("Something went wrong. Please try again."));
  }
});


// ROUTES
// ─────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) => {
  const errMsg = req.query.error ? '<p style="color:#dc2626;font-size:14px;background:#fef2f2;padding:10px 14px;border-radius:6px;border:1px solid #fca5a5;margin-bottom:16px;">Invalid email or password.</p>' : "";
  res.send(`<html><head><title>${BRAND}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#eceff4;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#fff;border-radius:14px;box-shadow:0 2px 8px rgba(0,0,0,.08);padding:36px 32px;width:100%;max-width:380px}.logo{font-size:22px;font-weight:700;color:#1a2332;margin-bottom:4px}.sub{font-size:14px;color:#64748b;margin-bottom:28px}label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}input{width:100%;padding:10px 14px;border:1.5px solid #d1d5db;border-radius:8px;font-size:14px;margin-bottom:16px;outline:none;color:#1a2332}input:focus{border-color:#1a2332}button{width:100%;padding:12px;background:#1a2332;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}button:hover{background:#0f172a}.nl{text-align:center;margin-top:18px;font-size:13px;color:#64748b}</style></head><body><div class="card"><div class="logo">${BRAND}</div><div class="sub">Enter your Twilio number and password to sign in</div>${errMsg}<form method="POST" action="/login"><label>Your Twilio Number</label><input type="tel" name="twilio_number" placeholder="+15139518826" required><label>Password</label><input type="password" name="password" required><button type="submit">Sign In</button></form><div class="nl">New here? <a href="/onboarding" style="color:#1a2332;font-weight:600;">Create your account &rarr;</a></div></div></body></html>`);
});
app.post("/login", async (req, res) => {
  const { email, twilio_number, password } = req.body;
  let host;
  if (email && email.trim()) {
    const r = await pool.query("SELECT * FROM hosts WHERE LOWER(email) = LOWER($1)", [email.trim()]);
    host = r.rows[0];
  } else if (twilio_number) {
    host = await getHostByTwilioNumber(twilio_number);
  }
  if (host && host.dashboard_password === password) {
    res.setHeader("Set-Cookie", [`host_id=${host.id}; Path=/; HttpOnly; Max-Age=86400`, `host_pass=${password}; Path=/; HttpOnly; Max-Age=86400`]);
    res.redirect("/dashboard");
  } else {
    res.redirect("/login?error=1");
  }
});

// ── CONVERSATIONS VIEW ──────────────────────────────────────────────────────
app.get("/conversations", requireAuth, async (req, res) => {
  try {
    const host = req.currentHost;
    const convos = await db.query(`
      SELECT c.id, c.guest_phone, c.messages, c.escalated, c.updated_at,
             p.name as property_name, p.address
      FROM conversations c
      JOIN properties p ON c.property_id = p.id
      WHERE p.host_id = $1
      ORDER BY c.updated_at DESC
      LIMIT 50
    `, [host.id]);

    const rows = convos.rows.map(c => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const ph = c.guest_phone || '';
      const masked = ph.length > 4 ? ph.slice(0,-4).replace(/\d/g,'*') + ph.slice(-4) : ph;
      return { ...c, guest_phone: masked, messages: msgs };
    });

    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tenario — Conversations</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6f8;color:#1a2236;min-height:100vh}
.topbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 24px;display:flex;align-items:center;justify-content:space-between}
.logo{font-weight:800;font-size:18px;color:#10b981}
.nav a{text-decoration:none;color:#64748b;font-size:14px;font-weight:500;margin-left:16px}
.nav a:hover,.nav a.active{color:#10b981}
.page{max-width:900px;margin:32px auto;padding:0 24px}
h1{font-size:22px;font-weight:700;margin-bottom:20px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:16px;overflow:hidden}
.card-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:#f8fafc;border-bottom:1px solid #e2e8f0;flex-wrap:wrap;gap:8px}
.meta strong{color:#1a2236;font-weight:600;font-size:14px}
.meta small{color:#64748b;font-size:12px;display:block;margin-top:2px}
.badge{padding:3px 9px;border-radius:10px;font-size:11px;font-weight:700}
.esc{background:#fef2f2;color:#ef4444;border:1px solid #fecaca}
.ok{background:#f0fdf4;color:#10b981;border:1px solid #bbf7d0}
.msgs{padding:14px 18px;display:flex;flex-direction:column;gap:10px;max-height:320px;overflow-y:auto}
.msg-wrap{display:flex;flex-direction:column}
.msg-wrap.ai{align-items:flex-end}
.lbl{font-size:10px;color:#94a3b8;margin-bottom:3px}
.bubble{max-width:80%;padding:9px 13px;border-radius:12px;font-size:14px;line-height:1.5;white-space:pre-wrap}
.bubble.guest{background:#f1f5f9;border-radius:12px 12px 12px 2px}
.bubble.ai{background:#10b981;color:#fff;border-radius:12px 12px 2px 12px}
.empty{text-align:center;padding:48px;color:#94a3b8;font-size:14px}
.ts{font-size:11px;color:#94a3b8}
</style></head><body>
<div class="topbar">
  <div class="logo">Tenario</div>
  <nav class="nav">
    <a href="/dashboard">Dashboard</a>
    <a href="/conversations" class="active">Conversations</a>
    <a href="/conversations">Conversations</a> <a href="/logout">Sign Out</a>
  </nav>
</div>
<div class="page">
  <h1>Guest Conversations</h1>
  ${rows.length === 0
    ? '<div class="empty"><p>No conversations yet. When guests text in, their messages will appear here.</p></div>'
    : rows.map(c => {
        const ts = new Date(c.updated_at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
        const msgHtml = c.messages.length === 0
          ? '<p style="color:#94a3b8;font-size:13px;padding:8px 0">No messages logged yet</p>'
          : c.messages.map(m => {
              const isGuest = m.role === 'user';
              const safe = String(m.content || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
              return `<div class="msg-wrap ${isGuest?'':'ai'}">
                <span class="lbl">${isGuest ? '👤 Guest' : '🤖 Tenario AI'}</span>
                <div class="bubble ${isGuest?'guest':'ai'}">${safe}</div>
              </div>`;
            }).join('');
        return `<div class="card">
          <div class="card-head">
            <div class="meta">
              <strong>${c.property_name}</strong>
              <small>Guest: ${c.guest_phone} &nbsp;·&nbsp; ${c.messages.length} message${c.messages.length!==1?'s':''}</small>
            </div>
            <div style="display:flex;gap:10px;align-items:center">
              <span class="badge ${c.escalated?'esc':'ok'}">${c.escalated?'🚨 Escalated':'✅ Resolved'}</span>
              <span class="ts">${ts}</span>
            </div>
          </div>
          <div class="msgs">${msgHtml}</div>
        </div>`;
      }).join('')}
</div></body></html>`);
  } catch(err) {
    console.error('[CONVERSATIONS]', err);
    res.status(500).send('Error loading conversations');
  }
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", ["host_id=; Path=/; HttpOnly; Max-Age=0", "host_pass=; Path=/; HttpOnly; Max-Age=0"]);
  res.redirect("/login");
});

app.get("/dashboard", checkHostAuth, async (req, res) => {
  const host       = req.currentHost;
  const properties = await getPropertiesByHost(host.id);
  const today      = new Date().toISOString().split("T")[0];

  const activeBookings = await pool.query(`
    SELECT b.*, p.address, p.name as property_name
    FROM bookings b JOIN properties p ON b.property_id = p.id
    WHERE b.host_id = $1 AND b.checkin_date <= $2 AND b.checkout_date >= $2
    ORDER BY b.checkout_date ASC
  `, [host.id, today]);

  const escalations = await pool.query(`
    SELECT c.*, p.address FROM conversations c
    LEFT JOIN properties p ON c.property_id = p.id
    WHERE c.host_id = $1 AND c.escalated = true
    ORDER BY c.updated_at DESC
  `, [host.id]);

  const activeRows = activeBookings.rows.map(b =>
    `<tr><td>${b.property_name || b.address}</td><td>${b.checkin_date}</td><td>${b.checkout_date}</td><td>${b.guest_name || "—"}</td><td><span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">${b.status}</span></td></tr>`
  ).join("");
  const escalationRows = escalations.rows.map(e =>
    `<tr><td>${e.address || "Unknown"}</td><td>${e.guest_phone}</td><td>${timeAgo(e.updated_at)}</td><td><span style="background:#ef4444;color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">Open</span></td></tr>`
  ).join("");
  const propRows = properties.map(p =>
    `<tr><td>${p.name || p.address}</td><td style="font-size:12px;color:#64748b">${p.address}</td><td>${p.ical_url ? '<span style="color:#22c55e;font-weight:bold">Yes</span>' : '<span style="color:#94a3b8">No</span>'}</td><td style="display:flex;gap:6px"><a href="/properties/${p.id}/edit" style="background:#3b82f6;color:white;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:bold;text-decoration:none">Edit</a><form method="POST" action="/properties/${p.id}/sync" style="display:inline"><button type="submit" style="background:#8b5cf6;color:white;border:none;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:bold;cursor:pointer">Sync iCal</button></form></td></tr>`
  ).join("");

  res.send(`<html><head><title>${BRAND} — Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;}.header{background:#1e293b;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;}.header h1{font-size:20px;}.logout{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 12px;border:1px solid #475569;border-radius:6px;}.content{padding:32px;}.section{background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}h2{font-size:17px;margin-bottom:16px;font-weight:700;}table{width:100%;border-collapse:collapse;}th{text-align:left;padding:10px 14px;font-size:12px;color:#64748b;text-transform:uppercase;border-bottom:1px solid #e2e8f0;}td{padding:12px 14px;font-size:14px;border-bottom:1px solid #f1f5f9;}tr:last-child td{border-bottom:none;}.stat-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;}.stat{background:white;border-radius:12px;padding:20px 24px;flex:1;min-width:120px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}.stat .num{font-size:28px;font-weight:bold;}.stat .label{font-size:12px;color:#64748b;margin-top:4px;}.btn{display:inline-block;padding:10px 20px;background:#1e293b;color:white;border-radius:8px;font-size:13px;font-weight:bold;text-decoration:none;}</style><meta http-equiv="refresh" content="60"></head><body>${req.query.welcome ? `<div style='background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px 20px;margin:16px 24px 0;color:#15803d;font-size:14px;display:flex;align-items:center;gap:10px;'><span style='font-size:18px;'>&#127881;</span><span><strong>Welcome to Tenario!</strong> Your property is set up and ready to receive guests.</span></div>` : ''}<div class="header"><h1>${BRAND} — ${host.name}</h1><a href="/logout" class="logout">Sign Out</a></div><div class="content"><div class="stat-row"><div class="stat"><div class="num">${properties.length}</div><div class="label">Properties</div></div><div class="stat"><div class="num" style="color:#22c55e">${activeBookings.rows.length}</div><div class="label">Active Stays</div></div><div class="stat"><div class="num" style="color:#ef4444">${escalations.rows.length}</div><div class="label">Open Escalations</div></div></div>${escalations.rows.length > 0 ? `<div class="section"><h2 style="color:#ef4444">Open Escalations</h2><table><thead><tr><th>Property</th><th>Guest Phone</th><th>Since</th><th>Status</th></tr></thead><tbody>${escalationRows}</tbody></table><p style="font-size:13px;color:#64748b;margin-top:12px">Reply from ${host.host_phone} to respond — auto-forwarded to the guest.</p></div>` : ""}<div class="section"><h2>Active Stays Today</h2><table><thead><tr><th>Property</th><th>Check-in</th><th>Check-out</th><th>Guest</th><th>Status</th></tr></thead><tbody>${activeRows || '<tr><td colspan="5" style="text-align:center;padding:32px;color:#94a3b8">No active stays today</td></tr>'}</tbody></table></div><div class="section"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px"><h2 style="margin:0">Properties</h2><a href="/properties/new" class="btn">Add Property</a></div><table><thead><tr><th>Name</th><th>Address</th><th>iCal</th><th>Actions</th></tr></thead><tbody>${propRows || '<tr><td colspan="4" style="text-align:center;padding:32px;color:#94a3b8">No properties yet</td></tr>'}</tbody></table></div></div></body></html>`);
});

function propertyForm(property = {}, action = "/properties", method = "POST") {
  const v = (f) => property[f] ?? "";
  return `<html><head><title>${property.id ? "Edit" : "Add"} Property — ${BRAND}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;padding:32px;color:#1e293b;}.card{background:white;border-radius:16px;padding:32px;max-width:800px;margin:0 auto;box-shadow:0 1px 3px rgba(0,0,0,0.08);}h1{font-size:22px;margin-bottom:24px;}.section-title{font-size:14px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin:24px 0 12px;padding-top:16px;border-top:1px solid #e2e8f0;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}.full{grid-column:1/-1;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input,textarea,select{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;font-family:inherit;}textarea{min-height:80px;resize:vertical;}.btn-row{display:flex;gap:12px;margin-top:24px;}button{padding:12px 24px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;}a.back{font-size:14px;color:#64748b;text-decoration:none;padding:12px 0;display:inline-block;}</style></head><body><div class="card"><h1>${property.id ? "Edit Property" : "Add New Property"}</h1><form method="${method}" action="${action}"><p class="section-title">Basic info</p><div class="grid"><div><label>Property name (optional)</label><input name="name" value="${v("name")}" placeholder="Beach House"></div><div class="full"><label>Full address *</label><input name="address" value="${v("address")}" placeholder="123 Main St, Lima OH 45801" required></div></div><p class="section-title">iCal sync (from Airbnb / VRBO settings)</p><div class="grid"><div class="full"><label>iCal URL 1</label><input name="ical_url" value="${v("ical_url")}"></div><div class="full"><label>iCal URL 2 (optional)</label><input name="ical_url_2" value="${v("ical_url_2")}"></div></div><p class="section-title">Access</p><div class="grid"><div><label>Check-in time</label><input name="checkin_time" value="${v("checkin_time") || "3:00 PM"}"></div><div><label>Check-out time</label><input name="checkout_time" value="${v("checkout_time") || "11:00 AM"}"></div><div><label>Door / lockbox code</label><input name="door_code" value="${v("door_code")}"></div><div><label>Key drop-off</label><input name="key_dropoff" value="${v("key_dropoff")}"></div><div class="full"><label>Parking</label><textarea name="parking_instructions">${v("parking_instructions")}</textarea></div></div><p class="section-title">WiFi</p><div class="grid"><div><label>Network name</label><input name="wifi_name" value="${v("wifi_name")}"></div><div><label>Password</label><input name="wifi_password" value="${v("wifi_password")}"></div></div><p class="section-title">Appliances</p><div class="grid"><div class="full"><label>Thermostat</label><textarea name="thermostat_instructions">${v("thermostat_instructions")}</textarea></div><div class="full"><label>Washer / dryer</label><textarea name="washer_dryer_instructions">${v("washer_dryer_instructions")}</textarea></div><div class="full"><label>TV / streaming</label><textarea name="tv_instructions">${v("tv_instructions")}</textarea></div><div class="full"><label>Trash &amp; recycling</label><textarea name="trash_instructions">${v("trash_instructions")}</textarea></div></div><p class="section-title">House rules</p><div class="grid"><div class="full"><label>Rules</label><textarea name="house_rules">${v("house_rules")}</textarea></div><div><label>Quiet hours start (24h)</label><input name="quiet_hours_start" type="number" value="${v("quiet_hours_start") || 22}" min="0" max="23"></div><div><label>Quiet hours end (24h)</label><input name="quiet_hours_end" type="number" value="${v("quiet_hours_end") || 8}" min="0" max="23"></div></div><p class="section-title">Emergency</p><div class="grid"><div><label>Breaker box</label><input name="breaker_location" value="${v("breaker_location")}"></div><div><label>Water shutoff</label><input name="water_shutoff" value="${v("water_shutoff")}"></div><div class="full"><label>Nearest urgent care</label><input name="nearest_urgent_care" value="${v("nearest_urgent_care")}"></div></div><p class="section-title">Local recs</p><div class="grid"><div class="full"><label>Restaurants</label><textarea name="local_restaurants">${v("local_restaurants")}</textarea></div><div><label>Grocery</label><input name="local_grocery" value="${v("local_grocery")}"></div><div><label>Coffee</label><input name="local_coffee" value="${v("local_coffee")}"></div><div class="full"><label>Activities</label><textarea name="local_activities">${v("local_activities")}</textarea></div></div><p class="section-title">Extra</p><div><label>Notes</label><textarea name="extra_notes">${v("extra_notes")}</textarea></div><div class="btn-row"><button type="submit">${property.id ? "Save" : "Add Property"}</button><a href="/dashboard" class="back">Cancel</a></div></form></div></body></html>`;
}

app.get("/properties/new", checkHostAuth, (req, res) => res.send(propertyForm({}, "/properties")));

app.post("/properties", checkHostAuth, async (req, res) => {
  const host = req.currentHost;
  const b    = req.body;
  await pool.query(`
    INSERT INTO properties (host_id, name, address, ical_url, ical_url_2, wifi_name, wifi_password, door_code, checkin_time, checkout_time, parking_instructions, key_dropoff, thermostat_instructions, washer_dryer_instructions, tv_instructions, trash_instructions, house_rules, quiet_hours_start, quiet_hours_end, breaker_location, water_shutoff, nearest_urgent_care, local_restaurants, local_grocery, local_coffee, local_activities, extra_notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
  `, [host.id, b.name||null, b.address, b.ical_url||null, b.ical_url_2||null, b.wifi_name||null, b.wifi_password||null, b.door_code||null, b.checkin_time||"3:00 PM", b.checkout_time||"11:00 AM", b.parking_instructions||null, b.key_dropoff||null, b.thermostat_instructions||null, b.washer_dryer_instructions||null, b.tv_instructions||null, b.trash_instructions||null, b.house_rules||null, parseInt(b.quiet_hours_start)||22, parseInt(b.quiet_hours_end)||8, b.breaker_location||null, b.water_shutoff||null, b.nearest_urgent_care||null, b.local_restaurants||null, b.local_grocery||null, b.local_coffee||null, b.local_activities||null, b.extra_notes||null]);
  res.redirect("/dashboard");
});

app.get("/properties/:id/edit", checkHostAuth, async (req, res) => {
  const property = await getPropertyById(parseInt(req.params.id));
  if (!property || property.host_id !== req.currentHost.id) return res.redirect("/dashboard");
  res.send(propertyForm(property, `/properties/${property.id}`, "POST"));
});

app.post("/properties/:id", checkHostAuth, async (req, res) => {
  const host = req.currentHost;
  const b    = req.body;
  const id   = parseInt(req.params.id);
  await pool.query(`
    UPDATE properties SET name=$1, address=$2, ical_url=$3, ical_url_2=$4, wifi_name=$5, wifi_password=$6, door_code=$7, checkin_time=$8, checkout_time=$9, parking_instructions=$10, key_dropoff=$11, thermostat_instructions=$12, washer_dryer_instructions=$13, tv_instructions=$14, trash_instructions=$15, house_rules=$16, quiet_hours_start=$17, quiet_hours_end=$18, breaker_location=$19, water_shutoff=$20, nearest_urgent_care=$21, local_restaurants=$22, local_grocery=$23, local_coffee=$24, local_activities=$25, extra_notes=$26
    WHERE id=$27 AND host_id=$28
  `, [b.name||null, b.address, b.ical_url||null, b.ical_url_2||null, b.wifi_name||null, b.wifi_password||null, b.door_code||null, b.checkin_time||"3:00 PM", b.checkout_time||"11:00 AM", b.parking_instructions||null, b.key_dropoff||null, b.thermostat_instructions||null, b.washer_dryer_instructions||null, b.tv_instructions||null, b.trash_instructions||null, b.house_rules||null, parseInt(b.quiet_hours_start)||22, parseInt(b.quiet_hours_end)||8, b.breaker_location||null, b.water_shutoff||null, b.nearest_urgent_care||null, b.local_restaurants||null, b.local_grocery||null, b.local_coffee||null, b.local_activities||null, b.extra_notes||null, id, host.id]);
  res.redirect("/dashboard");
});

app.post("/properties/:id/sync", checkHostAuth, async (req, res) => {
  const property = await getPropertyById(parseInt(req.params.id));
  if (property && property.host_id === req.currentHost.id) await syncIcalForProperty(property);
  res.redirect("/dashboard");
});

// ─────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────
app.get("/admin/login", (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px;font-size:14px;">Incorrect.</p>' : "";
  res.send(`<html><head><title>${BRAND} Admin</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{background:white;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}h1{font-size:22px;color:#1e293b;margin-bottom:8px;}p{font-size:14px;color:#64748b;margin-bottom:28px;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input{width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;outline:none;}button{width:100%;padding:13px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;margin-top:16px;}</style></head><body><div class="card"><h1>${BRAND} Admin</h1><p>Tenario Guest Services</p>${error}<form method="POST" action="/admin/login"><label>Password</label><input type="password" name="password" autofocus><button>Sign In</button></form></div></body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader("Set-Cookie", `admin_auth=${ADMIN_PASSWORD}; Path=/; HttpOnly; Max-Age=86400`);
    res.redirect("/admin");
  } else {
    res.redirect("/admin/login?error=1");
  }
});

app.get("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_auth=; Path=/; HttpOnly; Max-Age=0");
  res.redirect("/admin/login");
});

app.get("/admin", checkAdminAuth, async (req, res) => {
  const hosts = await pool.query("SELECT * FROM hosts ORDER BY created_at DESC");
  const PLAN_PRICES = { starter: 149, growth: 299, pro: 599 };
  const mrr = hosts.rows.reduce((s, h) => s + (PLAN_PRICES[h.plan] || 0), 0);
  const arr  = mrr * 12;

  const hostRows = hosts.rows.map(h =>
    `<tr><td>${h.name}</td><td>${h.email || "-"}</td><td>${h.twilio_number}</td><td>${h.host_phone}</td><td><code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:13px">${h.dashboard_password}</code></td><td>${h.plan}</td><td>${timeAgo(h.created_at)}</td><td><form method="POST" action="/admin/hosts/${h.id}/delete" onsubmit="return confirm('Delete ${h.name}?')"><button type="submit" style="background:#ef4444;color:white;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Delete</button></form></td></tr>`
  ).join("");

  res.send(`<html><head><title>${BRAND} Admin</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;}.header{background:#1e293b;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;}.header h1{font-size:22px;}.logout{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 12px;border:1px solid #475569;border-radius:6px;}.content{padding:32px;}.section{background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}h2{font-size:18px;margin-bottom:20px;}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input,select{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;}button{padding:12px 24px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;margin-top:8px;}table{width:100%;border-collapse:collapse;}th{text-align:left;padding:12px 16px;font-size:12px;color:#64748b;text-transform:uppercase;border-bottom:1px solid #e2e8f0;}td{padding:14px 16px;font-size:14px;border-bottom:1px solid #f1f5f9;}tr:last-child td{border-bottom:none;}.mrr-banner{background:linear-gradient(135deg,#1e293b,#334155);color:white;border-radius:12px;padding:28px 32px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;}.mrr-banner .big{font-size:48px;font-weight:bold;color:#22c55e;}.mrr-banner .arr{font-size:22px;font-weight:bold;color:#94a3b8;}</style></head><body><div class="header"><h1>${BRAND} — Admin</h1><a href="/admin/logout" class="logout">Sign Out</a></div><div class="content"><div class="mrr-banner"><div><div style="font-size:13px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase">MRR</div><div class="big">$${mrr.toLocaleString()}</div><div style="font-size:14px;color:#94a3b8;margin-top:4px">${hosts.rows.length} active hosts</div></div><div style="text-align:right"><div style="font-size:13px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase">ARR</div><div class="arr">$${arr.toLocaleString()}/yr</div></div></div><div class="section"><h2>Add Host</h2><form method="POST" action="/admin/hosts"><div class="form-grid"><div><label>Host Name</label><input name="name" required></div><div><label>Email</label><input name="email" type="email"></div><div><label>Twilio Number</label><input name="twilio_number" placeholder="+15139518826" required></div><div><label>Host's Personal Cell</label><input name="host_phone" placeholder="+15551234567" required></div><div><label>Dashboard Password</label><input name="password" required></div><div><label>Plan</label><select name="plan"><option value="starter">Starter $149</option><option value="growth">Growth $299</option><option value="pro">Pro $599</option></select></div></div><button type="submit" style="margin-top:16px">Add Host</button></form></div><div class="section"><h2>All Hosts</h2><table><thead><tr><th>Name</th><th>Email</th><th>Twilio #</th><th>Host Cell</th><th>Password</th><th>Plan</th><th>Added</th><th>Actions</th></tr></thead><tbody>${hostRows || '<tr><td colspan="8" style="text-align:center;padding:40px;color:#94a3b8">No hosts yet</td></tr>'}</tbody></table></div></div><div style="margin:24px auto;max-width:960px;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.06)"><div style="font-size:16px;font-weight:700;color:#1a2332;margin-bottom:8px">&#x1F517; Onboarding Link</div><p style="font-size:14px;color:#64748b;margin-bottom:12px">Share with new hosts to set up their account and first property:</p><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><code style="background:#f1f5f9;padding:8px 14px;border-radius:6px;font-size:13px;color:#1a2332;border:1px solid #e2e8f0">https://tenant-flow-ai.com/onboarding</code><button onclick="navigator.clipboard.writeText('https://tenant-flow-ai.com/onboarding').then(function(){var b=this;b.textContent='Copied!';setTimeout(function(){b.textContent='Copy Link'},2000)}.bind(this))" style="padding:8px 16px;background:#1a2332;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Copy Link</button></div></div></body></html>`);
});

app.post("/admin/hosts", checkAdminAuth, async (req, res) => {
  const { name, email, twilio_number, host_phone, password, plan } = req.body;
  await pool.query(
    `INSERT INTO hosts (name, email, twilio_number, host_phone, dashboard_password, plan) VALUES ($1, $2, $3, $4, $5, $6)`,
    [name, email || null, twilio_number, host_phone, password, plan || "starter"]
  );
  console.log(`[ADMIN] Host added: ${name}`);
  res.redirect("/admin");
});

app.post("/admin/hosts/:id/delete", checkAdminAuth, async (req, res) => {
  await pool.query("DELETE FROM hosts WHERE id = $1", [req.params.id]);
  res.redirect("/admin");
});

// ─────────────────────────────────────────────
// SMS WEBHOOK
// ─────────────────────────────────────────────
app.get("/sms", (req, res) => res.status(200).send("SMS endpoint alive."));

app.post("/sms", async (req, res) => {
  const from = req.body.From || "";
  const to   = req.body.To   || "";
  const body = (req.body.Body || "").trim();
  console.log(`[SMS IN] From: ${from} | To: ${to} | Body: ${body}`);
  res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());

  try {
    const host = await getHostByTwilioNumber(to);
    if (!host) {
      console.error(`[SMS] No host for ${to}`);
      return;
    }
    await handleSms(host, from, body);
  } catch (err) {
    console.error("[SMS HANDLER ERROR]", err);
  }
});

app.get("/privacy", (req, res) => {
  res.send(`<html><head><title>Privacy Policy — ${BRAND}</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}h2{font-size:24px;margin-top:30px;}p{font-size:18px;}</style></head><body><h1>Privacy Policy</h1><p>${BRAND} (Tenario Guest Services) collects phone numbers and message content solely to facilitate guest-host communication during stays.</p><h2>Information We Collect</h2><p>Phone numbers, property addresses, message content, booking dates.</p><h2>How We Use It</h2><p>Solely for guest support during stays. Data is automatically deleted 30 days after checkout.</p><h2>Opt-Out</h2><p>Reply STOP at any time to opt out of all messages.</p><h2>Contact</h2><p>Questions? Email wyatt@tenario.com</p></body></html>`);
});

app.get("/terms", (req, res) => {
  res.send(`<html><head><title>Terms of Service — ${BRAND}</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}p{font-size:18px;}</style></head><body><h1>Terms of Service</h1><p>By using ${BRAND} (Tenario Guest Services), you consent to SMS messages related to your stay. Msg and data rates may apply. Reply STOP to opt out at any time. Data is retained for 30 days after checkout then permanently deleted. Contact: wyatt@tenario.com</p><div style="margin:24px auto;max-width:960px;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.06)"><div style="font-size:16px;font-weight:700;color:#1a2332;margin-bottom:8px">&#x1F517; Onboarding Link</div><p style="font-size:14px;color:#64748b;margin-bottom:12px">Share with new hosts to set up their account:</p><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><code style="background:#f1f5f9;padding:8px 14px;border-radius:6px;font-size:13px;color:#1a2332;border:1px solid #e2e8f0">https://tenant-flow-ai.com/onboarding</code><button onclick="navigator.clipboard.writeText('https://tenant-flow-ai.com/onboarding').then(function(){var b=this;b.textContent='Copied!';setTimeout(function(){b.textContent='Copy Link'},2000)}.bind(this))" style="padding:8px 16px;background:#1a2332;color:#fff;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer">Copy Link</button></div></div></body></html>`);
});

app.use((req, res) => res.status(404).send("Not Found: " + req.method + " " + req.path));

// ─────────────────────────────────────────────
// START — DB FIRST, THEN SERVER, THEN CRONS
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(port, () => console.log(`${BRAND} server running on port ${port}`));
    // Crons — start AFTER server is live
    setInterval(syncAllIcal,           60 * 60 * 1000);      // iCal sync every hour
    setInterval(sendCheckoutReminders, 15 * 60 * 1000);      // Checkout check every 15 min
    setInterval(runDataRetention,      24 * 60 * 60 * 1000); // Data retention daily
    // Initial sync after 30s
    setTimeout(syncAllIcal, 30 * 1000);
  })
  .catch(err => {
    console.error("[DB INIT FATAL]", err);
    process.exit(1);
  });
