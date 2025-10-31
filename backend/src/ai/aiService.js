const { GoogleGenerativeAI } = require('@google/generative-ai');

class AIService {
    constructor() {
        if (process.env.GEMINI_API_KEY) {
            this.gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            this.model = this.gemini.getGenerativeModel({ model: "gemini-2.0-flash" });
        }
    }

    async interpretRequest(userMessage) {
        try {
            if (!this.model) {
                throw new Error('No AI service configured. Please add GEMINI_API_KEY to .env');
            }

            const prompt = `
You are a website builder assistant. A user wants something done with their website.

User request: "${userMessage}"

IMPORTANT: Only respond with JSON if the user is clearly asking to create or modify a website. 

For greetings, questions, or general chat, respond with:
{"action": "chat", "message": "appropriate response"}

For website requests, respond with:
{
  "action": "create_website" | "modify_website",
  "website_type": "restaurant" | "shop" | "portfolio" | "business" | "blog",
  "changes": {
    "title": "new title if requested",
    "header_color": "color if requested (hex code)",
    "content_changes": "description of content changes needed",
    "new_sections": ["list of new sections to add"]
  },
  "summary": "Brief description of what to do"
}

Examples:
- "hello" → {"action": "chat", "message": "Hi! I can help you create or modify websites. What would you like to do?"}
- "how are you" → {"action": "chat", "message": "I'm doing great! Ready to help with your website needs."}
- "create a shoe website" → {"action": "create_website", "website_type": "shop", ...}
- "make header blue" → {"action": "modify_website", "changes": {"header_color": "#3498db"}, ...}

Respond only with valid JSON.
      `;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const text = response.text();

           
            let cleanText = text.trim();
            if (cleanText.startsWith('```json')) {
                cleanText = cleanText.replace(/```json\n?/, '').replace(/\n?```$/, '');
            } else if (cleanText.startsWith('```')) {
                cleanText = cleanText.replace(/```\n?/, '').replace(/\n?```$/, '');
            }

            const parsed = JSON.parse(cleanText);
            console.log('AI Response:', parsed);

            return parsed;

        } catch (error) {
            console.error('AI Service Error:', error);

         
            return this.fallbackInterpretation(userMessage);
        }
    }

    fallbackInterpretation(userMessage) {
        const msg = userMessage.toLowerCase();

        const greetings = ['hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening'];
        const questions = ['how are you', 'what can you do', 'help', 'what do you do'];

        if (greetings.some(greeting => msg.includes(greeting))) {
            return {
                action: 'chat',
                message: 'Hi there! I can help you create and modify websites. Just tell me what you want!'
            };
        }

        if (questions.some(question => msg.includes(question))) {
            return {
                action: 'chat',
                message: 'I can create websites (like "create a shoe store") and modify them (like "make header blue"). What would you like to do?'
            };
        }

        
        if ((msg.includes('create') || msg.includes('build')) && (msg.includes('website') || msg.includes('site'))) {
            let websiteType = 'business';

            if (msg.includes('shoe') || msg.includes('show') || msg.includes('shop') || msg.includes('store')) websiteType = 'shop';
            else if (msg.includes('food') || msg.includes('restaurant')) websiteType = 'restaurant';
            else if (msg.includes('portfolio')) websiteType = 'portfolio';
            else if (msg.includes('blog')) websiteType = 'blog';

            return {
                action: 'create_website',
                website_type: websiteType,
                changes: {},
                summary: `Create a ${websiteType} website`
            };
        }

       
        if (msg.includes('make') || msg.includes('change') || msg.includes('add')) {
            const changes = {};

            if (msg.includes('header') && msg.includes('blue')) changes.header_color = '#3498db';
            else if (msg.includes('header') && msg.includes('red')) changes.header_color = '#e74c3c';
            else if (msg.includes('header') && msg.includes('green')) changes.header_color = '#27ae60';

            if (msg.includes('contact')) changes.new_sections = ['contact'];

            if (Object.keys(changes).length > 0) {
                return {
                    action: 'modify_website',
                    website_type: 'unknown',
                    changes: changes,
                    summary: 'Modify existing website'
                };
            }
        }

       
        return {
            action: 'chat',
            message: "I'm not sure what you want me to do. Try saying something like 'create a restaurant website' or 'make my header blue'."
        };
    }

