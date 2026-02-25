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

// Conversation history for Prime (keeps last 20 messages for context)
const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
const MAX_HISTORY = 20;

// OpenAI client for LLM responses and transcription
let openaiClient: OpenAI | null = null;

function getOpenAI(): OpenAI | null {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      logger.warn('OPENAI_API_KEY not set — Prime cannot respond to messages');
      return null;
    }
    openaiClient = new OpenAI();
  }
  return openaiClient;
}

// Prime's system prompt
const PRIME_SYSTEM_PROMPT = `You are Prime, the AI coordinator for Make It Legend — an AI pet portrait business. You are the brain of the operation, managing a team of AI directors:

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
- The team just set up this Discord command center today`;

/**
 * Downloads a file from a URL to a temporary path.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      // Handle redirects
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
  const openai = getOpenAI();
  if (!openai) return null;

  const tmpDir = os.tmpdir();
  const ext = path.extname(attachment.name || '.ogg') || '.ogg';
  const tmpPath = path.join(tmpDir, `voice_${Date.now()}${ext}`);

  try {
    logger.info(`Downloading voice memo: ${attachment.name} (${attachment.size} bytes)`);
    await downloadFile(attachment.url, tmpPath);

    logger.info('Transcribing voice memo with Whisper...');
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
    });

    logger.info(`Transcription complete: ${transcription.text.substring(0, 100)}...`);
    return transcription.text;
  } catch (error: any) {
    logger.error('Failed to transcribe voice memo', { error: error?.message || error });
    return null;
  } finally {
    // Clean up temp file
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Gets Prime's response using LLM.
 */
async function getPrimeResponse(userMessage: string): Promise<string> {
  const openai = getOpenAI();
  if (!openai) {
    return "I can't respond right now — my AI brain isn't connected. The Founder needs to add the OPENAI_API_KEY to Railway environment variables.";
  }

  // Add user message to history
  conversationHistory.push({ role: 'user', content: userMessage });
  
  // Trim history if too long
  while (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.shift();
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: PRIME_SYSTEM_PROMPT },
        ...conversationHistory,
      ],
      max_tokens: 1000,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content || "Sorry, I couldn't process that. Try again?";
    
    // Add assistant reply to history
    conversationHistory.push({ role: 'assistant', content: reply });
    
    return reply;
  } catch (error: any) {
    logger.error('Failed to get Prime response', { error: error?.message || error });
    return "Something went wrong on my end. Let me try again in a moment.";
  }
}

/**
 * Handles incoming messages in the ceo-briefing channel.
 * Prime responds to the Founder's messages (text and voice memos).
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
    // Show typing indicator
    try { await (message.channel as any).sendTyping(); } catch {}

    const transcription = await transcribeVoiceMemo(voiceAttachment);
    if (transcription) {
      userText = transcription;
      
      // Post the transcription so the Founder can see what was understood
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

  // If no text content at all, ignore
  if (!userText.trim()) return;

  // Show typing indicator
  try { await (message.channel as any).sendTyping(); } catch {}

  // Get Prime's response
  const response = await getPrimeResponse(userText);

  // Send response as Prime via webhook
  const router = getChannelRouter();
  if (router) {
    // Split long responses into chunks (Discord 2000 char limit)
    if (response.length <= 2000) {
      await router.sendAsAgent('ceo-briefing', 'manus-prime', response);
    } else {
      const chunks = response.match(/[\s\S]{1,1900}/g) || [response];
      for (const chunk of chunks) {
        await router.sendAsAgent('ceo-briefing', 'manus-prime', chunk);
      }
    }
  } else {
    // Fallback: reply directly
    await message.reply(response);
  }
}
