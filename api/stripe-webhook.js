// api/stripe-webhook.js
// Recibe avisos de Stripe cuando alguien paga, cancela o renueva su suscripción,
// y actualiza automáticamente la tabla "subscriptions" de Supabase.
// Nunca se ejecuta en el navegador: solo en el servidor de Vercel.

export const config = {
  api: { bodyParser: false } // necesitamos el cuerpo "en crudo" para verificar la firma
};

import crypto from 'crypto';

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const expectedSig = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedSig, 'hex'), Buffer.from(signature, 'hex'));
  } catch (e) {
    return false;
  }
}

async function supabaseUpsertSubscription(env, userId, unlockedUntilISO, extra = {}) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/subscriptions`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({
      user_id: userId,
      unlocked_until: unlockedUntilISO,
      updated_at: new Date().toISOString(),
      ...extra
    })
  });
}

async function findUserIdByStripeSubscription(env, stripeSubId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/subscriptions?select=user_id&stripe_subscription_id=eq.${stripeSubId}`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  );
  const rows = await res.json();
  return rows && rows[0] ? rows[0].user_id : null;
}

async function fetchStripeSubscription(env, subId) {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET
  };

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  const isValid = verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    res.status(400).send('Firma de Stripe no válida');
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    res.status(400).send('JSON inválido');
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.client_reference_id;
      if (userId && session.subscription) {
        const sub = await fetchStripeSubscription(env, session.subscription);
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
        await supabaseUpsertSubscription(env, userId, periodEnd, {
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription
        });
      }
    } else if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (subId) {
        const userId = await findUserIdByStripeSubscription(env, subId);
        if (userId) {
          const sub = await fetchStripeSubscription(env, subId);
          const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
          await supabaseUpsertSubscription(env, userId, periodEnd);
        }
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const userId = await findUserIdByStripeSubscription(env, sub.id);
      if (userId) {
        await supabaseUpsertSubscription(env, userId, new Date().toISOString());
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Error procesando webhook de Stripe:', err);
    res.status(500).json({ error: 'internal error' });
  }
}
