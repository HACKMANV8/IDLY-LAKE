const TelegramBot = require('node-telegram-bot-api');
const User = require('../models/User');
const GitHubService = require('../github/githubService');
const AIService = require('../ai/aiService');

class TelegramBotService {
    constructor() {
        this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
        this.githubService = new GitHubService();
        this.aiService = new AIService();
    }

    start() {
        console.log('🤖 Starting bot...');

        this.bot.getMe().then((botInfo) => {
            console.log(`✅ Bot ready: @${botInfo.username}`);
        }).catch((error) => {
            console.error('❌ Bot error:', error.message);
        });

        this.bot.onText(/\/start/, this.handleStart.bind(this));
        this.bot.on('message', this.handleMessage.bind(this));

        this.bot.on('polling_error', (error) => {
            console.error('❌ Polling error:', error.message);
        });
    }

    async handleStart(msg) {
        const chatId = msg.chat.id;
        const user = msg.from;

        try {
            await User.findOneAndUpdate(
                { telegramId: user.id.toString() },
                {
                    telegramId: user.id.toString(),
                    username: user.username || 'unknown',
                    firstName: user.first_name,
                    lastName: user.last_name
                },
                { upsert: true }
            );

            const message = `Hey ${user.first_name || 'there'}! 👋

I'm your website helper! I can create and edit websites for you.

Just tell me what you want in plain English:

🆕 **Create websites:**
• "Create a shoe store website"
• "Make a restaurant website" 
• "Build a portfolio site"

✏️ **Edit existing sites:**
• "Make my header blue"
• "Add a contact section"
• "Change the title to Welcome"

What would you like to do?`;

            await this.bot.sendMessage(chatId, message);
        } catch (error) {
            console.error('Start error:', error);
            await this.bot.sendMessage(chatId, "Hi! I help with websites. What can I do for you?");
        }
    }

    async handleMessage(msg) {
        const chatId = msg.chat.id;
        const text = msg.text;

        if (!text || text.startsWith('/start')) return;

        try {
            await this.bot.sendMessage(chatId, "Let me understand what you want... 🤔");

          
            console.log(`User request: ${text}`);
            const aiResponse = await this.aiService.interpretRequest(text);
            console.log('AI interpretation:', aiResponse);

    
            if (aiResponse.action === 'create_website') {
                await this.createWebsite(chatId, aiResponse, text);
            } else if (aiResponse.action === 'modify_website') {
                await this.modifyWebsite(chatId, aiResponse, text);
            } else if (aiResponse.action === 'chat') {
                await this.bot.sendMessage(chatId, aiResponse.message);
            } else {
                await this.bot.sendMessage(chatId, "I'm not sure what you want me to do. Can you try asking differently?");
            }

        } catch (error) {
            console.error('Message error:', error);
            await this.bot.sendMessage(chatId, `Sorry, I had trouble with that request. Error: ${error.message}`);
        }
    }

    async createWebsite(chatId, aiResponse, originalRequest) {
        try {
            
            let websiteType = aiResponse.website_type;
            if (websiteType === 'other' && (originalRequest.toLowerCase().includes('show') || originalRequest.toLowerCase().includes('shoe'))) {
                websiteType = 'shop';
            }

            await this.bot.sendMessage(chatId, `Perfect! Creating your ${websiteType} website... ✨`);

            
            const htmlContent = this.aiService.generateWebsiteHTML(websiteType, originalRequest);

            
            const siteName = `${websiteType}-site-${Date.now()}`;

            console.log(`Creating repository: ${siteName}`);

    
            const repo = await this.githubService.createRepository(siteName);
            console.log(`Repository created: ${repo.name}`);

           
            await this.githubService.updateFile(repo.name, 'index.html', htmlContent, 'Create website with AI');
            console.log('Website uploaded successfully');

            const successMessage = `🎉 Perfect! I created your ${websiteType} website!

📁 **GitHub repo:** ${repo.url}

Your code is ready! Now you can ask me to make changes like:
• "Make the header green"
• "Add my contact info" 
• "Change the colors"

What would you like to adjust?`;

            await this.bot.sendMessage(chatId, successMessage);

        } catch (error) {
            console.error('Create website error:', error);
            await this.bot.sendMessage(chatId, `Sorry, I couldn't create the website. Error: ${error.message}\n\nCan you try asking again?`);
        }
    }

