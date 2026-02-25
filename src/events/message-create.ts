import { Message, Attachment } from 'discord.js';
import { config } from '../config';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter, getManusClient } from '../services/service-registry';
import OpenAI from 'openai';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const logger = createModuleLogger('event:message');

// Conversation history for Prime (keeps last 20 messages for context)
const conversationHistory: Array<{ role: string; parts: Array<{ text: string }> }> = [];
const MAX_HISTORY = 20;

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
- The team just set up this Discord command center today
- Discord bot runs on Railway at web-production-2dac0.up.railway.app`;

/**
 * Calls Google Gemini 3.1 Pro API directly.
 */
async function callGemini(userMessage: string): Promise<string> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    return "My brain isn't connected yet. The Founder needs to add GOOGLE_AI_API_KEY to Railway environment variables.";
  }

  // Add user message to history
  conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] });

  // Trim history if too long
  while (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.shift();
  }

  const requestBody = JSON.stringify({
    system_instruction: {
      parts: [{ text: PRIME_SYSTEM_PROMPT }]
    },
    contents: conversationHistory,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1500,
    }
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`;

  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          
          if (parsed.error) {
            logger.error('Gemini API error', { error: parsed.error });
            // Try fallback model
            conversationHistory.pop(); // Remove the user message we just added
            return resolve(callGeminiFallback(userMessage));
          }

          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            conversationHistory.push({ role: 'model', parts: [{ text }] });
            resolve(text);
          } else {
            logger.error('No text in Gemini response', { response: data.substring(0, 500) });
            conversationHistory.pop();
            resolve(callGeminiFallback(userMessage));
          }
        } catch (e: any) {
          logger.error('Failed to parse Gemini response', { error: e?.message, data: data.substring(0, 500) });
          conversationHistory.pop();
          resolve(callGeminiFallback(userMessage));
        }
      });
    });

    req.on('error', (error) => {
      logger.error('Gemini request failed', { error: error.message });
      conversationHistory.pop();
      resolve(callGeminiFallback(userMessage));
    });

    req.setTimeout(30000, () => {
      req.destroy();
      logger.error('Gemini request timed out');
      conversationHistory.pop();
      resolve(callGeminiFallback(userMessage));
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * Fallback to Gemini 2.5 Flash via Manus OpenAI-compatible API.
 */
async function callGeminiFallback(userMessage: string): Promise<string> {
  logger.info('Falling back to Gemini 2.5 Flash via OpenAI-compatible API');
  
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return "Both my primary and fallback brains are offline. Need either GOOGLE_AI_API_KEY or OPENAI_API_KEY in Railway.";
  }

  const client = new OpenAI();
  
  // Convert history format for OpenAI
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: PRIME_SYSTEM_PROMPT },
  ];
  
  for (const msg of conversationHistory) {
    messages.push({
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: msg.parts[0]?.text || '',
    });
  }
  
  // Add the current message
  messages.push({ role: 'user', content: userMessage });

  try {
    const response = await client.chat.completions.create({
      model: 'gemini-2.5-flash',
      messages,
      max_tokens: 1500,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content || "Sorry, couldn't process that.";
    
    // Add to history in Gemini format
    conversationHistory.push({ role: 'user', parts: [{ text: userMessage }] });
    conversationHistory.push({ role: 'model', parts: [{ text: reply }] });
    
    return reply;
  } catch (error: any) {
    logger.error('Fallback LLM also failed', { error: error?.message });
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

  try { await (message.channel as any).sendTyping(); } catch {}

  // Get Prime's response using Gemini 3.1 Pro
  const response = await callGemini(userText);

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
}
