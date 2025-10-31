const express = require('express');
const router = express.Router();
const GitHubService = require('../github/githubService');

const githubService = new GitHubService();


router.get('/repos', async (req, res) => {
    try {
        const repos = await githubService.listRepositories();
        res.json({ repos });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


router.get('/repo/:repoName/files', async (req, res) => {
    try {
        const { repoName } = req.params;
        const files = await githubService.getRepositoryFiles(repoName);
        res.json({ files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


router.get('/repo/:repoName/file/:filePath(*)', async (req, res) => {
    try {
        const { repoName, filePath } = req.params;
        const content = await githubService.getFileContent(repoName, filePath);
        res.json({ content });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


router.put('/repo/:repoName/file/:filePath(*)', async (req, res) => {
    try {
        const { repoName, filePath } = req.params;
        const { content, message } = req.body;

        await githubService.updateFile(repoName, filePath, content, message || `Update ${filePath}`);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


router.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        github: !!process.env.GITHUB_TOKEN,
        telegram: !!process.env.TELEGRAM_BOT_TOKEN
    });
});

module.exports = router;