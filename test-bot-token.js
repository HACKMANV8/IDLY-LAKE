require('dotenv').config({ path: './backend/.env' });
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.TELEGRAM_BOT_TOKEN;

console.log('🔍 Testing Telegram Bot Token...');
console.log(`Token: ${token ? token.substring(0, 10) + '...' : 'NOT FOUND'}`);

if (!token) {
    console.error('❌ No TELEGRAM_BOT_TOKEN found in .env file');
    process.exit(1);
}

const bot = new TelegramBot(token);

bot.getMe()
    .then((botInfo) => {
        console.log('✅ Bot token is valid!');
        console.log(`Bot name: ${botInfo.first_name}`);
        console.log(`Bot username: @${botInfo.username}`);
        console.log(`Bot ID: ${botInfo.id}`);
        console.log('\n🚀 Your bot is ready to use!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('❌ Bot token is invalid:', error.message);
        console.log('\n💡 To fix this:');
        console.log('1. Open Telegram and message @BotFather');
        console.log('2. Send /newbot');
        console.log('3. Follow the instructions to create a new bot');
        console.log('4. Copy the new token to your .env file');
        process.exit(1);
    });