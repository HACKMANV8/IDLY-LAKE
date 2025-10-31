# GitHub Push Feature Setup Guide

## Overview
The GitHub Push feature allows you to automatically push your generated projects directly to a GitHub repository without needing to download and manually push them.

## How to Use

### Prerequisites
1. A GitHub account
2. A Personal Access Token with the following permissions:
   - `repo` - Full control of private repositories
   - `delete_repo` - Delete repositories (optional, but recommended if you want to update existing repos)

### Step 1: Create a GitHub Personal Access Token

1. Go to [GitHub Settings → Tokens (classic)](https://github.com/settings/tokens)
2. Click **"Generate new token"** → **"Generate new token (classic)"**
3. Fill in the token name (e.g., "WebGenie Token")
4. Set expiration date (e.g., "No expiration" or choose a timeframe)
5. Select scopes:
   - Check ✅ `repo` (Full control of private repositories)
   - Check ✅ `delete_repo` (Delete repositories)
6. Click **"Generate token"**
7. **Copy the token** - You won't be able to see it again!

### Step 2: Use the Feature in WebGenie

1. After generating your project in WebGenie, click the **GitHub icon button** (next to the download button)
2. A dialog will appear asking for:
   - **Repository Name**: Enter your desired repository name (e.g., `my-awesome-app`)
   - **GitHub Personal Access Token**: Paste your token from Step 1
3. Click **"Push to GitHub"**
4. WebGenie will:
   - Create a new repository on your GitHub account
   - Initialize a git repository with your files
   - Push all code to the repository
   - Display the repository URL

### Step 3: Access Your Repository

Once the push is successful, you'll see the repository URL in the chat. You can:
- Visit your repository on GitHub
- Clone it locally: `git clone <repo-url>`
- Make changes and push updates

## Features

✅ **Automatic Repository Creation** - Creates a new repo on GitHub automatically
✅ **Token-Based Authentication** - Secure OAuth authentication
✅ **Custom Repository Names** - Choose any valid GitHub repository name
✅ **Auto-Update** - If a repo with the same name exists, it can be updated
✅ **Real-time Feedback** - Get status updates as files are pushed

## Security Notes

- Your GitHub token is **only used during the push process**
- It's **never stored** on our servers
- Each session requires you to provide the token again
- Use a token with limited permissions and expiration date
- You can revoke tokens anytime from your GitHub settings

## Troubleshooting

### "Invalid GitHub token"
- Verify your token is correct
- Check that the token hasn't expired
- Ensure it has `repo` and `delete_repo` scopes

### "Repository name already exists"
- The system will delete and recreate the repository
- If it fails, manually delete it from GitHub first

### "Failed to push to GitHub"
- Check your internet connection
- Verify the token has correct permissions
- Ensure repository name is valid (alphanumeric, hyphens, underscores only)

## What Gets Pushed

All files generated in your sandbox are pushed to GitHub, including:
- Source code (React, Vue, etc.)
- Configuration files (package.json, etc.)
- Styles and assets
- Project documentation

## Next Steps After Pushing

```bash
# Clone your repository
git clone <your-repo-url>
cd <repo-name>

# Install dependencies
npm install

# Start development
npm run dev
```

## Need Help?

If you encounter issues:
1. Check the error message in the WebGenie chat
2. Verify your GitHub token is valid
3. Ensure you have internet connectivity
4. Try with a freshly generated token

---

Happy coding! 🚀