    async findBestRepository(userMessage, repositories) {
        try {
            if (!this.model || repositories.length === 0) {
                return repositories[0] || null;
            }

            const repoList = repositories.map(repo => `- ${repo.name}`).join('\n');

            const prompt = `
User wants to modify a website and said: "${userMessage}"

Available repositories:
${repoList}

Which repository is the user most likely referring to? Consider:
- Exact name matches
- Similar names (shoe vs show)
- Website type keywords (shop, restaurant, portfolio, etc.)
- Context clues in the user message

Respond with just the repository name, nothing else.
            `;

            const result = await this.model.generateContent(prompt);
            const response = await result.response;
            const selectedRepoName = response.text().trim();

         
            const foundRepo = repositories.find(repo =>
                repo.name.toLowerCase().includes(selectedRepoName.toLowerCase()) ||
                selectedRepoName.toLowerCase().includes(repo.name.toLowerCase())
            );

            return foundRepo || repositories[0];

        } catch (error) {
            console.error('AI Repository Search Error:', error);

    
            return this.fallbackFindRepository(userMessage, repositories);
        }
    }

    fallbackFindRepository(userMessage, repositories) {
        const msg = userMessage.toLowerCase();

        
        for (const repo of repositories) {
            if (msg.includes(repo.name.toLowerCase())) {
                return repo;
            }
        }

        const keywords = {
            'shoe': ['shoe', 'show', 'shop'],
            'restaurant': ['restaurant', 'food', 'cafe'],
            'portfolio': ['portfolio', 'personal'],
            'business': ['business', 'company'],
            'blog': ['blog', 'writing']
        };

        for (const [type, words] of Object.entries(keywords)) {
            if (words.some(word => msg.includes(word))) {
                const found = repositories.find(repo => repo.name.toLowerCase().includes(type));
                if (found) return found;
            }
        }

        return repositories[0];
    }

    generateWebsiteHTML(websiteType, userRequest) {
        const templates = {
            shop: this.generateShopHTML(userRequest),
            restaurant: this.generateRestaurantHTML(),
            portfolio: this.generatePortfolioHTML(),
            business: this.generateBusinessHTML(),
            blog: this.generateBlogHTML()
        };

        return templates[websiteType] || templates.business;
    }

    generateShopHTML(userRequest) {
        const isShoeStore = userRequest.toLowerCase().includes('shoe');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${isShoeStore ? 'Shoe Paradise' : 'My Shop'}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Arial', sans-serif; line-height: 1.6; }
        
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; 
            padding: 60px 20px; 
            text-align: center; 
        }
        
        .header h1 { font-size: 3rem; margin-bottom: 10px; }
        .header p { font-size: 1.2rem; opacity: 0.9; }
        
        .container { max-width: 1200px; margin: 0 auto; padding: 40px 20px; }
        
        .products { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 30px; 
            margin: 40px 0; 
        }
        
        .product { 
            background: white; 
            border-radius: 15px; 
            padding: 25px; 
            text-align: center; 
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            transition: transform 0.3s ease;
        }
        
        .product:hover { transform: translateY(-5px); }
        
