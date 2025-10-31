import { NextRequest, NextResponse } from 'next/server';
import { createGroq } from '@ai-sdk/groq';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText } from 'ai';
import type { SandboxState } from '@/types/sandbox';
import { selectFilesForEdit, getFileContents, formatFilesForAI } from '@/lib/context-selector';
import { executeSearchPlan, formatSearchResultsForAI, selectTargetFile } from '@/lib/file-search-executor';
import { FileManifest } from '@/types/file-manifest';
import type { ConversationState, ConversationMessage, ConversationEdit } from '@/types/conversation';
import { appConfig } from '@/config/app.config';

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
});

const googleGenerativeAI = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper function to analyze user preferences from conversation history
function analyzeUserPreferences(messages: ConversationMessage[]): {
  commonPatterns: string[];
  preferredEditStyle: 'targeted' | 'comprehensive';
} {
  const userMessages = messages.filter(m => m.role === 'user');
  const patterns: string[] = [];
  
  // Count edit-related keywords
  let targetedEditCount = 0;
  let comprehensiveEditCount = 0;
  
  userMessages.forEach(msg => {
    const content = msg.content.toLowerCase();
    
    // Check for targeted edit patterns
    if (content.match(/\b(update|change|fix|modify|edit|remove|delete)\s+(\w+\s+)?(\w+)\b/)) {
      targetedEditCount++;
    }
    
    // Check for comprehensive edit patterns
    if (content.match(/\b(rebuild|recreate|redesign|overhaul|refactor)\b/)) {
      comprehensiveEditCount++;
    }
    
    // Extract common request patterns
    if (content.includes('hero')) patterns.push('hero section edits');
    if (content.includes('header')) patterns.push('header modifications');
    if (content.includes('color') || content.includes('style')) patterns.push('styling changes');
    if (content.includes('button')) patterns.push('button updates');
    if (content.includes('animation')) patterns.push('animation requests');
  });
  
  return {
    commonPatterns: [...new Set(patterns)].slice(0, 3), // Top 3 unique patterns
    preferredEditStyle: targetedEditCount > comprehensiveEditCount ? 'targeted' : 'comprehensive'
  };
}

declare global {
  var sandboxState: SandboxState;
  var conversationState: ConversationState | null;
}

export async function POST(request: NextRequest) {
  try {
    const { prompt, model = 'openai/gpt-oss-20b', context, isEdit = false } = await request.json();
    
    console.log('[generate-ai-code-stream] Received request:');
    console.log('[generate-ai-code-stream] - prompt:', prompt);
    console.log('[generate-ai-code-stream] - isEdit:', isEdit);
    console.log('[generate-ai-code-stream] - context.sandboxId:', context?.sandboxId);
    console.log('[generate-ai-code-stream] - context.currentFiles:', context?.currentFiles ? Object.keys(context.currentFiles) : 'none');
    console.log('[generate-ai-code-stream] - currentFiles count:', context?.currentFiles ? Object.keys(context.currentFiles).length : 0);
    
    // Initialize conversation state if not exists
    if (!global.conversationState) {
      global.conversationState = {
        conversationId: `conv-${Date.now()}`,
        startedAt: Date.now(),
        lastUpdated: Date.now(),
        context: {
          messages: [],
          edits: [],
          projectEvolution: { majorChanges: [] },
          userPreferences: {}
        }
      };
    }
    
    // Add user message to conversation history
    const userMessage: ConversationMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
      metadata: {
        sandboxId: context?.sandboxId
      }
    };
    global.conversationState.context.messages.push(userMessage);
    
    // Clean up old messages to prevent unbounded growth
    if (global.conversationState.context.messages.length > 20) {
      // Keep only the last 15 messages
      global.conversationState.context.messages = global.conversationState.context.messages.slice(-15);
      console.log('[generate-ai-code-stream] Trimmed conversation history to prevent context overflow');
    }
    
    // Clean up old edits
    if (global.conversationState.context.edits.length > 10) {
      global.conversationState.context.edits = global.conversationState.context.edits.slice(-8);
    }
    
    // Debug: Show a sample of actual file content
    if (context?.currentFiles && Object.keys(context.currentFiles).length > 0) {
      const firstFile = Object.entries(context.currentFiles)[0];
      console.log('[generate-ai-code-stream] - sample file:', firstFile[0]);
      console.log('[generate-ai-code-stream] - sample content preview:', 
        typeof firstFile[1] === 'string' ? firstFile[1].substring(0, 100) + '...' : 'not a string');
    }
    
    if (!prompt) {
      return NextResponse.json({ 
        success: false, 
        error: 'Prompt is required' 
      }, { status: 400 });
    }
    
    // Create a stream for real-time updates
    const encoder = new TextEncoder();
    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    
    // Function to send progress updates
    const sendProgress = async (data: any) => {
      const message = `data: ${JSON.stringify(data)}\n\n`;
      await writer.write(encoder.encode(message));
    };
    
    // Start processing in background
    (async () => {
      try {
        // Send initial status
        await sendProgress({ type: 'status', message: 'Initializing AI...' });
        
        // No keep-alive needed - sandbox provisioned for 10 minutes
        
        // Check if we have a file manifest for edit mode
        let editContext = null;
        let enhancedSystemPrompt = '';
        
        if (isEdit) {
          console.log('[generate-ai-code-stream] Edit mode detected - starting agentic search workflow');
          console.log('[generate-ai-code-stream] Has fileCache:', !!global.sandboxState?.fileCache);
          console.log('[generate-ai-code-stream] Has manifest:', !!global.sandboxState?.fileCache?.manifest);
          
          const manifest: FileManifest | undefined = global.sandboxState?.fileCache?.manifest;
          
          if (manifest) {
            await sendProgress({ type: 'status', message: '🔍 Creating search plan...' });
            
            const fileContents = global.sandboxState.fileCache.files;
            console.log('[generate-ai-code-stream] Files available for search:', Object.keys(fileContents).length);
            
            // STEP 1: Get search plan from AI
            try {
              const intentResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/analyze-edit-intent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt, manifest, model })
              });
              
              if (intentResponse.ok) {
                const { searchPlan } = await intentResponse.json();
                console.log('[generate-ai-code-stream] Search plan received:', searchPlan);
                
                await sendProgress({ 
                  type: 'status', 
                  message: `🔎 Searching for: "${searchPlan.searchTerms.join('", "')}"`
                });
                
                // STEP 2: Execute the search plan
                const searchExecution = executeSearchPlan(searchPlan, 
                  Object.fromEntries(
                    Object.entries(fileContents).map(([path, data]) => [
                      path.startsWith('/') ? path : `/home/user/app/${path}`,
                      data.content
                    ])
                  )
                );
                
                console.log('[generate-ai-code-stream] Search execution:', {
                  success: searchExecution.success,
                  resultsCount: searchExecution.results.length,
                  filesSearched: searchExecution.filesSearched,
                  time: searchExecution.executionTime + 'ms'
                });
                
                if (searchExecution.success && searchExecution.results.length > 0) {
                  // STEP 3: Select the best target file
                  const target = selectTargetFile(searchExecution.results, searchPlan.editType);
                  
                  if (target) {
                    await sendProgress({ 
                      type: 'status', 
                      message: `✅ Found code in ${target.filePath.split('/').pop()} at line ${target.lineNumber}`
                    });
                    
                    console.log('[generate-ai-code-stream] Target selected:', target);
                    
                    // Create surgical edit context with exact location
                    const normalizedPath = target.filePath.replace('/home/user/app/', '');
                    const fileContent = fileContents[normalizedPath]?.content || '';
                    
                    // Build enhanced context with search results
                    enhancedSystemPrompt = `
${formatSearchResultsForAI(searchExecution.results)}

SURGICAL EDIT INSTRUCTIONS:
You have been given the EXACT location of the code to edit.
- File: ${target.filePath}
- Line: ${target.lineNumber}
- Reason: ${target.reason}

Make ONLY the change requested by the user. Do not modify any other code.
User request: "${prompt}"`;
                    
                    // Set up edit context with just this one file
                    editContext = {
                      primaryFiles: [target.filePath],
                      contextFiles: [],
                      systemPrompt: enhancedSystemPrompt,
                      editIntent: {
                        type: searchPlan.editType,
                        description: searchPlan.reasoning,
                        targetFiles: [target.filePath],
                        confidence: 0.95, // High confidence since we found exact location
                        searchTerms: searchPlan.searchTerms
                      }
                    };
                    
                    console.log('[generate-ai-code-stream] Surgical edit context created');
                  }
                } else {
                  // Search failed - fall back to old behavior but inform user
                  console.warn('[generate-ai-code-stream] Search found no results, falling back to broader context');
                  await sendProgress({ 
                    type: 'status', 
                    message: '⚠️ Could not find exact match, using broader search...'
                  });
                }
              } else {
                console.error('[generate-ai-code-stream] Failed to get search plan');
              }
            } catch (error) {
              console.error('[generate-ai-code-stream] Error in agentic search workflow:', error);
              await sendProgress({ 
                type: 'status', 
                message: '⚠️ Search workflow error, falling back to keyword method...'
              });
              // Fall back to old method on any error if we have a manifest
              if (manifest) {
                editContext = selectFilesForEdit(prompt, manifest);
              }
            }
          } else {
            // Fall back to old method if AI analysis fails
            console.warn('[generate-ai-code-stream] AI intent analysis failed, falling back to keyword method');
            if (manifest) {
              editContext = selectFilesForEdit(prompt, manifest);
            } else {
              console.log('[generate-ai-code-stream] No manifest available for fallback');
              await sendProgress({ 
                type: 'status', 
                message: '⚠️ No file manifest available, will use broad context'
              });
            }
          }
          
          // If we got an edit context from any method, use its system prompt
          if (editContext) {
            enhancedSystemPrompt = editContext.systemPrompt;
            
            await sendProgress({ 
              type: 'status', 
              message: `Identified edit type: ${editContext.editIntent?.description || 'Code modification'}`
            });
          } else if (!manifest) {
            console.log('[generate-ai-code-stream] WARNING: No manifest available for edit mode!');
            
            // Try to fetch files from sandbox if we have one
            if (global.activeSandbox) {
              await sendProgress({ type: 'status', message: 'Fetching current files from sandbox...' });
              
              try {
                // Fetch files directly from sandbox
                const filesResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/get-sandbox-files`, {
                  method: 'GET',
                  headers: { 'Content-Type': 'application/json' }
                });
                
                if (filesResponse.ok) {
                  const filesData = await filesResponse.json();
                  
                  if (filesData.success && filesData.manifest) {
                    console.log('[generate-ai-code-stream] Successfully fetched manifest from sandbox');
                    const manifest = filesData.manifest;
                    
                    // Now try to analyze edit intent with the fetched manifest
                    try {
                      const intentResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/analyze-edit-intent`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ prompt, manifest, model })
                      });
                      
                      if (intentResponse.ok) {
                        const { searchPlan } = await intentResponse.json();
                        console.log('[generate-ai-code-stream] Search plan received (after fetch):', searchPlan);
                        
                        // For now, fall back to keyword search since we don't have file contents for search execution
                        // This path happens when no manifest was initially available
                        let targetFiles = [];
                        if (!searchPlan || searchPlan.searchTerms.length === 0) {
                          console.warn('[generate-ai-code-stream] No target files after fetch, searching for relevant files');
                          
                          const promptLower = prompt.toLowerCase();
                          const allFilePaths = Object.keys(manifest.files);
                          
                          // Look for component names mentioned in the prompt
                          if (promptLower.includes('hero')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('hero'));
                          } else if (promptLower.includes('header')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('header'));
                          } else if (promptLower.includes('footer')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('footer'));
                          } else if (promptLower.includes('nav')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('nav'));
                          } else if (promptLower.includes('button')) {
                            targetFiles = allFilePaths.filter(p => p.toLowerCase().includes('button'));
                          }
                          
                          if (targetFiles.length > 0) {
                            console.log('[generate-ai-code-stream] Found target files by keyword search after fetch:', targetFiles);
                          }
                        }
                        
                        const allFiles = Object.keys(manifest.files)
                          .filter(path => !targetFiles.includes(path));
                        
                        editContext = {
                          primaryFiles: targetFiles,
                          contextFiles: allFiles,
                          systemPrompt: `
You are an expert senior software engineer performing a surgical, context-aware code modification. Your primary directive is **precision and preservation**.

Think of yourself as a surgeon making a precise incision, not a construction worker demolishing a wall.

## Search-Based Edit
Search Terms: ${searchPlan?.searchTerms?.join(', ') || 'keyword-based'}
Edit Type: ${searchPlan?.editType || 'UPDATE_COMPONENT'}
Reasoning: ${searchPlan?.reasoning || 'Modifying based on user request'}

Files to Edit: ${targetFiles.join(', ') || 'To be determined'}
User Request: "${prompt}"

## Your Mandatory Thought Process (Execute Internally):
Before writing ANY code, you MUST follow these steps:

1. **Understand Intent:**
   - What is the user's core goal? (adding feature, fixing bug, changing style?)
   - Does the conversation history provide extra clues?

2. **Locate the Code:**
   - First examine the Primary Files provided
   - Check the "ALL PROJECT FILES" list to find the EXACT file name
   - "nav" might be Navigation.tsx, NavBar.tsx, Nav.tsx, or Header.tsx
   - DO NOT create a new file if a similar one exists!

3. **Plan the Changes (Mental Diff):**
   - What is the *minimal* set of changes required?
   - Which exact lines need to be added, modified, or deleted?
   - Will this require new packages?

4. **Verify Preservation:**
   - What existing code, props, state, and logic must NOT be touched?
   - How can I make my change without disrupting surrounding code?

5. **Construct the Final Code:**
   - Only after completing steps above, generate the final code
   - Provide the ENTIRE file content with modifications integrated

## Critical Rules & Constraints:

**PRESERVATION IS KEY:** You MUST NOT rewrite entire components or files. Integrate your changes into the existing code. Preserve all existing logic, props, state, and comments not directly related to the user's request.

**MINIMALISM:** Only output files you have actually changed. If a file doesn't need modification, don't include it.

**COMPLETENESS:** Each file must be COMPLETE from first line to last:
- NEVER TRUNCATE - Include EVERY line
- NO ellipsis (...) to skip content
- ALL imports, functions, JSX, and closing tags must be present
- The file MUST be runnable

**SURGICAL PRECISION:**
- Change ONLY what's explicitly requested
- If user says "change background to green", change ONLY the background class
- 99% of the original code should remain untouched
- NO refactoring, reformatting, or "improvements" unless requested

**NO CONVERSATION:** Your output must contain ONLY the code. No explanations or apologies.

## EXAMPLES:

### CORRECT APPROACH for "change hero background to blue":
<thinking>
I need to change the background color of the Hero component. Looking at the file, I see the main div has 'bg-gray-900'. I will change ONLY this to 'bg-blue-500' and leave everything else exactly as is.
</thinking>

Then return the EXACT same file with only 'bg-gray-900' changed to 'bg-blue-500'.

### WRONG APPROACH (DO NOT DO THIS):
- Rewriting the Hero component from scratch
- Changing the structure or reorganizing imports
- Adding or removing unrelated code
- Reformatting or "cleaning up" the code

Remember: You are a SURGEON making a precise incision, not an artist repainting the canvas!`,
                          editIntent: {
                            type: searchPlan?.editType || 'UPDATE_COMPONENT',
                            targetFiles: targetFiles,
                            confidence: searchPlan ? 0.85 : 0.6,
                            description: searchPlan?.reasoning || 'Keyword-based file selection',
                            suggestedContext: []
                          }
                        };
                        
                        enhancedSystemPrompt = editContext.systemPrompt;
                        
                        await sendProgress({ 
                          type: 'status', 
                          message: `Identified edit type: ${editContext.editIntent.description}`
                        });
                      }
                    } catch (error) {
                      console.error('[generate-ai-code-stream] Error analyzing intent after fetch:', error);
                    }
                  } else {
                    console.error('[generate-ai-code-stream] Failed to get manifest from sandbox files');
                  }
                } else {
                  console.error('[generate-ai-code-stream] Failed to fetch sandbox files:', filesResponse.status);
                }
              } catch (error) {
                console.error('[generate-ai-code-stream] Error fetching sandbox files:', error);
                await sendProgress({ 
                  type: 'warning', 
                  message: 'Could not analyze existing files for targeted edits. Proceeding with general edit mode.'
                });
              }
            } else {
              console.log('[generate-ai-code-stream] No active sandbox to fetch files from');
              await sendProgress({ 
                type: 'warning', 
                message: 'No existing files found. Consider generating initial code first.'
              });
            }
          }
        }
        
        // Build conversation context for system prompt
        let conversationContext = '';
        if (global.conversationState && global.conversationState.context.messages.length > 1) {
          console.log('[generate-ai-code-stream] Building conversation context');
          console.log('[generate-ai-code-stream] Total messages:', global.conversationState.context.messages.length);
          console.log('[generate-ai-code-stream] Total edits:', global.conversationState.context.edits.length);
          
          conversationContext = `\n\n## Conversation History (Recent)\n`;
          
          // Include only the last 3 edits to save context
          const recentEdits = global.conversationState.context.edits.slice(-3);
          if (recentEdits.length > 0) {
            console.log('[generate-ai-code-stream] Including', recentEdits.length, 'recent edits in context');
            conversationContext += `\n### Recent Edits:\n`;
            recentEdits.forEach(edit => {
              conversationContext += `- "${edit.userRequest}" → ${edit.editType} (${edit.targetFiles.map(f => f.split('/').pop()).join(', ')})\n`;
            });
          }
          
          // Include recently created files - CRITICAL for preventing duplicates
          const recentMsgs = global.conversationState.context.messages.slice(-5);
          const recentlyCreatedFiles: string[] = [];
          recentMsgs.forEach(msg => {
            if (msg.metadata?.editedFiles) {
              recentlyCreatedFiles.push(...msg.metadata.editedFiles);
            }
          });
          
          if (recentlyCreatedFiles.length > 0) {
            const uniqueFiles = [...new Set(recentlyCreatedFiles)];
            conversationContext += `\n### 🚨 RECENTLY CREATED/EDITED FILES (DO NOT RECREATE THESE):\n`;
            uniqueFiles.forEach(file => {
              conversationContext += `- ${file}\n`;
            });
            conversationContext += `\nIf the user mentions any of these components, UPDATE the existing file!\n`;
          }
          
          // Include only last 5 messages for context (reduced from 10)
          const recentMessages = recentMsgs;
          if (recentMessages.length > 2) { // More than just current message
            conversationContext += `\n### Recent Messages:\n`;
            recentMessages.slice(0, -1).forEach(msg => { // Exclude current message
              if (msg.role === 'user') {
                const truncatedContent = msg.content.length > 100 ? msg.content.substring(0, 100) + '...' : msg.content;
                conversationContext += `- "${truncatedContent}"\n`;
              }
            });
          }
          
          // Include only last 2 major changes
          const majorChanges = global.conversationState.context.projectEvolution.majorChanges.slice(-2);
          if (majorChanges.length > 0) {
            conversationContext += `\n### Recent Changes:\n`;
            majorChanges.forEach(change => {
              conversationContext += `- ${change.description}\n`;
            });
          }
          
          // Keep user preferences - they're concise
          const userPrefs = analyzeUserPreferences(global.conversationState.context.messages);
          if (userPrefs.commonPatterns.length > 0) {
            conversationContext += `\n### User Preferences:\n`;
            conversationContext += `- Edit style: ${userPrefs.preferredEditStyle}\n`;
          }
          
          // Limit total conversation context length
          if (conversationContext.length > 2000) {
            conversationContext = conversationContext.substring(0, 2000) + '\n[Context truncated to prevent length errors]';
          }
        }
        
        // Build system prompt with conversation awareness
        const systemPrompt = `You are an expert React developer with perfect memory of the conversation. You maintain context across messages and remember scraped websites, generated components, and applied code. Generate clean, modern React code for Vite applications that work perfectly together.

CRITICAL: Every website you generate MUST have proper component interlinking and excellent user experience:
- Navigation MUST work smoothly with scroll-to-section functionality
- All sections MUST have unique IDs that match navigation links
- Mobile menus MUST work with proper state management
- Components MUST be properly integrated and work together seamlessly
- Smooth scrolling MUST be enabled in CSS
- All interactive elements MUST have proper event handlers

${conversationContext}

🚨 CRITICAL RULES - YOUR MOST IMPORTANT INSTRUCTIONS:
1. **DO EXACTLY WHAT IS ASKED - NOTHING MORE, NOTHING LESS**
   - Don't add features not requested
   - Don't fix unrelated issues
   - Don't improve things not mentioned
2. **CHECK App.jsx FIRST** - ALWAYS see what components exist before creating new ones
3. **NAVIGATION LIVES IN Header.jsx** - Don't create Nav.jsx if Header exists with nav
4. **USE STANDARD TAILWIND CLASSES ONLY**:
   - ✅ CORRECT: bg-white, text-black, bg-blue-500, bg-gray-100, text-gray-900
   - ❌ WRONG: bg-background, text-foreground, bg-primary, bg-muted, text-secondary
   - Use ONLY classes from the official Tailwind CSS documentation
5. **FILE COUNT LIMITS**:
   - Simple style/text change = 1 file ONLY
   - New component = 2 files MAX (component + parent)
   - If >3 files, YOU'RE DOING TOO MUCH

COMPONENT RELATIONSHIPS (CHECK THESE FIRST):
- Navigation usually lives INSIDE Header.jsx, not separate Nav.jsx
- Logo is typically in Header, not standalone
- Footer often contains nav links already
- Menu/Hamburger is part of Header, not separate

PACKAGE USAGE RULES:
- DO NOT use react-router-dom unless user explicitly asks for routing
- For simple nav links in a single-page app, use scroll-to-section or href="#"
- Only add routing if building a multi-page application
- Common packages are auto-installed from your imports

WEBSITE CLONING REQUIREMENTS:
When recreating/cloning a website, you MUST include:
1. **Header with Navigation** - Usually Header.jsx containing nav
2. **Hero Section** - The main landing area (Hero.jsx)
3. **Main Content Sections** - Features, Services, About, etc.
4. **Footer** - Contact info, links, copyright (Footer.jsx)
5. **App.jsx** - Main app component that imports and uses all components

${isEdit ? `CRITICAL: THIS IS AN EDIT TO AN EXISTING APPLICATION

