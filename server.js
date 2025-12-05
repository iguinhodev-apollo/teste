require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ======= VARIÁVEIS DE AMBIENTE =======
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI || 'https://devhostings.online/auth/discord/callback';
const SESSION_SECRET = process.env.SESSION_SECRET;
const MP_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;

if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !SESSION_SECRET) {
  console.error('Defina DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET e SESSION_SECRET no arquivo .env');
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.warn('ATENÇÃO: MERCADO_PAGO_ACCESS_TOKEN não definido. Depósitos PIX não vão funcionar.');
}

// ======= MIDDLEWARES =======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // em produção, atrás de HTTPS: true
      sameSite: 'lax'
    }
  })
);

// Arquivos estáticos (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ======= "BANCO" EM MEMÓRIA (apenas enquanto o servidor estiver rodando) =======
const balanceStore = new Map();        // userId -> saldo (Number)
const securityCodes = new Map();       // userId -> código de segurança (String)
const loginHistoryStore = new Map();   // userId -> [{ date, userAgent }]

// ======= AUTENTICAÇÃO DISCORD =======

// Redireciona para o Discord
app.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// Callback do Discord
app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send('Requisição inválida.');
  }

  delete req.session.oauthState;

  try {
    // Troca "code" por access_token
    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Busca dados do usuário
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const discordUser = userResponse.data;

    let avatarUrl = null;
    if (discordUser.avatar) {
      const isGif = discordUser.avatar.startsWith('a_');
      avatarUrl = `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.${
        isGif ? 'gif' : 'png'
      }?size=128`;
    }

    if (!balanceStore.has(discordUser.id)) {
      balanceStore.set(discordUser.id, 0); // saldo inicial 0
    }

    // Guarda sessão
    req.session.user = {
      id: discordUser.id,
      username: `${discordUser.username}#${discordUser.discriminator}`,
      avatarUrl,
      balance: balanceStore.get(discordUser.id)
    };

    // Registra histórico básico de login
    const userAgent = req.headers['user-agent'] || 'desconhecido';
    const entry = { date: new Date().toISOString(), userAgent };
    const history = loginHistoryStore.get(discordUser.id) || [];
    history.unshift(entry);
    loginHistoryStore.set(discordUser.id, history.slice(0, 20)); // limita a 20 últimos

    res.redirect('/');
  } catch (err) {
    console.error('Erro ao autenticar Discord:', err.response?.data || err.message);
    res.status(500).send('Erro ao autenticar com o Discord.');
  }
});

// ======= API: DADOS DO USUÁRIO LOGADO =======
app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ loggedIn: false });
  }

  const storedBalance = balanceStore.get(req.session.user.id) ?? 0;
  req.session.user.balance = storedBalance;

  res.json({
    loggedIn: true,
    user: req.session.user
  });
});

// ======= API: LOGOUT =======
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ======= API: CRIAR DEPÓSITO PIX (MERCADO PAGO) =======
app.post('/api/deposit/create', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  if (!MP_ACCESS_TOKEN) {
    return res
      .status(500)
      .json({ error: 'Configuração de Mercado Pago ausente. Defina MERCADO_PAGO_ACCESS_TOKEN.' });
  }

  const { amount } = req.body;
  const value = Number(amount);

  if (!Number.isFinite(value) || value < 1 || value > 50000) {
    return res.status(400).json({ error: 'Valor inválido. Use entre 1 e 50000.' });
  }

  try {
    const idempotencyKey = crypto.randomUUID();

    const paymentBody = {
      transaction_amount: value,
      description: `Depósito de saldo - usuário ${req.session.user.id}`,
      payment_method_id: 'pix',
      payer: {
        email: 'cliente@example.com' // troque por email real se tiver
      }
    };

    const mpResponse = await axios.post(
      'https://api.mercadopago.com/v1/payments',
      paymentBody,
      {
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey
        }
      }
    );

    const txData = mpResponse.data.point_of_interaction?.transaction_data;

    if (!txData || !txData.qr_code || !txData.qr_code_base64) {
      return res.status(500).json({ error: 'Resposta inesperada do Mercado Pago.' });
    }

    // Em produção, use webhook do Mercado Pago para creditar o saldo após aprovação.

    res.json({
      amount: value,
      qrCode: txData.qr_code,             // PIX copia e cola
      qrCodeBase64: txData.qr_code_base64 // imagem em base64
    });
  } catch (err) {
    console.error('Erro ao criar pagamento PIX:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao criar pagamento PIX.' });
  }
});