        .product-icon { font-size: 4rem; margin-bottom: 20px; }
        .product h3 { color: #333; margin-bottom: 15px; font-size: 1.5rem; }
        .product p { color: #666; margin-bottom: 20px; }
        .price { font-size: 1.5rem; font-weight: bold; color: #667eea; }
        
        .cta { 
            background: linear-gradient(45deg, #ff6b6b, #ee5a24);
            color: white; 
            padding: 60px 20px; 
            text-align: center; 
            margin-top: 40px;
        }
        
        .btn { 
            display: inline-block; 
            background: white; 
            color: #333; 
            padding: 15px 30px; 
            text-decoration: none; 
            border-radius: 25px; 
            font-weight: bold; 
            margin-top: 20px;
            transition: transform 0.3s ease;
        }
        
        .btn:hover { transform: scale(1.05); }
        
        .contact { 
            background: #2c3e50; 
            color: white; 
            padding: 40px 20px; 
            text-align: center; 
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${isShoeStore ? '👟 Shoe Paradise' : '🛍️ My Shop'}</h1>
        <p>${isShoeStore ? 'Step into style with our amazing shoe collection' : 'Quality products at great prices'}</p>
    </div>
    
    <div class="container">
        <h2>Featured Products</h2>
        
        <div class="products">
            <div class="product">
                <div class="product-icon">${isShoeStore ? '👟' : '📱'}</div>
                <h3>${isShoeStore ? 'Running Shoes' : 'Smartphone'}</h3>
                <p>${isShoeStore ? 'Comfortable running shoes for daily workouts' : 'Latest smartphone with amazing features'}</p>
                <div class="price">$${isShoeStore ? '89' : '299'}</div>
            </div>
            
            <div class="product">
                <div class="product-icon">${isShoeStore ? '👠' : '💻'}</div>
                <h3>${isShoeStore ? 'Dress Shoes' : 'Laptop'}</h3>
                <p>${isShoeStore ? 'Elegant shoes for special occasions' : 'Powerful laptop for work and gaming'}</p>
                <div class="price">$${isShoeStore ? '129' : '799'}</div>
            </div>
            
            <div class="product">
                <div class="product-icon">${isShoeStore ? '🥾' : '🎧'}</div>
                <h3>${isShoeStore ? 'Boots' : 'Headphones'}</h3>
                <p>${isShoeStore ? 'Durable boots for outdoor adventures' : 'Premium sound quality headphones'}</p>
                <div class="price">$${isShoeStore ? '149' : '199'}</div>
            </div>
        </div>
    </div>
    
    <div class="cta">
        <h2>Ready to Shop?</h2>
        <p>Browse our full collection and find exactly what you're looking for!</p>
        <a href="#" class="btn">Shop Now</a>
    </div>
    
    <div class="contact">
        <h2>Get In Touch</h2>
        <p>📧 shop@${isShoeStore ? 'shoeparadise' : 'myshop'}.com</p>
        <p>📞 (555) 123-SHOP</p>
        <p>🚚 Free shipping on orders over $50</p>
    </div>
</body>
</html>`;
    }

    generateRestaurantHTML() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Delicious Bites Restaurant</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Arial', sans-serif; }
        
        .header { 
            background: linear-gradient(135deg, #e74c3c 0%, #c0392b 100%);
            color: white; 
            padding: 60px 20px; 
            text-align: center; 
        }
        
        .header h1 { font-size: 3rem; margin-bottom: 10px; }
        .container { max-width: 1000px; margin: 0 auto; padding: 40px 20px; }
        
        .menu { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 25px; 
        }
        
        .dish { 
            background: #f8f9fa; 
            padding: 25px; 
            border-radius: 10px; 
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        
        .contact { 
            background: #2c3e50; 
            color: white; 
            padding: 40px 20px; 
            text-align: center; 
            margin-top: 40px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🍕 Delicious Bites</h1>
        <p>Fresh, tasty meals made with love</p>
    </div>
    
    <div class="container">
        <h2>Our Menu</h2>
        <div class="menu">
            <div class="dish">
                <h3>🍔 Gourmet Burger - $14</h3>
                <p>Juicy beef patty with premium toppings</p>
            </div>
            <div class="dish">
                <h3>🍕 Wood-Fired Pizza - $18</h3>
                <p>Authentic Italian pizza from our wood oven</p>
            </div>
            <div class="dish">
                <h3>🥗 Fresh Garden Salad - $12</h3>
                <p>Crisp vegetables with house dressing</p>
            </div>
        </div>
    </div>
    
    <div class="contact">
        <h2>Visit Us Today!</h2>
        <p>📍 123 Food Street, Flavor Town</p>
        <p>📞 (555) 123-FOOD</p>
        <p>🕒 Open Daily 11am - 10pm</p>
    </div>
</body>
</html>`;
    }

    generateBusinessHTML() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Professional Services</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Arial', sans-serif; }
        
        .header { 
            background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
            color: white; 
            padding: 60px 20px; 
            text-align: center; 
        }
        
        .header h1 { font-size: 3rem; margin-bottom: 10px; }
        .container { max-width: 1000px; margin: 0 auto; padding: 40px 20px; }
        
        .services { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 25px; 
        }
        
        .service { 
            background: #f8f9fa; 
            padding: 25px; 
            border-radius: 10px; 
            text-align: center;
        }
        
        .contact { 
            background: #2c3e50; 
            color: white; 
            padding: 40px 20px; 
            text-align: center; 
            margin-top: 40px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>💼 Professional Services</h1>
        <p>Expert solutions for your business needs</p>
    </div>
    
    <div class="container">
        <h2>What We Offer</h2>
        <div class="services">
            <div class="service">
                <h3>🎯 Consulting</h3>
                <p>Strategic advice to grow your business</p>
            </div>
            <div class="service">
                <h3>📊 Analytics</h3>
                <p>Data insights for better decisions</p>
            </div>
            <div class="service">
                <h3>🚀 Growth</h3>
                <p>Scalable solutions for expansion</p>
            </div>
        </div>
    </div>
    
    <div class="contact">
        <h2>Let's Work Together</h2>
        <p>📧 hello@professional.com</p>
        <p>📞 (555) 123-4567</p>
        <p>🌐 Ready to help you succeed</p>
    </div>
</body>
</html>`;
    }

    generatePortfolioHTML() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Portfolio</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Arial', sans-serif; }
        
        .header { 
            background: linear-gradient(135deg, #9b59b6 0%, #8e44ad 100%);
            color: white; 
            padding: 60px 20px; 
            text-align: center; 
        }
        
        .header h1 { font-size: 3rem; margin-bottom: 10px; }
        .container { max-width: 1000px; margin: 0 auto; padding: 40px 20px; }
        
        .projects { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
            gap: 25px; 
        }
        
        .project { 
            background: #f8f9fa; 
            padding: 25px; 
            border-radius: 10px; 
        }
        
        .contact { 
            background: #2c3e50; 
            color: white; 
            padding: 40px 20px; 
            text-align: center; 
            margin-top: 40px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🎨 My Portfolio</h1>
        <p>Creative designer & developer</p>
    </div>
    
    <div class="container">
        <h2>My Work</h2>
        <div class="projects">
            <div class="project">
                <h3>🌐 Web Design</h3>
                <p>Modern, responsive websites</p>
            </div>
            <div class="project">
                <h3>📱 Mobile Apps</h3>
                <p>User-friendly mobile applications</p>
            </div>
            <div class="project">
                <h3>🎨 Branding</h3>
                <p>Complete brand identity design</p>
            </div>
        </div>
    </div>
    
    <div class="contact">
        <h2>Let's Create Together</h2>
        <p>📧 hello@myportfolio.com</p>
        <p>📞 (555) 123-4567</p>
        <p>💼 Available for freelance work</p>
    </div>
</body>
</html>`;
    }

    generateBlogHTML() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My Blog</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Arial', sans-serif; }
        
        .header { 
            background: linear-gradient(135deg, #27ae60 0%, #229954 100%);
            color: white; 
            padding: 60px 20px; 
            text-align: center; 
        }
        
        .header h1 { font-size: 3rem; margin-bottom: 10px; }
        .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
        
        .posts { margin: 40px 0; }
        
        .post { 
            background: #f8f9fa; 
            padding: 25px; 
            border-radius: 10px; 
            margin-bottom: 25px;
        }
        
        .contact { 
            background: #2c3e50; 
            color: white; 
            padding: 40px 20px; 
            text-align: center; 
            margin-top: 40px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📝 My Blog</h1>
        <p>Thoughts, ideas, and stories</p>
    </div>
    
    <div class="container">
        <div class="posts">
            <div class="post">
                <h3>Welcome to My Blog</h3>
                <p><small>Posted on January 15, 2024</small></p>
                <p>This is my first blog post. I'll be sharing interesting thoughts and experiences here.</p>
            </div>
            <div class="post">
                <h3>Getting Started with Web Development</h3>
                <p><small>Posted on January 10, 2024</small></p>
                <p>Here are some tips for beginners who want to learn web development...</p>
            </div>
        </div>
    </div>
    
    <div class="contact">
        <h2>Subscribe</h2>
        <p>📧 subscribe@myblog.com</p>
        <p>📞 Follow me on social media</p>
        <p>✍️ New posts every week</p>
    </div>
</body>
</html>`;
    }
}

module.exports = AIService;