YOU MUST FOLLOW THESE EDIT RULES:
0. NEVER create tailwind.config.js, vite.config.js, package.json, or any other config files - they already exist!
1. DO NOT regenerate the entire application
2. DO NOT create files that already exist (like App.jsx, index.css, tailwind.config.js)
3. ONLY edit the EXACT files needed for the requested change - NO MORE, NO LESS
4. If the user says "update the header", ONLY edit the Header component - DO NOT touch Footer, Hero, or any other components
5. If the user says "change the color", ONLY edit the relevant style or component file - DO NOT "improve" other parts
6. If you're unsure which file to edit, choose the SINGLE most specific one related to the request
7. IMPORTANT: When adding new components or libraries:
   - Create the new component file
   - UPDATE ONLY the parent component that will use it
   - Example: Adding a Newsletter component means:
     * Create Newsletter.jsx
     * Update ONLY the file that will use it (e.g., Footer.jsx OR App.jsx) - NOT both
8. When adding npm packages:
   - Import them ONLY in the files where they're actually used
   - The system will auto-install missing packages

CRITICAL FILE MODIFICATION RULES - VIOLATION = FAILURE:
- **NEVER TRUNCATE FILES** - Always return COMPLETE files with ALL content
- **NO ELLIPSIS (...)** - Include every single line of code, no skipping
- Files MUST be complete and runnable - include ALL imports, functions, JSX, and closing tags
- Count the files you're about to generate
- If the user asked to change ONE thing, you should generate ONE file (or at most two if adding a new component)
- DO NOT "fix" or "improve" files that weren't mentioned in the request
- DO NOT update multiple components when only one was requested
- DO NOT add features the user didn't ask for
- RESIST the urge to be "helpful" by updating related files

CRITICAL: DO NOT REDESIGN OR REIMAGINE COMPONENTS
- "update" means make a small change, NOT redesign the entire component
- "change X to Y" means ONLY change X to Y, nothing else
- "fix" means repair what's broken, NOT rewrite everything
- "remove X" means delete X from the existing file, NOT create a new file
- "delete X" means remove X from where it currently exists
- Preserve ALL existing functionality and design unless explicitly asked to change it

NEVER CREATE NEW FILES WHEN THE USER ASKS TO REMOVE/DELETE SOMETHING
If the user says "remove X", you must:
1. Find which existing file contains X
2. Edit that file to remove X
3. DO NOT create any new files

