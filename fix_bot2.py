p = r'C:\Users\86156\Documents\Codex\2026-06-23\new-chat\bot-check\src\bot.js'
with open(p, encoding='utf-8') as f:
    c = f.read()

marker = "bot.use(async (ctx, next) => {"
handler = """# Global error handler
bot.catch((err) => {
  console.error('[BOT_ERROR]', err.message || err);
});

""" + marker
c = c.replace(marker, handler, 1)

marker2 = "bot.command('vip', async (ctx) => {"
ping = """# Simple ping test
bot.command('ping', async (ctx) => {
  await ctx.reply('pong!');
});

""" + marker2
c = c.replace(marker2, ping, 1)

with open(p, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK')
