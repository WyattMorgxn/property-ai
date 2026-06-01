import express from "express";
import nodemailer from "nodemailer";
import pg from "pg";
import * as ical from "node-ical";

const { Pool } = pg;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ─────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  // ── EXISTING TABLES ──────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS managers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      twilio_number TEXT UNIQUE NOT NULL,
      dashboard_password TEXT NOT NULL,
      plan TEXT DEFAULT 'starter',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS maintenance_contacts (
      id SERIAL PRIMARY KEY,
      manager_id INTEGER REFERENCES managers(id),
      category TEXT NOT NULL,
      name TEXT,
      phone TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      phone TEXT PRIMARY KEY,
      address TEXT,
      opted_in BOOLEAN DEFAULT true,
      opted_in_at TIMESTAMPTZ DEFAULT NOW(),
      opted_out BOOLEAN DEFAULT false,
      manager_id INTEGER REFERENCES managers(id)
    );
  `);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES managers(id)`).catch(() => {});

  await pool.query(`DROP TABLE IF EXISTS conversations CASCADE`);
  await pool.query(`
    CREATE TABLE conversations (
      phone TEXT NOT NULL,
      manager_id INTEGER REFERENCES managers(id),
      messages JSONB DEFAULT '[]',
      resolved BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (phone, manager_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      tenant_phone TEXT,
      address TEXT,
      summary TEXT,
      urgency TEXT,
      availability TEXT,
      category TEXT,
      status TEXT DEFAULT 'active',
      manager_id INTEGER REFERENCES managers(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE requests ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES managers(id)`).catch(() => {});

  // ── NEW STR TABLES ───────────────────────────

  // STR hosts — each host gets their own Twilio number (same pattern as managers)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS str_hosts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      twilio_number TEXT UNIQUE NOT NULL,
      dashboard_password TEXT NOT NULL,
      host_phone TEXT NOT NULL,
      plan TEXT DEFAULT 'starter',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Properties — each property belongs to a host, has a knowledge base
  await pool.query(`
    CREATE TABLE IF NOT EXISTS str_properties (
      id SERIAL PRIMARY KEY,
      host_id INTEGER REFERENCES str_hosts(id) ON DELETE CASCADE,
      name TEXT,
      address TEXT NOT NULL,
      address_normalized TEXT,
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

  // Bookings — populated by iCal sync
  await pool.query(`
    CREATE TABLE IF NOT EXISTS str_bookings (
      id SERIAL PRIMARY KEY,
      property_id INTEGER REFERENCES str_properties(id) ON DELETE CASCADE,
      host_id INTEGER REFERENCES str_hosts(id) ON DELETE CASCADE,
      checkin_date DATE NOT NULL,
      checkout_date DATE NOT NULL,
      guest_name TEXT,
      ical_uid TEXT,
      status TEXT DEFAULT 'upcoming',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(property_id, ical_uid)
    );
  `);

  // Guests — linked when they text in and confirm address
  await pool.query(`
    CREATE TABLE IF NOT EXISTS str_guests (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      property_id INTEGER REFERENCES str_properties(id),
      booking_id INTEGER REFERENCES str_bookings(id),
      host_id INTEGER REFERENCES str_hosts(id),
      onboarding_state TEXT DEFAULT 'awaiting_address',
      pending_property_id INTEGER,
      opted_out BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(phone, host_id)
    );
  `);

  // STR Conversations — per guest per host
  await pool.query(`
    CREATE TABLE IF NOT EXISTS str_conversations (
      id SERIAL PRIMARY KEY,
      guest_phone TEXT NOT NULL,
      host_id INTEGER REFERENCES str_hosts(id),
      property_id INTEGER REFERENCES str_properties(id),
      messages JSONB DEFAULT '[]',
      escalated BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(guest_phone, host_id)
    );
  `);

  // ── SEED EXISTING MANAGER ────────────────────
  const existing = await pool.query("SELECT id FROM managers WHERE twilio_number = $1", ["+15139518826"]);
  let wyattId;
  if (existing.rows.length === 0) {
    const res = await pool.query(`
      INSERT INTO managers (name, email, twilio_number, dashboard_password, plan)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, ["Wyatt Morgan", "wyattmorgan@tenant-flow-ai.com", "+15139518826", "Tenaro", "pro"]);
    wyattId = res.rows[0].id;
    const categories = ["plumbing", "electrical", "hvac", "structural", "pest", "security", "appliances", "general"];
    for (const cat of categories) {
      await pool.query(
        "INSERT INTO maintenance_contacts (manager_id, category, name, phone) VALUES ($1, $2, $3, $4)",
        [wyattId, cat, cat.charAt(0).toUpperCase() + cat.slice(1) + " Team", "+13308106687"]
      );
    }
  } else {
    wyattId = existing.rows[0].id;
  }

  await pool.query("UPDATE tenants SET manager_id = $1 WHERE manager_id IS NULL", [wyattId]);
  await pool.query("UPDATE conversations SET manager_id = $1 WHERE manager_id IS NULL", [wyattId]);
  await pool.query("UPDATE requests SET manager_id = $1 WHERE manager_id IS NULL", [wyattId]);

  console.log("[DB] All tables ready (tenant flow + STR)");
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
      for (const key of Object.keys(events)) {
        const ev = events[key];
        if (ev.type !== "VEVENT") continue;

        const checkin = ev.start ? new Date(ev.start).toISOString().split("T")[0] : null;
        const checkout = ev.end ? new Date(ev.end).toISOString().split("T")[0] : null;
        if (!checkin || !checkout) continue;

        const guestName = ev.summary || ev.description || null;
        const uid = ev.uid || `${property.id}-${checkin}-${checkout}`;

        await pool.query(`
          INSERT INTO str_bookings (property_id, host_id, checkin_date, checkout_date, guest_name, ical_uid, status)
          VALUES ($1, $2, $3, $4, $5, $6, 'upcoming')
          ON CONFLICT (property_id, ical_uid) DO UPDATE SET
            checkin_date = $3,
            checkout_date = $4,
            guest_name = $5,
            status = CASE
              WHEN NOW()::DATE > $4::DATE THEN 'completed'
              WHEN NOW()::DATE >= $3::DATE THEN 'active'
              ELSE 'upcoming'
            END
        `, [property.id, property.host_id, checkin, checkout, guestName, uid]);
      }
      console.log(`[ICAL SYNC] Property ${property.id} (${property.address}) synced from ${url}`);
    } catch (err) {
      console.error(`[ICAL SYNC ERROR] Property ${property.id}:`, err.message);
    }
  }
}

async function syncAllIcal() {
  const res = await pool.query("SELECT * FROM str_properties WHERE ical_url IS NOT NULL OR ical_url_2 IS NOT NULL");
  for (const property of res.rows) {
    await syncIcalForProperty(property);
  }
}

// Poll every hour
setInterval(syncAllIcal, 60 * 60 * 1000);

// ─────────────────────────────────────────────
// CHECKOUT REMINDER CRON (check every 15 min)
// ─────────────────────────────────────────────
async function sendCheckoutReminders() {
  const today = new Date().toISOString().split("T")[0];
  const hour = new Date().getHours();
  // Only send between 8am and 10am
  if (hour < 8 || hour > 10) return;

  const res = await pool.query(`
    SELECT b.*, p.address, p.checkout_time, p.key_dropoff, h.twilio_number
    FROM str_bookings b
    JOIN str_properties p ON b.property_id = p.id
    JOIN str_hosts h ON b.host_id = h.id
    WHERE b.checkout_date = $1 AND b.status = 'active'
  `, [today]);

  for (const booking of res.rows) {
    const guest = await pool.query(
      "SELECT * FROM str_guests WHERE booking_id = $1",
      [booking.id]
    );
    if (!guest.rows[0]?.phone) continue;

    const msg =
      `Good morning! Just a reminder that checkout today is at ${booking.checkout_time || "11:00 AM"}. ` +
      `${booking.key_dropoff ? `Please leave the key at: ${booking.key_dropoff}. ` : ""}` +
      `It was a pleasure having you — safe travels! Reply if you have any questions.`;

    await sendSms(guest.rows[0].phone, msg, booking.twilio_number);

    // Send review request 2 hours after checkout (schedule it)
    setTimeout(async () => {
      await sendSms(
        guest.rows[0].phone,
        `Hope you enjoyed your stay! If you have a moment, we'd love a review — it means the world to us. Thank you for choosing us!`,
        booking.twilio_number
      );
    }, 2 * 60 * 60 * 1000);

    // Mark booking completed
    await pool.query("UPDATE str_bookings SET status = 'completed' WHERE id = $1", [booking.id]);
    console.log(`[CHECKOUT REMINDER] Sent to ${guest.rows[0].phone} for ${booking.address}`);
  }
}

setInterval(sendCheckoutReminders, 15 * 60 * 1000);

// ─────────────────────────────────────────────
// STR HOST FUNCTIONS
// ─────────────────────────────────────────────
async function getStrHostByTwilioNumber(number) {
  const res = await pool.query("SELECT * FROM str_hosts WHERE twilio_number = $1", [number]);
  return res.rows[0] || null;
}

async function getStrHostById(id) {
  const res = await pool.query("SELECT * FROM str_hosts WHERE id = $1", [id]);
  return res.rows[0] || null;
}

async function getStrPropertiesByHost(hostId) {
  const res = await pool.query("SELECT * FROM str_properties WHERE host_id = $1 ORDER BY created_at DESC", [hostId]);
  return res.rows;
}

// ─────────────────────────────────────────────
// STR GUEST FUNCTIONS
// ─────────────────────────────────────────────
async function getStrGuest(phone, hostId) {
  const res = await pool.query(
    "SELECT * FROM str_guests WHERE phone = $1 AND host_id = $2",
    [phone, hostId]
  );
  return res.rows[0] || null;
}

async function upsertStrGuest(phone, hostId, data) {
  await pool.query(`
    INSERT INTO str_guests (phone, host_id, property_id, booking_id, onboarding_state, pending_property_id, opted_out)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (phone, host_id) DO UPDATE SET
      property_id = COALESCE($3, str_guests.property_id),
      booking_id = COALESCE($4, str_guests.booking_id),
      onboarding_state = COALESCE($5, str_guests.onboarding_state),
      pending_property_id = $6,
      opted_out = COALESCE($7, str_guests.opted_out)
  `, [
    phone, hostId,
    data.property_id || null,
    data.booking_id || null,
    data.onboarding_state || 'awaiting_address',
    data.pending_property_id || null,
    data.opted_out ?? false
  ]);
}