${editContext ? `
TARGETED EDIT MODE ACTIVE
- Edit Type: ${editContext.editIntent.type}
- Confidence: ${editContext.editIntent.confidence}
- Files to Edit: ${editContext.primaryFiles.join(', ')}

🚨 CRITICAL RULE - VIOLATION WILL RESULT IN FAILURE 🚨
YOU MUST ***ONLY*** GENERATE THE FILES LISTED ABOVE!

ABSOLUTE REQUIREMENTS:
1. COUNT the files in "Files to Edit" - that's EXACTLY how many files you must generate
2. If "Files to Edit" shows ONE file, generate ONLY that ONE file
3. DO NOT generate App.jsx unless it's EXPLICITLY listed in "Files to Edit"
4. DO NOT generate ANY components that aren't listed in "Files to Edit"
5. DO NOT "helpfully" update related files
6. DO NOT fix unrelated issues you notice
7. DO NOT improve code quality in files not being edited
8. DO NOT add bonus features

EXAMPLE VIOLATIONS (THESE ARE FAILURES):
❌ User says "update the hero" → You update Hero, Header, Footer, and App.jsx
❌ User says "change header color" → You redesign the entire header
❌ User says "fix the button" → You update multiple components
❌ Files to Edit shows "Hero.jsx" → You also generate App.jsx "to integrate it"
❌ Files to Edit shows "Header.jsx" → You also update Footer.jsx "for consistency"

CORRECT BEHAVIOR (THIS IS SUCCESS):
✅ User says "update the hero" → You ONLY edit Hero.jsx with the requested change
✅ User says "change header color" → You ONLY change the color in Header.jsx
✅ User says "fix the button" → You ONLY fix the specific button issue
✅ Files to Edit shows "Hero.jsx" → You generate ONLY Hero.jsx
✅ Files to Edit shows "Header.jsx, Nav.jsx" → You generate EXACTLY 2 files: Header.jsx and Nav.jsx

THE AI INTENT ANALYZER HAS ALREADY DETERMINED THE FILES.
DO NOT SECOND-GUESS IT.
DO NOT ADD MORE FILES.
ONLY OUTPUT THE EXACT FILES LISTED IN "Files to Edit".
` : ''}

