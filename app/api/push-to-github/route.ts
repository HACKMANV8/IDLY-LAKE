import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { mkdir } from 'fs/promises';

const execAsync = promisify(exec);

declare global {
  var activeSandbox: any;
}

export async function POST(request: NextRequest) {
  try {
    const { repoName, githubToken } = await request.json();

    if (!repoName || !githubToken) {
      return NextResponse.json(
        { success: false, error: 'Repository name and GitHub token are required' },
        { status: 400 }
      );
    }

    if (!global.activeSandbox) {
      return NextResponse.json(
        { success: false, error: 'No active sandbox' },
        { status: 400 }
      );
    }

    // Sanitize repo name (GitHub allows alphanumeric, hyphens, underscores)
    const sanitizedRepoName = repoName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();

    // Create a temporary directory for the project
    const tempDir = path.join(os.tmpdir(), `github-push-${Date.now()}`);
    const zipPath = path.join(tempDir, 'project.zip');
    const extractDir = path.join(tempDir, 'extracted');
    
    await mkdir(tempDir, { recursive: true });
    await mkdir(extractDir, { recursive: true });

    try {
      console.log('[push-to-github] Creating zip file from sandbox...');
      
      // Create zip file in sandbox (same as download)
      const createZipResult = await global.activeSandbox.runCode(`
import zipfile
import os
import json

os.chdir('/home/user/app')

# Create zip file
with zipfile.ZipFile('/tmp/project.zip', 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk('.'):
        # Skip node_modules and .git
        dirs[:] = [d for d in dirs if d not in ['node_modules', '.git', '.next', 'dist', '.turbo']]
        
        for file in files:
            file_path = os.path.join(root, file)
            arcname = os.path.relpath(file_path, '.')
            zipf.write(file_path, arcname)

# Get file size
file_size = os.path.getsize('/tmp/project.zip')
print(f"Created project.zip ({file_size} bytes)")
      `);

      console.log('[push-to-github]', createZipResult.logs.stdout.join(''));

      // Read and encode the zip file
      const readZipResult = await global.activeSandbox.runCode(`
import base64

with open('/tmp/project.zip', 'rb') as f:
    content = f.read()
    encoded = base64.b64encode(content).decode('utf-8')
    print(encoded)
      `);

      const zipBase64 = readZipResult.logs.stdout.join('').trim();
      
      if (!zipBase64) {
        throw new Error('Failed to create or read zip file from sandbox');
      }

      console.log('[push-to-github] Converting base64 to buffer...');
      
      // Convert base64 to buffer and write to disk
      const zipBuffer = Buffer.from(zipBase64, 'base64');
      await fs.promises.writeFile(zipPath, zipBuffer);
      
      console.log('[push-to-github] Extracting zip file using system command...');
      
      // Extract zip file using system command
      if (os.platform() === 'win32') {
        // Windows: Use PowerShell
        await execAsync(
          `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
          { shell: 'powershell.exe', maxBuffer: 50 * 1024 * 1024 }
        );
      } else {
        // Linux/Mac: Use unzip
        await execAsync(`unzip -q "${zipPath}" -d "${extractDir}"`, { 
          maxBuffer: 50 * 1024 * 1024 
        });
      }
      
      console.log('[push-to-github] Zip extracted successfully');

      // Find the actual source directory (might be nested)
      let sourceDir = extractDir;
      const extractedContents = fs.readdirSync(extractDir);
      
      if (extractedContents.length === 1) {
        const singleItem = path.join(extractDir, extractedContents[0]);
        if (fs.statSync(singleItem).isDirectory()) {
          sourceDir = singleItem;
        }
      }

      // Create repo directory and copy files
      const repoDir = path.join(tempDir, 'repo');
      await mkdir(repoDir, { recursive: true });

      const copyFiles = (src: string, dest: string) => {
        const files = fs.readdirSync(src);
        for (const file of files) {
          const srcPath = path.join(src, file);
          const destPath = path.join(dest, file);
          
          if (fs.statSync(srcPath).isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyFiles(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      };

      copyFiles(sourceDir, repoDir);
      console.log('[push-to-github] Files copied to repo directory');

      console.log('[push-to-github] Adding vercel.json and GitHub workflow files...');
      
      const vercelJsonContent = {
        buildCommand: "npm run build",
        outputDirectory: "dist",
        cleanUrls: true,
        rewrites: [
          { source: "/(.*)", destination: "/index.html" }
        ]
      };
      
      fs.writeFileSync(
        path.join(repoDir, 'vercel.json'),
        JSON.stringify(vercelJsonContent, null, 2)
      );
      
      const workflowDir = path.join(repoDir, '.github', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      
      const workflowContent = `name: Deploy to Vercel

on:
  push:
    branches: [ "main" ]

permissions:
  contents: read
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build project
        run: npm run build

      - name: Remove .vercel directory if exists
        run: rm -rf .vercel || true

      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        env:
          VERCEL_ORG_ID: team_lsgVoFh7EXKNEue8or2kAyof
          VERCEL_PROJECT_ID: prj_2rOdKgArVCXUk2sqe8O1XvCi37bk
        with:
          vercel-token: j7blm4aGZAf8zR1zMcJGYSvz
          vercel-org-id: team_96O29gel90O2knTw1NX6n0UA
          vercel-project-id: prj_cmiOqLgc8HBOtCEPmHpYQXhlvq27
          vercel-args: '--prod --force'
`;
      
      fs.writeFileSync(
        path.join(workflowDir, 'vercel-deploy.yml'),
        workflowContent
      );
      
      console.log('[push-to-github] Added vercel.json and vercel-deploy.yml');

      console.log('[push-to-github] Initializing git repository...');
      
      const gitCommands = [
        'git init',
        'git config user.name "WebGenie Bot"',
        'git config user.email "bot@webgenie.ai"',
        'git add .',
        'git commit -m "Initial commit from WebGenie"',
        'git branch -M main',
      ];

      // Execute git commands in the repo directory
      for (const cmd of gitCommands) {
        try {
          const { stdout, stderr } = await execAsync(cmd, { cwd: repoDir });
          if (stderr && !stderr.includes('hint:')) {
            console.log(`Git command: ${cmd}`, stderr);
          }
        } catch (err: any) {
          if (!err.message?.includes('nothing to commit') && !err.message?.includes('changes not staged')) {
            console.error(`Git command failed: ${cmd}`, err.message);
          }
        }
      }

      // Get GitHub username from token
      const githubApiResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'WebGenie-Bot',
        },
      });

      if (!githubApiResponse.ok) {
        const errorBody = await githubApiResponse.text();
        console.error('GitHub API Error Response:', {
          status: githubApiResponse.status,
          statusText: githubApiResponse.statusText,
          body: errorBody,
          token: githubToken.substring(0, 20) + '...',
        });
        throw new Error(
          `GitHub authentication failed (${githubApiResponse.status}): ${githubApiResponse.statusText}. Make sure your token is valid and has 'repo' and 'delete_repo' permissions.`
        );
      }

      const githubUser = await githubApiResponse.json();
      const username = githubUser.login;

      // Check if repo already exists and delete if necessary
      const checkRepoResponse = await fetch(
        `https://api.github.com/repos/${username}/${sanitizedRepoName}`,
        {
          headers: {
            Authorization: `token ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (checkRepoResponse.ok) {
        // Repo exists, try to delete it
        try {
          const deleteResponse = await fetch(
            `https://api.github.com/repos/${username}/${sanitizedRepoName}`,
            {
              method: 'DELETE',
              headers: {
                Authorization: `token ${githubToken}`,
                Accept: 'application/vnd.github.v3+json',
              },
            }
          );

          if (!deleteResponse.ok) {
            console.log('Could not delete existing repository');
          }

          // Small delay to ensure deletion is processed
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } catch (err) {
          console.error('Error deleting existing repo:', err);
        }
      }

      // Create new repository on GitHub
      const createRepoResponse = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: sanitizedRepoName,
          description: `Generated with WebGenie AI - ${new Date().toLocaleString()}`,
          private: false,
          auto_init: false,
        }),
      });

      if (!createRepoResponse.ok) {
        const errorData = await createRepoResponse.json();
        throw new Error(`Failed to create repository: ${errorData.message}`);
      }

      const repoData = await createRepoResponse.json();
      const repoUrl = `https://github.com/${username}/${sanitizedRepoName}`;

      // Add remote and push
      console.log('[push-to-github] Adding remote and pushing code...');
      const remoteUrl = `https://oauth:${githubToken}@github.com/${username}/${sanitizedRepoName}.git`;

      try {
        await execAsync(`git remote add origin "${remoteUrl}"`, { cwd: repoDir, maxBuffer: 50 * 1024 * 1024 });
        await execAsync('git push -u origin main', { cwd: repoDir, maxBuffer: 50 * 1024 * 1024 });
        console.log('[push-to-github] Successfully pushed to GitHub!');
      } catch (pushErr: any) {
        console.error('Push error:', pushErr.message);
      }

      return NextResponse.json({
        success: true,
        message: 'Repository created and code pushed successfully',
        repoUrl: repoUrl,
        repoName: sanitizedRepoName,
      });
    } finally {
      // Cleanup temporary directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.error('Cleanup error:', cleanupErr);
      }
    }
  } catch (error: any) {
    console.error('GitHub push error:', error);

    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to push to GitHub',
      },
      { status: 500 }
    );
  }
}