// ─────────────────────────────────────────────
// ADDRESS FUZZY MATCH
// ─────────────────────────────────────────────
function normalizeAddress(addr) {
  return addr.toLowerCase()
    .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr").replace(/\bboulevard\b/g, "blvd")
    .replace(/\blane\b/g, "ln").replace(/\broad\b/g, "rd")
    .replace(/\bapartment\b/g, "apt").replace(/\bunit\b/g, "apt")
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function addressSimilarity(a, b) {
  const na = normalizeAddress(a);
  const nb = normalizeAddress(b);
  if (na.includes(nb) || nb.includes(na)) return 1.0;
  const wordsA = new Set(na.split(" "));
  const wordsB = new Set(nb.split(" "));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

async function findActiveBookingByAddress(hostId, guestAddress) {
  const today = new Date().toISOString().split("T")[0];
  const res = await pool.query(`
    SELECT b.*, p.address, p.id as property_id
    FROM str_bookings b
    JOIN str_properties p ON b.property_id = p.id
    WHERE b.host_id = $1
      AND b.checkin_date <= $2
      AND b.checkout_date >= $2
      AND b.status IN ('upcoming', 'active')
  `, [hostId, today]);

  let bestMatch = null;
  let bestScore = 0;
  for (const booking of res.rows) {
    const score = addressSimilarity(guestAddress, booking.address);
    if (score > bestScore) { bestScore = score; bestMatch = booking; }
  }
  // Require at least 40% word overlap
  return bestScore >= 0.4 ? bestMatch : null;
}

async function getPropertyById(propertyId) {
  const res = await pool.query("SELECT * FROM str_properties WHERE id = $1", [propertyId]);
  return res.rows[0] || null;
}

// ─────────────────────────────────────────────
// STR CONVERSATION FUNCTIONS
// ─────────────────────────────────────────────
async function getStrConversation(phone, hostId) {
  const res = await pool.query(
    "SELECT * FROM str_conversations WHERE guest_phone = $1 AND host_id = $2",
    [phone, hostId]
  );
  if (res.rows[0]) return res.rows[0];
  await pool.query(`
    INSERT INTO str_conversations (guest_phone, host_id, messages)
    VALUES ($1, $2, '[]')
    ON CONFLICT (guest_phone, host_id) DO NOTHING
  `, [phone, hostId]);
  return { guest_phone: phone, host_id: hostId, messages: [], escalated: false };
}

async function addStrMessage(phone, hostId, role, content) {
  await pool.query(`
    UPDATE str_conversations SET messages = messages || $1::jsonb, updated_at = NOW()
    WHERE guest_phone = $2 AND host_id = $3
  `, [JSON.stringify([{ role, content }]), phone, hostId]);
}

async function clearStrConversation(phone, hostId) {
  await pool.query(
    "UPDATE str_conversations SET messages = '[]', escalated = false WHERE guest_phone = $1 AND host_id = $2",
    [phone, hostId]
  );
}

// ─────────────────────────────────────────────
// BUILD PROPERTY CONTEXT FOR CLAUDE
// ─────────────────────────────────────────────
function buildPropertyContext(property, booking) {
  const lines = [
    `Property address: ${property.address}`,
    `Check-in time: ${property.checkin_time || "3:00 PM"}`,
    `Check-out time: ${property.checkout_time || "11:00 AM"}`,
  ];
  if (property.door_code) lines.push(`Door code: ${property.door_code}`);
  if (property.wifi_name) lines.push(`WiFi network: ${property.wifi_name}`);
  if (property.wifi_password) lines.push(`WiFi password: ${property.wifi_password}`);
  if (property.parking_instructions) lines.push(`Parking: ${property.parking_instructions}`);
  if (property.key_dropoff) lines.push(`Key drop-off: ${property.key_dropoff}`);
  if (property.thermostat_instructions) lines.push(`Thermostat: ${property.thermostat_instructions}`);
  if (property.washer_dryer_instructions) lines.push(`Washer/dryer: ${property.washer_dryer_instructions}`);
  if (property.tv_instructions) lines.push(`TV/streaming: ${property.tv_instructions}`);
  if (property.trash_instructions) lines.push(`Trash: ${property.trash_instructions}`);
  if (property.house_rules) lines.push(`House rules: ${property.house_rules}`);
  if (property.breaker_location) lines.push(`Breaker box location: ${property.breaker_location}`);
  if (property.water_shutoff) lines.push(`Water shutoff: ${property.water_shutoff}`);
  if (property.nearest_urgent_care) lines.push(`Nearest urgent care: ${property.nearest_urgent_care}`);
  if (property.local_restaurants) lines.push(`Local restaurants: ${property.local_restaurants}`);
  if (property.local_grocery) lines.push(`Grocery store: ${property.local_grocery}`);
  if (property.local_coffee) lines.push(`Coffee shop: ${property.local_coffee}`);
  if (property.local_activities) lines.push(`Things to do nearby: ${property.local_activities}`);
  if (property.extra_notes) lines.push(`Additional notes: ${property.extra_notes}`);
  if (booking) {
    lines.push(`Guest check-out date: ${booking.checkout_date}`);
    if (booking.guest_name) lines.push(`Guest name from booking: ${booking.guest_name}`);
  }
  return lines.join("\n");
}

function isQuietHours(property) {
  const hour = new Date().getHours();
  const start = property.quiet_hours_start ?? 22;
  const end = property.quiet_hours_end ?? 8;
  if (start > end) return hour >= start || hour < end;
  return hour >= start && hour < end;
}

function isEmergency(text) {
  const lower = text.toLowerCase();
  const keywords = ["gas leak", "gas smell", "fire", "flooding", "flood", "electrical fire",
    "smoke", "carbon monoxide", "no heat", "locked out", "break in", "intruder"];
  return keywords.some(k => lower.includes(k));
}

// ─────────────────────────────────────────────
// ESCALATE TO HOST
// ─────────────────────────────────────────────
async function escalateToHost(host, guestPhone, property, issue, isEmerg) {
  const msg =
    `GUEST ALERT${isEmerg ? " - EMERGENCY" : ""}\n` +
    `Property: ${property.address}\n` +
    `Guest Phone: ${guestPhone}\n` +
    `Issue: ${issue}\n\n` +
    `Reply to this number to respond — your reply will be forwarded to the guest automatically.`;

  await sendSms(host.host_phone, msg, host.twilio_number);
  await pool.query(
    "UPDATE str_conversations SET escalated = true WHERE guest_phone = $1 AND host_id = $2",
    [guestPhone, host.id]
  );
  console.log(`[STR ESCALATE] ${isEmerg ? "EMERGENCY " : ""}Host ${host.name} alerted for ${guestPhone} at ${property.address}`);

  // If no reply in 30 min, notify guest
  if (!isEmerg) {
    setTimeout(async () => {
      const convo = await getStrConversation(guestPhone, host.id);
      if (convo.escalated) {
        await sendSms(guestPhone,
          "We've passed your request to the host and are waiting to hear back. We'll update you as soon as we get a response.",
          host.twilio_number
        );
      }
    }, 30 * 60 * 1000);
  }
}

// ─────────────────────────────────────────────
// CLAUDE STR — AI RESOLUTION
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function buildStrSystemPrompt(property, booking) {
  const context = buildPropertyContext(property, booking);
  return `You are an AI host assistant for a short-term rental property. You help guests with questions and issues during their stay via SMS. Keep all replies SHORT — this is SMS.

PROPERTY KNOWLEDGE BASE:
${context}

YOUR RESOLUTION APPROACH:
1. FIRST check if the answer is in the property knowledge base above. If yes, answer directly and concisely.
2. If not in the knowledge base, try to troubleshoot using general knowledge (appliance fixes, common issues).
3. If you cannot resolve it after trying, say you are escalating to the host and end your reply with exactly: ESCALATE|<one sentence summary of the issue>
4. For EMERGENCIES (gas, fire, flooding, carbon monoxide), respond with safety instructions AND end your reply with: EMERGENCY|<one sentence summary>

TONE: Warm, helpful, like a knowledgeable friend. Never robotic.
LANGUAGE: Auto-detect and reply in the guest's language.
LENGTH: 1-3 sentences max per SMS reply.

IMPORTANT: Never make up information not in the knowledge base. If unsure, escalate.`;
}

async function processStrMessage(host, guestPhone, message, property, booking) {
  try {
    await addStrMessage(guestPhone, host.id, "user", message);
    const convo = await getStrConversation(guestPhone, host.id);

    // Use web search tool for things not in knowledge base
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: buildStrSystemPrompt(property, booking),
        messages: convo.messages,
        tools: [{
          type: "web_search_20250305",
          name: "web_search"
        }]
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("[CLAUDE STR ERROR]", data);
      await sendSms(guestPhone, "Sorry, I ran into an issue. Let me get the host for you.", host.twilio_number);
      await escalateToHost(host, guestPhone, property, "System error — guest needs help", false);
      return;
    }

    // Extract text from response (may include tool use blocks)
    const rawReply = data.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("") || "";

    await addStrMessage(guestPhone, host.id, "assistant", rawReply);

    // Check for escalation signal
    const emergMatch = rawReply.match(/EMERGENCY\|(.+)/);
    const escalateMatch = rawReply.match(/ESCALATE\|(.+)/);

    const cleanReply = rawReply
      .replace(/\nEMERGENCY\|[^\n]*/g, "")
      .replace(/\nESCALATE\|[^\n]*/g, "")
      .trim();

    await sendSms(guestPhone, cleanReply || "Let me get the host for you right away.", host.twilio_number);

    if (emergMatch) {
      await escalateToHost(host, guestPhone, property, emergMatch[1].trim(), true);
    } else if (escalateMatch) {
      // Respect quiet hours for non-emergency escalations
      if (isQuietHours(property)) {
        await sendSms(guestPhone,
          `The host has been notified and will follow up first thing in the morning. If this is an emergency, please call ${host.host_phone} directly.`,
          host.twilio_number
        );
        // Queue for morning
        const msUntilMorning = getMillisUntilHour(property.quiet_hours_end ?? 8);
        setTimeout(() => escalateToHost(host, guestPhone, property, escalateMatch[1].trim(), false), msUntilMorning);
      } else {
        await escalateToHost(host, guestPhone, property, escalateMatch[1].trim(), false);
      }
    }
  } catch (err) {
    console.error("[CLAUDE STR EXCEPTION]", err);
    await sendSms(guestPhone, "Sorry, something went wrong. I'll get the host to reach out to you directly.", host.twilio_number);
  }
}

function getMillisUntilHour(targetHour) {
  const now = new Date();
  const target = new Date();
  target.setHours(targetHour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

// ─────────────────────────────────────────────
// STR SMS FLOW
// ─────────────────────────────────────────────
async function handleStrSms(host, from, body) {
  const lower = body.toLowerCase().trim();

  // Opt-out
  if (["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(lower)) {
    await pool.query("UPDATE str_guests SET opted_out = true WHERE phone = $1 AND host_id = $2", [from, host.id]);
    return;
  }

  // Check if host is replying to escalation (host_phone texting in)
  if (from === host.host_phone) {
    await handleHostReplyStr(host, body);
    return;
  }

  let guest = await getStrGuest(from, host.id);

  // ── NEW GUEST ──────────────────────────────
  if (!guest) {
    await upsertStrGuest(from, host.id, { onboarding_state: "awaiting_address" });
    await sendSms(from,
      `Hi! I'm your AI host assistant. To get started, what's the address of the property you're staying at?`,
      host.twilio_number
    );
    return;
  }

  if (guest.opted_out) return;

  // ── RETURNING GUEST — check if they have an active booking ───────────
  if (guest.onboarding_state === "linked" && guest.booking_id) {
    const booking = await pool.query("SELECT * FROM str_bookings WHERE id = $1", [guest.booking_id]);
    const bk = booking.rows[0];
    const today = new Date().toISOString().split("T")[0];

    // Booking over — check if they have a new active booking
    if (bk && bk.checkout_date < today) {
      const newBooking = await findActiveBookingByAddress(host.id,
        (await getPropertyById(guest.property_id))?.address || ""
      );
      if (newBooking) {
        await upsertStrGuest(from, host.id, {
          booking_id: newBooking.id,
          property_id: newBooking.property_id,
          onboarding_state: "linked"
        });
        await clearStrConversation(from, host.id);
        guest = await getStrGuest(from, host.id);
      } else {
        await sendSms(from,
          `Hi! Your previous stay has ended. If you have a new booking, please text the address you're staying at and I'll get you set up.`,
          host.twilio_number
        );
        await upsertStrGuest(from, host.id, { onboarding_state: "awaiting_address", property_id: null, booking_id: null });
        return;
      }
    }

    // Active linked guest — process with Claude
    if (guest.onboarding_state === "linked") {
      const property = await getPropertyById(guest.property_id);
      const booking2 = await pool.query("SELECT * FROM str_bookings WHERE id = $1", [guest.booking_id]);
      if (isEmergency(body)) {
        await sendSms(from,
          `This sounds like an emergency. If you're in immediate danger, call 911 first. I'm alerting your host right now.`,
          host.twilio_number
        );
        await escalateToHost(host, from, property, body, true);
        return;
      }
      processStrMessage(host, from, body, property, booking2.rows[0]);
      return;
    }
  }

  // ── AWAITING ADDRESS ─────────────────────────
  if (guest.onboarding_state === "awaiting_address") {
    const match = await findActiveBookingByAddress(host.id, body);
    if (!match) {
      await sendSms(from,
        `I couldn't find an active booking at that address. Double-check the address or contact your host directly. What address are you staying at?`,
        host.twilio_number
      );
      return;
    }
    // Found a match — ask guest to confirm
    await upsertStrGuest(from, host.id, {
      onboarding_state: "awaiting_confirmation",
      pending_property_id: match.property_id
    });
    // Store the matched booking ID temporarily
    await pool.query(
      "UPDATE str_guests SET booking_id = $1 WHERE phone = $2 AND host_id = $3",
      [match.id, from, host.id]
    );
    const property = await getPropertyById(match.property_id);
    await sendSms(from,
      `Just to confirm — are you staying at ${property.address}? Reply YES or NO.`,
      host.twilio_number
    );

    // Timeout: reset if no reply in 10 minutes
    setTimeout(async () => {
      const g = await getStrGuest(from, host.id);
      if (g?.onboarding_state === "awaiting_confirmation") {
        await upsertStrGuest(from, host.id, {
          onboarding_state: "awaiting_address",
          pending_property_id: null,
          booking_id: null
        });
        await sendSms(from,
          `We didn't hear back from you. No worries — just text the address whenever you're ready!`,
          host.twilio_number
        );
        console.log(`[STR TIMEOUT] ${from} confirmation timed out`);
      }
    }, 10 * 60 * 1000);
    return;
  }

  // ── AWAITING CONFIRMATION ────────────────────
  if (guest.onboarding_state === "awaiting_confirmation") {
    const answer = lower.replace(/[^a-z]/g, "");
    if (["yes", "yeah", "yep", "yup", "correct", "right", "y"].includes(answer)) {
      await upsertStrGuest(from, host.id, {
        onboarding_state: "linked",
        property_id: guest.pending_property_id,
        pending_property_id: null
      });
      const property = await getPropertyById(guest.pending_property_id);
      const booking = await pool.query("SELECT * FROM str_bookings WHERE id = $1", [guest.booking_id]);
      await sendSms(from,
        `Perfect, you're all set! I'm your AI host assistant for ${property.address}. Ask me anything — WiFi, check-out info, local spots, or if something needs fixing. I'm here 24/7!`,
        host.twilio_number
      );
      console.log(`[STR LINKED] ${from} linked to property ${guest.pending_property_id}`);
    } else if (["no", "nope", "n", "wrong", "incorrect"].includes(answer)) {
      await upsertStrGuest(from, host.id, {
        onboarding_state: "awaiting_address",
        pending_property_id: null,
        booking_id: null
      });
      await sendSms(from,
        `No problem! What's the address of the property you're staying at?`,
        host.twilio_number
      );
    } else {
      // Unclear answer — re-ask
      await sendSms(from,
        `Sorry, I didn't catch that. Reply YES if that's correct, or NO to try a different address.`,
        host.twilio_number
      );
    }
    return;
  }

  // Fallback
  await sendSms(from,
    `Hi! What's the address of the property you're staying at?`,
    host.twilio_number
  );
}

// ─────────────────────────────────────────────
// HOST REPLY HANDLER (STR)
// ─────────────────────────────────────────────
async function handleHostReplyStr(host, body) {
  // Find most recently escalated guest for this host
  const res = await pool.query(`
    SELECT c.guest_phone, c.property_id
    FROM str_conversations c
    WHERE c.host_id = $1 AND c.escalated = true
    ORDER BY c.updated_at DESC LIMIT 1
  `, [host.id]);

  if (!res.rows[0]) {
    await sendSms(host.host_phone, "No open escalations found.", host.twilio_number);
    return;
  }

  const { guest_phone, property_id } = res.rows[0];
  await sendSms(guest_phone, body, host.twilio_number);
  await pool.query(
    "UPDATE str_conversations SET escalated = false WHERE guest_phone = $1 AND host_id = $2",
    [guest_phone, host.id]
  );
  await sendSms(host.host_phone, `Your reply was forwarded to the guest at ${guest_phone}.`, host.twilio_number);
  console.log(`[STR HOST REPLY] Host ${host.name} replied to ${guest_phone}`);
}

// ─────────────────────────────────────────────
// MANAGER FUNCTIONS (existing)
// ─────────────────────────────────────────────
async function getManagerByTwilioNumber(number) {
  const res = await pool.query("SELECT * FROM managers WHERE twilio_number = $1", [number]);
  return res.rows[0] || null;
}

async function getManagerById(id) {
  const res = await pool.query("SELECT * FROM managers WHERE id = $1", [id]);
  return res.rows[0] || null;
}

async function getAllManagers() {
  const res = await pool.query("SELECT * FROM managers ORDER BY created_at DESC");
  return res.rows;
}

async function createManager(name, email, twilioNumber, password, plan, contacts) {
  const res = await pool.query(`
    INSERT INTO managers (name, email, twilio_number, dashboard_password, plan)
    VALUES ($1, $2, $3, $4, $5) RETURNING id
  `, [name, email, twilioNumber, password, plan]);
  const managerId = res.rows[0].id;
  const categories = ["plumbing", "electrical", "hvac", "structural", "pest", "security", "appliances", "general"];
  for (const cat of categories) {
    const phone = contacts[cat] || contacts.default || "+13308106687";
    await pool.query(
      "INSERT INTO maintenance_contacts (manager_id, category, name, phone) VALUES ($1, $2, $3, $4)",
      [managerId, cat, cat.charAt(0).toUpperCase() + cat.slice(1) + " Team", phone]
    );
  }
  return managerId;
}

async function getManagerStats(managerId) {
  const res = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'active') as active,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE urgency = 'EMERGENCY') as emergencies
    FROM requests WHERE manager_id = $1
  `, [managerId]);
  return res.rows[0];
}

// ─────────────────────────────────────────────
// MAINTENANCE CONTACT FUNCTIONS (existing)
// ─────────────────────────────────────────────
const ISSUE_KEYWORDS = {
  plumbing:   ["leak", "leaking", "pipe", "drain", "toilet", "sink", "faucet", "water heater", "clog", "clogged", "flood", "flooding", "sewage", "water"],
  electrical: ["electric", "electrical", "outlet", "breaker", "power", "light", "lights", "wiring", "spark", "shock", "circuit", "fuse"],
  hvac:       ["heat", "heating", "ac", "air conditioning", "hvac", "furnace", "thermostat", "vent", "ventilation", "cold", "hot", "temperature"],
  structural: ["door", "window", "wall", "floor", "ceiling", "roof", "crack", "hole", "broken", "damage", "structural", "stairs", "railing"],
  pest:       ["bug", "bugs", "pest", "roach", "cockroach", "mouse", "mice", "rat", "rats", "ant", "ants", "spider", "insect", "rodent", "termite"],
  security:   ["lock", "locks", "key", "keys", "entry", "door lock", "deadbolt", "security", "locked out", "break in", "broken lock"],
  appliances: ["stove", "oven", "fridge", "refrigerator", "washer", "dryer", "dishwasher", "microwave", "appliance", "garbage disposal"],
};

async function getMaintenanceContact(managerId, summary) {
  const lower = summary.toLowerCase();
  let category = "general";
  for (const [cat, keywords] of Object.entries(ISSUE_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) { category = cat; break; }
  }
  const res = await pool.query(
    "SELECT * FROM maintenance_contacts WHERE manager_id = $1 AND category = $2",
    [managerId, category]
  );
  if (res.rows[0]) return { category, ...res.rows[0] };
  const fallback = await pool.query(
    "SELECT * FROM maintenance_contacts WHERE manager_id = $1 AND category = 'general'",
    [managerId]
  );
  return { category: "general", ...fallback.rows[0] };
}

async function getAllMaintenancePhones(managerId) {
  const res = await pool.query("SELECT DISTINCT phone FROM maintenance_contacts WHERE manager_id = $1", [managerId]);
  return new Set(res.rows.map(r => r.phone));
}

// ─────────────────────────────────────────────
// TENANT FUNCTIONS (existing)
// ─────────────────────────────────────────────
async function getTenant(phone, managerId) {
  const res = await pool.query("SELECT * FROM tenants WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  return res.rows[0] || null;
}

async function upsertTenant(phone, managerId, data) {
  await pool.query(`
    INSERT INTO tenants (phone, manager_id, address, opted_in, opted_in_at, opted_out)
    VALUES ($1, $2, $3, $4, NOW(), $5)
    ON CONFLICT (phone) DO UPDATE SET
      address = COALESCE($3, tenants.address),
      opted_in = COALESCE($4, tenants.opted_in),
      opted_out = COALESCE($5, tenants.opted_out),
      manager_id = $2
  `, [phone, managerId, data.address || null, data.opted_in ?? true, data.opted_out ?? false]);
}

async function saveAddress(phone, managerId, address) {
  await pool.query("UPDATE tenants SET address = $1 WHERE phone = $2 AND manager_id = $3", [address, phone, managerId]);
}

async function isOptedOut(phone, managerId) {
  const tenant = await getTenant(phone, managerId);
  return tenant?.opted_out === true;
}

async function isFirstTimeTexter(phone, managerId) {
  const tenant = await getTenant(phone, managerId);
  return !tenant;
}

async function recordOptIn(phone, managerId) {
  await upsertTenant(phone, managerId, { opted_in: true, opted_out: false });
}

async function recordOptOut(phone, managerId) {
  await pool.query("UPDATE tenants SET opted_out = true WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
}

async function getTenantByAddress(managerId, addressFragment) {
  const res = await pool.query(
    "SELECT * FROM tenants WHERE manager_id = $1 AND LOWER(address) LIKE $2 AND opted_out = false",
    [managerId, `%${addressFragment.toLowerCase()}%`]
  );
  return res.rows[0] || null;
}

// ─────────────────────────────────────────────
// CONVERSATION FUNCTIONS (existing)
// ─────────────────────────────────────────────
async function getConversation(phone, managerId) {
  const res = await pool.query("SELECT * FROM conversations WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  if (res.rows[0]) return res.rows[0];
  await pool.query(`
    INSERT INTO conversations (phone, manager_id, messages, resolved)
    VALUES ($1, $2, '[]', false)
    ON CONFLICT (phone, manager_id) DO NOTHING
  `, [phone, managerId]);
  return { phone, manager_id: managerId, messages: [], resolved: false };
}

async function addMessage(phone, managerId, role, content) {
  await pool.query(`
    UPDATE conversations SET messages = messages || $1::jsonb, updated_at = NOW()
    WHERE phone = $2 AND manager_id = $3
  `, [JSON.stringify([{ role, content }]), phone, managerId]);
}

async function markResolved(phone, managerId) {
  await pool.query("UPDATE conversations SET resolved = true, updated_at = NOW() WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  setTimeout(async () => {
    await pool.query("UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
  }, 24 * 60 * 60 * 1000);
}

async function isResolved(phone, managerId) {
  const convo = await getConversation(phone, managerId);
  return convo.resolved;
}

async function clearConversation(phone, managerId) {
  await pool.query("UPDATE conversations SET messages = '[]', resolved = false WHERE phone = $1 AND manager_id = $2", [phone, managerId]);
}

// ─────────────────────────────────────────────
// REQUEST FUNCTIONS (existing)
// ─────────────────────────────────────────────
async function saveRequest(managerId, tenantPhone, address, summary, urgency, availability, category) {
  const res = await pool.query(`
    INSERT INTO requests (manager_id, tenant_phone, address, summary, urgency, availability, category, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING id
  `, [managerId, tenantPhone, address, summary, urgency, availability, category]);
  return res.rows[0].id;
}

async function updateRequestStatus(managerId, address, status) {
  await pool.query(`
    UPDATE requests SET status = $1, updated_at = NOW()
    WHERE manager_id = $2 AND LOWER(address) LIKE $3 AND status = 'active'
  `, [status, managerId, `%${address.toLowerCase()}%`]);
}

async function getRequestsByManager(managerId) {
  const res = await pool.query("SELECT * FROM requests WHERE manager_id = $1 ORDER BY created_at DESC", [managerId]);
  return res.rows;
}

async function markRequestDone(id) {
  await pool.query("UPDATE requests SET status = 'completed', updated_at = NOW() WHERE id = $1", [id]);
}

// ─────────────────────────────────────────────
// COMPLIANCE MESSAGES (existing)
// ─────────────────────────────────────────────
const OPT_IN_CONFIRMATION =
  "Welcome to Tenant Flow AI! By texting this number you consent to receive " +
  "conversational SMS messages for maintenance requests, scheduling updates, and " +
  "property management communication. Msg frequency varies. Msg and data rates may " +
  "apply. Reply STOP to opt out at any time or HELP for assistance.";

const HELP_REPLY =
  "Tenant Flow AI Help: Text us to report maintenance issues and we will route " +
  "your request to the right person. Msg and data rates may apply. Reply STOP to " +
  "opt out. Support: wyattmorgan@tenant-flow-ai.com";

const STOP_KEYWORDS  = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_KEYWORDS = new Set(["START", "UNSTOP", "YES"]);

// ─────────────────────────────────────────────
// TWILIO
// ─────────────────────────────────────────────
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

async function sendSms(to, message, fromNumber) {
  const from = fromNumber || TWILIO_PHONE_NUMBER;
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const body = new URLSearchParams({ To: to, From: from, Body: message });
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await response.json();
  if (!response.ok) console.error("[TWILIO ERROR]", data);
  else console.log(`[SMS SENT] to ${to} from ${from}`);
}

// ─────────────────────────────────────────────
// EMAIL (existing)
// ─────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", port: 587, secure: false,
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

transporter.verify(err => {
  if (err) console.error("[EMAIL VERIFY ERROR]", err.message);
  else console.log("[EMAIL READY] Gmail connection verified");
});

async function sendEmail(to, subject, body) {
  try {
    await transporter.sendMail({ from: `"Tenant Flow AI" <${GMAIL_USER}>`, to, subject, text: body });
    console.log(`[EMAIL SENT] to ${to}`);
  } catch (err) {
    console.error("[EMAIL ERROR]", err.message);
  }
}

// ─────────────────────────────────────────────
// NOTIFY MAINTENANCE (existing)
// ─────────────────────────────────────────────
async function notifyMaintenance(manager, tenantPhone, summary, urgency, availability, address) {
  const contact = await getMaintenanceContact(manager.id, summary);
  await saveRequest(manager.id, tenantPhone, address, summary, urgency, availability, contact.category);

  const smsMessage =
    `TENANT FLOW AI - NEW JOB\nCategory: ${contact.category.toUpperCase()}\nUrgency: ${urgency}\n` +
    `Property: ${address}\nTenant Phone: ${tenantPhone}\nAvailability: ${availability}\nIssue: ${summary}\n\n` +
    `Reply: Done <address>, Scheduled <address>, On my way <address>, or Unavailable <address>`;

  const emailBody =
    `New Maintenance Job\n\nCategory: ${contact.category.toUpperCase()}\nProperty: ${address}\n` +
    `Tenant Phone: ${tenantPhone}\nUrgency: ${urgency}\nAvailability: ${availability}\n\nIssue:\n${summary}\n\n---\nTenant Flow AI`;

  await Promise.all([
    sendSms(contact.phone, smsMessage, manager.twilio_number),
    sendEmail(manager.email || GMAIL_USER, `[${urgency}] ${contact.category.toUpperCase()} - ${address}`, emailBody),
  ]);
}

// ─────────────────────────────────────────────
// MAINTENANCE REPLY HANDLER (existing)
// ─────────────────────────────────────────────
const STATUS_KEYWORDS = {
  done:        ["done", "completed", "complete", "finished", "fixed", "resolved"],
  scheduled:   ["scheduled", "confirmed", "booked", "appointment set"],
  onmyway:     ["on my way", "on the way", "heading over", "coming now", "be there"],
  unavailable: ["unavailable", "cant make it", "can't make it", "rescheduling", "reschedule"],
};

function detectStatusKeyword(body) {
  const lower = body.toLowerCase();
  for (const [status, keywords] of Object.entries(STATUS_KEYWORDS)) {
    if (keywords.some(k => lower.startsWith(k))) return status;
  }
  return null;
}

function extractAddress(body) {
  for (const keywords of Object.values(STATUS_KEYWORDS)) {
    for (const kw of keywords) {
      if (body.toLowerCase().startsWith(kw)) return body.slice(kw.length).trim();
    }
  }
  return body.trim().split(/\s+/).slice(1).join(" ").trim();
}

async function handleMaintenanceReply(manager, from, body) {
  const status = detectStatusKeyword(body);
  if (!status) {
    await sendSms(from, "To update a job, text: Done <address>, Scheduled <address>, On my way <address>, or Unavailable <address>.", manager.twilio_number);
    return;
  }
  const address = extractAddress(body);
  if (!address) {
    await sendSms(from, "Please include the property address. Example: Done 111 Woodlawn Lima Ohio", manager.twilio_number);
    return;
  }
  const tenant = await getTenantByAddress(manager.id, address);
  if (!tenant) {
    await sendSms(from, `Could not find a tenant at "${address}". Please check the address and try again.`, manager.twilio_number);
    return;
  }
  const dbStatus = status === "done" ? "completed" : status === "onmyway" ? "active" : status;
  await updateRequestStatus(manager.id, address, dbStatus);
  let tenantMessage = "";
  if (status === "done") tenantMessage = `Good news! Your maintenance issue at ${tenant.address} has been resolved. Reply if you have any further concerns. Reply STOP to opt out or HELP for assistance.`;
  else if (status === "scheduled") tenantMessage = `Your maintenance appointment at ${tenant.address} has been scheduled. Your technician will contact you to confirm the exact time. Reply STOP to opt out or HELP for assistance.`;
  else if (status === "onmyway") tenantMessage = `Your technician is on the way to ${tenant.address}! Please make sure someone is available. Reply STOP to opt out or HELP for assistance.`;
  else if (status === "unavailable") tenantMessage = `We are working on rescheduling your visit at ${tenant.address}. We will follow up shortly. Reply STOP to opt out or HELP for assistance.`;
  await sendSms(tenant.phone, tenantMessage, manager.twilio_number);
  await sendSms(from, `Got it! Tenant at ${tenant.address} has been notified.`, manager.twilio_number);
}

// ─────────────────────────────────────────────
// CLAUDE AI (existing tenant flow)
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Tenant Flow AI, a friendly AI property management assistant that helps tenants submit maintenance requests via SMS.

Your goal is to collect all the information needed to dispatch the right maintenance person in as few messages as possible. Keep messages short since this is SMS.

CONVERSATION FLOW:
1. When a tenant first describes an issue, acknowledge it warmly.
2. If they have not provided their unit address yet, ask for it naturally (e.g. "Got it! What is your unit address so we can send someone out?")
3. Once you have the address, ask about their availability.
4. Once you have the issue, address, and availability — confirm and tell them the right person will reach out shortly.
5. One question per message maximum.

URGENCY LEVELS:
- EMERGENCY: gas leak, flooding, no heat in winter, electrical hazard → dispatch immediately, skip availability question
- URGENT: no hot water, broken lock, major appliance failure → someone will follow up within a few hours
- ROUTINE: minor repairs, cosmetic issues → scheduled within 1-2 business days

WHEN YOU HAVE ENOUGH INFO:
Send a warm confirmation like "You are all set! We are sending a technician your way. They will reach out to you directly at this number to confirm the appointment. Reply STOP to opt out or HELP for assistance."

Then on the very last line write exactly:
RESOLVED|URGENCY:<level>|SUMMARY:<one sentence summary>|AVAILABILITY:<their availability>|ADDRESS:<their address>

Example: RESOLVED|URGENCY:ROUTINE|SUMMARY:Leaking kitchen sink|AVAILABILITY:Tomorrow morning|ADDRESS:324 Warner St Apt 2 Cincinnati OH

For EMERGENCY: RESOLVED|URGENCY:EMERGENCY|SUMMARY:<issue>|AVAILABILITY:ASAP|ADDRESS:<address or Unknown>

Never make up technician names or exact times. Always end visible messages with "Reply STOP to opt out or HELP for assistance."`;

function parseResolution(text) {
  const match = text.match(/RESOLVED\|URGENCY:(\w+)\|SUMMARY:([^|]+)\|AVAILABILITY:([^|]+)\|ADDRESS:(.+)/);
  if (!match) return null;
  return { urgency: match[1].toUpperCase(), summary: match[2].trim(), availability: match[3].trim(), address: match[4].trim() };
}

function stripResolutionLine(text) {
  return text.replace(/\nRESOLVED\|URGENCY:[^\n]+/g, "").trim();
}

async function processWithClaude(manager, tenantPhone, message) {
  try {
    await addMessage(tenantPhone, manager.id, "user", message);
    const convo = await getConversation(tenantPhone, manager.id);
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, system: SYSTEM_PROMPT, messages: convo.messages }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("[CLAUDE ERROR]", data);
      await sendSms(tenantPhone, "We received your message and will follow up shortly. Reply STOP to opt out or HELP for assistance.", manager.twilio_number);
      return;
    }
    const rawReply = data.content[0].text;
    const resolution = parseResolution(rawReply);
    const reply = stripResolutionLine(rawReply);
    await addMessage(tenantPhone, manager.id, "assistant", rawReply);
    await sendSms(tenantPhone, reply, manager.twilio_number);
    if (resolution) {
      if (resolution.address && resolution.address !== "Unknown") await saveAddress(tenantPhone, manager.id, resolution.address);
      await markResolved(tenantPhone, manager.id);
      await notifyMaintenance(manager, tenantPhone, resolution.summary, resolution.urgency, resolution.availability, resolution.address);
    }
  } catch (err) {
    console.error("[CLAUDE EXCEPTION]", err);
    await sendSms(tenantPhone, "We received your message and will follow up shortly. Reply STOP to opt out or HELP for assistance.", manager.twilio_number);
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function twimlResponse(msg) { return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + msg + '</Message></Response>'; }
function emptyTwiml() { return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'; }
function urgencyColor(u) { return u === "EMERGENCY" ? "#ef4444" : u === "URGENT" ? "#f97316" : "#22c55e"; }
function statusColor(s) { return s === "completed" ? "#22c55e" : s === "scheduled" ? "#3b82f6" : s === "unavailable" ? "#ef4444" : "#f97316"; }
function timeAgo(date) {
  const s = Math.floor((new Date() - new Date(date)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ─────────────────────────────────────────────
// COOKIE PARSER
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  req.cookies = {};
  const h = req.headers.cookie;
  if (h) h.split(";").forEach(c => { const [k, v] = c.trim().split("="); req.cookies[k] = v; });
  next();
});

app.use((req, res, next) => {
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + req.path);
  next();
});

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "F@tboyPenny2005";

function checkAdminAuth(req, res, next) {
  if (req.cookies?.admin_auth === ADMIN_PASSWORD) return next();
  res.redirect("/admin/login");
}

async function checkManagerAuth(req, res, next) {
  const managerId = req.cookies?.manager_id;
  const managerPass = req.cookies?.manager_pass;
  if (!managerId) return res.redirect("/dashboard/login");
  const manager = await getManagerById(parseInt(managerId));
  if (!manager || manager.dashboard_password !== managerPass) return res.redirect("/dashboard/login");
  req.manager = manager;
  next();
}

async function checkStrHostAuth(req, res, next) {
  const hostId = req.cookies?.str_host_id;
  const hostPass = req.cookies?.str_host_pass;
  if (!hostId) return res.redirect("/str/login");
  const host = await getStrHostById(parseInt(hostId));
  if (!host || host.dashboard_password !== hostPass) return res.redirect("/str/login");
  req.strHost = host;
  next();
}

// ─────────────────────────────────────────────
// STR HOST LOGIN
// ─────────────────────────────────────────────
app.get("/str/login", (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px;font-size:14px;">Incorrect credentials.</p>' : "";
  res.send(`<html><head><title>Host Login — STR</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{background:white;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}h1{font-size:22px;color:#1e293b;margin-bottom:8px;}p{font-size:14px;color:#64748b;margin-bottom:28px;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input{width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;outline:none;margin-bottom:16px;}button{width:100%;padding:13px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;}</style></head><body><div class="card"><h1>Host Dashboard</h1><p>STR Guest Experience — Host Login</p>${error}<form method="POST" action="/str/login"><label>Phone Number (your Twilio number)</label><input name="twilio_number" placeholder="+15551234567"><label>Password</label><input type="password" name="password" autofocus><button>Sign In</button></form></div></body></html>`);
});

app.post("/str/login", async (req, res) => {
  const { twilio_number, password } = req.body;
  const host = await getStrHostByTwilioNumber(twilio_number);
  if (host && host.dashboard_password === password) {
    res.setHeader("Set-Cookie", [
      `str_host_id=${host.id}; Path=/; HttpOnly; Max-Age=86400`,
      `str_host_pass=${password}; Path=/; HttpOnly; Max-Age=86400`
    ]);
    res.redirect("/str/dashboard");
  } else {
    res.redirect("/str/login?error=1");
  }
});

app.get("/str/logout", (req, res) => {
  res.setHeader("Set-Cookie", ["str_host_id=; Path=/; HttpOnly; Max-Age=0", "str_host_pass=; Path=/; HttpOnly; Max-Age=0"]);
  res.redirect("/str/login");
});

// ─────────────────────────────────────────────
// STR HOST DASHBOARD
// ─────────────────────────────────────────────
app.get("/str/dashboard", checkStrHostAuth, async (req, res) => {
  const host = req.strHost;
  const properties = await getStrPropertiesByHost(host.id);

  const today = new Date().toISOString().split("T")[0];
  const activeBookings = await pool.query(`
    SELECT b.*, p.address, p.name as property_name
    FROM str_bookings b
    JOIN str_properties p ON b.property_id = p.id
    WHERE b.host_id = $1 AND b.checkin_date <= $2 AND b.checkout_date >= $2
    ORDER BY b.checkout_date ASC
  `, [host.id, today]);

  const escalations = await pool.query(`
    SELECT c.*, p.address
    FROM str_conversations c
    LEFT JOIN str_properties p ON c.property_id = p.id
    WHERE c.host_id = $1 AND c.escalated = true
    ORDER BY c.updated_at DESC
  `, [host.id]);

  const activeRows = activeBookings.rows.map(b => `
    <tr>
      <td>${b.property_name || b.address}</td>
      <td>${b.checkin_date}</td>
      <td>${b.checkout_date}</td>
      <td>${b.guest_name || "—"}</td>
      <td><span style="background:#22c55e;color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">${b.status}</span></td>
    </tr>
  `).join("");

  const escalationRows = escalations.rows.map(e => `
    <tr>
      <td>${e.address || "Unknown"}</td>
      <td>${e.guest_phone}</td>
      <td>${timeAgo(e.updated_at)}</td>
      <td><span style="background:#ef4444;color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">Open</span></td>
    </tr>
  `).join("");

  const propRows = properties.map(p => `
    <tr>
      <td>${p.name || p.address}</td>
      <td style="font-size:12px;color:#64748b">${p.address}</td>
      <td>${p.ical_url ? '<span style="color:#22c55e;font-weight:bold">Yes</span>' : '<span style="color:#94a3b8">No</span>'}</td>
      <td style="display:flex;gap:6px">
        <a href="/str/properties/${p.id}/edit" style="background:#3b82f6;color:white;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:bold;text-decoration:none">Edit</a>
        <form method="POST" action="/str/properties/${p.id}/sync" style="display:inline">
          <button type="submit" style="background:#8b5cf6;color:white;border:none;padding:4px 12px;border-radius:6px;font-size:12px;font-weight:bold;cursor:pointer">Sync iCal</button>
        </form>
      </td>
    </tr>
  `).join("");

  res.send(`
    <html><head><title>STR Dashboard — ${host.name}</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;}
    .header{background:#1e293b;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;}
    .header h1{font-size:20px;}.logout{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 12px;border:1px solid #475569;border-radius:6px;}
    .content{padding:32px;}.section{background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    h2{font-size:17px;margin-bottom:16px;font-weight:700;}
    table{width:100%;border-collapse:collapse;}
    th{text-align:left;padding:10px 14px;font-size:12px;color:#64748b;text-transform:uppercase;border-bottom:1px solid #e2e8f0;}
    td{padding:12px 14px;font-size:14px;border-bottom:1px solid #f1f5f9;}tr:last-child td{border-bottom:none;}
    .stat-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;}
    .stat{background:white;border-radius:12px;padding:20px 24px;flex:1;min-width:120px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    .stat .num{font-size:28px;font-weight:bold;}.stat .label{font-size:12px;color:#64748b;margin-top:4px;}
    .btn{display:inline-block;padding:10px 20px;background:#1e293b;color:white;border-radius:8px;font-size:13px;font-weight:bold;text-decoration:none;border:none;cursor:pointer;}
    </style><meta http-equiv="refresh" content="60"></head><body>
    <div class="header">
      <h1>STR Dashboard — ${host.name}</h1>
      <a href="/str/logout" class="logout">Sign Out</a>
    </div>
    <div class="content">
      <div class="stat-row">
        <div class="stat"><div class="num">${properties.length}</div><div class="label">Properties</div></div>
        <div class="stat"><div class="num" style="color:#22c55e">${activeBookings.rows.length}</div><div class="label">Active Stays</div></div>
        <div class="stat"><div class="num" style="color:#ef4444">${escalations.rows.length}</div><div class="label">Open Escalations</div></div>
      </div>

      ${escalations.rows.length > 0 ? `
      <div class="section">
        <h2 style="color:#ef4444">Open Escalations</h2>
        <table>
          <thead><tr><th>Property</th><th>Guest Phone</th><th>Since</th><th>Status</th></tr></thead>
          <tbody>${escalationRows}</tbody>
        </table>
        <p style="font-size:13px;color:#64748b;margin-top:12px">Reply from your host phone (${host.host_phone}) to respond — your reply is auto-forwarded to the guest.</p>
      </div>` : ""}

      <div class="section">
        <h2>Active Stays Today</h2>
        <table>
          <thead><tr><th>Property</th><th>Check-in</th><th>Check-out</th><th>Guest</th><th>Status</th></tr></thead>
          <tbody>${activeRows || '<tr><td colspan="5" style="text-align:center;padding:32px;color:#94a3b8">No active stays today</td></tr>'}</tbody>
        </table>
      </div>

      <div class="section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <h2 style="margin:0">Properties</h2>
          <a href="/str/properties/new" class="btn">Add Property</a>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Address</th><th>iCal Synced</th><th>Actions</th></tr></thead>
          <tbody>${propRows || '<tr><td colspan="4" style="text-align:center;padding:32px;color:#94a3b8">No properties yet — add one above</td></tr>'}</tbody>
        </table>
      </div>
    </div></body></html>
  `);
});

// ─────────────────────────────────────────────
// STR PROPERTY MANAGEMENT
// ─────────────────────────────────────────────
function propertyForm(property = {}, action = "/str/properties", method = "POST") {
  const v = (field) => property[field] || "";
  return `
    <html><head><title>${property.id ? "Edit" : "Add"} Property</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;padding:32px;color:#1e293b;}
    .card{background:white;border-radius:16px;padding:32px;max-width:800px;margin:0 auto;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    h1{font-size:22px;margin-bottom:24px;}
    .section-title{font-size:14px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;margin:24px 0 12px;padding-top:16px;border-top:1px solid #e2e8f0;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    .full{grid-column:1/-1;}
    label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}
    input,textarea,select{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;font-family:inherit;}
    textarea{min-height:80px;resize:vertical;}
    .btn-row{display:flex;gap:12px;margin-top:24px;}
    button{padding:12px 24px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;}
    a.back{font-size:14px;color:#64748b;text-decoration:none;padding:12px 0;display:inline-block;}
    </style></head><body>
    <div class="card">
      <h1>${property.id ? "Edit Property" : "Add New Property"}</h1>
      <form method="${method}" action="${action}">

        <p class="section-title">Basic info</p>
        <div class="grid">
          <div><label>Property name (optional)</label><input name="name" value="${v("name")}" placeholder="Beach House, Unit 4B..."></div>
          <div class="full"><label>Full address *</label><input name="address" value="${v("address")}" placeholder="123 Main St, Lima OH 45801" required></div>
        </div>

        <p class="section-title">iCal sync (paste from Airbnb / VRBO settings)</p>
        <div class="grid">
          <div class="full"><label>iCal URL 1</label><input name="ical_url" value="${v("ical_url")}" placeholder="https://www.airbnb.com/calendar/ical/..."></div>
          <div class="full"><label>iCal URL 2 (optional — for second platform)</label><input name="ical_url_2" value="${v("ical_url_2")}" placeholder="https://www.vrbo.com/icalendar/..."></div>
        </div>

        <p class="section-title">Access</p>
        <div class="grid">
          <div><label>Check-in time</label><input name="checkin_time" value="${v("checkin_time") || "3:00 PM"}" placeholder="3:00 PM"></div>
          <div><label>Check-out time</label><input name="checkout_time" value="${v("checkout_time") || "11:00 AM"}" placeholder="11:00 AM"></div>
          <div><label>Door / lockbox code</label><input name="door_code" value="${v("door_code")}" placeholder="1234"></div>
          <div><label>Key drop-off location</label><input name="key_dropoff" value="${v("key_dropoff")}" placeholder="Lockbox on front gate"></div>
          <div class="full"><label>Parking instructions</label><textarea name="parking_instructions">${v("parking_instructions")}</textarea></div>
        </div>

        <p class="section-title">WiFi</p>
        <div class="grid">
          <div><label>Network name</label><input name="wifi_name" value="${v("wifi_name")}" placeholder="HomeNetwork_5G"></div>
          <div><label>Password</label><input name="wifi_password" value="${v("wifi_password")}" placeholder="password123"></div>
        </div>

        <p class="section-title">Appliances & utilities</p>
        <div class="grid">
          <div class="full"><label>Thermostat instructions</label><textarea name="thermostat_instructions">${v("thermostat_instructions")}</textarea></div>
          <div class="full"><label>Washer / dryer instructions</label><textarea name="washer_dryer_instructions">${v("washer_dryer_instructions")}</textarea></div>
          <div class="full"><label>TV / streaming instructions</label><textarea name="tv_instructions">${v("tv_instructions")}</textarea></div>
          <div class="full"><label>Trash & recycling</label><textarea name="trash_instructions">${v("trash_instructions")}</textarea></div>
        </div>

        <p class="section-title">House rules</p>
        <div class="grid">
          <div class="full"><label>House rules</label><textarea name="house_rules">${v("house_rules")}</textarea></div>
          <div><label>Quiet hours start (24hr)</label><input name="quiet_hours_start" type="number" value="${v("quiet_hours_start") || 22}" min="0" max="23"></div>
          <div><label>Quiet hours end (24hr)</label><input name="quiet_hours_end" type="number" value="${v("quiet_hours_end") || 8}" min="0" max="23"></div>
        </div>

        <p class="section-title">Emergency info</p>
        <div class="grid">
          <div><label>Breaker box location</label><input name="breaker_location" value="${v("breaker_location")}" placeholder="Hallway closet, left side"></div>
          <div><label>Water shutoff location</label><input name="water_shutoff" value="${v("water_shutoff")}" placeholder="Under kitchen sink"></div>
          <div class="full"><label>Nearest urgent care</label><input name="nearest_urgent_care" value="${v("nearest_urgent_care")}" placeholder="St. Rita's Medical Center — 0.5 miles"></div>
        </div>

        <p class="section-title">Local recommendations</p>
        <div class="grid">
          <div class="full"><label>Restaurants</label><textarea name="local_restaurants">${v("local_restaurants")}</textarea></div>
          <div><label>Grocery store</label><input name="local_grocery" value="${v("local_grocery")}" placeholder="Kroger — 0.3 miles on Main St"></div>
          <div><label>Coffee shop</label><input name="local_coffee" value="${v("local_coffee")}" placeholder="Starbucks — 2 min walk"></div>
          <div class="full"><label>Things to do nearby</label><textarea name="local_activities">${v("local_activities")}</textarea></div>
        </div>

        <p class="section-title">Additional notes</p>
        <div><label>Extra notes for guests</label><textarea name="extra_notes">${v("extra_notes")}</textarea></div>

        <div class="btn-row">
          <button type="submit">${property.id ? "Save Changes" : "Add Property"}</button>
          <a href="/str/dashboard" class="back">Cancel</a>
        </div>
      </form>
    </div></body></html>
  `;
}

app.get("/str/properties/new", checkStrHostAuth, (req, res) => {
  res.send(propertyForm({}, "/str/properties"));
});

app.post("/str/properties", checkStrHostAuth, async (req, res) => {
  const host = req.strHost;
  const b = req.body;
  await pool.query(`
    INSERT INTO str_properties (
      host_id, name, address, ical_url, ical_url_2,
      wifi_name, wifi_password, door_code, checkin_time, checkout_time,
      parking_instructions, key_dropoff, thermostat_instructions,
      washer_dryer_instructions, tv_instructions, trash_instructions,
      house_rules, quiet_hours_start, quiet_hours_end,
      breaker_location, water_shutoff, nearest_urgent_care,
      local_restaurants, local_grocery, local_coffee, local_activities, extra_notes
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
  `, [
    host.id, b.name||null, b.address, b.ical_url||null, b.ical_url_2||null,
    b.wifi_name||null, b.wifi_password||null, b.door_code||null,
    b.checkin_time||"3:00 PM", b.checkout_time||"11:00 AM",
    b.parking_instructions||null, b.key_dropoff||null,
    b.thermostat_instructions||null, b.washer_dryer_instructions||null,
    b.tv_instructions||null, b.trash_instructions||null,
    b.house_rules||null,
    parseInt(b.quiet_hours_start)||22, parseInt(b.quiet_hours_end)||8,
    b.breaker_location||null, b.water_shutoff||null, b.nearest_urgent_care||null,
    b.local_restaurants||null, b.local_grocery||null, b.local_coffee||null,
    b.local_activities||null, b.extra_notes||null
  ]);
  console.log(`[STR] Property added for host ${host.name}: ${b.address}`);
  res.redirect("/str/dashboard");
});

app.get("/str/properties/:id/edit", checkStrHostAuth, async (req, res) => {
  const property = await getPropertyById(parseInt(req.params.id));
  if (!property || property.host_id !== req.strHost.id) return res.redirect("/str/dashboard");
  res.send(propertyForm(property, `/str/properties/${property.id}`, "POST"));
});

app.post("/str/properties/:id", checkStrHostAuth, async (req, res) => {
  const host = req.strHost;
  const b = req.body;
  const id = parseInt(req.params.id);
  await pool.query(`
    UPDATE str_properties SET
      name=$1, address=$2, ical_url=$3, ical_url_2=$4,
      wifi_name=$5, wifi_password=$6, door_code=$7,
      checkin_time=$8, checkout_time=$9, parking_instructions=$10,
      key_dropoff=$11, thermostat_instructions=$12, washer_dryer_instructions=$13,
      tv_instructions=$14, trash_instructions=$15, house_rules=$16,
      quiet_hours_start=$17, quiet_hours_end=$18, breaker_location=$19,
      water_shutoff=$20, nearest_urgent_care=$21, local_restaurants=$22,
      local_grocery=$23, local_coffee=$24, local_activities=$25, extra_notes=$26
    WHERE id=$27 AND host_id=$28
  `, [
    b.name||null, b.address, b.ical_url||null, b.ical_url_2||null,
    b.wifi_name||null, b.wifi_password||null, b.door_code||null,
    b.checkin_time||"3:00 PM", b.checkout_time||"11:00 AM",
    b.parking_instructions||null, b.key_dropoff||null,
    b.thermostat_instructions||null, b.washer_dryer_instructions||null,
    b.tv_instructions||null, b.trash_instructions||null, b.house_rules||null,
    parseInt(b.quiet_hours_start)||22, parseInt(b.quiet_hours_end)||8,
    b.breaker_location||null, b.water_shutoff||null, b.nearest_urgent_care||null,
    b.local_restaurants||null, b.local_grocery||null, b.local_coffee||null,
    b.local_activities||null, b.extra_notes||null,
    id, host.id
  ]);
  res.redirect("/str/dashboard");
});

app.post("/str/properties/:id/sync", checkStrHostAuth, async (req, res) => {
  const property = await getPropertyById(parseInt(req.params.id));
  if (property && property.host_id === req.strHost.id) {
    await syncIcalForProperty(property);
  }
  res.redirect("/str/dashboard");
});

// ─────────────────────────────────────────────
// ADMIN — ADD STR HOST
// ─────────────────────────────────────────────
app.post("/admin/str-hosts", checkAdminAuth, async (req, res) => {
  const { name, email, twilio_number, password, host_phone, plan } = req.body;
  await pool.query(`
    INSERT INTO str_hosts (name, email, twilio_number, dashboard_password, host_phone, plan)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [name, email, twilio_number, password, host_phone, plan || "starter"]);
  console.log(`[ADMIN] STR host added: ${name} | ${twilio_number}`);
  res.redirect("/admin");
});

app.post("/admin/str-hosts/:id/delete", checkAdminAuth, async (req, res) => {
  const id = req.params.id;
  await pool.query("DELETE FROM str_conversations WHERE host_id = $1", [id]);
  await pool.query("DELETE FROM str_guests WHERE host_id = $1", [id]);
  await pool.query("DELETE FROM str_bookings WHERE host_id = $1", [id]);
  await pool.query("DELETE FROM str_properties WHERE host_id = $1", [id]);
  await pool.query("DELETE FROM str_hosts WHERE id = $1", [id]);
  res.redirect("/admin");
});

// ─────────────────────────────────────────────
// ADMIN LOGIN (existing)
// ─────────────────────────────────────────────
app.get("/admin/login", (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px;font-size:14px;">Incorrect password.</p>' : "";
  res.send(`<html><head><title>Admin Login</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{background:white;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}h1{font-size:22px;color:#1e293b;margin-bottom:8px;}p{font-size:14px;color:#64748b;margin-bottom:28px;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input{width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;outline:none;}button{width:100%;padding:13px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;margin-top:16px;}</style></head><body><div class="card"><h1>Admin Panel</h1><p>Tenant Flow AI — Admin Access</p>${error}<form method="POST" action="/admin/login"><label>Admin Password</label><input type="password" name="password" autofocus><button>Sign In</button></form></div></body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader("Set-Cookie", `admin_auth=${ADMIN_PASSWORD}; Path=/; HttpOnly; Max-Age=86400`);
    res.redirect("/admin");
  } else {
    res.redirect("/admin/login?error=1");
  }
});

// ─────────────────────────────────────────────
// ADMIN PANEL (existing + STR section added)
// ─────────────────────────────────────────────
app.get("/admin", checkAdminAuth, async (req, res) => {
  const managers = await getAllManagers();
  const statsPromises = managers.map(m => getManagerStats(m.id));
  const stats = await Promise.all(statsPromises);
  const strHosts = await pool.query("SELECT * FROM str_hosts ORDER BY created_at DESC");

  const PLAN_PRICES = { starter: 149, growth: 299, pro: 599 };
  const mrr = managers.reduce((sum, m) => sum + (PLAN_PRICES[m.plan] || 0), 0)
            + strHosts.rows.reduce((sum, h) => sum + (PLAN_PRICES[h.plan] || 0), 0);
  const arr = mrr * 12;

  function monthsActive(createdAt) {
    return Math.max(1, Math.floor((new Date() - new Date(createdAt)) / (1000 * 60 * 60 * 24 * 30)));
  }

  const clientRows = managers.map((m, i) => `
    <tr>
      <td>${m.name}</td><td>${m.email || "-"}</td><td>${m.twilio_number}</td>
      <td><code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:13px">${m.dashboard_password}</code></td>
      <td><form method="POST" action="/admin/managers/${m.id}/plan" style="display:flex;align-items:center;gap:6px">
        <select name="plan" style="padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px">
          <option value="starter" ${m.plan==="starter"?"selected":""}>Starter $149</option>
          <option value="growth" ${m.plan==="growth"?"selected":""}>Growth $299</option>
          <option value="pro" ${m.plan==="pro"?"selected":""}>Pro $599</option>
        </select>
        <button type="submit" style="background:#3b82f6;color:white;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Save</button>
      </form></td>
      <td>${stats[i].total}</td><td>${stats[i].active}</td><td>${timeAgo(m.created_at)}</td>
      <td style="display:flex;gap:6px">
        <a href="/admin/managers/${m.id}/contacts" style="background:#8b5cf6;color:white;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold;text-decoration:none">Contacts</a>
        <form method="POST" action="/admin/managers/${m.id}/delete" onsubmit="return confirm('Delete ${m.name}?')">
          <button type="submit" style="background:#ef4444;color:white;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Delete</button>
        </form>
      </td>
    </tr>
  `).join("");

  const strHostRows = strHosts.rows.map(h => `
    <tr>
      <td>${h.name}</td><td>${h.email||"-"}</td><td>${h.twilio_number}</td>
      <td>${h.host_phone}</td>
      <td><code style="background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:13px">${h.dashboard_password}</code></td>
      <td>${timeAgo(h.created_at)}</td>
      <td>
        <form method="POST" action="/admin/str-hosts/${h.id}/delete" onsubmit="return confirm('Delete ${h.name}?')">
          <button type="submit" style="background:#ef4444;color:white;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Delete</button>
        </form>
      </td>
    </tr>
  `).join("");

  res.send(`
    <html><head><title>Tenant Flow AI Admin</title><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;}
    .header{background:#1e293b;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;}
    .header h1{font-size:22px;}.logout{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 12px;border:1px solid #475569;border-radius:6px;}
    .content{padding:32px;}.section{background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    h2{font-size:18px;margin-bottom:20px;}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}
    input,select{width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none;}
    button{padding:12px 24px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;margin-top:8px;}
    table{width:100%;border-collapse:collapse;}th{text-align:left;padding:12px 16px;font-size:12px;color:#64748b;text-transform:uppercase;border-bottom:1px solid #e2e8f0;}
    td{padding:14px 16px;font-size:14px;border-bottom:1px solid #f1f5f9;}tr:last-child td{border-bottom:none;}tr:hover td{background:#f8fafc;}
    .stat-row{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;}
    .stat{background:white;border-radius:12px;padding:20px 24px;flex:1;min-width:120px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}
    .stat .num{font-size:28px;font-weight:bold;}.stat .label{font-size:12px;color:#64748b;margin-top:4px;}
    .mrr-banner{background:linear-gradient(135deg,#1e293b,#334155);color:white;border-radius:12px;padding:28px 32px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;}
    .mrr-banner .big{font-size:48px;font-weight:bold;color:#22c55e;}
    .mrr-banner .sub{font-size:14px;color:#94a3b8;margin-top:4px;}
    .mrr-banner .arr{font-size:22px;font-weight:bold;color:#94a3b8;}
    .tab{display:inline-block;padding:8px 20px;border-radius:20px;font-size:13px;font-weight:bold;background:#f1f5f9;color:#64748b;text-decoration:none;margin-right:8px;}
    .tab.active{background:#1e293b;color:white;}
    </style></head><body>
    <div class="header"><h1>Tenant Flow AI — Admin</h1><a href="/admin/logout" class="logout">Sign Out</a></div>
    <div class="content">

      <div class="mrr-banner">
        <div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Monthly Recurring Revenue</div>
          <div class="big">$${mrr.toLocaleString()}</div>
          <div class="sub">${managers.length + strHosts.rows.length} active clients</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:13px;color:#94a3b8;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em">Annual Run Rate</div>
          <div class="arr">$${arr.toLocaleString()}/yr</div>
        </div>
      </div>

      <div class="section">
        <h2>Property Management Clients</h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Twilio #</th><th>Password</th><th>Plan</th><th>Total</th><th>Active</th><th>Added</th><th>Actions</th></tr></thead>
          <tbody>${clientRows || '<tr><td colspan="9" style="text-align:center;padding:40px;color:#94a3b8">No clients yet</td></tr>'}</tbody>
        </table>
      </div>

      <div class="section">
        <h2>Add Property Management Client</h2>
        <form method="POST" action="/admin/managers">
          <div class="form-grid">
            <div><label>Manager Name</label><input name="name" placeholder="John Smith" required></div>
            <div><label>Email</label><input name="email" type="email" placeholder="john@company.com"></div>
            <div><label>Twilio Phone Number</label><input name="twilio_number" placeholder="+15551234567" required></div>
            <div><label>Dashboard Password</label><input name="password" placeholder="their login password" required></div>
            <div><label>Plan</label><select name="plan"><option value="starter">Starter — $149/mo</option><option value="growth">Growth — $299/mo</option><option value="pro">Pro — $599/mo</option></select></div>
          </div>
          <div style="margin-top:16px">
            <p style="font-size:13px;font-weight:bold;color:#374151;margin-bottom:12px">Maintenance Contacts</p>
            <div class="form-grid">
              <div><label>Plumbing</label><input name="plumbing" placeholder="+15551234567"></div>
              <div><label>Electrical</label><input name="electrical" placeholder="+15551234567"></div>
              <div><label>HVAC</label><input name="hvac" placeholder="+15551234567"></div>
              <div><label>Structural</label><input name="structural" placeholder="+15551234567"></div>
              <div><label>Pest Control</label><input name="pest" placeholder="+15551234567"></div>
              <div><label>Security</label><input name="security" placeholder="+15551234567"></div>
              <div><label>Appliances</label><input name="appliances" placeholder="+15551234567"></div>
              <div><label>General</label><input name="general" placeholder="+15551234567"></div>
            </div>
          </div>
          <button type="submit" style="margin-top:16px">Add Client</button>
        </form>
      </div>

      <div class="section">
        <h2>STR Hosts</h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Twilio #</th><th>Host Phone</th><th>Password</th><th>Added</th><th>Actions</th></tr></thead>
          <tbody>${strHostRows || '<tr><td colspan="7" style="text-align:center;padding:40px;color:#94a3b8">No STR hosts yet</td></tr>'}</tbody>
        </table>
      </div>

      <div class="section">
        <h2>Add STR Host</h2>
        <form method="POST" action="/admin/str-hosts">
          <div class="form-grid">
            <div><label>Host Name</label><input name="name" placeholder="Jane Smith" required></div>
            <div><label>Email</label><input name="email" type="email" placeholder="jane@email.com"></div>
            <div><label>Twilio Number (dedicated for this host)</label><input name="twilio_number" placeholder="+15551234567" required></div>
            <div><label>Host's Personal Cell (for escalations)</label><input name="host_phone" placeholder="+15551234567" required></div>
            <div><label>Dashboard Password</label><input name="password" placeholder="their login password" required></div>
            <div><label>Plan</label><select name="plan"><option value="starter">Starter — $149/mo</option><option value="growth">Growth — $299/mo</option><option value="pro">Pro — $599/mo</option></select></div>
          </div>
          <button type="submit" style="margin-top:16px">Add STR Host</button>
        </form>
      </div>

    </div></body></html>
  `);
});

app.post("/admin/managers", checkAdminAuth, async (req, res) => {
  const { name, email, twilio_number, password, plan, plumbing, electrical, hvac, structural, pest, security, appliances, general } = req.body;
  const contacts = { plumbing, electrical, hvac, structural, pest, security, appliances, general };
  const managerId = await createManager(name, email, twilio_number, password, plan, contacts);
  console.log(`[ADMIN] New manager created: ${name}`);
  res.redirect("/admin");
});

app.post("/admin/managers/:id/plan", checkAdminAuth, async (req, res) => {
  await pool.query("UPDATE managers SET plan = $1 WHERE id = $2", [req.body.plan, req.params.id]);
  res.redirect("/admin");
});

app.post("/admin/managers/:id/delete", checkAdminAuth, async (req, res) => {
  const id = req.params.id;
  await pool.query("DELETE FROM maintenance_contacts WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM requests WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM conversations WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM tenants WHERE manager_id = $1", [id]);
  await pool.query("DELETE FROM managers WHERE id = $1", [id]);
  res.redirect("/admin");
});

app.get("/admin/managers/:id/contacts", checkAdminAuth, async (req, res) => {
  const manager = await getManagerById(parseInt(req.params.id));
  if (!manager) return res.redirect("/admin");
  const contacts = await pool.query("SELECT * FROM maintenance_contacts WHERE manager_id = $1 ORDER BY category", [manager.id]);
  const contactMap = {};
  contacts.rows.forEach(c => { contactMap[c.category] = c; });
  const categories = [
    { key: "plumbing", label: "Plumbing" }, { key: "electrical", label: "Electrical" },
    { key: "hvac", label: "HVAC" }, { key: "structural", label: "Structural" },
    { key: "pest", label: "Pest Control" }, { key: "security", label: "Security" },
    { key: "appliances", label: "Appliances" }, { key: "general", label: "General" },
  ];
  const fields = categories.map(c => `
    <div><label style="font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px">${c.label}</label>
    <input name="${c.key}" value="${contactMap[c.key]?.phone || ""}" placeholder="+15551234567" style="width:100%;padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;outline:none"></div>
  `).join("");
  res.send(`<html><head><title>Edit Contacts</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;padding:40px 32px;color:#1e293b;}.card{background:white;border-radius:16px;padding:32px;max-width:700px;margin:0 auto;box-shadow:0 1px 3px rgba(0,0,0,0.08);}h1{font-size:22px;margin-bottom:6px;}p{font-size:14px;color:#64748b;margin-bottom:28px;}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;}button{padding:12px 24px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:14px;font-weight:bold;cursor:pointer;margin-right:8px;}a.back{font-size:14px;color:#64748b;text-decoration:none;}</style></head><body><div class="card"><h1>Edit Maintenance Contacts</h1><p>${manager.name} | ${manager.twilio_number}</p><form method="POST" action="/admin/managers/${manager.id}/contacts"><div class="grid">${fields}</div><button type="submit">Save</button><a href="/admin" class="back">Cancel</a></form></div></body></html>`);
});

app.post("/admin/managers/:id/contacts", checkAdminAuth, async (req, res) => {
  const managerId = parseInt(req.params.id);
  const categories = ["plumbing", "electrical", "hvac", "structural", "pest", "security", "appliances", "general"];
  for (const cat of categories) {
    if (req.body[cat]) {
      await pool.query("UPDATE maintenance_contacts SET phone = $1 WHERE manager_id = $2 AND category = $3", [req.body[cat], managerId, cat]);
    }
  }
  res.redirect("/admin");
});

app.get("/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin_auth=; Path=/; HttpOnly; Max-Age=0");
  res.redirect("/admin/login");
});

// ─────────────────────────────────────────────
// MANAGER DASHBOARD (existing — unchanged)
// ─────────────────────────────────────────────
app.get("/dashboard/login", (req, res) => {
  const error = req.query.error ? '<p style="color:#ef4444;margin-bottom:16px;font-size:14px;">Incorrect password.</p>' : "";
  res.send(`<html><head><title>Dashboard Login</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;}.card{background:white;border-radius:16px;padding:40px;width:100%;max-width:380px;box-shadow:0 4px 24px rgba(0,0,0,0.08);}h1{font-size:22px;color:#1e293b;margin-bottom:8px;}p.sub{font-size:14px;color:#64748b;margin-bottom:28px;}label{font-size:13px;font-weight:bold;color:#374151;display:block;margin-bottom:6px;}input{width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:15px;outline:none;margin-bottom:16px;}button{width:100%;padding:13px;background:#1e293b;color:white;border:none;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer;}</style></head><body><div class="card"><h1>Tenant Flow AI</h1><p class="sub">Sign in to your dashboard</p>${error}<form method="POST" action="/dashboard/login"><label>Phone Number</label><input name="twilio_number" placeholder="+15139518826"><label>Password</label><input type="password" name="password" autofocus><button>Sign In</button></form></div></body></html>`);
});

app.post("/dashboard/login", async (req, res) => {
  const { twilio_number, password } = req.body;
  const manager = await getManagerByTwilioNumber(twilio_number);
  if (manager && manager.dashboard_password === password) {
    res.setHeader("Set-Cookie", [`manager_id=${manager.id}; Path=/; HttpOnly; Max-Age=86400`, `manager_pass=${password}; Path=/; HttpOnly; Max-Age=86400`]);
    res.redirect("/dashboard");
  } else {
    res.redirect("/dashboard/login?error=1");
  }
});

app.get("/dashboard", checkManagerAuth, async (req, res) => {
  const manager = req.manager;
  const filter = req.query.filter || "all";
  let requests = await getRequestsByManager(manager.id);
  const total = requests.length;
  const active = requests.filter(r => r.status === "active").length;
  const completed = requests.filter(r => r.status === "completed").length;
  const emergency = requests.filter(r => r.urgency === "EMERGENCY").length;
  if (filter === "active") requests = requests.filter(r => r.status === "active");
  if (filter === "completed") requests = requests.filter(r => r.status === "completed");
  if (filter === "scheduled") requests = requests.filter(r => r.status === "scheduled");
  const rows = requests.map(r => `
    <tr>
      <td>${timeAgo(r.created_at)}</td><td>${r.address||"Unknown"}</td><td>${r.tenant_phone}</td>
      <td><span style="background:${urgencyColor(r.urgency)};color:#fff;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:bold">${r.urgency}</span></td>
      <td>${r.category}</td><td>${r.summary}</td><td>${r.availability}</td>
      <td><form method="POST" action="/dashboard/status/${r.id}" style="display:flex;align-items:center;gap:6px">
        <select name="status" style="padding:4px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px">
          <option value="active" ${r.status==="active"?"selected":""}>Active</option>
          <option value="scheduled" ${r.status==="scheduled"?"selected":""}>Scheduled</option>
          <option value="completed" ${r.status==="completed"?"selected":""}>Completed</option>
          <option value="unavailable" ${r.status==="unavailable"?"selected":""}>Unavailable</option>
        </select>
        <button type="submit" style="background:#1e293b;color:white;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:bold">Save</button>
      </form></td>
    </tr>
  `).join("");
  res.send(`<html><head><title>${manager.name} — Dashboard</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#f1f5f9;color:#1e293b;}.header{background:#1e293b;color:white;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;}.header h1{font-size:20px;}.header-right{display:flex;align-items:center;gap:16px;}.header-right span{font-size:13px;color:#94a3b8;}.logout{font-size:13px;color:#94a3b8;text-decoration:none;padding:6px 12px;border:1px solid #475569;border-radius:6px;}.stats{display:flex;gap:16px;padding:24px 32px;flex-wrap:wrap;}.stat{background:white;border-radius:12px;padding:20px 24px;flex:1;min-width:140px;box-shadow:0 1px 3px rgba(0,0,0,0.08);}.stat .num{font-size:32px;font-weight:bold;}.stat .label{font-size:13px;color:#64748b;margin-top:4px;}.filters{padding:0 32px 16px;display:flex;gap:8px;flex-wrap:wrap;}.filters a{padding:8px 16px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:bold;background:white;color:#64748b;}.filters a.active{background:#1e293b;color:white;}.table-wrap{padding:0 32px 32px;overflow-x:auto;}table{width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);}th{background:#f8fafc;text-align:left;padding:12px 16px;font-size:12px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;}td{padding:14px 16px;font-size:14px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}tr:last-child td{border-bottom:none;}tr:hover td{background:#f8fafc;}.empty{text-align:center;padding:60px;color:#94a3b8;font-size:16px;}</style><meta http-equiv="refresh" content="30"></head><body>
    <div class="header"><h1>Tenant Flow AI — ${manager.name}</h1><div class="header-right"><span>Auto-refreshes every 30s</span><a href="/dashboard/logout" class="logout">Sign Out</a></div></div>
    <div class="stats"><div class="stat"><div class="num">${total}</div><div class="label">Total</div></div><div class="stat"><div class="num" style="color:#f97316">${active}</div><div class="label">Active</div></div><div class="stat"><div class="num" style="color:#22c55e">${completed}</div><div class="label">Completed</div></div><div class="stat"><div class="num" style="color:#ef4444">${emergency}</div><div class="label">Emergencies</div></div></div>
    <div class="filters"><a href="/dashboard?filter=all" class="${filter==="all"?"active":""}">All</a><a href="/dashboard?filter=active" class="${filter==="active"?"active":""}">Active</a><a href="/dashboard?filter=completed" class="${filter==="completed"?"active":""}">Completed</a><a href="/dashboard?filter=scheduled" class="${filter==="scheduled"?"active":""}">Scheduled</a></div>
    <div class="table-wrap"><table><thead><tr><th>Time</th><th>Property</th><th>Tenant</th><th>Urgency</th><th>Category</th><th>Issue</th><th>Availability</th><th>Status</th></tr></thead><tbody>${rows||'<tr><td colspan="8" class="empty">No requests found</td></tr>'}</tbody></table></div></body></html>`);
});

app.post("/dashboard/status/:id", checkManagerAuth, async (req, res) => {
  await pool.query("UPDATE requests SET status = $1, updated_at = NOW() WHERE id = $2", [req.body.status, req.params.id]);
  res.redirect("/dashboard" + (req.headers.referer?.includes("filter=") ? "?" + req.headers.referer.split("?")[1] : ""));
});

app.post("/dashboard/complete/:id", checkManagerAuth, async (req, res) => {
  await markRequestDone(req.params.id);
  res.redirect("/dashboard");
});

app.get("/dashboard/logout", (req, res) => {
  res.setHeader("Set-Cookie", ["manager_id=; Path=/; HttpOnly; Max-Age=0", "manager_pass=; Path=/; HttpOnly; Max-Age=0"]);
  res.redirect("/dashboard/login");
});

// ─────────────────────────────────────────────
// SMS ENDPOINT — ROUTES TO TENANT FLOW OR STR
// ─────────────────────────────────────────────
app.get("/sms", (req, res) => res.status(200).send("SMS endpoint alive."));

app.post("/sms", async (req, res) => {
  const from = req.body.From || "";
  const to   = req.body.To || TWILIO_PHONE_NUMBER;
  const body = (req.body.Body || "").trim();
  const keyword = body.toUpperCase();

  console.log(`Incoming SMS | From: ${from} | To: ${to} | Body: ${body}`);

  // ── ROUTE: STR HOST? ─────────────────────────
  const strHost = await getStrHostByTwilioNumber(to);
  if (strHost) {
    res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
    await handleStrSms(strHost, from, body);
    return;
  }

  // ── ROUTE: PROPERTY MANAGER (existing flow) ──
  const manager = await getManagerByTwilioNumber(to);
  if (!manager) {
    console.error(`[ERROR] No manager or STR host found for Twilio number: ${to}`);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }

  if (STOP_KEYWORDS.has(keyword)) {
    await recordOptOut(from, manager.id);
    await clearConversation(from, manager.id);
    return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  }
  if (START_KEYWORDS.has(keyword)) {
    await recordOptIn(from, manager.id);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }
  if (keyword === "HELP") {
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(HELP_REPLY));
  }

  const maintenancePhones = await getAllMaintenancePhones(manager.id);
  if (maintenancePhones.has(from)) {
    res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
    await handleMaintenanceReply(manager, from, body);
    return;
  }

  if (await isOptedOut(from, manager.id)) return res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());

  if (await isFirstTimeTexter(from, manager.id)) {
    await recordOptIn(from, manager.id);
    return res.status(200).set("Content-Type", "text/xml").send(twimlResponse(OPT_IN_CONFIRMATION));
  }

  if (await isResolved(from, manager.id)) await clearConversation(from, manager.id);

  res.status(200).set("Content-Type", "text/xml").send(emptyTwiml());
  processWithClaude(manager, from, body);
});

// ─────────────────────────────────────────────
// HOMEPAGE + STATIC PAGES (existing)
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.redirect("/dashboard/login");
});