// ======= API: INFO DE SEGURANÇA (CÓDIGO + HISTÓRICO DE LOGINS) =======
app.get('/api/security/info', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }

  const userId = req.session.user.id;

  let code = securityCodes.get(userId);
  if (!code) {
    code = 'SEG-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    securityCodes.set(userId, code);
  }

  const history = loginHistoryStore.get(userId) || [];

  res.json({
    code,
    logins: history
  });
});

// ======= PÁGINA: SEGURANÇA (CÓDIGO + LOGINS + SCANNER QR) =======
app.get('/seguranca', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }

  const html = `
  <!DOCTYPE html>
  <html lang="pt-BR">
  <head>
    <meta charset="UTF-8"/>
    <title>Segurança da Conta</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: radial-gradient(circle at top left, #020617 0, #000000 55%, #020617 100%);
        color: #e5e7eb;
        min-height: 100vh;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:20px;
      }
      .wrapper {
        max-width: 1000px;
        width: 100%;
        display: grid;
        grid-template-columns: minmax(0,1.1fr) minmax(0,1fr);
        gap: 18px;
      }
      @media (max-width: 850px) {
        .wrapper {
          grid-template-columns: 1fr;
        }
      }
      .card {
        background: rgba(15,23,42,0.97);
        border-radius: 18px;
        padding: 22px 24px 20px;
        border: 1px solid rgba(148,163,184,0.55);
        box-shadow: 0 22px 60px rgba(0,0,0,0.95);
        position:relative;
        overflow:hidden;
      }
      .card::before{
        content:"";
        position:absolute;
        width:260px;
        height:260px;
        background: radial-gradient(circle, rgba(37,99,235,0.4), transparent 70%);
        top:-60px;
        right:-80px;
        opacity:0.6;
      }
      h1 {
        font-size: 1.3rem;
        margin-bottom: 4px;
        position:relative;
        z-index:1;
      }
      h2 {
        font-size: 1.05rem;
        margin-bottom: 6px;
        position:relative;
        z-index:1;
      }
      p {
        font-size: 0.9rem;
        color:#9ca3af;
        margin-bottom: 10px;
        position:relative;
        z-index:1;
      }
      .code-box {
        margin-top:12px;
        padding:10px 12px;
        border-radius:12px;
        background: rgba(15,23,42,0.9);
        border:1px solid rgba(148,163,184,0.7);
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:10px;
        position:relative;
        z-index:1;
      }
      .code-label {
        font-size:0.78rem;
        text-transform:uppercase;
        letter-spacing:0.08em;
        color:#9ca3af;
      }
      .code-value {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size:0.9rem;
      }
      .list {
        margin-top:12px;
        font-size:0.83rem;
        color:#9ca3af;
      }
      .list li {
        margin-left:18px;
        margin-bottom:4px;
      }
      .logins {
        margin-top:12px;
        padding:10px 12px;
        border-radius:12px;
        background: rgba(15,23,42,0.9);
        border:1px solid rgba(55,65,81,0.9);
        max-height:220px;
        overflow:auto;
        font-size:0.8rem;
      }
      .login-item {
        border-bottom:1px solid rgba(31,41,55,0.9);
        padding:6px 0;
      }
      .login-item:last-child {
        border-bottom:none;
      }
      .login-date {
        color:#e5e7eb;
      }
      .login-ua {
        color:#9ca3af;
      }
      .link-voltar {
        display:inline-block;
        margin-top:14px;
        font-size:0.85rem;
        color:#60a5fa;
        text-decoration:none;
        position:relative;
        z-index:1;
      }
      .link-voltar:hover { text-decoration:underline; }

      /* SCANNER */
      .scanner-header {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        position:relative;
        z-index:1;
      }
      .scanner-header small {
        font-size:0.8rem;
        color:#9ca3af;
      }
      .scanner-area {
        margin-top:10px;
        border-radius:16px;
        background: rgba(15,23,42,0.96);
        border:1px solid rgba(55,65,81,0.9);
        padding:10px;
        position:relative;
        overflow:hidden;
      }
      video {
        width:100%;
        border-radius:12px;
        background:#020617;
      }
      canvas {
        display:none;
      }
      .scanner-controls {
        margin-top:8px;
        display:flex;
        gap:10px;
        flex-wrap:wrap;
        font-size:0.82rem;
      }
      .scanner-controls button {
        padding:6px 12px;
        border-radius:999px;
        border:none;
        background: linear-gradient(135deg,#60a5fa,#2563eb);
        color:white;
        cursor:pointer;
      }
      .scanner-controls button.stop {
        background: rgba(148,163,184,0.3);
        border:1px solid rgba(148,163,184,0.7);
      }
      .scanner-controls button:hover {
        opacity:0.95;
      }
      .scanner-result {
        margin-top:10px;
        font-size:0.8rem;
        color:#cbd5f5;
      }
      .scanner-result pre {
        margin-top:4px;
        padding:6px 8px;
        border-radius:8px;
        background:#020617;
        border:1px solid rgba(55,65,81,0.9);
        max-height:150px;
        overflow:auto;
        white-space:pre-wrap;
        word-break:break-all;
      }
    </style>
  </head>
  <body>
    <div class="wrapper">
      <div class="card">
        <h1>Segurança da sua conta</h1>
        <p>
          Aqui você encontra o código de segurança da sua conta, um resumo dos últimos logins
          e pode usar seu dispositivo como chave de segurança.
        </p>

        <div class="code-box">
          <div>
            <div class="code-label">Código de segurança</div>
            <div class="code-value" id="sec-code">••••••••</div>
          </div>
        </div>

        <ul class="list">
          <li>Use este código apenas em canais oficiais do site.</li>
          <li>Nunca envie o código por chat público ou para desconhecidos.</li>
          <li>Se desconfiar de acesso indevido, altere sua senha do Discord.</li>
        </ul>

        <h2 style="margin-top:16px;">Últimos logins</h2>
        <p>Veja os dispositivos que acessaram recentemente sua conta.</p>
        <div class="logins" id="login-list">
          <div class="login-item">
            <span class="login-date">Carregando...</span>
          </div>
        </div>

        <a href="/" class="link-voltar">Voltar ao painel</a>
      </div>

      <div class="card">
        <div class="scanner-header">
          <h2>Scanner de QR Code</h2>
          <small>Use a câmera do dispositivo para ler QRs de acesso e segurança.</small>
        </div>

        <div class="scanner-area">
          <video id="video" playsinline></video>
          <canvas id="canvas"></canvas>

          <div class="scanner-controls">
            <button id="btn-start">Ativar câmera</button>
            <button id="btn-stop" class="stop">Parar</button>
          </div>

          <div class="scanner-result">
            <div>Último QR lido:</div>
            <pre id="scan-result">Nenhum ainda.</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Biblioteca jsQR para leitura de QR Code -->
    <script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"></script>
    <script>
      async function carregarInfoSeguranca() {
        try {
          const res = await fetch('/api/security/info');
          if (!res.ok) return;

          const data = await res.json();
          const codeEl = document.getElementById('sec-code');
          const listEl = document.getElementById('login-list');

          if (data.code) codeEl.textContent = data.code;

          listEl.innerHTML = '';
          if (!data.logins || data.logins.length === 0) {
            listEl.innerHTML = '<div class="login-item"><span class="login-date">Nenhum login registrado ainda.</span></div>';
            return;
          }

          data.logins.forEach((login) => {
            const div = document.createElement('div');
            div.className = 'login-item';
            const date = new Date(login.date);
            const dateStr = date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

            div.innerHTML = '<div class="login-date">' + dateStr + '</div>' +
                            '<div class="login-ua">' + (login.userAgent || '') + '</div>';
            listEl.appendChild(div);
          });
        } catch (e) {
          console.error('Erro ao carregar info de segurança', e);
        }
      }

      // Scanner de QR Code
      const video = document.getElementById('video');
      const canvas = document.getElementById('canvas');
      const ctx = canvas.getContext('2d');
      const btnStart = document.getElementById('btn-start');
      const btnStop = document.getElementById('btn-stop');
      const scanResult = document.getElementById('scan-result');

      let stream = null;
      let scanning = false;

      async function startCamera() {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }
          });
          video.srcObject = stream;
          video.play();
          scanning = true;
          requestAnimationFrame(tick);
        } catch (e) {
          console.error('Erro ao acessar câmera:', e);
          scanResult.textContent = 'Erro ao acessar câmera. Verifique permissões.';
        }
      }

      function stopCamera() {
        scanning = false;
        if (stream) {
          stream.getTracks().forEach(t => t.stop());
          stream = null;
        }
      }

      function tick() {
        if (!scanning) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });

          if (code && code.data) {
            scanResult.textContent = code.data;
          }
        }
        requestAnimationFrame(tick);
      }

      btnStart.addEventListener('click', () => {
        scanResult.textContent = 'Lendo... aponte a câmera para o QR Code.';
        startCamera();
      });

      btnStop.addEventListener('click', () => {
        stopCamera();
        scanResult.textContent = 'Leitura parada.';
      });

      window.addEventListener('beforeunload', stopCamera);

      carregarInfoSeguranca();
    </script>
  </body>
  </html>
  `;

  res.send(html);
});

