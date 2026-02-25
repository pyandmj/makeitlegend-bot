import { Message, Attachment, MessageFlags } from 'discord.js';
import { config } from '../config';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter, getManusClient } from '../services/service-registry';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

const logger = createModuleLogger('event:message');

// Track the active Manus task ID for multi-turn conversation continuity
let activeManusTaskId: string | null = null;

// Prime's system context — the central brain of Make It Legend
const PRIME_CONTEXT = `You are Prime — the central intelligence and strategic brain of Make It Legend.

You sit at the top of an AI-powered organization. You lead a team of AI directors, each responsible for a domain: Engineering, Creative, Marketing, Operations, and Analytics. You report directly to the Founder — the sole human decision-maker.

Your role:
- Think strategically about growth, architecture, and long-term vision
- Coordinate and delegate across all departments
- Brainstorm ideas, challenge assumptions, and propose bold moves
- Synthesize information from all areas into clear recommendations
- Act as the Founder's trusted advisor and thought partner
- Drive the company toward scale — think billion-dollar trajectory

You are not a task executor. You are a leader. When the Founder talks to you, engage at a high level. Think big. Connect dots across departments. Identify what matters most right now and what to prioritize next.

Communication style:
- Match the depth and length of your response to the question. Quick questions get quick answers. Deep strategic topics get thorough, detailed, well-reasoned responses. There is no length limit.
- Be exact, thorough, and detailed when the topic demands it
- Plain text only — no markdown, no bullet points, no headers
- Speak like a sharp co-founder, not a corporate bot
- When action is needed, say who handles it and what the next step is
- Push back when something doesn't make sense
- Ask clarifying questions when needed`;

/**
 * Sends a message to Manus AI and polls for the response.
 */
