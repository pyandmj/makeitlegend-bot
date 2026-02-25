import { Message, Attachment } from 'discord.js';
import { config } from '../config';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter, getManusClient } from '../services/service-registry';
import OpenAI from 'openai';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

const logger = createModuleLogger('event:message');

// Track the active Manus task ID for multi-turn conversation continuity
let activeManusTaskId: string | null = null;

// OpenAI client for Whisper transcription only
let whisperClient: OpenAI | null = null;

function getWhisperClient(): OpenAI | null {
  if (!whisperClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('OPENAI_API_KEY not set — voice memo transcription unavailable');
      return null;
    }
    whisperClient = new OpenAI();
  }
  return whisperClient;
}

// Prime's system context — prepended to the first message in each Manus task
const PRIME_CONTEXT = `You are Prime, the AI coordinator for Make It Legend — an AI pet portrait business. You are the brain of the operation, managing a team of AI directors:

- Alex — Engineering Director (website, infrastructure, APIs)
- Maya — Creative Director (portrait generation, UGC, content)
- Sam — Marketing Director (SEO, social media, campaigns)
- Jordan — Operations Director (orders, support, QA)
- Riley — Analytics Director (KPIs, credit tracking, anomalies)

You report directly to the Founder (the human you're chatting with). Your job:
1. Understand what the Founder wants
2. Delegate to the right department via Manus tasks
3. Track progress and report back
4. Make smart recommendations
5. Keep things moving efficiently

Communication style:
- Talk like a real person, not a bot. Casual but professional.
- Keep responses concise — 1-3 short paragraphs max
- No markdown formatting, no bullet points, no headers — just plain conversational text
- Be direct and action-oriented
- When the Founder gives you a task, confirm what you'll do and which director handles it
- If something is unclear, ask for clarification
- You know the business inside out: AI pet portraits, $9 main product, upsells, Stripe payments, makeitlegend.ai

Current business context:
- Website is live at makeitlegend.ai (built with Next.js on Vercel)
- Portrait generation uses a two-step process (LLM describes the pet, then AI generates painting from text)
- Three portrait styles: Royal General, Space Explorer, Superhero
- Stripe integration needs to be wired up for real payments
- The team just set up this Discord command center today
- Discord bot runs on Railway at web-production-2dac0.up.railway.app`;

/**
 * Sends a message to Manus AI and polls for the response.
 * Uses multi-turn conversation (continues existing task if available).
 */
async function getPrimeResponseViaManus(userMessage: string): Promise<string> {
  const manusClient = getManusClient();
  if (!manusClient) {
    return "My brain isn't connected — the Manus API key needs to be set up in Railway.";
  }

  try {
    // If we have an active task, continue the conversation
    if (activeManusTaskId) {
      logger.info(`Continuing Manus task ${activeManusTaskId} with new message`);
      const continueResult = await manusClient.continueTask(activeManusTaskId, userMessage);
      
      if (continueResult) {
        // Poll for the response
        const taskDetail = await manusClient.pollTaskUntilDone(continueResult.task_id, {
          intervalMs: 3_000,
          timeoutMs: 120_000, // 2 minutes max
        });

        if (taskDetail) {
          const extracted = manusClient.extractTaskOutput(taskDetail);
          if (extracted.text) {
            // Update active task ID in case it changed
            activeManusTaskId = continueResult.task_id;
            return extracted.text;
          }
        }
      }
      
      // If continue failed, start a fresh task
      logger.warn('Continue task failed, starting fresh conversation');
      activeManusTaskId = null;
    }

    // Start a new Manus task for Prime
    const enrichedPrompt = `${PRIME_CONTEXT}\n\n---\n\nThe Founder says: ${userMessage}`;
    
    const result = await manusClient.createTask({
      department: 'engineering', // Prime is cross-department but needs a department for routing
      agent: 'prime',
      operation: 'prime:conversation',
      request: {
        prompt: enrichedPrompt,
        agentProfile: 'manus-1.6',
        hideInTaskList: true,
      },
      estimatedCredits: 0.5,
    });

    if (!result.success || !result.taskResponse) {
      logger.error('Failed to create Manus task for Prime', { error: result.error });
      return "Something went wrong creating my task. Let me try again in a moment.";
    }

    const manusTaskId = result.taskResponse.task_id;
    logger.info(`Created Manus task for Prime: ${manusTaskId}`);

    // Poll for the response
    const taskDetail = await manusClient.pollTaskUntilDone(manusTaskId, {
      intervalMs: 3_000,
      timeoutMs: 120_000, // 2 minutes max
    });

    if (!taskDetail) {
      logger.warn(`Prime Manus task timed out: ${manusTaskId}`);
      return "I'm still thinking on that one — took longer than expected. Try asking again?";
    }

    const extracted = manusClient.extractTaskOutput(taskDetail);
    
    if (extracted.text) {
      // Save the task ID for multi-turn continuation
      activeManusTaskId = manusTaskId;
      return extracted.text;
    }

    return "I processed your message but didn't get a clear response back. Could you rephrase?";

  } catch (error: any) {
    logger.error('Prime Manus response failed', { error: error?.message || error });
    return "Something went wrong on my end. Let me try again in a moment.";
  }
}