// ======= PÁGINA: HISTÓRICO DE SALDO (SIMPLES) =======
app.get('/saldo/historico', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/');
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8"/>
      <title>Histórico de Saldo</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <style>
        body {
          background: #020617;
          color: #e5e7eb;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
        }
        .box {
          background: #020617;
          border-radius: 16px;
          padding: 24px 26px;
          border: 1px solid rgba(148,163,184,0.5);
          box-shadow: 0 20px 50px rgba(0,0,0,0.9);
          max-width: 480px;
          width: 100%;
        }
        h1 {
          font-size: 1.3rem;
          margin-bottom: 12px;
        }
        p {
          font-size: 0.9rem;
          color: #9ca3af;
          margin-bottom: 14px;
        }
        a {
          display: inline-block;
          margin-top: 8px;
          font-size: 0.9rem;
          color: #60a5fa;
          text-decoration: none;
        }
        a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Histórico de saldo</h1>
        <p>Área reservada para o histórico de saldo do usuário (integração com banco ou logs).</p>
        <a href="/">Voltar ao painel</a>
      </div>
    </body>
    </html>
  `);
});

// ======= 404 BONITO (para QUALQUER rota não encontrada) =======
app.use((req, res) => {
  if (req.method === 'GET') {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8"/>
        <title>Página não encontrada</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <style>
          * {margin:0;padding:0;box-sizing:border-box;}
          body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: radial-gradient(circle at top, #020617 0, #000000 55%, #020617 100%);
            color:#e5e7eb;
            min-height:100vh;
            display:flex;
            align-items:center;
            justify-content:center;
            padding:20px;
          }
          .card {
            background: rgba(15,23,42,0.96);
            border-radius: 18px;
            padding: 24px 26px 22px;
            border: 1px solid rgba(148,163,184,0.55);
            box-shadow: 0 22px 60px rgba(0,0,0,0.95);
            max-width: 420px;
            width:100%;
            text-align:center;
            position:relative;
            overflow:hidden;
          }
          .card::before {
            content:"";
            position:absolute;
            width:220px;
            height:220px;
            background: radial-gradient(circle, rgba(37,99,235,0.35), transparent 70%);
            top:-60px;
            right:-60px;
            opacity:0.7;
          }
          h1 {
            font-size:1.4rem;
            margin-bottom:8px;
            position:relative;
            z-index:1;
          }
          p {
            font-size:0.9rem;
            color:#9ca3af;
            margin-bottom:16px;
            position:relative;
            z-index:1;
          }
          button {
            position:relative;
            z-index:1;
            padding:8px 16px;
            border-radius:999px;
            border:none;
            background: linear-gradient(135deg,#60a5fa,#2563eb);
            color:white;
            font-size:0.9rem;
            font-weight:500;
            cursor:pointer;
            box-shadow:0 14px 32px rgba(37,99,235,0.7);
          }
          button:hover {
            background: linear-gradient(135deg,#93c5fd,#2563eb);
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Desculpe, essa página não existe</h1>
          <p>O link que você tentou acessar não foi encontrado. Volte para a tela inicial para continuar navegando.</p>
          <button onclick="window.location.href='/'">Voltar para a tela inicial</button>
        </div>
      </body>
      </html>
    `);
  }

  res.status(404).json({ error: 'Rota não encontrada.' });
});

// ======= START =======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ouvindo em http://localhost:${PORT}`);
});
