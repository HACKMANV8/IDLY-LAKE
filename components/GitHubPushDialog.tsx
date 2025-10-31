import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AnimatePresence, motion } from 'framer-motion';

interface GitHubPushDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onPush: (repoName: string, githubToken: string) => Promise<void>;
  isLoading: boolean;
}

export function GitHubPushDialog({
  isOpen,
  onClose,
  onPush,
  isLoading,
}: GitHubPushDialogProps) {
  const [repoName, setRepoName] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handlePush = async () => {
    setError(null);

    if (!repoName.trim()) {
      setError('Please enter a repository name');
      return;
    }

    if (!githubToken.trim()) {
      setError('Please enter your GitHub personal access token');
      return;
    }

    try {
      await onPush(repoName, githubToken);
      setRepoName('');
      setGithubToken('');
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to push to GitHub');
    }
  };

  const handleClose = () => {
    setRepoName('');
    setGithubToken('');
    setError(null);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handlePush();
    }
    if (e.key === 'Escape') {
      handleClose();
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/50"
            onClick={handleClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed top-1/2 left-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-lg"
          >
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Push to GitHub</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Create a new GitHub repository and push your project
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="repo-name" className="text-sm font-medium">
                  Repository Name
                </label>
                <Input
                  id="repo-name"
                  placeholder="e.g., my-awesome-project"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  disabled={isLoading}
                  onKeyDown={handleKeyDown}
                  autoFocus
                />
                <p className="text-xs text-gray-500">
                  Repository will be created under your GitHub account
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="github-token" className="text-sm font-medium">
                  GitHub Personal Access Token
                </label>
                <Input
                  id="github-token"
                  type="password"
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  disabled={isLoading}
                  onKeyDown={handleKeyDown}
                />
                <p className="text-xs text-gray-500">
                  Token must have repo and delete_repo permissions.{' '}
                  <a
                    href="https://github.com/settings/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-500 hover:underline"
                  >
                    Create token
                  </a>
                </p>
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-md bg-red-50 p-3"
                >
                  <p className="text-sm text-red-800">{error}</p>
                </motion.div>
              )}

              <div className="flex gap-3 pt-4">
                <Button
                  variant="outline"
                  onClick={handleClose}
                  disabled={isLoading}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handlePush}
                  disabled={isLoading}
                  className="flex-1 bg-blue-600 hover:bg-blue-700"
                >
                  {isLoading ? 'Pushing...' : 'Push to GitHub'}
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