/**
 * Downloads a file from a URL to a temporary path.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          https.get(redirectUrl, (res) => {
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }).on('error', reject);
          return;
        }
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Transcribes a voice memo attachment using OpenAI Whisper.
 */
async function transcribeVoiceMemo(attachment: Attachment): Promise<string | null> {
  const whisper = getWhisperClient();
  if (!whisper) return null;

  const tmpDir = os.tmpdir();
  const ext = path.extname(attachment.name || '.ogg') || '.ogg';
  const tmpPath = path.join(tmpDir, `voice_${Date.now()}${ext}`);

  try {
    logger.info(`Downloading voice memo: ${attachment.name} (${attachment.size} bytes)`);
    await downloadFile(attachment.url, tmpPath);

    logger.info('Transcribing voice memo with Whisper...');
    const transcription = await whisper.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
    });

    logger.info(`Transcription complete: ${transcription.text.substring(0, 100)}...`);
    return transcription.text;
  } catch (error: any) {
    logger.error('Failed to transcribe voice memo', { error: error?.message || error });
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Handles incoming messages in the ceo-briefing channel.
 * Prime responds to the Founder's messages (text and voice memos).
 * Uses Manus AI as the brain — same as all other directors.
 */
export async function handleMessageCreate(message: Message): Promise<void> {
  // Ignore bot messages (including our own webhook messages)
  if (message.author.bot) return;
  
  // Only respond in ceo-briefing channel
  const channel = message.channel;
  if (!('name' in channel) || (channel as any).name !== 'ceo-briefing') return;

  // Only respond to the Founder
  const founderId = config.discord.founderUserId;
  if (founderId && message.author.id !== founderId) return;

  logger.info(`Founder message in #ceo-briefing: ${message.content || '[attachment]'}`);

  let userText = message.content || '';

  // Check for voice memo attachments
  const voiceAttachment = message.attachments.find(
    (att) => att.contentType?.startsWith('audio/') || 
             att.name?.endsWith('.ogg') || 
             att.name?.endsWith('.mp3') || 
             att.name?.endsWith('.wav') ||
             att.name?.endsWith('.m4a') ||
             att.name?.endsWith('.webm')
  );

  if (voiceAttachment) {
    try { await (message.channel as any).sendTyping(); } catch {}

    const transcription = await transcribeVoiceMemo(voiceAttachment);
    if (transcription) {
      userText = transcription;
      
      const router = getChannelRouter();
      if (router) {
        await router.sendAsAgent('ceo-briefing', 'manus-prime', `Got your voice memo. Here's what I heard:\n\n"${transcription}"`);
      }
    } else {
      const router = getChannelRouter();
      if (router) {
        await router.sendAsAgent('ceo-briefing', 'manus-prime', "I couldn't transcribe that voice memo. Could you try sending it again or type it out?");
      }
      return;
    }
  }

  if (!userText.trim()) return;

  // Show typing indicator — keep refreshing it since Manus takes time
  const typingInterval = setInterval(async () => {
    try { await (message.channel as any).sendTyping(); } catch {}
  }, 5000);
  try { await (message.channel as any).sendTyping(); } catch {}

  try {
    // Get Prime's response via Manus AI
    const response = await getPrimeResponseViaManus(userText);

    const router = getChannelRouter();
    if (router) {
      if (response.length <= 2000) {
        await router.sendAsAgent('ceo-briefing', 'manus-prime', response);
      } else {
        const chunks = response.match(/[\s\S]{1,1900}/g) || [response];
        for (const chunk of chunks) {
          await router.sendAsAgent('ceo-briefing', 'manus-prime', chunk);
        }
      }
    } else {
      await message.reply(response);
    }
  } finally {
    clearInterval(typingInterval);
  }
}