app.get("/privacy", (req, res) => {
  res.status(200).send('<html><head><title>Privacy Policy</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;color:#333;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}h2{font-size:24px;margin-top:30px;}p{font-size:18px;margin-bottom:15px;}</style></head><body><h1>Privacy Policy</h1><p>Tenant Flow AI collects phone numbers, addresses, and message content to facilitate communication between tenants and maintenance personnel.</p><h2>Information We Collect</h2><p>We collect phone numbers, unit addresses, message content, maintenance issue details, and communication history.</p><h2>How We Use Information</h2><p>We use this information solely for service-related communication including maintenance requests, scheduling updates, and property management communication.</p><h2>Information Sharing</h2><p>Tenant Flow AI does not sell or share personal information with third parties for marketing purposes. Mobile numbers are never sold or shared.</p><h2>SMS Messaging and Opt-In</h2><p>Users opt in by sending the first text message to Tenant Flow AI. Upon first contact, users automatically receive a confirmation message. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for assistance.</p><h2>Opt-Out</h2><p>Users may opt out at any time by replying STOP.</p><h2>Contact</h2><p>wyattmorgan@tenant-flow-ai.com</p></body></html>');
});

app.get("/terms", (req, res) => {
  res.status(200).send('<html><head><title>Terms and Conditions</title><style>body{font-family:Arial,sans-serif;background:#f5f7fb;padding:40px;color:#333;max-width:900px;margin:auto;line-height:1.7;}h1{font-size:36px;margin-bottom:20px;}h2{font-size:24px;margin-top:30px;}p{font-size:18px;margin-bottom:15px;}</style></head><body><h1>Terms and Conditions</h1><p>These Terms govern the use of Tenant Flow AI messaging services.</p><h2>Program Description</h2><p>Tenant Flow AI provides SMS-based communication for maintenance requests, scheduling, and property management communication.</p><h2>Consent to Receive Messages</h2><p>Users consent by sending the first text message. Upon first contact, users receive an opt-in confirmation recorded with a timestamp.</p><h2>Message Frequency</h2><p>Message frequency varies depending on maintenance activity.</p><h2>Fees</h2><p>Message and data rates may apply.</p><h2>Opt-Out</h2><p>Reply STOP at any time.</p><h2>Help</h2><p>Reply HELP for assistance.</p><h2>Support</h2><p>wyattmorgan@tenant-flow-ai.com</p></body></html>');
});

app.use((req, res) => res.status(404).send("Not Found: " + req.method + " " + req.path));

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const port = process.env.PORT || 3000;
initDb().then(() => {
  syncAllIcal(); // Initial sync on startup
  app.listen(port, () => console.log("Server running on port " + port));
}).catch(err => {
  console.error("[DB INIT ERROR]", err);
  process.exit(1);
});
