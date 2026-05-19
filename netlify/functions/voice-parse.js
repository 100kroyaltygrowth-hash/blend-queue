// Netlify Function: voice-parse
// Accepts a spoken-order transcript and parses it into a structured order
// using Claude. Browser does transcription via Web Speech API; this function
// just handles the LLM parsing so the Anthropic key stays on the server.
//
// Required env var:
//   ANTHROPIC_API_KEY  (sk-ant-...)
//
// Optional (enables server-side Whisper transcription if you ever want it):
//   OPENAI_API_KEY     (sk-...)

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const WHISPER_MODEL = 'whisper-1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return json(500, {
      error: 'Server not configured. Set ANTHROPIC_API_KEY in Netlify env vars.'
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { transcript: providedTranscript, audioBase64, mimeType = 'audio/webm', recipeNames = '' } = payload;
  let transcript = (providedTranscript || '').trim();

  // If no transcript was sent but audio was, run Whisper (only when OPENAI_API_KEY is configured).
  if (!transcript && audioBase64) {
    if (!OPENAI_API_KEY) {
      return json(400, {
        error: 'Audio uploaded but OPENAI_API_KEY is not configured. Send a `transcript` field instead, or set OPENAI_API_KEY.'
      });
    }
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const audioBlob = new Blob([audioBuffer], { type: mimeType });
      const ext = mimeType.includes('mp4') ? 'mp4'
                : mimeType.includes('ogg') ? 'ogg'
                : mimeType.includes('wav') ? 'wav'
                : 'webm';
      const fd = new FormData();
      fd.append('file', audioBlob, `audio.${ext}`);
      fd.append('model', WHISPER_MODEL);
      fd.append('language', 'en');
      const whRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: fd
      });
      if (!whRes.ok) {
        const detail = await whRes.text();
        return json(502, { error: 'Whisper transcription failed', detail });
      }
      const whJson = await whRes.json();
      transcript = (whJson.text || '').trim();
    } catch (err) {
      return json(500, { error: 'Whisper error: ' + err.message });
    }
  }

  if (!transcript) {
    return json(400, { error: 'Missing `transcript` (or `audioBase64` with OpenAI configured)' });
  }

  // ── Claude parsing ────────────────────────────────────────────
  const prompt = `You are an order parser for Blend nutrition cafe. Parse the spoken order and match items to the recipe list.

Available recipes: ${recipeNames || '(no recipes provided — return items as the customer named them)'}

Shakes come in sizes: 16oz, 24oz, 32oz (default 16oz if not mentioned).
Teas come in levels: Sparked, Lit, Loaded (default Sparked if not mentioned).

Spoken order: "${transcript}"

Respond ONLY with valid JSON (no markdown, no commentary):
{"customerName": "Mary Perryman", "items": [{"name": "Exact Recipe Name", "size": "24oz", "level": "Loaded"}]}

Rules:
- customerName: the person's name if mentioned after "for", otherwise null (not the string "null")
- size: only for shakes — "16oz", "24oz", or "32oz". null for teas.
- level: only for teas — "Sparked", "Lit", or "Loaded". null for shakes.
- Match recipe names as closely as possible to the available list. Prefer exact matches.`;

  try {
    const clRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!clRes.ok) {
      const detail = await clRes.text();
      return json(502, { transcript, error: 'Claude parsing failed', detail });
    }

    const clJson = await clRes.json();
    const rawText = (clJson.content && clJson.content[0] && clJson.content[0].text || '').trim();
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return json(200, {
        transcript,
        customerName: null,
        items: [],
        parseError: 'Could not parse Claude JSON response'
      });
    }

    return json(200, {
      transcript,
      customerName:
        parsed.customerName && parsed.customerName !== 'null' ? parsed.customerName : null,
      items: Array.isArray(parsed.items) ? parsed.items : []
    });
  } catch (err) {
    return json(500, { transcript, error: 'Claude error: ' + err.message });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}
