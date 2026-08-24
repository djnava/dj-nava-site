// Meta Conversions API — server-side Lead event for officialdjnava.com
// Vercel serverless function (CommonJS, zero dependencies).
// Env vars (Vercel > Project > Settings > Environment Variables):
//   META_PIXEL_ID   = 179566686193408
//   META_CAPI_TOKEN = <Conversions API access token from Events Manager>
//   META_TEST_CODE  = <optional TESTxxxxx code from Events Manager > Test events>

const crypto = require("crypto");

const sha256 = (v) =>
  v ? crypto.createHash("sha256").update(String(v).trim().toLowerCase()).digest("hex") : undefined;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { event_id, email, phone, name, fbp, fbc, source_url } = req.body || {};
    if (!event_id) return res.status(400).json({ error: "event_id required" });

    const [fn, ...rest] = String(name || "").trim().split(/\s+/);
    const ln = rest.join(" ") || undefined;

    const userData = {
      em: email ? [sha256(email)] : undefined,
      ph: phone ? [sha256(String(phone).replace(/[^0-9]/g, ""))] : undefined,
      fn: fn ? [sha256(fn)] : undefined,
      ln: ln ? [sha256(ln)] : undefined,
      fbp: fbp || undefined,
      fbc: fbc || undefined,
      client_ip_address:
        (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || undefined,
      client_user_agent: req.headers["user-agent"],
    };
    Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

    const payload = {
      data: [
        {
          event_name: "Lead",
          event_time: Math.floor(Date.now() / 1000),
          event_id,
          action_source: "website",
          event_source_url: source_url || "https://officialdjnava.com/",
          custom_data: { content_name: "Booking Inquiry" },
          user_data: userData,
        },
      ],
    };
    if (process.env.META_TEST_CODE) payload.test_event_code = process.env.META_TEST_CODE;

    const r = await fetch(
      `https://graph.facebook.com/v21.0/${process.env.META_PIXEL_ID}/events?access_token=${process.env.META_CAPI_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    const out = await r.json();
    if (!r.ok) {
      console.error("Meta CAPI error:", JSON.stringify(out));
      return res.status(502).json({ error: "meta_capi_failed" });
    }
    return res.status(200).json({ ok: true, events_received: out.events_received });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server_error" });
  }
};