VIOLATION OF THESE RULES WILL RESULT IN FAILURE!
` : ''}

CRITICAL INCREMENTAL UPDATE RULES:
- When the user asks for additions or modifications (like "add a videos page", "create a new component", "update the header"):
  - DO NOT regenerate the entire application
  - DO NOT recreate files that already exist unless explicitly asked
  - ONLY create/modify the specific files needed for the requested change
  - Preserve all existing functionality and files
  - If adding a new page/route, integrate it with the existing routing system
  - Reference existing components and styles rather than duplicating them
  - NEVER recreate config files (tailwind.config.js, vite.config.js, package.json, etc.)

IMPORTANT: When the user asks for edits or modifications:
- You have access to the current file contents in the context
- Make targeted changes to existing files rather than regenerating everything
- Preserve the existing structure and only modify what's requested
- If you need to see a specific file that's not in context, mention it

IMPORTANT: You have access to the full conversation context including:
- Previously scraped websites and their content
- Components already generated and applied
- The current project being worked on
- Recent conversation history
- Any Vite errors that need to be resolved

When the user references "the app", "the website", or "the site" without specifics, refer to:
1. The most recently scraped website in the context
2. The current project name in the context
3. The files currently in the sandbox

If you see scraped websites in the context, you're working on a clone/recreation of that site.

CRITICAL UI/UX RULES:
- NEVER use emojis in any code, text, console logs, or UI elements
- ALWAYS ensure responsive design using proper Tailwind classes (sm:, md:, lg:, xl:)
- ALWAYS use proper mobile-first responsive design patterns
- NEVER hardcode pixel widths - use relative units and responsive classes
- ALWAYS test that the layout works on mobile devices (320px and up)
- ALWAYS make sections full-width by default - avoid max-w-7xl or similar constraints
- For full-width layouts: use className="w-full" or no width constraint at all
- Only add max-width constraints when explicitly needed for readability (like blog posts)
- Prefer system fonts and clean typography
- Ensure all interactive elements have proper hover/focus states
- Use proper semantic HTML elements for accessibility
- ALWAYS create beautiful, visually appealing designs - prioritize aesthetics
- Use generous white space for breathing room (minimum py-16 for sections)
- Create visual hierarchy with size, weight, and color contrast
- Use rounded corners liberally (rounded-xl, rounded-2xl, rounded-3xl) - avoid sharp edges
- Apply shadows strategically for depth (shadow-lg, shadow-xl, shadow-2xl)

CRITICAL STYLING RULES - MUST FOLLOW:
- NEVER use inline styles with style={{ }} in JSX
- NEVER use <style jsx> tags or any CSS-in-JS solutions
- NEVER create App.css, Component.css, or any component-specific CSS files
- NEVER import './App.css' or any CSS files except index.css
- ALWAYS use Tailwind CSS classes for ALL styling
- ONLY create src/index.css with the @tailwind directives
- The ONLY CSS file should be src/index.css with:
  @tailwind base;
  @tailwind components;
  @tailwind utilities;
- Use Tailwind's full utility set: spacing, colors, typography, flexbox, grid, animations, etc.
- ALWAYS add smooth transitions and animations where appropriate:
  - Use transition-all, transition-colors, transition-opacity for hover states
  - Use transition-all duration-300 ease-in-out for smooth animations
  - Use animate-fade-in, animate-pulse, animate-bounce for engaging UI elements
  - Add hover:scale-105 or hover:scale-110 for interactive elements
  - Use transform and transition utilities for smooth interactions
  - Implement hover:shadow-2xl hover:-translate-y-2 for card lift effects
  - Use active:scale-95 for button press feedback
  - Add backdrop-blur effects for modern glassmorphism: backdrop-blur-md bg-white/10
  - Implement gradient backgrounds: bg-gradient-to-br from-blue-500 to-purple-600
- For complex layouts, combine Tailwind utilities rather than writing custom CSS
- NEVER use non-standard Tailwind classes like "border-border", "bg-background", "text-foreground", etc.
- Use standard Tailwind classes only:
  - For borders: use "border-gray-200", "border-gray-300", etc. NOT "border-border"
  - For backgrounds: use "bg-white", "bg-gray-100", etc. NOT "bg-background"
  - For text: use "text-gray-900", "text-black", etc. NOT "text-foreground"
- Examples of good Tailwind usage:
  - Premium Buttons: className="px-6 py-3 bg-gradient-to-r from-blue-600 to-purple-600 text-white rounded-xl shadow-lg hover:shadow-xl transform hover:scale-105 active:scale-95 transition-all duration-300 font-semibold"
  - Premium Cards: className="bg-white rounded-2xl shadow-xl p-8 border border-gray-100 hover:shadow-2xl hover:-translate-y-2 transition-all duration-300"
  - Glassmorphism Cards: className="backdrop-blur-md bg-white/10 border border-white/20 rounded-2xl p-6 shadow-xl"
  - Full-width sections: className="w-full px-4 sm:px-6 lg:px-8"
  - Constrained content (only when needed): className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"
  - Gradient backgrounds: className="min-h-screen bg-gradient-to-br from-gray-900 via-blue-900 to-purple-900 text-white"
  - Hero sections: className="relative overflow-hidden bg-gradient-to-br from-blue-600 via-purple-600 to-pink-600"
  - Feature cards with interactions: className="group bg-white rounded-2xl p-8 shadow-lg hover:shadow-2xl transform hover:scale-105 hover:-translate-y-2 transition-all duration-300 cursor-pointer"
  - CTAs with animations: className="bg-gradient-to-r from-cyan-500 to-blue-500 text-white px-8 py-4 rounded-full font-bold shadow-xl hover:shadow-2xl transform hover:scale-110 transition-all duration-300"

CRITICAL STRING AND SYNTAX RULES:
- ALWAYS escape apostrophes in strings: use \' instead of ' or use double quotes
- ALWAYS escape quotes properly in JSX attributes
- NEVER use curly quotes or smart quotes ('' "" '' "") - only straight quotes (' ")
- ALWAYS convert smart/curly quotes to straight quotes:
  - ' and ' → '
  - " and " → "
  - Any other Unicode quotes → straight quotes
- When strings contain apostrophes, either:
  1. Use double quotes: "you're" instead of 'you're'
  2. Escape the apostrophe: 'you\'re'
- When working with scraped content, ALWAYS sanitize quotes first
- Replace all smart quotes with straight quotes before using in code
- Be extra careful with user-generated content or scraped text
- Always validate that JSX syntax is correct before generating

CRITICAL CODE SNIPPET DISPLAY RULES:
- When displaying code examples in JSX, NEVER put raw curly braces { } in text
- ALWAYS wrap code snippets in template literals with backticks
- For code examples in components, use one of these patterns:
  1. Template literals: <div>{\`const example = { key: 'value' }\`}</div>
  2. Pre/code blocks: <pre><code>{\`your code here\`}</code></pre>
  3. Escape braces: <div>{'{'}key: value{'}'}</div>
- NEVER do this: <div>const example = { key: 'value' }</div> (causes parse errors)
- For multi-line code snippets, always use:
  <pre className="bg-gray-900 text-gray-100 p-4 rounded">
    <code>{\`
      // Your code here
      const example = {
        key: 'value'
      }
    \`}</code>
  </pre>

CRITICAL: When asked to create a React app or components:
- ALWAYS CREATE ALL FILES IN FULL - never provide partial implementations
- ALWAYS CREATE EVERY COMPONENT that you import - no placeholders
- ALWAYS IMPLEMENT COMPLETE FUNCTIONALITY - don't leave TODOs unless explicitly asked
- If you're recreating a website, implement ALL sections and features completely
- NEVER create tailwind.config.js - it's already configured in the template
- ALWAYS include a Navigation/Header component (Nav.jsx or Header.jsx) - websites need navigation!

REQUIRED COMPONENTS for website clones:
1. Nav.jsx or Header.jsx - Navigation bar with links (NEVER SKIP THIS!)
   - MUST include smooth scroll navigation with anchor links
   - MUST have mobile menu with useState for open/close state
   - MUST have active link highlighting
2. Hero.jsx - Main landing section
   - MUST have id="hero" for navigation
   - MUST include CTA buttons that link to other sections
3. Features/Services/Products sections - Based on the site content
   - MUST have id="features" or id="services" for navigation
   - MUST be properly linked from navigation
4. Footer.jsx - Footer with links and info
   - MUST include navigation links to main sections
   - MUST have social media links if applicable
5. App.jsx - Main component that imports and arranges all components
   - MUST import ALL components it references
   - MUST arrange components in logical order
   - MUST include smooth scroll behavior in index.css
- NEVER create vite.config.js - it's already configured in the template
- NEVER create package.json - it's already configured in the template

CRITICAL COMPONENT INTERLINKING & UX REQUIREMENTS:
1. **SMOOTH SCROLLING** - MUST implement in index.css:
   html { scroll-behavior: smooth; }
   
2. **SECTION IDs** - EVERY section MUST have an ID for navigation:
   - Hero: id="hero"
   - Features: id="features"
   - Services: id="services"
   - About: id="about"
   - Contact: id="contact"
   - Testimonials: id="testimonials"
   
3. **NAVIGATION LINKS** - MUST use anchor links that match section IDs:
   <a href="#hero">Home</a>
   <a href="#features">Features</a>
   <a href="#about">About</a>
   <a href="#contact">Contact</a>
   
4. **MOBILE MENU** - Header MUST include:
   - useState for menu open/close state
   - Hamburger button with onClick handler
   - Mobile menu that slides in/out
   - Close menu when link is clicked
   
5. **INTERACTIVE ELEMENTS** - All buttons/cards MUST have:
   - Proper onClick handlers
   - Hover effects with transitions
   - Focus states for accessibility
   - Loading states where appropriate (useState)
   
6. **COMPONENT STATE** - Use useState for:
   - Mobile menu (open/closed)
   - Active navigation link
   - Form inputs (if forms exist)
   - Modal/dialog states (if modals exist)
   - Any interactive features
   
7. **PROPER COMPONENT COMPOSITION**:
   - App.jsx imports Header, Hero, Features, About, Footer, etc.
   - Each component receives only necessary props
   - Components are self-contained and reusable
   - No circular dependencies between components
   
8. **SCROLL TO SECTION FUNCTION** - Navigation MUST include:
   const scrollToSection = (id) => {
     const element = document.getElementById(id);
     if (element) {
       element.scrollIntoView({ behavior: 'smooth', block: 'start' });
     }
   };
   
9. **ACTIVE LINK HIGHLIGHTING** - Navigation MUST show which section is active:
   - Use useState to track active section
   - Update on scroll (optional: useEffect with scroll listener)
   - Visual indicator (underline, highlight, or bold)
   
10. **FORM HANDLING** (if forms exist):
    - Use useState for form fields
    - onSubmit handler
    - Basic validation feedback
    - Success/error message display

WHEN WORKING WITH SCRAPED CONTENT:
- ALWAYS sanitize all text content before using in code
- Convert ALL smart quotes to straight quotes
- Example transformations:
  - "Firecrawl's API" → "Firecrawl's API" or "Firecrawl\\'s API"
  - 'It's amazing' → "It's amazing" or 'It\\'s amazing'
  - "Best tool ever" → "Best tool ever"
- When in doubt, use double quotes for strings containing apostrophes
- For testimonials or quotes from scraped content, ALWAYS clean the text:
  - Bad: content: 'Moved our internal agent's web scraping...'
  - Good: content: "Moved our internal agent's web scraping..."
  - Also good: content: 'Moved our internal agent\\'s web scraping...'

When generating code, FOLLOW THIS PROCESS:
1. ALWAYS generate src/index.css FIRST - this establishes the styling foundation
   - MUST include: html { scroll-behavior: smooth; }
   - Include base styles, font settings, reset styles
2. List ALL components you plan to import in App.jsx
   - Header (with navigation)
   - Hero (with id="hero")
   - Features (with id="features")
   - About (with id="about")
   - Footer (with links)
   - Any other sections needed
3. Count them - if there are 10 imports, you MUST create 10 component files
4. Generate src/index.css first (with proper CSS reset and base styles + smooth scroll)
5. Generate App.jsx second - MUST import and arrange ALL components in order
6. Generate Header/Nav component - MUST include navigation with scroll functions
7. Generate Hero component - MUST have id="hero" and CTA buttons
8. Generate Feature sections - MUST have proper IDs for navigation
9. Generate Footer - MUST include section links
10. Then generate EVERY SINGLE component file you imported
11. Verify all components are properly interlinked with section IDs and navigation
12. Do NOT stop until all imports are satisfied and navigation works

Use this XML format for React components only (DO NOT create tailwind.config.js - it already exists):

<file path="src/index.css">
@tailwind base;
@tailwind components;
@tailwind utilities;
</file>

<file path="src/App.jsx">
// Main App component that imports and uses other components
// Use Tailwind classes: className="min-h-screen bg-gray-50"
</file>

<file path="src/components/Example.jsx">
// Your React component code here
// Use Tailwind classes for ALL styling
</file>

CRITICAL COMPLETION RULES:
1. NEVER say "I'll continue with the remaining components"
2. NEVER say "Would you like me to proceed?"
3. NEVER use <continue> tags
4. Generate ALL components in ONE response
5. If App.jsx imports 10 components, generate ALL 10
6. Complete EVERYTHING before ending your response

With 16,000 tokens available, you have plenty of space to generate a complete application. Use it!

UNDERSTANDING USER INTENT FOR INCREMENTAL VS FULL GENERATION:
- "add/create/make a [specific feature]" → Add ONLY that feature to existing app
- "add a videos page" → Create ONLY Videos.jsx and update routing
- "update the header" → Modify ONLY header component
- "fix the styling" → Update ONLY the affected components
- "change X to Y" → Find the file containing X and modify it
- "make the header black" → Find Header component and change its color
- "rebuild/recreate/start over" → Full regeneration
- Default to incremental updates when working on an existing app

SURGICAL EDIT RULES (CRITICAL FOR PERFORMANCE):
- **PREFER TARGETED CHANGES**: Don't regenerate entire components for small edits
- For color/style changes: Edit ONLY the specific className or style prop
- For text changes: Change ONLY the text content, keep everything else
- For adding elements: INSERT into existing JSX, don't rewrite the whole return
- **PRESERVE EXISTING CODE**: Keep all imports, functions, and unrelated code exactly as-is
- Maximum files to edit:
  - Style change = 1 file ONLY
  - Text change = 1 file ONLY
  - New feature = 2 files MAX (feature + parent)
- If you're editing >3 files for a simple request, STOP - you're doing too much

EXAMPLES OF CORRECT SURGICAL EDITS:
✅ "change header to black" → Find className="..." in Header.jsx, change ONLY color classes
✅ "update hero text" → Find the <h1> or <p> in Hero.jsx, change ONLY the text inside
✅ "add a button to hero" → Find the return statement, ADD button, keep everything else
❌ WRONG: Regenerating entire Header.jsx to change one color
❌ WRONG: Rewriting Hero.jsx to add one button

NAVIGATION/HEADER INTELLIGENCE:
- ALWAYS check App.jsx imports first
- Navigation is usually INSIDE Header.jsx, not separate
- If user says "nav", check Header.jsx FIRST
- Only create Nav.jsx if no navigation exists anywhere
- Logo, menu, hamburger = all typically in Header

CRITICAL: When files are provided in the context:
1. The user is asking you to MODIFY the existing app, not create a new one
2. Find the relevant file(s) from the provided context
3. Generate ONLY the files that need changes
4. Do NOT ask to see files - they are already provided in the context above
5. Make the requested change immediately`;

        // Build full prompt with context
        let fullPrompt = prompt;
        if (context) {
          const contextParts = [];
          
          if (context.sandboxId) {
            contextParts.push(`Current sandbox ID: ${context.sandboxId}`);
          }
          
          if (context.structure) {
            contextParts.push(`Current file structure:\n${context.structure}`);
          }
          
          // Use backend file cache instead of frontend-provided files
          let backendFiles = global.sandboxState?.fileCache?.files || {};
          let hasBackendFiles = Object.keys(backendFiles).length > 0;
          
          console.log('[generate-ai-code-stream] Backend file cache status:');
          console.log('[generate-ai-code-stream] - Has sandboxState:', !!global.sandboxState);
          console.log('[generate-ai-code-stream] - Has fileCache:', !!global.sandboxState?.fileCache);
          console.log('[generate-ai-code-stream] - File count:', Object.keys(backendFiles).length);
          console.log('[generate-ai-code-stream] - Has manifest:', !!global.sandboxState?.fileCache?.manifest);
          
          // If no backend files and we're in edit mode, try to fetch from sandbox
          if (!hasBackendFiles && isEdit && (global.activeSandbox || context?.sandboxId)) {
            console.log('[generate-ai-code-stream] No backend files, attempting to fetch from sandbox...');
            
            try {
              const filesResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/get-sandbox-files`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' }
              });
              
              if (filesResponse.ok) {
                const filesData = await filesResponse.json();
                if (filesData.success && filesData.files) {
                  console.log('[generate-ai-code-stream] Successfully fetched', Object.keys(filesData.files).length, 'files from sandbox');
                  
                  // Initialize sandboxState if needed
                  if (!global.sandboxState) {
                    global.sandboxState = {
                      fileCache: {
                        files: {},
                        lastSync: Date.now(),
                        sandboxId: context?.sandboxId || 'unknown'
                      }
                    } as any;
                  } else if (!global.sandboxState.fileCache) {
                    global.sandboxState.fileCache = {
                      files: {},
                      lastSync: Date.now(),
                      sandboxId: context?.sandboxId || 'unknown'
                    };
                  }
                  
                  // Store files in cache
                  for (const [path, content] of Object.entries(filesData.files)) {
                    const normalizedPath = path.replace('/home/user/app/', '');
                    global.sandboxState.fileCache.files[normalizedPath] = {
                      content: content as string,
                      lastModified: Date.now()
                    };
                  }
                  
                  if (filesData.manifest) {
                    global.sandboxState.fileCache.manifest = filesData.manifest;
                    
                    // Now try to analyze edit intent with the fetched manifest
                    if (!editContext) {
                      console.log('[generate-ai-code-stream] Analyzing edit intent with fetched manifest');
                      try {
                        const intentResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/analyze-edit-intent`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ prompt, manifest: filesData.manifest, model })
                        });
                        
                        if (intentResponse.ok) {
                          const { searchPlan } = await intentResponse.json();
                          console.log('[generate-ai-code-stream] Search plan received:', searchPlan);
                          
                          // Create edit context from AI analysis
                          // Note: We can't execute search here without file contents, so fall back to keyword method
                          const fileContext = selectFilesForEdit(prompt, filesData.manifest);
                          editContext = fileContext;
                          enhancedSystemPrompt = fileContext.systemPrompt;
                          
                          console.log('[generate-ai-code-stream] Edit context created with', editContext.primaryFiles.length, 'primary files');
                        }
                      } catch (error) {
                        console.error('[generate-ai-code-stream] Failed to analyze edit intent:', error);
                      }
                    }
                  }
                  
                  // Update variables
                  backendFiles = global.sandboxState.fileCache.files;
                  hasBackendFiles = Object.keys(backendFiles).length > 0;
                  console.log('[generate-ai-code-stream] Updated backend cache with fetched files');
                }
              }
            } catch (error) {
              console.error('[generate-ai-code-stream] Failed to fetch sandbox files:', error);
            }
          }
          
          // Include current file contents from backend cache
          if (hasBackendFiles) {
            // If we have edit context, use intelligent file selection
            if (editContext && editContext.primaryFiles.length > 0) {
              contextParts.push('\nEXISTING APPLICATION - TARGETED EDIT MODE');
              contextParts.push(`\n${editContext.systemPrompt || enhancedSystemPrompt}\n`);
              
              // Get contents of primary and context files
              const primaryFileContents = await getFileContents(editContext.primaryFiles, global.sandboxState!.fileCache!.manifest!);
              const contextFileContents = await getFileContents(editContext.contextFiles, global.sandboxState!.fileCache!.manifest!);
              
              // Format files for AI
              const formattedFiles = formatFilesForAI(primaryFileContents, contextFileContents);
              contextParts.push(formattedFiles);
              
              contextParts.push('\nIMPORTANT: Only modify the files listed under "Files to Edit". The context files are provided for reference only.');
            } else {
              // Fallback to showing all files if no edit context
              console.log('[generate-ai-code-stream] WARNING: Using fallback mode - no edit context available');
              contextParts.push('\nEXISTING APPLICATION - TARGETED EDIT REQUIRED');
              contextParts.push('\nYou MUST analyze the user request and determine which specific file(s) to edit.');
              contextParts.push('\nCurrent project files (DO NOT regenerate all of these):');
              
              const fileEntries = Object.entries(backendFiles);
              console.log(`[generate-ai-code-stream] Using backend cache: ${fileEntries.length} files`);
              
              // Show file list first for reference
              contextParts.push('\n### File List:');
              for (const [path] of fileEntries) {
                contextParts.push(`- ${path}`);
              }
              
              // Include ALL files as context in fallback mode
              contextParts.push('\n### File Contents (ALL FILES FOR CONTEXT):');
              for (const [path, fileData] of fileEntries) {
                const content = fileData.content;
                if (typeof content === 'string') {
                  contextParts.push(`\n<file path="${path}">\n${content}\n</file>`);
                }
              }
              
              contextParts.push('\n🚨 CRITICAL INSTRUCTIONS - VIOLATION = FAILURE 🚨');
              contextParts.push('1. Analyze the user request: "' + prompt + '"');
              contextParts.push('2. Identify the MINIMUM number of files that need editing (usually just ONE)');
              contextParts.push('3. PRESERVE ALL EXISTING CONTENT in those files');
              contextParts.push('4. ONLY ADD/MODIFY the specific part requested');
              contextParts.push('5. DO NOT regenerate entire components from scratch');
              contextParts.push('6. DO NOT change unrelated parts of any file');
              contextParts.push('7. Generate ONLY the files that MUST be changed - NO EXTRAS');
              contextParts.push('\n⚠️ FILE COUNT RULE:');
              contextParts.push('- Simple change (color, text, spacing) = 1 file ONLY');
              contextParts.push('- Adding new component = 2 files MAX (new component + parent that imports it)');
              contextParts.push('- DO NOT exceed these limits unless absolutely necessary');
              contextParts.push('\nEXAMPLES OF CORRECT BEHAVIOR:');
              contextParts.push('✅ "add a chart to the hero" → Edit ONLY Hero.jsx, ADD the chart, KEEP everything else');
              contextParts.push('✅ "change header to black" → Edit ONLY Header.jsx, change ONLY the color');
              contextParts.push('✅ "fix spacing in footer" → Edit ONLY Footer.jsx, adjust ONLY spacing');
              contextParts.push('\nEXAMPLES OF FAILURES:');
              contextParts.push('❌ "change header color" → You edit Header, Footer, and App "for consistency"');
              contextParts.push('❌ "add chart to hero" → You regenerate the entire Hero component');
              contextParts.push('❌ "fix button" → You update 5 different component files');
              contextParts.push('\n⚠️ FINAL WARNING:');
              contextParts.push('If you generate MORE files than necessary, you have FAILED');
              contextParts.push('If you DELETE or REWRITE existing functionality, you have FAILED');
              contextParts.push('ONLY change what was EXPLICITLY requested - NOTHING MORE');
            }
          } else if (context.currentFiles && Object.keys(context.currentFiles).length > 0) {
            // Fallback to frontend-provided files if backend cache is empty
            console.log('[generate-ai-code-stream] Warning: Backend cache empty, using frontend files');
            contextParts.push('\nEXISTING APPLICATION - DO NOT REGENERATE FROM SCRATCH');
            contextParts.push('Current project files (modify these, do not recreate):');
            
            const fileEntries = Object.entries(context.currentFiles);
            for (const [path, content] of fileEntries) {
              if (typeof content === 'string') {
                contextParts.push(`\n<file path="${path}">\n${content}\n</file>`);
              }
            }
            contextParts.push('\nThe above files already exist. When the user asks to modify something (like "change the header color to black"), find the relevant file above and generate ONLY that file with the requested changes.');
          }
          
          // Add explicit edit mode indicator
          if (isEdit) {
            contextParts.push('\nEDIT MODE ACTIVE');
            contextParts.push('This is an incremental update to an existing application.');
            contextParts.push('DO NOT regenerate App.jsx, index.css, or other core files unless explicitly requested.');
            contextParts.push('ONLY create or modify the specific files needed for the user\'s request.');
            contextParts.push('\n⚠️ CRITICAL FILE OUTPUT FORMAT - VIOLATION = FAILURE:');
            contextParts.push('YOU MUST OUTPUT EVERY FILE IN THIS EXACT XML FORMAT:');
            contextParts.push('<file path="src/components/ComponentName.jsx">');
            contextParts.push('// Complete file content here');
            contextParts.push('</file>');
            contextParts.push('<file path="src/index.css">');
            contextParts.push('/* CSS content here */');
            contextParts.push('</file>');
            contextParts.push('\n❌ NEVER OUTPUT: "Generated Files: index.css, App.jsx"');
            contextParts.push('❌ NEVER LIST FILE NAMES WITHOUT CONTENT');
            contextParts.push('✅ ALWAYS: One <file> tag per file with COMPLETE content');
            contextParts.push('✅ ALWAYS: Include EVERY file you modified');
          } else if (!hasBackendFiles) {
            contextParts.push('\n🎨 ENHANCED SITE GENERATION MODE - CREATE PREMIUM WEBSITES!');
            contextParts.push('\nThis is initial site generation. Create a MODERN, PROFESSIONAL, FEATURE-RICH website:');
            contextParts.push('\n✨ MODERN UI/UX REQUIREMENTS:');
            contextParts.push('1. **VISUAL DEPTH** - Use gradients, shadows, and depth layers');
            contextParts.push('   - Background gradients: bg-gradient-to-br from-blue-500 to-purple-600');
            contextParts.push('   - Card shadows: shadow-xl, shadow-2xl for premium feel');
            contextParts.push('   - Layered elements with z-index for depth');
            contextParts.push('2. **ANIMATIONS & INTERACTIONS** - Smooth, engaging micro-interactions');
            contextParts.push('   - Hover effects: transform hover:scale-105 hover:-translate-y-1');
            contextParts.push('   - Smooth transitions: transition-all duration-300 ease-in-out');
            contextParts.push('   - Fade-in animations: animate-[fadeIn_0.6s_ease-in]');
            contextParts.push('   - Button press effects: active:scale-95');
            contextParts.push('3. **MODERN DESIGN PATTERNS**');
            contextParts.push('   - Glassmorphism: backdrop-blur-md bg-white/10 border border-white/20');
            contextParts.push('   - Neumorphism: subtle shadows and highlights for depth');
            contextParts.push('   - Modern gradients: bg-gradient-to-r from-cyan-500 to-blue-500');
            contextParts.push('   - Rounded corners: rounded-2xl, rounded-3xl for modern feel');
            contextParts.push('4. **TYPography EXCELLENCE**');
            contextParts.push('   - Font weight hierarchy: font-light (300), font-normal (400), font-bold (700), font-black (900)');
            contextParts.push('   - Letter spacing: tracking-tight, tracking-wide for impact');
            contextParts.push('   - Line height: leading-tight for headings, leading-relaxed for body');
            contextParts.push('   - Text shadows: drop-shadow-lg for text on images');
            contextParts.push('5. **RESPONSIVE PERFECTION**');
            contextParts.push('   - Mobile-first: Start with mobile styles, enhance for larger screens');
            contextParts.push('   - Breakpoint usage: sm: (640px), md: (768px), lg: (1024px), xl: (1280px), 2xl: (1536px)');
            contextParts.push('   - Responsive typography: text-3xl md:text-5xl lg:text-6xl');
            contextParts.push('   - Responsive spacing: p-4 md:p-8 lg:p-12');
            contextParts.push('   - Grid layouts: grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3');
            contextParts.push('6. **INTERACTIVE ELEMENTS**');
            contextParts.push('   - Buttons with multiple states: default, hover, active, focus');
            contextParts.push('   - Cards that lift on hover: hover:shadow-2xl hover:-translate-y-2');
            contextParts.push('   - Image overlays on hover: opacity changes, scale effects');
            contextParts.push('   - Form inputs with focus rings: focus:ring-2 focus:ring-blue-500');
            contextParts.push('7. **COLOR SYSTEM & CONTRAST**');
            contextParts.push('   - Use vibrant colors: bg-indigo-600, bg-emerald-500, bg-rose-500');
            contextParts.push('   - Proper contrast: text-white on dark bg, text-gray-900 on light bg');
            contextParts.push('   - Color gradients for visual interest');
            contextParts.push('   - Accent colors for CTAs: Use vibrant colors that stand out');
            contextParts.push('8. **COMPONENT ARCHITECTURE**');
            contextParts.push('   - Reusable components with props for flexibility');
            contextParts.push('   - Component composition: Build complex UIs from simple pieces');
            contextParts.push('   - State management: Use useState for interactive features');
            contextParts.push('   - Event handlers: onClick, onSubmit, onChange for interactivity');
            contextParts.push('9. **PERFORMANCE & OPTIMIZATION**');
            contextParts.push('   - Lazy loading concepts: Code for future image lazy loading');
            contextParts.push('   - Efficient re-renders: Proper key props in lists');
            contextParts.push('   - CSS optimization: Use Tailwind utilities, avoid inline styles');
            contextParts.push('10. **ACCESSIBILITY (A11Y)**');
            contextParts.push('    - Semantic HTML: Use <nav>, <header>, <main>, <footer>, <section>');
            contextParts.push('    - ARIA labels: aria-label for icon-only buttons');
            contextParts.push('    - Keyboard navigation: tabIndex for interactive elements');
            contextParts.push('    - Focus indicators: focus:outline-none focus:ring-2');
            contextParts.push('    - Alt text: Always include descriptive alt text for images');
            contextParts.push('\n🏗️ REQUIRED SECTIONS FOR PREMIUM SITES:');
            contextParts.push('1. **Header/Navigation** - Sticky, responsive, with mobile menu');
            contextParts.push('   - Logo/name on left, nav links in center/right');
            contextParts.push('   - Mobile hamburger menu with smooth slide-in');
            contextParts.push('   - Active state indicators for current page');
            contextParts.push('2. **Hero Section** - Large, impactful, with CTA');
            contextParts.push('   - Compelling headline (h1) - Large, bold, attention-grabbing');
            contextParts.push('   - Supporting subheadline (p) - Clear value proposition');
            contextParts.push('   - Primary CTA button - Prominent, with hover effects');
            contextParts.push('   - Optional: Hero image/illustration or gradient background');
            contextParts.push('3. **Features/Services Section** - Showcase key offerings');
            contextParts.push('   - 3-6 feature cards with icons or images');
            contextParts.push('   - Card hover effects (lift, shadow, scale)');
            contextParts.push('   - Clear headings and descriptions');
            contextParts.push('4. **About/Content Section** - Tell the story');
            contextParts.push('   - Engaging copy, not placeholder text');
            contextParts.push('   - Visual elements (images or illustrations)');
            contextParts.push('5. **Testimonials/Reviews** (if applicable)');
            contextParts.push('   - Quote cards with author info');
            contextParts.push('   - Star ratings if reviews');
            contextParts.push('6. **CTA Section** - Drive action');
            contextParts.push('   - Prominent call-to-action');
            contextParts.push('   - Compelling copy');
            contextParts.push('7. **Footer** - Complete site information');
            contextParts.push('   - Links organized in columns');
            contextParts.push('   - Social media links');
            contextParts.push('   - Copyright and legal info');
            contextParts.push('\n💎 PREMIUM FEATURES TO INCLUDE:');
            contextParts.push('- Smooth scroll behavior for anchor links');
            contextParts.push('- Loading states for buttons (optional: useState for demo)');
            contextParts.push('- Modal/dialog capability (for future use)');
            contextParts.push('- Form validation styling (error states)');
            contextParts.push('- Success/error message displays');
            contextParts.push('- Dark/light mode ready structure (if theme switching requested)');
            contextParts.push('\n🎯 CONTENT QUALITY:');
            contextParts.push('- NO lorem ipsum - Use realistic, meaningful content');
            contextParts.push('- Professional copy that matches the website purpose');
            contextParts.push('- Realistic company/product names and descriptions');
            contextParts.push('- Authentic-feeling testimonials if included');
            contextParts.push('\n📐 SPACING & LAYOUT:');
            contextParts.push('- Generous whitespace: py-16, py-24 for sections');
            contextParts.push('- Consistent spacing: Use Tailwind spacing scale (4, 8, 12, 16, 24, 32)');
            contextParts.push('- Container padding: px-4 sm:px-6 lg:px-8');
            contextParts.push('- Max-width containers: max-w-7xl mx-auto for readable content');
            contextParts.push('- Section spacing: Space sections with mb-16 or py-16');
            contextParts.push('\n🔧 TECHNICAL EXCELLENCE:');
            contextParts.push('1. **USE STANDARD TAILWIND CLASSES ONLY**:');
            contextParts.push('   - ✅ CORRECT: bg-white, text-black, bg-blue-500, bg-gray-100, text-gray-900');
            contextParts.push('   - ❌ WRONG: bg-background, text-foreground, bg-primary, bg-muted');
            contextParts.push('2. **NO PLACEHOLDERS** - Use real content, not lorem ipsum');
            contextParts.push('3. **COMPLETE COMPONENTS** - Header, Hero, Features, Footer minimum');
            contextParts.push('4. **VERIFIED HIGH-QUALITY IMAGES** - MUST use sources guaranteed to load:');
            contextParts.push('   🚨 CRITICAL: Images MUST come from verified CDN sources that always work!');
            contextParts.push('   **Picsum Photos (BEST - 100% reliable, CDN-backed):**');
            contextParts.push('   - Hero: <img src="https://picsum.photos/1600/900" alt="Hero image" className="w-full rounded-2xl shadow-xl" loading="lazy" />');
            contextParts.push('   - Cards: <img src="https://picsum.photos/600/400" alt="Feature" className="rounded-xl shadow-lg" loading="lazy" />');
            contextParts.push('   - Consistent images (same every time):');
            contextParts.push('     * <img src="https://picsum.photos/id/237/1600/900" alt="Dog" />');
            contextParts.push('     * <img src="https://picsum.photos/id/1015/1600/900" alt="Mountain" />');
            contextParts.push('     * <img src="https://picsum.photos/id/1018/1600/900" alt="Nature" />');
            contextParts.push('   **Unsplash Source (VERIFIED - always loads):**');
            contextParts.push('   - Technology: <img src="https://source.unsplash.com/1600x900/?technology,computer" alt="Technology" className="w-full rounded-2xl" loading="lazy" />');
            contextParts.push('   - Business: <img src="https://source.unsplash.com/1600x900/?business,office" alt="Business" className="w-full rounded-2xl" loading="lazy" />');
            contextParts.push('   - Nature: <img src="https://source.unsplash.com/1600x900/?nature,landscape" alt="Nature" className="w-full rounded-2xl" loading="lazy" />');
            contextParts.push('   **MANDATORY attributes for ALL images:**');
            contextParts.push('   - src: MUST be https:// URL from Picsum or Unsplash Source');
            contextParts.push('   - alt: Descriptive text (required for accessibility)');
            contextParts.push('   - className: Include rounded corners (rounded-xl, rounded-2xl) and shadows (shadow-lg, shadow-xl)');
            contextParts.push('   - loading: MUST be "lazy" for performance');
            contextParts.push('   - NEVER use: placeholder.com, broken URLs, localhost, or relative paths');
            contextParts.push('5. **PROPER FILE STRUCTURE** - Organize components in src/components/');
            contextParts.push('\n⚠️ OUTPUT FORMAT:');
            contextParts.push('Use <file path="...">content</file> tags for EVERY file');
            contextParts.push('NEVER output "Generated Files:" as plain text');
            contextParts.push('\n🎨 BEAUTIFUL DESIGN GUIDELINES - CREATE VISUALLY STUNNING WEBSITES:');
            contextParts.push('\n🌈 BEAUTIFUL COLOR PALETTES (Choose one theme per website):');
            contextParts.push('- **Ocean Blue**: bg-gradient-to-br from-blue-400 via-cyan-500 to-teal-600');
            contextParts.push('- **Sunset Purple**: bg-gradient-to-br from-purple-500 via-pink-500 to-orange-500');
            contextParts.push('- **Emerald Forest**: bg-gradient-to-br from-green-400 via-emerald-500 to-teal-600');
            contextParts.push('- **Royal Purple**: bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500');
            contextParts.push('- **Warm Orange**: bg-gradient-to-br from-orange-400 via-red-500 to-pink-500');
            contextParts.push('- **Cool Mint**: bg-gradient-to-br from-cyan-300 via-blue-400 to-indigo-500');
            contextParts.push('- **Sophisticated Gray**: bg-gradient-to-br from-gray-800 via-gray-900 to-black (elegant dark theme)');
            contextParts.push('\n💫 HERO SECTION BEAUTY:');
            contextParts.push('- Use stunning gradient backgrounds: bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-500');
            contextParts.push('- Add subtle animation: animate-pulse (slow, subtle) or floating elements');
            contextParts.push('- Large, bold typography: text-5xl md:text-7xl lg:text-8xl font-black tracking-tight');
            contextParts.push('- Text gradient effects: bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent');
            contextParts.push('- Overlay dark/light layer for text readability: bg-black/20 or bg-white/10');
            contextParts.push('- Add decorative elements: floating shapes, subtle patterns, or geometric designs');
            contextParts.push('- Use backdrop-blur for depth: backdrop-blur-xl bg-white/5');
            contextParts.push('\n✨ BEAUTIFUL BUTTONS & CTAs:');
            contextParts.push('- Gradient buttons: bg-gradient-to-r from-blue-600 to-purple-600');
            contextParts.push('- Glow effects: shadow-[0_0_20px_rgba(59,130,246,0.5)]');
            contextParts.push('- Rounded-full for pill shape: rounded-full px-8 py-4');
            contextParts.push('- Hover glow: hover:shadow-[0_0_30px_rgba(59,130,246,0.8)]');
            contextParts.push('- Text white with gradient: text-white font-bold');
            contextParts.push('- Scale on hover: hover:scale-110 transform transition-all duration-300');
            contextParts.push('- Premium example: className="bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-500 text-white px-10 py-4 rounded-full font-bold text-lg shadow-[0_0_25px_rgba(59,130,246,0.6)] hover:shadow-[0_0_40px_rgba(147,51,234,0.8)] hover:scale-110 transform transition-all duration-300"');
            contextParts.push('\n🏆 BEAUTIFUL CARD DESIGNS:');
            contextParts.push('- White cards with shadow: bg-white rounded-2xl shadow-xl p-8');
            contextParts.push('- Hover lift effect: hover:-translate-y-3 hover:shadow-2xl transition-all duration-500');
            contextParts.push('- Border subtle: border border-gray-100');
            contextParts.push('- Gradient borders: border-2 border-transparent bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-border');
            contextParts.push('- Glass cards: backdrop-blur-xl bg-white/80 rounded-3xl shadow-2xl border border-white/20');
            contextParts.push('- Dark cards: bg-gray-800/90 backdrop-blur-md rounded-2xl border border-gray-700/50');
            contextParts.push('- Premium card example: className="group bg-white rounded-3xl shadow-xl p-10 border border-gray-100 hover:shadow-2xl hover:-translate-y-4 hover:scale-[1.02] transition-all duration-500 cursor-pointer"');
            contextParts.push('\n🎭 VISUAL HIERARCHY & LAYOUT BEAUTY:');
            contextParts.push('- Large headings: text-4xl md:text-5xl lg:text-6xl font-black');
            contextParts.push('- Subheadings: text-xl md:text-2xl text-gray-600');
            contextParts.push('- Body text: text-base md:text-lg text-gray-700 leading-relaxed');
            contextParts.push('- Spacing between sections: py-20 md:py-32');
            contextParts.push('- Container max-width: max-w-7xl mx-auto');
            contextParts.push('- Grid layouts: grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8');
            contextParts.push('- Alternating section backgrounds: bg-white and bg-gray-50 for rhythm');
            contextParts.push('- Asymmetric layouts for visual interest (not always centered)');
            contextParts.push('\n🌟 SPECIAL EFFECTS & DECORATIVE ELEMENTS:');
            contextParts.push('- Floating blobs: absolute rounded-full blur-3xl opacity-20 animate-pulse');
            contextParts.push('- Gradient orbs: bg-gradient-to-r from-blue-400 to-purple-400 rounded-full blur-3xl');
            contextParts.push('- Subtle patterns: Use CSS patterns or subtle background images');
            contextParts.push('- Animated gradients: Consider subtle color shifts');
            contextParts.push('- Particles/confetti effects (optional, for special sections)');
            contextParts.push('- Glassmorphism overlays: backdrop-blur-2xl bg-white/10');
            contextParts.push('\n🎨 ICON & IMAGE BEAUTY:');
            contextParts.push('- Use Heroicons or similar clean icon sets');
            contextParts.push('- Icon backgrounds: bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl p-4');
            contextParts.push('- Icon sizing: w-12 h-12 md:w-16 md:h-16');
            contextParts.push('- Image rounded corners: rounded-2xl or rounded-3xl');
            contextParts.push('- Image hover effects: hover:scale-105 transition-transform duration-300');
            contextParts.push('- Image overlays: Overlay gradients on images for text readability');
            contextParts.push('- High-quality images: ALWAYS use Picsum Photos or Unsplash for instant, beautiful images');
            contextParts.push('  **Picsum Photos (RECOMMENDED - fastest, no API key needed):**');
            contextParts.push('    * Hero sections: src="https://picsum.photos/1600/900"');
            contextParts.push('    * Feature cards: src="https://picsum.photos/400/300"');
            contextParts.push('    * Gallery/grid: src="https://picsum.photos/600/400"');
            contextParts.push('    * Consistent images (same ID): src="https://picsum.photos/id/237/800/600" (dog), id/1015/800/600 (mountain), id/1018/800/600 (nature)');
            contextParts.push('  **Unsplash Source (for themed images):**');
            contextParts.push('    * Technology: src="https://source.unsplash.com/800x600/?technology"');
            contextParts.push('    * Business: src="https://source.unsplash.com/800x600/?business"');
            contextParts.push('    * Nature: src="https://source.unsplash.com/1600x900/?nature"');
            contextParts.push('    * Abstract: src="https://source.unsplash.com/1200x800/?abstract"');
            contextParts.push('  **Always add proper image attributes:**');
            contextParts.push('    <img src="https://picsum.photos/800/600" alt="Descriptive text" className="rounded-2xl shadow-xl w-full" loading="lazy" />');
            contextParts.push('  **🚨 IMAGE VERIFICATION - CRITICAL:**');
            contextParts.push('    - ALL image URLs MUST be from VERIFIED sources: Picsum Photos or Unsplash Source');
            contextParts.push('    - These sources are CDN-backed and 100% guaranteed to load');
            contextParts.push('    - Use specific image IDs for consistency (same image every time)');
            contextParts.push('    - NEVER use placeholder.com, broken URLs, or unverified sources');
            contextParts.push('    - ALL images MUST have https:// protocol (never http://)');
            contextParts.push('  **Image size guidelines:**');
            contextParts.push('    - Hero sections: 1600x900 or 1920x1080');
            contextParts.push('    - Feature cards: 400x300 or 600x400');
            contextParts.push('    - Thumbnails: 300x300 or 400x400');
            contextParts.push('    - Backgrounds: 1600x900 (landscape) or match container size');
            contextParts.push('\n🌊 SMOOTH ANIMATIONS & TRANSITIONS:');
            contextParts.push('- Page load fade-in: animate-[fadeIn_0.8s_ease-in]');
            contextParts.push('- Stagger animations: delay-100, delay-200, delay-300 for list items');
            contextParts.push('- Smooth scrolling: html { scroll-behavior: smooth; } MUST be in index.css');
            contextParts.push('- Parallax-ready structure (if needed)');
            contextParts.push('- Hover state transitions: transition-all duration-300 ease-in-out');
            contextParts.push('- Active state feedback: active:scale-95');
            contextParts.push('\n🔗 COMPONENT INTERLINKING & NAVIGATION (CRITICAL FOR UX):');
            contextParts.push('1. **Section IDs** - EVERY section MUST have unique IDs:');
            contextParts.push('   - <section id="hero">Hero content</section>');
            contextParts.push('   - <section id="features">Features content</section>');
            contextParts.push('   - <section id="about">About content</section>');
            contextParts.push('   - <section id="contact">Contact content</section>');
            contextParts.push('2. **Navigation Links** - MUST match section IDs:');
            contextParts.push('   <a href="#hero" onClick={() => scrollToSection("hero")}>Home</a>');
            contextParts.push('   <a href="#features" onClick={() => scrollToSection("features")}>Features</a>');
            contextParts.push('3. **Scroll Function** - Include in Header/Nav component:');
            contextParts.push('   const scrollToSection = (id) => {');
            contextParts.push('     const element = document.getElementById(id);');
            contextParts.push('     if (element) element.scrollIntoView({ behavior: "smooth", block: "start" });');
            contextParts.push('   };');
            contextParts.push('4. **Mobile Menu** - MUST use useState for open/close:');
            contextParts.push('   const [isMenuOpen, setIsMenuOpen] = useState(false);');
            contextParts.push('   - Toggle function: onClick={() => setIsMenuOpen(!isMenuOpen)}');
            contextParts.push('   - Close on link click: onClick={() => { scrollToSection(id); setIsMenuOpen(false); }}');
            contextParts.push('   - Smooth slide-in animation: transform translate-x-full when closed');
            contextParts.push('5. **Active Link State** - Track current section:');
            contextParts.push('   const [activeSection, setActiveSection] = useState("hero");');
            contextParts.push('   - Update on scroll or link click');
            contextParts.push('   - Apply active styles: className={activeSection === "hero" ? "text-blue-600 font-bold" : ""}');
            contextParts.push('6. **Component Integration** - App.jsx MUST:');
            contextParts.push('   - Import all components: import Header from "./components/Header";');
            contextParts.push('   - Arrange in order: Header → Hero → Features → About → Footer');
            contextParts.push('   - Pass necessary props between components');
            contextParts.push('   - Ensure all components are properly rendered');
            contextParts.push('7. **Interactive Elements** - All buttons MUST have onClick handlers:');
            contextParts.push('   - CTA buttons: onClick={() => scrollToSection("contact")}');
            contextParts.push('   - Navigation links: onClick={() => scrollToSection("section-id")}');
            contextParts.push('   - Form buttons: onSubmit={handleSubmit} with preventDefault');
            contextParts.push('8. **Form Handling** (if forms exist):');
            contextParts.push('   - useState for each input field');
            contextParts.push('   - onChange handlers for controlled inputs');
            contextParts.push('   - onSubmit with preventDefault and validation');
            contextParts.push('   - Success/error state display');
            contextParts.push('9. **Footer Links** - MUST link to sections:');
            contextParts.push('   - Quick links: href="#features", href="#about", etc.');
            contextParts.push('   - Social media links: href with target="_blank" rel="noopener noreferrer"');
            contextParts.push('10. **Error Prevention** - Always check:');
            contextParts.push('    - All imports exist before using');
            contextParts.push('    - All functions are defined');
            contextParts.push('    - All useState hooks are at component top');
            contextParts.push('    - All event handlers are properly bound');
            contextParts.push('\n🎪 BEAUTIFUL NAVIGATION:');
            contextParts.push('- Sticky header: sticky top-0 z-50');
            contextParts.push('- Backdrop blur: backdrop-blur-xl bg-white/80');
            contextParts.push('- Glass effect: bg-white/90 backdrop-blur-md border-b border-gray-200/50');
            contextParts.push('- Smooth mobile menu: Slide-in from right with backdrop');
            contextParts.push('- Active link indicator: Underline or highlight current page');
            contextParts.push('- Logo/name: Large, bold, prominent');
            contextParts.push('\n✨ PREMIUM FOOTER:');
            contextParts.push('- Dark footer: bg-gray-900 text-white');
            contextParts.push('- Gradient footer: bg-gradient-to-br from-gray-900 to-black');
            contextParts.push('- Organized columns: grid grid-cols-2 md:grid-cols-4 gap-8');
            contextParts.push('- Social icons: Rounded, hover effects, colorful');
            contextParts.push('- Subtle borders: border-t border-gray-800');
            contextParts.push('- Links hover: hover:text-blue-400 transition-colors');
            contextParts.push('\n🎯 FINAL BEAUTY CHECKLIST:');
            contextParts.push('✓ Every section has proper spacing (py-16 or py-24 minimum)');
            contextParts.push('✓ All buttons have hover effects and smooth transitions');
            contextParts.push('✓ All cards lift or transform on hover');
            contextParts.push('✓ Color gradients are used strategically');
            contextParts.push('✓ Typography has proper hierarchy (large headings, readable body)');
            contextParts.push('✓ No harsh edges (use rounded corners: rounded-xl, rounded-2xl, rounded-3xl)');
            contextParts.push('✓ Shadows create depth (shadow-lg, shadow-xl, shadow-2xl)');
            contextParts.push('✓ White space is generous (don\'t cramp elements)');
            contextParts.push('✓ All interactive elements provide visual feedback');
            contextParts.push('✓ Colors are vibrant but not overwhelming');
            contextParts.push('✓ Mobile experience is as beautiful as desktop');
            contextParts.push('\n🚀 REMEMBER: Create a website so beautiful that users will want to take screenshots and share it!');
            contextParts.push('Think like Apple, Stripe, or Linear - clean, modern, and absolutely stunning.');
            contextParts.push('\n✅ PERFECT UX CHECKLIST - EVERY SITE MUST HAVE:');
            contextParts.push('1. ✓ Smooth scrolling enabled (html { scroll-behavior: smooth; } in index.css)');
            contextParts.push('2. ✓ Every section has unique ID (id="hero", id="features", id="about", etc.)');
            contextParts.push('3. ✓ Navigation links properly connect to sections (href="#section-id")');
            contextParts.push('4. ✓ Scroll function implemented in Header component');
            contextParts.push('5. ✓ Mobile menu works with useState (opens/closes smoothly)');
            contextParts.push('6. ✓ Mobile menu closes when link is clicked');
            contextParts.push('7. ✓ All buttons have onClick handlers');
            contextParts.push('8. ✓ CTA buttons scroll to correct sections');
            contextParts.push('9. ✓ Footer links work (anchor links to sections)');
            contextParts.push('10. ✓ Active link highlighting (current section is visually indicated)');
            contextParts.push('11. ✓ All components are imported in App.jsx');
            contextParts.push('12. ✓ Components are arranged in logical order');
            contextParts.push('13. ✓ No broken links or missing imports');
            contextParts.push('14. ✓ Forms have proper state management (if forms exist)');
            contextParts.push('15. ✓ Interactive elements provide visual feedback');
            contextParts.push('16. ✓ Loading states for async actions (if any)');
            contextParts.push('17. ✓ Error handling for user inputs (if forms exist)');
            contextParts.push('18. ✓ Responsive design works on all screen sizes');
            contextParts.push('19. ✓ Smooth transitions between sections');
            contextParts.push('20. ✓ All interactive elements are accessible (keyboard navigation)');
            contextParts.push('\n🎯 FINAL QUALITY CHECK:');
            contextParts.push('Before completing, verify:');
            contextParts.push('- Navigation clicks scroll to correct sections smoothly');
            contextParts.push('- Mobile menu toggles properly and closes on link click');
            contextParts.push('- All sections have IDs that match navigation links');
            contextParts.push('- Footer links navigate to sections correctly');
            contextParts.push('- CTA buttons in hero link to appropriate sections');
            contextParts.push('- Components are properly composed and work together');
            contextParts.push('- No console errors when clicking buttons/links');
            contextParts.push('- Site feels cohesive and professionally built');
          }
          
          // Add conversation context (scraped websites, etc)
          if (context.conversationContext) {
            if (context.conversationContext.scrapedWebsites?.length > 0) {
              contextParts.push('\nScraped Websites in Context:');
              context.conversationContext.scrapedWebsites.forEach((site: any) => {
                contextParts.push(`\nURL: ${site.url}`);
                contextParts.push(`Scraped: ${new Date(site.timestamp).toLocaleString()}`);
                if (site.content) {
                  // Include a summary of the scraped content
                  const contentPreview = typeof site.content === 'string' 
                    ? site.content.substring(0, 1000) 
                    : JSON.stringify(site.content).substring(0, 1000);
                  contextParts.push(`Content Preview: ${contentPreview}...`);
                }
              });
            }
            
            if (context.conversationContext.currentProject) {
              contextParts.push(`\nCurrent Project: ${context.conversationContext.currentProject}`);
            }
          }
          
          if (contextParts.length > 0) {
            fullPrompt = `CONTEXT:\n${contextParts.join('\n')}\n\nUSER REQUEST:\n${prompt}`;
          }
        }
        
        await sendProgress({ type: 'status', message: 'Planning application structure...' });
        
        console.log('\n[generate-ai-code-stream] Starting streaming response...\n');
        
        // Track packages that need to be installed
        const packagesToInstall: string[] = [];
        
        // Determine which provider to use based on model
        const isAnthropic = model.startsWith('anthropic/');
        const isGoogle = model.startsWith('google/');
        const isOpenAI = model.startsWith('openai/gpt-5');
        const modelProvider = isAnthropic ? anthropic : (isOpenAI ? openai : (isGoogle ? googleGenerativeAI : groq));
        const actualModel = isAnthropic ? model.replace('anthropic/', '') : 
                           (model === 'openai/gpt-5') ? 'gpt-5' :
                           (isGoogle ? model.replace('google/', '') : model);

        // Make streaming API call with appropriate provider
        const streamOptions: any = {
          model: modelProvider(actualModel),
          messages: [
            { 
              role: 'system', 
              content: systemPrompt + `

🚨 CRITICAL CODE GENERATION RULES - VIOLATION = FAILURE 🚨:
1. NEVER truncate ANY code - ALWAYS write COMPLETE files
2. NEVER use "..." anywhere in your code - this causes syntax errors
3. NEVER cut off strings mid-sentence - COMPLETE every string
4. NEVER leave incomplete class names or attributes
5. ALWAYS close ALL tags, quotes, brackets, and parentheses
6. If you run out of space, prioritize completing the current file

CRITICAL STRING RULES TO PREVENT SYNTAX ERRORS:
- NEVER write: className="px-8 py-4 bg-black text-white font-bold neobrut-border neobr...
- ALWAYS write: className="px-8 py-4 bg-black text-white font-bold neobrut-border neobrut-shadow"
- COMPLETE every className attribute
- COMPLETE every string literal
- NO ellipsis (...) ANYWHERE in code

PACKAGE RULES:
- For INITIAL generation: Use ONLY React, no external packages
- For EDITS: You may use packages, specify them with <package> tags
- NEVER install packages like @mendable/firecrawl-js unless explicitly requested

Examples of SYNTAX ERRORS (NEVER DO THIS):
❌ className="px-4 py-2 bg-blue-600 hover:bg-blue-7...
❌ <button className="btn btn-primary btn-...
❌ const title = "Welcome to our...
❌ import { useState, useEffect, ... } from 'react'

Examples of CORRECT CODE (ALWAYS DO THIS):
✅ className="px-4 py-2 bg-blue-600 hover:bg-blue-700"
✅ <button className="btn btn-primary btn-large">
✅ const title = "Welcome to our application"
✅ import { useState, useEffect, useCallback } from 'react'

REMEMBER: It's better to generate fewer COMPLETE files than many INCOMPLETE files.`
            },
            { 
              role: 'user', 
              content: fullPrompt + `

CRITICAL: You MUST complete EVERY file you start. If you write:
<file path="src/components/Hero.jsx">

You MUST include the closing </file> tag and ALL the code in between.

NEVER write partial code like:
<h1>Build and deploy on the AI Cloud.</h1>
<p>Some text...</p>  ❌ WRONG

ALWAYS write complete code:
<h1>Build and deploy on the AI Cloud.</h1>
<p>Some text here with full content</p>  ✅ CORRECT

If you're running out of space, generate FEWER files but make them COMPLETE.
It's better to have 3 complete files than 10 incomplete files.`
            }
          ],
          maxTokens: 8192, // Reduce to ensure completion
          stopSequences: [] // Don't stop early
          // Note: Neither Groq nor Anthropic models support tool/function calling in this context
          // We use XML tags for package detection instead
        };
        
        // Add temperature for non-reasoning models
        if (!model.startsWith('openai/gpt-5')) {
          streamOptions.temperature = 0.7;
        }
        
        // Add reasoning effort for GPT-5 models
        if (isOpenAI) {
          streamOptions.experimental_providerMetadata = {
            openai: {
              reasoningEffort: 'high'
            }
          };
        }
        
        const result = await streamText(streamOptions);
        
        // Stream the response and parse in real-time
        let generatedCode = '';
        let currentFile = '';
        let currentFilePath = '';
        let componentCount = 0;
        let isInFile = false;
        let isInTag = false;
        let conversationalBuffer = '';
        
        // Buffer for incomplete tags
        let tagBuffer = '';
        
        // Stream the response and parse for packages in real-time
        for await (const textPart of result.textStream) {
          const text = textPart || '';
          generatedCode += text;
          currentFile += text;
          
          // Combine with buffer for tag detection
          const searchText = tagBuffer + text;
          
          // Log streaming chunks to console
          process.stdout.write(text);
          
          // Check if we're entering or leaving a tag
          const hasOpenTag = /<(file|package|packages|explanation|command|structure|template)\b/.test(text);
          const hasCloseTag = /<\/(file|package|packages|explanation|command|structure|template)>/.test(text);
          
          if (hasOpenTag) {
            // Send any buffered conversational text before the tag
            if (conversationalBuffer.trim() && !isInTag) {
              await sendProgress({ 
                type: 'conversation', 
                text: conversationalBuffer.trim()
              });
              conversationalBuffer = '';
            }
            isInTag = true;
          }
          
          if (hasCloseTag) {
            isInTag = false;
          }
          
          // If we're not in a tag, buffer as conversational text
          if (!isInTag && !hasOpenTag) {
            conversationalBuffer += text;
          }
          
          // Stream the raw text for live preview
          await sendProgress({ 
            type: 'stream', 
            text: text,
            raw: true 
          });
          
          // Check for package tags in buffered text (ONLY for edits, not initial generation)
          let lastIndex = 0;
          if (isEdit) {
            const packageRegex = /<package>([^<]+)<\/package>/g;
            let packageMatch;
            
            while ((packageMatch = packageRegex.exec(searchText)) !== null) {
              const packageName = packageMatch[1].trim();
              if (packageName && !packagesToInstall.includes(packageName)) {
                packagesToInstall.push(packageName);
                console.log(`[generate-ai-code-stream] Package detected: ${packageName}`);
                await sendProgress({ 
                  type: 'package', 
                  name: packageName,
                  message: `Package detected: ${packageName}`
                });
              }
              lastIndex = packageMatch.index + packageMatch[0].length;
            }
          }
          
          // Keep unmatched portion in buffer for next iteration
          tagBuffer = searchText.substring(Math.max(0, lastIndex - 50)); // Keep last 50 chars
          
          // Check for file boundaries
          if (text.includes('<file path="')) {
            const pathMatch = text.match(/<file path="([^"]+)"/);
            if (pathMatch) {
              currentFilePath = pathMatch[1];
              isInFile = true;
              currentFile = text;
            }
          }
          
          // Check for file end
          if (isInFile && currentFile.includes('</file>')) {
            isInFile = false;
            
            // Send component progress update
            if (currentFilePath.includes('components/')) {
              componentCount++;
              const componentName = currentFilePath.split('/').pop()?.replace('.jsx', '') || 'Component';
              await sendProgress({ 
                type: 'component', 
                name: componentName,
                path: currentFilePath,
                index: componentCount
              });
            } else if (currentFilePath.includes('App.jsx')) {
              await sendProgress({ 
                type: 'app', 
                message: 'Generated main App.jsx',
                path: currentFilePath
              });
            }
            
            currentFile = '';
            currentFilePath = '';
          }
        }
        
        console.log('\n\n[generate-ai-code-stream] Streaming complete.');
        
        // Send any remaining conversational text
        if (conversationalBuffer.trim()) {
          await sendProgress({ 
            type: 'conversation', 
            text: conversationalBuffer.trim()
          });
        }
        
        // Also parse <packages> tag for multiple packages - ONLY for edits
        if (isEdit) {
          const packagesRegex = /<packages>([\s\S]*?)<\/packages>/g;
          let packagesMatch;
          while ((packagesMatch = packagesRegex.exec(generatedCode)) !== null) {
            const packagesContent = packagesMatch[1].trim();
            const packagesList = packagesContent.split(/[\n,]+/)
              .map(pkg => pkg.trim())
              .filter(pkg => pkg.length > 0);
            
            for (const packageName of packagesList) {
              if (!packagesToInstall.includes(packageName)) {
                packagesToInstall.push(packageName);
                console.log(`[generate-ai-code-stream] Package from <packages> tag: ${packageName}`);
                await sendProgress({ 
                  type: 'package', 
                  name: packageName,
                  message: `Package detected: ${packageName}`
                });
              }
            }
          }
        }
        
        // Function to extract packages from import statements
        function extractPackagesFromCode(content: string): string[] {
          const packages: string[] = [];
          // Match ES6 imports
          const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))*\s+from\s+)?['"]([^'"]+)['"]/g;
          let importMatch;
          
          while ((importMatch = importRegex.exec(content)) !== null) {
            const importPath = importMatch[1];
            // Skip relative imports and built-in React
            if (!importPath.startsWith('.') && !importPath.startsWith('/') && 
                importPath !== 'react' && importPath !== 'react-dom' &&
                !importPath.startsWith('@/')) {
              // Extract package name (handle scoped packages like @heroicons/react)
              const packageName = importPath.startsWith('@') 
                ? importPath.split('/').slice(0, 2).join('/')
                : importPath.split('/')[0];
              
              if (!packages.includes(packageName)) {
                packages.push(packageName);
              }
            }
          }
          
          return packages;
        }
        
        // Parse files and send progress for each
        const fileRegex = /<file path="([^"]+)">([\s\S]*?)<\/file>/g;
        const files = [];
        let match;
        
        while ((match = fileRegex.exec(generatedCode)) !== null) {
          const filePath = match[1];
          const content = match[2].trim();
          files.push({ path: filePath, content });
          
          // Extract packages from file content - ONLY for edits
          if (isEdit) {
            const filePackages = extractPackagesFromCode(content);
            for (const pkg of filePackages) {
              if (!packagesToInstall.includes(pkg)) {
                packagesToInstall.push(pkg);
                console.log(`[generate-ai-code-stream] Package detected from imports: ${pkg}`);
                await sendProgress({ 
                  type: 'package', 
                  name: pkg,
                  message: `Package detected from imports: ${pkg}`
                });
              }
            }
          }
          
          // Send progress for each file (reusing componentCount from streaming)
          if (filePath.includes('components/')) {
            const componentName = filePath.split('/').pop()?.replace('.jsx', '') || 'Component';
            await sendProgress({ 
              type: 'component', 
              name: componentName,
              path: filePath,
              index: componentCount
            });
          } else if (filePath.includes('App.jsx')) {
            await sendProgress({ 
              type: 'app', 
              message: 'Generated main App.jsx',
              path: filePath
            });
          }
        }
        
        // Extract explanation
        const explanationMatch = generatedCode.match(/<explanation>([\s\S]*?)<\/explanation>/);
        const explanation = explanationMatch ? explanationMatch[1].trim() : 'Code generated successfully!';
        
        // Validate generated code for truncation issues
        const truncationWarnings: string[] = [];
        
        // Skip ellipsis checking entirely - too many false positives with spread operators, loading text, etc.
        
        // Check for unclosed file tags
        const fileOpenCount = (generatedCode.match(/<file path="/g) || []).length;
        const fileCloseCount = (generatedCode.match(/<\/file>/g) || []).length;
        if (fileOpenCount !== fileCloseCount) {
          truncationWarnings.push(`Unclosed file tags detected: ${fileOpenCount} open, ${fileCloseCount} closed`);
        }
        
        // Check for files that seem truncated (very short or ending abruptly)
        const truncationCheckRegex = /<file path="([^"]+)">([\s\S]*?)(?:<\/file>|$)/g;
        let truncationMatch;
        while ((truncationMatch = truncationCheckRegex.exec(generatedCode)) !== null) {
          const filePath = truncationMatch[1];
          const content = truncationMatch[2];
          
          // Only check for really obvious HTML truncation - file ends with opening tag
          if (content.trim().endsWith('<') || content.trim().endsWith('</')) {
            truncationWarnings.push(`File ${filePath} appears to have incomplete HTML tags`);
          }
          
          // Skip "..." check - too many false positives with loading text, etc.
          
          // Only check for SEVERE truncation issues
          if (filePath.match(/\.(jsx?|tsx?)$/)) {
            // Only check for severely unmatched brackets (more than 3 difference)
            const openBraces = (content.match(/{/g) || []).length;
            const closeBraces = (content.match(/}/g) || []).length;
            const braceDiff = Math.abs(openBraces - closeBraces);
            if (braceDiff > 3) { // Only flag severe mismatches
              truncationWarnings.push(`File ${filePath} has severely unmatched braces (${openBraces} open, ${closeBraces} closed)`);
            }
            
            // Check if file is extremely short and looks incomplete
            if (content.length < 20 && content.includes('function') && !content.includes('}')) {
              truncationWarnings.push(`File ${filePath} appears severely truncated`);
            }
          }
        }
        
        // Handle truncation with automatic retry (if enabled in config)
        if (truncationWarnings.length > 0 && appConfig.codeApplication.enableTruncationRecovery) {
          console.warn('[generate-ai-code-stream] Truncation detected, attempting to fix:', truncationWarnings);
          
          await sendProgress({
            type: 'warning',
            message: 'Detected incomplete code generation. Attempting to complete...',
            warnings: truncationWarnings
          });
          
          // Try to fix truncated files automatically
          const truncatedFiles: string[] = [];
          const fileRegex = /<file path="([^"]+)">([\s\S]*?)(?:<\/file>|$)/g;
          let match;
          
          while ((match = fileRegex.exec(generatedCode)) !== null) {
            const filePath = match[1];
            const content = match[2];
            
            // Check if this file appears truncated - be more selective
            const hasEllipsis = content.includes('...') && 
                               !content.includes('...rest') && 
                               !content.includes('...props') &&
                               !content.includes('spread');
                               
            const endsAbruptly = content.trim().endsWith('...') || 
                                 content.trim().endsWith(',') ||
                                 content.trim().endsWith('(');
                                 
            const hasUnclosedTags = content.includes('</') && 
                                    !content.match(/<\/[a-zA-Z0-9]+>/) &&
                                    content.includes('<');
                                    
            const tooShort = content.length < 50 && filePath.match(/\.(jsx?|tsx?)$/);
            
            // Check for unmatched braces specifically
            const openBraceCount = (content.match(/{/g) || []).length;
            const closeBraceCount = (content.match(/}/g) || []).length;
            const hasUnmatchedBraces = Math.abs(openBraceCount - closeBraceCount) > 1;
            
            const isTruncated = (hasEllipsis && endsAbruptly) || 
                               hasUnclosedTags || 
                               (tooShort && !content.includes('export')) ||
                               hasUnmatchedBraces;
            
            if (isTruncated) {
              truncatedFiles.push(filePath);
            }
          }
          
          // If we have truncated files, try to regenerate them
          if (truncatedFiles.length > 0) {
            console.log('[generate-ai-code-stream] Attempting to regenerate truncated files:', truncatedFiles);
            
            for (const filePath of truncatedFiles) {
              await sendProgress({
                type: 'info',
                message: `Completing ${filePath}...`
              });
              
              try {
                // Create a focused prompt to complete just this file
                const completionPrompt = `Complete the following file that was truncated. Provide the FULL file content.
                
File: ${filePath}
Original request: ${prompt}
                
Provide the complete file content without any truncation. Include all necessary imports, complete all functions, and close all tags properly.`;
                
                // Make a focused API call to complete this specific file
                // Create a new client for the completion based on the provider
                let completionClient;
                if (model.includes('gpt') || model.includes('openai')) {
                  completionClient = openai;
                } else if (model.includes('claude')) {
                  completionClient = anthropic;
                } else {
                  completionClient = groq;
                }
                
                const completionResult = await streamText({
                  model: completionClient(modelMapping[model] || model),
                  messages: [
                    { 
                      role: 'system', 
                      content: 'You are completing a truncated file. Provide the complete, working file content.'
                    },
                    { role: 'user', content: completionPrompt }
                  ],
                  temperature: isGPT5 ? undefined : appConfig.ai.defaultTemperature,
                  maxTokens: appConfig.ai.truncationRecoveryMaxTokens
                });
                
                // Get the full text from the stream
                let completedContent = '';
                for await (const chunk of completionResult.textStream) {
                  completedContent += chunk;
                }
                
                // Replace the truncated file in the generatedCode
                const filePattern = new RegExp(
                  `<file path="${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">[\\s\\S]*?(?:</file>|$)`,
                  'g'
                );
                
                // Extract just the code content (remove any markdown or explanation)
                let cleanContent = completedContent;
                if (cleanContent.includes('```')) {
                  const codeMatch = cleanContent.match(/```[\w]*\n([\s\S]*?)```/);
                  if (codeMatch) {
                    cleanContent = codeMatch[1];
                  }
                }
                
                generatedCode = generatedCode.replace(
                  filePattern,
                  `<file path="${filePath}">\n${cleanContent}\n</file>`
                );
                
                console.log(`[generate-ai-code-stream] Successfully completed ${filePath}`);
                
              } catch (completionError) {
                console.error(`[generate-ai-code-stream] Failed to complete ${filePath}:`, completionError);
                await sendProgress({
                  type: 'warning',
                  message: `Could not auto-complete ${filePath}. Manual review may be needed.`
                });
              }
            }
            
            // Clear the warnings after attempting fixes
            truncationWarnings.length = 0;
            await sendProgress({
              type: 'info',
              message: 'Truncation recovery complete'
            });
          }
        }
        
        // Send completion with packages info
        await sendProgress({ 
          type: 'complete', 
          generatedCode,
          explanation,
          files: files.length,
          components: componentCount,
          model,
          packagesToInstall: packagesToInstall.length > 0 ? packagesToInstall : undefined,
          warnings: truncationWarnings.length > 0 ? truncationWarnings : undefined
        });
        
        // Track edit in conversation history
        if (isEdit && editContext && global.conversationState) {
          const editRecord: ConversationEdit = {
            timestamp: Date.now(),
            userRequest: prompt,
            editType: editContext.editIntent.type,
            targetFiles: editContext.primaryFiles,
            confidence: editContext.editIntent.confidence,
            outcome: 'success' // Assuming success if we got here
          };
          
          global.conversationState.context.edits.push(editRecord);
          
          // Track major changes
          if (editContext.editIntent.type === 'ADD_FEATURE' || files.length > 3) {
            global.conversationState.context.projectEvolution.majorChanges.push({
              timestamp: Date.now(),
              description: editContext.editIntent.description,
              filesAffected: editContext.primaryFiles
            });
          }
          
          // Update last updated timestamp
          global.conversationState.lastUpdated = Date.now();
          
          console.log('[generate-ai-code-stream] Updated conversation history with edit:', editRecord);
        }
        
      } catch (error) {
        console.error('[generate-ai-code-stream] Stream processing error:', error);
        
        // Check if it's a tool validation error
        if ((error as any).message?.includes('tool call validation failed')) {
          console.error('[generate-ai-code-stream] Tool call validation error - this may be due to the AI model sending incorrect parameters');
          await sendProgress({ 
            type: 'warning', 
            message: 'Package installation tool encountered an issue. Packages will be detected from imports instead.'
          });
          // Continue processing - packages can still be detected from the code
        } else {
          await sendProgress({ 
            type: 'error', 
            error: (error as Error).message 
          });
        }
      } finally {
        await writer.close();
      }
    })();
    
    // Return the stream
    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
    
  } catch (error) {
    console.error('[generate-ai-code-stream] Error:', error);
    return NextResponse.json({ 
      success: false, 
      error: (error as Error).message 
    }, { status: 500 });
  }
}