// api/notify-report.js
// Envía un email de aviso al titular cuando un usuario registra una denuncia.
// Seguridad:
//  - Solo se puede avisar de una denuncia propia (se comprueba con la sesión del usuario).
//  - El contenido del email sale de la base de datos, nunca de lo que envíe el navegador.
//  - Cada denuncia avisa una sola vez (se "reserva" con notified_at antes de enviar).
// Se ejecuta solo en el servidor de Vercel.

const FROM = 'COCHES.GO <noreply@cochesgo.shop>';
const DEFAULT_TO = 'contacto@cochesgo.shop';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    TO: process.env.REPORTS_EMAIL_TO || DEFAULT_TO
  };
  if (!env.SUPABASE_URL || !env.SERVICE_KEY || !env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'Servidor mal configurado' });
  }

  const svc = {
    apikey: env.SERVICE_KEY,
    Authorization: `Bearer ${env.SERVICE_KEY}`
  };

  // 1) ¿Quién llama? Se deduce solo de su sesión.
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Sesión no válida' });

  let user;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SERVICE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return res.status(401).json({ error: 'Sesión no válida o caducada' });
    user = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'No se pudo comprobar la sesión' });
  }
  if (!user || !user.id) return res.status(401).json({ error: 'Sesión no válida' });

  // 2) Qué denuncia
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const reportId = body && body.report_id;
  if (!reportId || !UUID_RE.test(reportId)) {
    return res.status(400).json({ error: 'Denuncia no válida' });
  }

  try {
    // 3) "Reservar" la denuncia: solo si es del usuario que llama y aún no se avisó.
    const claimRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/reports?id=eq.${reportId}&reporter_id=eq.${user.id}&notified_at=is.null`,
      {
        method: 'PATCH',
        headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ notified_at: new Date().toISOString() })
      }
    );
    if (!claimRes.ok) return res.status(500).json({ error: 'No se pudo procesar la denuncia' });
    const claimed = await claimRes.json();
    if (!claimed || claimed.length === 0) {
      // No existe, no es suya, o ya se avisó: no se hace nada más.
      return res.status(200).json({ ok: true, sent: false });
    }
    const report = claimed[0];

    // 4) Datos de contexto (nombres) para que el aviso sea útil
    async function displayName(id) {
      if (!id) return null;
      try {
        const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?select=display_name&id=eq.${id}`, { headers: svc });
        const rows = r.ok ? await r.json() : [];
        return rows && rows[0] ? rows[0].display_name : null;
      } catch (e) { return null; }
    }
    const [reporterName, reportedName] = await Promise.all([
      displayName(report.reporter_id),
      displayName(report.reported_user_id)
    ]);

    const when = new Date(report.created_at || Date.now()).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    const rows = [
      ['Motivo', report.reason],
      ['Detalles del denunciante', report.details || '(sin detalles)'],
      ['Anuncio', report.listing_title ? `${report.listing_title} (${report.listing_id || 'sin id'})` : '(no indicado)'],
      ['Mensaje denunciado', report.message_text || '(no es una denuncia de mensaje)'],
      ['Usuario denunciado', report.reported_user_id ? `${reportedName || 'Usuario'} (${report.reported_user_id})` : '(no indicado)'],
      ['Denunciante', `${reporterName || 'Usuario'} <${user.email || 'sin email'}>`],
      ['Fecha', when]
    ];

    const textBody =
      'Nueva denuncia en COCHES.GO\n\n' +
      rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      '\n\nRevísala y actúa lo antes posible:\nhttps://supabase.com/dashboard/project/kfcfntydfeqeusqcxdzr/editor\n';

    const htmlBody =
      '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">' +
      '<h2 style="margin:0 0 12px;">Nueva denuncia en COCHES.GO</h2>' +
      '<table style="border-collapse:collapse;">' +
      rows.map(([k, v]) =>
        `<tr><td style="padding:6px 14px 6px 0;vertical-align:top;color:#666;white-space:nowrap;"><b>${esc(k)}</b></td>` +
        `<td style="padding:6px 0;white-space:pre-wrap;">${esc(v)}</td></tr>`
      ).join('') +
      '</table>' +
      '<p style="margin-top:18px;">Revísala y actúa lo antes posible en ' +
      '<a href="https://supabase.com/dashboard/project/kfcfntydfeqeusqcxdzr/editor">Supabase &gt; tabla reports</a>.</p>' +
      '</div>';

    // 5) Enviar el email. Si falla, se libera la reserva para poder reintentar.
    let sent = false;
    try {
      const mail = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: [env.TO],
          subject: `Nueva denuncia en COCHES.GO: ${String(report.reason || '').slice(0, 80)}`,
          html: htmlBody,
          text: textBody
        })
      });
      sent = mail.ok;
    } catch (e) {
      sent = false;
    }

    if (!sent) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/reports?id=eq.${reportId}`, {
        method: 'PATCH',
        headers: { ...svc, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ notified_at: null })
      }).catch(() => {});
      return res.status(502).json({ error: 'No se pudo enviar el aviso' });
    }

    return res.status(200).json({ ok: true, sent: true });
  } catch (err) {
    console.error('Error avisando de denuncia:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
}
