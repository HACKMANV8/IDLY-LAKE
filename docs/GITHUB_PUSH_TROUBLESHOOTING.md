# GitHub Push - Troubleshooting Guide

## Expected Behavior

When you push to GitHub, your repository should contain:
- ✅ Real files with actual names (package.json, src/App.jsx, etc.)
- ✅ Real content inside files (React code, package config, etc.)
- ✅ Proper folder structure maintained
- ✅ All project dependencies and config

## Common Issues & Solutions

### Issue 1: "No active sandbox"
**Error**: `No active sandbox`

**Cause**: You tried to push without creating a project first

**Solution**:
1. Create a project first by typing a prompt
2. Wait for code generation
3. Then click GitHub icon

---

### Issue 2: "GitHub authentication failed"
**Error**: `GitHub authentication failed (401)`

**Cause**: Token is invalid or expired

**Solution**:
1. Go to: https://github.com/settings/tokens
2. Create a NEW token with:
   - ✅ `repo` permission
   - ✅ `delete_repo` permission
3. Copy the new token
4. Try pushing again

---

### Issue 3: Repository created but no files pushed
**Error**: Repo exists on GitHub but is empty

**Cause**: Git push failed (usually permission issue)

**Solution**:
1. Check if token has `delete_repo` permission
2. Try with a NEW token
3. Check if repo name is valid (only alphanumeric, hyphens, underscores)

---

### Issue 4: Files still have numeric names (0, 1, 2)
**Error**: Files named "0", "1", "2" with random content

**Cause**: This was the OLD bug - you're using the NEW solution!

**Solution**: 
- If you see this, the code wasn't fully updated
- Check that push-to-github/route.ts has the ZIP extraction code
- Restart the dev server

---

## Debugging Steps

### Step 1: Check Server Logs
When you push, look at the terminal running `npm run dev`:
```
[push-to-github] Step 1: Creating zip file from sandbox...
[push-to-github] Step 2: Reading and encoding zip...
[push-to-github] Step 3: Saving and extracting zip...
[push-to-github] Step 4: Copying extracted files to repo directory...
[push-to-github] Step 5: Initializing git repository...
[push-to-github] Step 6: Authenticating with GitHub...
[push-to-github] Step 7: Checking for existing repository...
[push-to-github] Step 8: Creating GitHub repository...
[push-to-github] Step 9: Pushing to GitHub...
```

If any step fails, you'll see the error

### Step 2: Check GitHub Web UI
After push completes:
1. Go to https://github.com/Prish399/your-repo-name
2. Click on a few files to verify content
3. Check that files have proper names (not 0, 1, 2)

### Step 3: Manual Git Test
To test locally after GitHub push:
```bash
# Clone the repo
git clone https://github.com/Prish399/your-repo-name
cd your-repo-name

# Check files
ls -la
cat package.json
cat src/App.jsx
```

---

## Success Checklist

- ✅ Repository created on GitHub
- ✅ Files have proper names (not numeric)
- ✅ Files have actual content (not random text)
- ✅ Project structure is correct
- ✅ Can clone and run locally

---

## Getting Help

If you're still having issues:

1. **Check server logs** - look for [push-to-github] messages
2. **Verify token** - test it with the PowerShell script
3. **Check permissions** - token must have repo and delete_repo
4. **Try new token** - old tokens might be expired
5. **Restart server** - changes might need rebuild

---

**Ready to try again?** Generate a project and push! 🚀
