// @ts-check
// Obolus Demo Store — simulates a real service purchase for hackathon demo.
//
// The AI agent gets a Stripe test card from the VCC service, then calls
// POST /purchase here. This page completes the purchase in Stripe test mode
// and returns a receipt — proving the end-to-end flow works.
//
// Setup: set STRIPE_SECRET_KEY to your Stripe test key (sk_test_...)

const express = require('express');
const path = require('path');

const PORT = process.env.DEMO_PORT || 3001;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Available demo services (what the agent can "buy")
const SERVICES = {
  'vercel-pro': { name: 'Vercel Pro', price: 2000, currency: 'usd', description: 'Vercel Pro Plan — 1 month' },
  'openai-credits': { name: 'OpenAI API Credits', price: 1000, currency: 'usd', description: 'OpenAI API — $10 credit top-up' },
  'github-pro': { name: 'GitHub Pro', price: 400, currency: 'usd', description: 'GitHub Pro — 1 month' },
  'aws-credits': { name: 'AWS Credits', price: 2500, currency: 'usd', description: 'AWS — $25 service credits' },
};

// GET /services — list available services
app.get('/services', (_req, res) => {
  res.json(Object.entries(SERVICES).map(([id, s]) => ({ id, ...s })));
});

// POST /purchase — agent submits card + service to purchase
// Body: { service_id, card: { number, expiry, cvv }, order_id }
app.post('/purchase', async (req, res) => {
  const { service_id, card, order_id } = req.body;

  if (!service_id || !card || !order_id) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const service = SERVICES[service_id];
  if (!service) {
    return res.status(404).json({ error: 'service_not_found' });
  }

  // If Stripe key is set, use real Stripe test mode
  if (STRIPE_KEY) {
    try {
      const Stripe = require('stripe');
      const stripe = new Stripe(STRIPE_KEY);

      const [expMonth, expYear] = card.expiry.replace(/\s/g, '').split('/');

      // Create a payment method from the card details
      const paymentMethod = await stripe.paymentMethods.create({
        type: 'card',
        card: {
          number: card.number.replace(/\s/g, ''),
          exp_month: parseInt(expMonth, 10),
          exp_year: parseInt('20' + expYear, 10),
          cvc: card.cvv,
        },
      });

      // Confirm the payment
      const paymentIntent = await stripe.paymentIntents.create({
        amount: service.price,
        currency: service.currency,
        payment_method: paymentMethod.id,
        confirm: true,
        return_url: `http://localhost:${PORT}/success`,
        description: `Obolus Agent Purchase: ${service.name} for order ${order_id}`,
        metadata: { order_id, service_id },
      });

      console.log(`[demo] purchase: ${service.name} $${service.price / 100} → ${paymentIntent.status}`);

      return res.json({
        success: true,
        service: service.name,
        amount_cents: service.price,
        payment_intent_id: paymentIntent.id,
        status: paymentIntent.status,
        receipt: {
          service: service.name,
          description: service.description,
          amount: `$${(service.price / 100).toFixed(2)}`,
          card_last4: card.number.slice(-4),
          order_id,
          purchased_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      console.error('[demo] Stripe error:', err.message);
      return res.status(400).json({ error: 'payment_failed', message: err.message });
    }
  }

  // No Stripe key — simulate success (for pure demo without Stripe account)
  console.log(`[demo] simulated purchase: ${service.name} $${service.price / 100} card=****${card.number.slice(-4)}`);

  return res.json({
    success: true,
    service: service.name,
    amount_cents: service.price,
    payment_intent_id: `pi_demo_${Date.now()}`,
    status: 'succeeded',
    receipt: {
      service: service.name,
      description: service.description,
      amount: `$${(service.price / 100).toFixed(2)}`,
      card_last4: card.number.slice(-4),
      order_id,
      purchased_at: new Date().toISOString(),
    },
  });
});

// GET / — demo store UI
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Obolus Demo Store</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; }
    .header { padding: 24px 32px; border-bottom: 1px solid #222; display: flex; align-items: center; gap: 12px; }
    .logo { font-size: 20px; font-weight: 700; }
    .badge { background: #1a1a1a; border: 1px solid #333; padding: 4px 10px; border-radius: 20px; font-size: 12px; color: #888; }
    .main { max-width: 960px; margin: 48px auto; padding: 0 24px; }
    h1 { font-size: 32px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: #888; margin-bottom: 40px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .card { background: #111; border: 1px solid #222; border-radius: 12px; padding: 24px; cursor: pointer; transition: border-color 0.2s; }
    .card:hover { border-color: #7c3aed; }
    .card .icon { font-size: 32px; margin-bottom: 12px; }
    .card .name { font-weight: 600; margin-bottom: 4px; }
    .card .desc { color: #888; font-size: 13px; margin-bottom: 16px; }
    .card .price { font-size: 20px; font-weight: 700; color: #7c3aed; }
    .activity { margin-top: 48px; }
    .activity h2 { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
    .log { background: #111; border: 1px solid #222; border-radius: 12px; padding: 16px; font-family: monospace; font-size: 13px; min-height: 120px; color: #0f0; }
    .log .entry { padding: 4px 0; border-bottom: 1px solid #1a1a1a; }
    .log .entry:last-child { border-bottom: none; }
    .log .ts { color: #666; margin-right: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">🛍️ Demo Store</div>
    <div class="badge">Obolus Agent Marketplace</div>
  </div>
  <div class="main">
    <h1>Developer Services</h1>
    <p class="subtitle">AI agents funded by Bags communities purchase services here</p>
    <div class="grid" id="services"></div>
    <div class="activity">
      <h2>Live Agent Purchases</h2>
      <div class="log" id="log"><span style="color:#666">Waiting for agent purchases...</span></div>
    </div>
  </div>
  <script>
    fetch('/services').then(r => r.json()).then(services => {
      document.getElementById('services').innerHTML = services.map(s => \`
        <div class="card">
          <div class="icon">${{'vercel-pro':'▲','openai-credits':'🤖','github-pro':'🐙','aws-credits':'☁️'}[s.id] || '📦'}</div>
          <div class="name">\${s.name}</div>
          <div class="desc">\${s.description}</div>
          <div class="price">$\${(s.price/100).toFixed(2)}/mo</div>
        </div>
      \`).join('');
    });

    // Poll for recent purchases
    const log = document.getElementById('log');
    let firstLoad = true;
    setInterval(() => {
      fetch('/recent').then(r => r.json()).then(entries => {
        if (!entries.length) return;
        if (firstLoad) { log.innerHTML = ''; firstLoad = false; }
        log.innerHTML = entries.map(e => \`
          <div class="entry">
            <span class="ts">\${new Date(e.at).toLocaleTimeString()}</span>
            ✅ Agent purchased <strong>\${e.service}</strong> — \${e.amount} (card ****\${e.card_last4})
          </div>
        \`).join('');
      }).catch(() => {});
    }, 2000);
  </script>
</body>
</html>`);
});

// Recent purchases for the live feed
const recentPurchases = [];
const _origPost = app.post.bind(app);
// Intercept purchase to track in-memory
app.use('/purchase', (req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (data) => {
    if (data?.success && data?.receipt) {
      recentPurchases.unshift({
        service: data.receipt.service,
        amount: data.receipt.amount,
        card_last4: data.receipt.card_last4,
        at: data.receipt.purchased_at,
      });
      if (recentPurchases.length > 20) recentPurchases.pop();
    }
    return origJson(data);
  };
  next();
});

app.get('/recent', (_req, res) => res.json(recentPurchases.slice(0, 10)));

app.listen(PORT, () => {
  console.log(`[demo] store running at http://localhost:${PORT}`);
  console.log(`[demo] Stripe: ${STRIPE_KEY ? 'real test mode' : 'simulated (no key)'}`);
});
