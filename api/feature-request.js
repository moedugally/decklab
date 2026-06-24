const RESEND_API_KEY = process.env.RESEND_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { idea, email } = req.body || {};
  if (!idea || !idea.trim()) return res.status(400).json({ error: 'idea is required' });

  if (!RESEND_API_KEY) return res.status(500).json({ error: 'Email not configured' });

  const submitterLine = email?.trim()
    ? `<p><strong>From:</strong> ${email.trim()}</p>`
    : `<p><strong>From:</strong> anonymous</p>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Decklab <hello@decklab.gg>',
        to: ['hello@decklab.gg'],
        subject: 'New Decklab feature request',
        html: `<p><strong>Idea:</strong></p><blockquote>${idea.trim()}</blockquote>${submitterLine}`,
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('Resend error:', err);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('feature-request error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