    async modifyWebsite(chatId, aiResponse, userMessage) {
        try {
            await this.bot.sendMessage(chatId, "Got it! Making those changes... 🔧");

   
            const repos = await this.githubService.listRepositories();

            if (repos.length === 0) {
                await this.bot.sendMessage(chatId, "I don't see any websites to modify yet. Would you like me to create one first?");
                return;
            }

         
            const targetRepo = await this.aiService.findBestRepository(userMessage, repos);

            console.log(`Modifying repository: ${targetRepo.name}`);

            const currentHTML = await this.githubService.getFileContent(targetRepo.name, 'index.html');

            
            const newHTML = await this.applyChanges(currentHTML, aiResponse.changes, userMessage);

            if (newHTML !== currentHTML) {
                await this.githubService.updateFile(
                    targetRepo.name,
                    'index.html',
                    newHTML,
                    `AI Update: ${aiResponse.summary}`
                );

                const successMessage = `✅ Perfect! I made the changes!

${aiResponse.summary}

Your code is updated in GitHub. What else would you like me to change?`;

                await this.bot.sendMessage(chatId, successMessage);
            } else {
                await this.bot.sendMessage(chatId, "I couldn't make that specific change yet. Can you try describing it differently?");
            }

        } catch (error) {
            console.error('Modify website error:', error);
            await this.bot.sendMessage(chatId, `I had trouble making that change. Error: ${error.message}`);
        }
    }

    async applyChanges(html, changes, userMessage) {
        try {
           
            if (this.aiService.model) {
                const prompt = `
User wants to modify this HTML website: "${userMessage}"

Current HTML (first 2000 chars):
${html.substring(0, 2000)}...

Make the requested changes and return the complete modified HTML. Keep all existing content but apply the specific changes requested.

Changes requested: ${JSON.stringify(changes)}

Return only the complete HTML code, no explanations.
                `;

                const result = await this.aiService.model.generateContent(prompt);
                const response = await result.response;
                let modifiedHTML = response.text();

        
                if (modifiedHTML.includes('```html')) {
                    modifiedHTML = modifiedHTML.replace(/```html\n?/, '').replace(/\n?```$/, '');
                } else if (modifiedHTML.includes('```')) {
                    modifiedHTML = modifiedHTML.replace(/```\n?/, '').replace(/\n?```$/, '');
                }

         
                if (modifiedHTML.includes('<html') && modifiedHTML.includes('</html>')) {
                    return modifiedHTML;
                }
            }
        } catch (error) {
            console.error('AI modification error:', error);
        }

        
        return this.applySimpleChanges(html, changes);
    }

    applySimpleChanges(html, changes) {
        let newHTML = html;

      
        if (changes.header_color) {
            newHTML = newHTML.replace(
                /background:\s*[^;]+;/g,
                `background: ${changes.header_color};`
            );
        }


        if (changes.background_color) {
            newHTML = newHTML.replace(
                /body\s*{[^}]*}/g,
                `body { font-family: Arial, sans-serif; margin: 0; background: ${changes.background_color}; }`
            );
        }

    
        if (changes.title) {
            newHTML = newHTML.replace(/<h1>.*?<\/h1>/g, `<h1>${changes.title}</h1>`);
            newHTML = newHTML.replace(/<title>.*?<\/title>/g, `<title>${changes.title}</title>`);
        }

       
        if (changes.new_sections && changes.new_sections.includes('contact')) {
            if (!newHTML.includes('contact')) {
                const contactSection = `
    <div class="contact" style="background: #2c3e50; color: white; padding: 40px 20px; text-align: center; margin-top: 40px;">
        <h2>Contact Us</h2>
        <p>📧 hello@mywebsite.com</p>
        <p>📞 (555) 123-4567</p>
        <p>📍 123 Main Street, Your City</p>
    </div>`;

                newHTML = newHTML.replace('</body>', contactSection + '\n</body>');
            }
        }

        return newHTML;
    }
}

module.exports = TelegramBotService;