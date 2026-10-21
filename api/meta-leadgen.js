// Instagram / Facebook Instant Form leads -> bookings@officialdjnava.com
// Vercel serverless function (CommonJS, zero dependencies).
//
// How it works:
//   1. Someone submits the Instant Form on a Meta lead ad.
//   2. Meta calls this endpoint (webhook, field "leadgen") with the lead ID.
//   3. We fetch the answers from the Graph API with the Page access token.
//   4. We email them to bookings@officialdjnava.com (Resend, or Web3Forms fallback).
//
// Env vars (Vercel > Project > Settings > Environment Variables):
//   META_PAGE_TOKEN          = long-lived Page access token (leads_retrieval permission)
//   META_LEADGEN_VERIFY      = optional; webhook "Verify token" (defaults to the public phrase below)
//   RESEND_API_KEY           = Resend API key (free account signed up with bookings@officialdjnava.com)
//   LEADS_TO / LEADS_FROM    = optional overrides for recipient / sender
//   WEB3FORMS_KEY            = optional fallback; defaults to the site's existing Web3Forms key
//
// Health check / test email: GET /api/meta-leadgen?selftest=<verify phrase>

const GRAPH = "https://graph.facebook.com/v21.0";
// Not a secret: it only confirms to Meta that this URL belongs to us. Leads can only be
// read with META_PAGE_TOKEN, so a fake webhook call cannot pull or send anything.
const VERIFY = process.env.META_LEADGEN_VERIFY || "djnava-leads";
const DEFAULT_W3F_KEY = "8fb1441c-f08b-43df-b990-35fea276ff31"; // already public in index.html

const readRaw = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });

const labelFor = (name) =>
  ({
    full_name: "Name",
    email: "Email",
    phone_number: "Phone",
  }[name] || name.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()));

async function sendEmail(subject, lines, replyTo, fromName) {
  const text = lines.join("\n");

  // Preferred: Resend (free plan, server-side friendly). Set RESEND_API_KEY in Vercel.
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.LEADS_FROM || `${fromName || "Instagram Lead Ad"} <onboarding@resend.dev>`,
        to: [process.env.LEADS_TO || "bookings@officialdjnava.com"],
        subject,
        text,
        reply_to: replyTo || undefined,
      }),
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`resend ${r.status}: ${raw.slice(0, 300)}`);
    return raw;
  }

  // Fallback: Web3Forms (may block server-side requests on the free plan)
  const body = {
    access_key: process.env.WEB3FORMS_KEY || DEFAULT_W3F_KEY,
    subject,
    from_name: fromName || "Instagram Lead Ad",
    message: text,
  };
  if (replyTo) body.replyto = replyTo;
  const r = await fetch("https://api.web3forms.com/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let out = {};
  try { out = JSON.parse(raw); } catch (_) {}
  if (!r.ok || out.success === false) throw new Error(`web3forms ${r.status}: ${raw.slice(0, 300)}`);
  return out;
}

async function handleLead(leadId) {
  const token = process.env.META_PAGE_TOKEN;
  const url = `${GRAPH}/${leadId}?fields=created_time,field_data,ad_name,campaign_name,form_id,platform&access_token=${encodeURIComponent(token)}`;
  const r = await fetch(url);
  const lead = await r.json();
  if (!r.ok || lead.error) throw new Error("graph: " + JSON.stringify(lead.error || lead));

  const answers = {};
  (lead.field_data || []).forEach((f) => (answers[f.name] = (f.values || []).join(", ")));

  const name = answers.full_name || "New lead";
  const email = answers.email;
  const lines = ["New booking inquiry from an Instagram / Facebook lead ad", ""];
  Object.entries(answers).forEach(([k, v]) => lines.push(`${labelFor(k)}: ${v}`));
  lines.push(
    "",
    `Source: Meta Instant Form (${lead.platform || "ig/fb"})`,
    `Ad: ${lead.ad_name || "n/a"}`,
    `Campaign: ${lead.campaign_name || "n/a"}`,
    `Submitted: ${lead.created_time || "n/a"}`,
    `Lead ID: ${leadId}`
  );

  await sendEmail(`Booking Inquiry (Instagram ad): ${name}`, lines, email, name);
}

module.exports = async (req, res) => {
  const q = req.query || {};

  // Meta webhook verification handshake
  if (req.method === "GET" && q["hub.mode"] === "subscribe") {
    if (q["hub.verify_token"] === VERIFY) {
      return res.status(200).send(q["hub.challenge"]);
    }
    return res.status(403).send("verify token mismatch");
  }

  // Self test: sends a sample email so we can confirm delivery end to end
  if (req.method === "GET" && q.selftest) {
    if (q.selftest !== VERIFY) {
      return res.status(403).json({ error: "bad selftest key" });
    }
    try {
      await sendEmail(
        "TEST Booking Inquiry (Instagram ad): hookup check",
        [
          "This is a test of the Instagram lead ad to email hookup. Safe to delete.",
          "",
          "What do you need a DJ for?: Sangeet",
          "Wedding date (or month if not set yet): June 2027",
          "City or venue: Philadelphia",
          "Name: Test Lead",
        ],
        undefined,
        "Instagram Lead Ad (test)"
      );
      return res.status(200).json({ ok: true, page_token_set: !!process.env.META_PAGE_TOKEN, resend_set: !!process.env.RESEND_API_KEY });
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    let payload = req.body;
    if (!payload || typeof payload !== "object") {
      const raw = await readRaw(req);
      payload = raw ? JSON.parse(raw) : {};
    }
    const ids = [];
    (payload.entry || []).forEach((e) =>
      (e.changes || []).forEach((c) => {
        if (c.field === "leadgen" && c.value && c.value.leadgen_id) ids.push(c.value.leadgen_id);
      })
    );
    const results = await Promise.allSettled(ids.map(handleLead));
    results.forEach((r) => r.status === "rejected" && console.error("lead failed:", r.reason));
    return res.status(200).json({ ok: true, leads: ids.length });
  } catch (e) {
    console.error(e);
    // Always 200 so Meta does not disable the webhook; error is in Vercel logs
    return res.status(200).json({ ok: false });
  }
};
