import re
path = r'C:\Users\86156\Documents\Codex\2026-06-23\new-chat\bot-check\src\bot.js'
with open(path, encoding='utf-8') as f:
    c = f.read()

# Add diagnostic middleware before auth middleware
old = "bot.use(async (ctx, next) => {\n  var userId = ctx.from && ctx.from.id;"
new = "// Diagnostic: log every incoming message\nbot.use(async (ctx, next) => {\n  console.log(\"[DIAG] Received from \" + ctx.from?.id + \": \" + (ctx.message?.text || \"\"));\n  await next();\n});\n\n" + old
c = c.replace(old, new, 1)

# Add /ping command before /vip command
old2 = "bot.command('vip', async (ctx) => {"
new2 = "bot.command('ping', async (ctx) => {\n  await ctx.reply('pong! Bot is alive @' + Date.now());\n  console.log('[DIAG] /ping responded');\n});\n\n" + old2
c = c.replace(old2, new2, 1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(c)
print('OK - bot.js modified')
