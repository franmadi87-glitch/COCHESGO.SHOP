// api/delete-account.js
// Elimina la cuenta de QUIEN HACE LA PETICIÓN (identificado por su sesión).
// Pasos: 1) comprueba quién es, 2) cancela su suscripción de Stripe si la tiene,
// 3) borra sus fotos, 4) borra su usuario (la base de datos borra en cascada
// sus anuncios, mensajes, favoritos, búsquedas guardadas, suscripción, perfil,
// bloqueos y denuncias).
// Se ejecuta solo en el servidor de Vercel; la clave de servicio nunca llega al navegador.

const PHOTOS_BUCKET = 'fotos-vehiculos';

function json(res, status, body) {
  res.status(status).json(body);
}

async function cancelStripeSubscription(stripeKey, subId) {
  const base = `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`;
  const headers = { Authorization: `Bearer ${stripeKey}` };

  const get = await fetch(base, { headers });
  if (get.status === 404) return true; // ya no existe
  if (!get.ok) return false;

  const sub = await get.json();
  if (sub.status === 'canceled' || sub.status === 'incomplete_expired') return true;

  const del = await fetch(base, { method: 'DELETE', headers });
  return del.ok;
}

async function deleteUserPhotos(env, userId) {
  try {
    const headers = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    };

    const listRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/list/${PHOTOS_BUCKET}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prefix: userId, limit: 1000 })
    });
    if (!listRes.ok) return false;

    const files = await listRes.json();
    const paths = (files || []).filter((f) => f && f.name).map((f) => `${userId}/${f.name}`);
    if (paths.length === 0) return true;

    const delRes = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${PHOTOS_BUCKET}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ prefixes: paths })
    });
    return delRes.ok;
  } catch (e) {
    return false; // las fotos son "mejor esfuerzo": no bloquean el borrado de la cuenta
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Método no permitido' });
  }

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY
  };

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(res, 500, { error: 'Servidor mal configurado' });
  }

  // 1) ¿Quién pide el borrado? Se deduce SOLO de su sesión, nunca de datos enviados en la petición.
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return json(res, 401, { error: 'Sesión no válida' });

  let userId;
  try {
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return json(res, 401, { error: 'Sesión no válida o caducada' });
    const user = await userRes.json();
    userId = user && user.id;
  } catch (e) {
    return json(res, 502, { error: 'No se pudo comprobar la sesión' });
  }
  if (!userId) return json(res, 401, { error: 'Sesión no válida' });

  try {
    // 2) Suscripción de Stripe: si falla la cancelación, NO se borra la cuenta
    //    (para no dejar a nadie pagando sin cuenta).
    const subRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/subscriptions?select=stripe_subscription_id&user_id=eq.${userId}`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    const subRows = subRes.ok ? await subRes.json() : [];
    const stripeSubId = subRows && subRows[0] && subRows[0].stripe_subscription_id;

    if (stripeSubId) {
      if (!env.STRIPE_SECRET_KEY) {
        return json(res, 500, { error: 'No se pudo cancelar tu suscripción. Contacta con soporte.' });
      }
      const cancelled = await cancelStripeSubscription(env.STRIPE_SECRET_KEY, stripeSubId);
      if (!cancelled) {
        return json(res, 502, {
          error: 'No se pudo cancelar tu suscripción de pago. Inténtalo de nuevo o contacta con soporte.'
        });
      }
    }

    // 3) Fotos (mejor esfuerzo)
    await deleteUserPhotos(env, userId);

    // 4) Borrar el usuario (cascada sobre el resto de datos)
    const delUser = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    if (!delUser.ok) {
      return json(res, 500, { error: 'No se pudo eliminar la cuenta. Inténtalo de nuevo.' });
    }

    return json(res, 200, { ok: true });
  } catch (err) {
    console.error('Error eliminando cuenta:', err);
    return json(res, 500, { error: 'Error interno al eliminar la cuenta' });
  }
}