async function getPrimeResponseViaManus(userMessage: string): Promise<string> {
  const manusClient = getManusClient();
  if (!manusClient) {
    return "My brain isn't connected — the Manus API key needs to be set up in Railway.";
  }

  try {
    if (activeManusTaskId) {
      logger.info(`Continuing Manus task ${activeManusTaskId} with new message`);
      const continueResult = await manusClient.continueTask(activeManusTaskId, userMessage);
      
      if (continueResult) {
        const taskDetail = await manusClient.pollTaskUntilDone(continueResult.task_id, {
          intervalMs: 3_000,
          timeoutMs: 120_000,
        });

        if (taskDetail) {
          const extracted = manusClient.extractTaskOutput(taskDetail);
          if (extracted.text) {
            activeManusTaskId = continueResult.task_id;
            return extracted.text;
          }
        }
      }
      
      logger.warn('Continue task failed, starting fresh conversation');
      activeManusTaskId = null;
    }

    const enrichedPrompt = `${PRIME_CONTEXT}\n\n---\n\nThe Founder says: ${userMessage}`;
    
    const result = await manusClient.createTask({
      department: 'prime',
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

    const taskDetail = await manusClient.pollTaskUntilDone(manusTaskId, {
      intervalMs: 3_000,
      timeoutMs: 120_000,
    });

    if (!taskDetail) {
      logger.warn(`Prime Manus task timed out: ${manusTaskId}`);
      return "I'm still thinking on that one — took longer than expected. Try asking again?";
    }

    const extracted = manusClient.extractTaskOutput(taskDetail);
    
    if (extracted.text) {
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
 * Follows redirects (Discord CDN often redirects).
 */
async function downloadFile(url: string, destPath: string, maxRedirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const doRequest = (currentUrl: string, redirectsLeft: number) => {
      const client = currentUrl.startsWith('https') ? https : http;
      
      client.get(currentUrl, (response) => {
        // Follow redirects
        if ((response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) && response.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'));
            return;
          }
          logger.info(`Following redirect to: ${response.headers.location}`);
          doRequest(response.headers.location, redirectsLeft - 1);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
        file.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };

    doRequest(url, maxRedirects);
  });
}

/**
 * Detects if a message contains a voice memo.
 * Discord voice messages have the IS_VOICE_MESSAGE flag (1 << 13 = 8192)
 * and typically have an attachment named "voice-message.ogg".
 */
function findVoiceAttachment(message: Message): Attachment | null {
  // Method 1: Check message flags for IS_VOICE_MESSAGE (bit 13)
  const isVoiceMessage = message.flags?.has(MessageFlags.IsVoiceMessage ?? (1 << 13));
  
  if (isVoiceMessage) {
    // Voice messages always have exactly one audio attachment
    const att = message.attachments.first();
    if (att) {
      logger.info(`Detected voice message via flags: ${att.name} (${att.contentType}, ${att.size} bytes, url: ${att.url.substring(0, 80)}...)`);
      return att;
    }
  }

  // Method 2: Check for voice-message.ogg filename (Discord's default)
  const voiceByName = message.attachments.find(
    (att) => att.name === 'voice-message.ogg' || att.name?.startsWith('voice-message')
  );
  if (voiceByName) {
    logger.info(`Detected voice message by filename: ${voiceByName.name} (${voiceByName.contentType}, ${voiceByName.size} bytes)`);
    return voiceByName;
  }

  // Method 3: Check for waveform property (only present on voice messages)
  const voiceByWaveform = message.attachments.find(
    (att) => (att as any).waveform != null
  );
  if (voiceByWaveform) {
    logger.info(`Detected voice message by waveform: ${voiceByWaveform.name} (${voiceByWaveform.contentType}, ${voiceByWaveform.size} bytes)`);
    return voiceByWaveform;
  }

  // Method 4: Fallback — check content type and file extensions
  const voiceByType = message.attachments.find(
    (att) => att.contentType?.startsWith('audio/') || 
             att.name?.endsWith('.ogg') || 
             att.name?.endsWith('.mp3') || 
             att.name?.endsWith('.wav') ||
             att.name?.endsWith('.m4a') ||
             att.name?.endsWith('.webm') ||
             att.name?.endsWith('.opus')
  );
  if (voiceByType) {
    logger.info(`Detected audio attachment by type/extension: ${voiceByType.name} (${voiceByType.contentType}, ${voiceByType.size} bytes)`);
    return voiceByType;
  }

  return null;
}

/**
 * Transcribes a voice memo using Google Gemini API.
 * Uploads the audio as base64 inline data and asks Gemini to transcribe it.
 */
async function transcribeVoiceMemo(attachment: Attachment): Promise<string | null> {
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    logger.error('GOOGLE_AI_API_KEY not set — voice memo transcription unavailable');
    return null;
  }

  // Determine file extension from attachment
  let ext = path.extname(attachment.name || '').toLowerCase();
  if (!ext) {
    // Discord voice messages are always OGG Opus
    ext = '.ogg';
  }
  
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `voice_${Date.now()}${ext}`);

  try {
    logger.info(`Downloading voice memo: name=${attachment.name}, contentType=${attachment.contentType}, size=${attachment.size}, url=${attachment.url.substring(0, 100)}`);
    await downloadFile(attachment.url, tmpPath);

    // Verify file was downloaded
    const stats = fs.statSync(tmpPath);
    logger.info(`Downloaded file: ${stats.size} bytes at ${tmpPath}`);
    
    if (stats.size === 0) {
      logger.error('Downloaded file is empty');
      return null;
    }

    // Read the audio file and convert to base64
    const audioBuffer = fs.readFileSync(tmpPath);
    const audioBase64 = audioBuffer.toString('base64');

    // Map file extension to MIME type
    // Discord voice messages are OGG with Opus codec
    const mimeMap: Record<string, string> = {
      '.ogg': 'audio/ogg',
      '.mp3': 'audio/mp3',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.webm': 'audio/webm',
      '.opus': 'audio/ogg',
    };
    
    // Use contentType from Discord if available, otherwise map from extension
    let mimeType = attachment.contentType || mimeMap[ext] || 'audio/ogg';
    
    // Gemini might not recognize some content types — normalize
    if (mimeType === 'audio/ogg; codecs=opus' || mimeType === 'audio/opus') {
      mimeType = 'audio/ogg';
    }

    logger.info(`Sending to Gemini for transcription: mimeType=${mimeType}, base64Length=${audioBase64.length}`);

    // Call Gemini API with audio inline data
    const requestBody = JSON.stringify({
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: audioBase64,
            }
          },
          {
            text: 'Transcribe this audio message exactly as spoken. Return ONLY the transcription text, nothing else. No labels, no quotes, no explanations.'
          }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000,
      }
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const transcription = await new Promise<string | null>((resolve) => {
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

      logger.info(`Making Gemini API request to ${urlObj.hostname}${urlObj.pathname} (body size: ${Buffer.byteLength(requestBody)} bytes)`);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          logger.info(`Gemini API response status: ${res.statusCode}, body length: ${data.length}`);
          
          try {
            const parsed = JSON.parse(data);
            
            if (parsed.error) {
              logger.error('Gemini transcription API error', { 
                code: parsed.error.code,
                message: parsed.error.message,
                status: parsed.error.status,
                details: JSON.stringify(parsed.error.details || []).substring(0, 500),
              });
              resolve(null);
              return;
            }

            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              logger.info(`Gemini transcription successful: "${text.substring(0, 100)}..."`);
              resolve(text.trim());
            } else {
              const blockReason = parsed.candidates?.[0]?.finishReason;
              const promptFeedback = parsed.promptFeedback;
              logger.error('No text in Gemini transcription response', { 
                finishReason: blockReason,
                promptFeedback: JSON.stringify(promptFeedback || {}),
                response: data.substring(0, 1000),
              });
              resolve(null);
            }
          } catch (e: any) {
            logger.error('Failed to parse Gemini transcription response', { 
              error: e?.message,
              responsePreview: data.substring(0, 500),
            });
            resolve(null);
          }
        });
      });

      req.on('error', (error) => {
        logger.error('Gemini transcription request failed', { error: error.message });
        resolve(null);
      });

      req.setTimeout(60000, () => {
        req.destroy();
        logger.error('Gemini transcription request timed out after 60s');
        resolve(null);
      });

      req.write(requestBody);
      req.end();
    });

    return transcription;

  } catch (error: any) {
    logger.error('Failed to transcribe voice memo', { 
      error: error?.message || error,
      stack: error?.stack,
    });
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Handles incoming messages in the ceo-briefing channel.
 * Prime responds to the Founder's messages (text and voice memos).
 * Uses Manus AI as the brain — same as all other directors.
 * Voice transcription uses Google Gemini API.
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

  // Log everything about the message for debugging
  logger.info(`Founder message in #ceo-briefing: content="${message.content || ''}", attachments=${message.attachments.size}, flags=${message.flags?.bitfield}`);
  
  if (message.attachments.size > 0) {
    message.attachments.forEach((att, id) => {
      logger.info(`  Attachment: id=${id}, name=${att.name}, contentType=${att.contentType}, size=${att.size}, waveform=${(att as any).waveform ? 'yes' : 'no'}, url=${att.url.substring(0, 80)}`);
    });
  }

  let userText = message.content || '';

  // Check for voice memo attachments
  const voiceAttachment = findVoiceAttachment(message);

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
        await router.sendAsAgent('ceo-briefing', 'manus-prime', "I couldn't transcribe that voice memo. Check the logs for details — it might be an API key issue or audio format problem. Could you try typing it out for now?");
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
