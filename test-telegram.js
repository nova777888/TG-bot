const https = require('https');
const token = process.env.TELEGRAM_BOT_TOKEN || 'test';
https.get('https://api.telegram.org/bot' + token + '/getMe', (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => { console.log('RESULT:', d); process.exit(0); });
}).on('error', e => { console.log('ERROR:', e.message); process.exit(1); });
