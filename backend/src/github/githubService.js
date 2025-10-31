const { Octokit } = require('@octokit/rest');
const { v4: uuidv4 } = require('uuid');

class GitHubService {
    constructor() {
        this.octokit = new Octokit({
            auth: process.env.GITHUB_TOKEN
        });
        this.owner = process.env.GITHUB_OWNER;
    }

    async createRepository(siteName) {
        try {
            const repoName = `${siteName}-${uuidv4().slice(0, 8)}`;

            const { data: repo } = await this.octokit.rest.repos.createForAuthenticatedUser({
                name: repoName,
                description: `Website: ${siteName}`,
                private: false,
                auto_init: true
            });

            return {
                name: repo.name,
                url: repo.html_url
            };
        } catch (error) {
            throw new Error(`Failed to create repository: ${error.message}`);
        }
    }

    async listRepositories() {
        try {
            const { data } = await this.octokit.rest.repos.listForAuthenticatedUser({
                sort: 'updated',
                per_page: 50
            });

            return data.map(repo => ({
                name: repo.name,
                updated_at: repo.updated_at,
                full_name: repo.full_name
            }));
        } catch (error) {
            throw new Error(`Failed to list repositories: ${error.message}`);
        }
    }

    async findRepository(searchTerm) {
        try {
            const repos = await this.listRepositories();

          
            let found = repos.find(repo => repo.name.toLowerCase() === searchTerm.toLowerCase());
            if (found) return found;

           
            found = repos.find(repo => repo.name.toLowerCase().includes(searchTerm.toLowerCase()));
            if (found) return found;

           
            const keywords = ['shoe', 'shop', 'restaurant', 'food', 'portfolio', 'business', 'blog'];
            for (const keyword of keywords) {
                if (searchTerm.toLowerCase().includes(keyword)) {
                    found = repos.find(repo => repo.name.toLowerCase().includes(keyword));
                    if (found) return found;
                }
            }

            return null;
        } catch (error) {
            throw new Error(`Failed to find repository: ${error.message}`);
        }
    }

    async getRepositoryFiles(repoName) {
        try {
            const { data } = await this.octokit.rest.repos.getContent({
                owner: this.owner,
                repo: repoName,
                path: ''
            });

            const items = Array.isArray(data) ? data : [data];

            return items.map(item => ({
                name: item.name,
                path: item.path,
                type: item.type
            }));
        } catch (error) {
            throw new Error(`Failed to get files: ${error.message}`);
        }
    }

    async getFileContent(repoName, filePath) {
        try {
            const { data } = await this.octokit.rest.repos.getContent({
                owner: this.owner,
                repo: repoName,
                path: filePath
            });

            return Buffer.from(data.content, 'base64').toString('utf-8');
        } catch (error) {
            throw new Error(`Failed to get file: ${error.message}`);
        }
    }

    async updateFile(repoName, filePath, content, message) {
        try {
            let sha;
            try {
                const { data: currentFile } = await this.octokit.rest.repos.getContent({
                    owner: this.owner,
                    repo: repoName,
                    path: filePath
                });
                sha = currentFile.sha;
            } catch (error) {
               
            }

            await this.octokit.rest.repos.createOrUpdateFileContents({
                owner: this.owner,
                repo: repoName,
                path: filePath,
                message: message,
                content: Buffer.from(content).toString('base64'),
                ...(sha && { sha })
            });

            return true;
        } catch (error) {
            throw new Error(`Failed to update file: ${error.message}`);
        }
    }
}

module.exports = GitHubService;