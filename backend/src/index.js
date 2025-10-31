require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const TelegramBot = require('./bot/telegramBot');

const app = express();
const PORT = process.env.PORT || 3001;


app.use(cors());
app.use(express.json());


mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/github-bot')
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB connection error:', err));


app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        services: {
            github: !!process.env.GITHUB_TOKEN,
            telegram: !!process.env.TELEGRAM_BOT_TOKEN,
            gemini: !!process.env.GEMINI_API_KEY,
            openai: !!process.env.OPENAI_API_KEY
        }
    });
});


console.log('🤖 Starting Telegram Bot...');
const telegramBot = new TelegramBot();
telegramBot.start();

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Telegram bot is active`);
    console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

module.exports = app;