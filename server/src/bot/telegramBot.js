import dotenv from 'dotenv';
dotenv.config();
import { Telegraf } from 'telegraf';
import axios from 'axios';
import { CONFIG } from '../config.js';

const BOT_TOKEN = CONFIG.TELEGRAM_BOT_TOKEN || '8373838662:AAFxh092CJToPEFgECTm_Ock0o0jcxFO41M';
const SERVER_URL = CONFIG.SERVER_URL;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply('Welcome! Send your link code to bind this chat to your web account.');
});

bot.hears(/^[a-z0-9\-]{6,12}$/i, async (ctx) => {
  const code = ctx.message.text.trim();
  try {
    const resp = await axios.post(`${SERVER_URL}/telegram/link`, { code, telegramId: String(ctx.chat.id) });
    const userId = resp?.data?.userId;
    await ctx.reply(userId ? 'Linked! You can now send commands like: create repo my-repo' : 'Linked!');
  } catch (e) {
    await ctx.reply('Invalid code or already used. Generate a new one from the website.');
  }
});

bot.hears(/^create repo (.+)$/i, async (ctx) => {
  const name = ctx.match[1].trim();
  try {
    const { data: userData } = await axios.get(`${SERVER_URL}/api/user-by-telegram`, { params: { telegramId: String(ctx.chat.id) } });
    const userId = userData?.user?._id;
    if (!userId) return ctx.reply('No linked account. Send your link code first.');

    const { data: tokenData } = await axios.post(`${SERVER_URL}/api/request-mediator-token`, { userId, allowedActions: ['create_repo'] });
    const mediatorJwt = tokenData?.mediatorJwt;
    const { data: execData } = await axios.post(`${SERVER_URL}/mediator/exec`, { mediatorJwt, action: 'create_repo', payload: { name, private: false } });
    await ctx.reply(`Repo created: ${execData?.repo?.full_name || name}`);
  } catch (e) {
    await ctx.reply('Failed to create repo. Ensure GitHub is connected and scopes allow repo create.');
  }
});

bot.hears(/^delete repo (.+)$/i, async (ctx) => {
  const repoName = ctx.match[1].trim();
  try {
    const { data: userData } = await axios.get(`${SERVER_URL}/api/user-by-telegram`, { params: { telegramId: String(ctx.chat.id) } });
    const userId = userData?.user?._id;
    if (!userId) return ctx.reply('No linked account. Send your link code first.');

    const { data: tokenData } = await axios.post(`${SERVER_URL}/api/request-mediator-token`, { userId, allowedActions: ['delete_repo'] });
    const mediatorJwt = tokenData?.mediatorJwt;
    const { data: execData } = await axios.post(`${SERVER_URL}/mediator/exec`, { mediatorJwt, action: 'delete_repo', payload: { repo: repoName } });
    await ctx.reply(execData?.ok ? `Repo deleted: ${repoName}` : 'Delete failed.');
  } catch (e) {
    await ctx.reply('Failed to delete repo. Ensure GitHub scopes include delete_repo and you own the repo.');
  }
});

bot.launch().then(() => console.log('Telegram bot started.')); 

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


