const https = require('https');
const token = process.env.TELEGRAM_BOT_TOKEN;
const api = 'https://api.telegram.org/bot' + token;
const calls = [
  '/deleteWebhook?drop_pending_updates=true',
  '/getUpdates?offset=-1&timeout=1',
  '/getUpdates?offset=-2&timeout=1'
];
let done = 0;
calls.forEach(p => {
  https.get(api + p, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      console.log('OK:', p.substring(0, 30), d.substring(0, 100));
      if (++done === calls.length) process.exit(0);
    });
  }).on('error', e => {
    console.log('FAIL:', p.substring(0, 30), e.message);
    if (++done === calls.length) process.exit(1);
  });
});
