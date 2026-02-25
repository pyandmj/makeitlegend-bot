import { Message, Attachment, MessageFlags } from 'discord.js';
import { config } from '../config';
import { createModuleLogger } from '../utils/logger';
import { getChannelRouter, getManusClient } from '../services/service-registry';

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
 * Detects if a message contains a voice memo.
 * Discord voice messages have the IS_VOICE_MESSAGE flag (1 << 13 = 8192)
 * and typically have an attachment named "voice-message.ogg".
 */
function findVoiceAttachment(message: Message): Attachment | null {
  // Method 1: Check message flags for IS_VOICE_MESSAGE (bit 13)
  const isVoiceMessage = message.flags?.has(MessageFlags.IsVoiceMessage ?? (1 << 13));
  
  if (isVoiceMessage) {
    const att = message.attachments.first();
    if (att) {
      console.log(`[VOICE] Detected voice message via flags: ${att.name} (${att.contentType}, ${att.size} bytes)`);
      return att;
    }
  }

  // Method 2: Check for voice-message.ogg filename
  const voiceByName = message.attachments.find(
    (att) => att.name === 'voice-message.ogg' || att.name?.startsWith('voice-message')
  );
  if (voiceByName) {
    console.log(`[VOICE] Detected voice message by filename: ${voiceByName.name}`);
    return voiceByName;
  }

  // Method 3: Check for waveform property
  const voiceByWaveform = message.attachments.find(
    (att) => (att as any).waveform != null
  );
  if (voiceByWaveform) {
    console.log(`[VOICE] Detected voice message by waveform: ${voiceByWaveform.name}`);
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
    console.log(`[VOICE] Detected audio attachment by type/extension: ${voiceByType.name}`);
    return voiceByType;
  }

  return null;
}

/**
 * Transcribes a voice memo using Google Gemini API.
 * Uses native fetch to download the audio and send to Gemini.
 */
async function transcribeVoiceMemo(attachment: Attachment): Promise<string | null> {
  const apiKey = config.googleAi?.apiKey || process.env.GOOGLE_AI_API_KEY;
  
  console.log(`[VOICE] transcribeVoiceMemo called. API key present: ${!!apiKey}, API key length: ${apiKey?.length || 0}`);
  
  if (!apiKey) {
    console.error('[VOICE] GOOGLE_AI_API_KEY not set! Cannot transcribe.');
    return null;
  }

  try {
    // Download the audio file using fetch (handles redirects automatically)
    const downloadUrl = attachment.proxyURL || attachment.url;
    console.log(`[VOICE] Downloading from: ${downloadUrl.substring(0, 150)}`);
    
    const downloadResponse = await fetch(downloadUrl);
    console.log(`[VOICE] Download status: ${downloadResponse.status}, content-type: ${downloadResponse.headers.get('content-type')}`);
    
    if (!downloadResponse.ok) {
      console.error(`[VOICE] Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`);
      return null;
    }

    const audioBuffer = Buffer.from(await downloadResponse.arrayBuffer());
    console.log(`[VOICE] Downloaded ${audioBuffer.length} bytes`);
    
    if (audioBuffer.length === 0) {
      console.error('[VOICE] Downloaded file is empty');
      return null;
    }

    const audioBase64 = audioBuffer.toString('base64');

    // Determine MIME type — Discord voice memos are always OGG Opus
    let mimeType = attachment.contentType || 'audio/ogg';
    if (mimeType.includes(';')) {
      mimeType = mimeType.split(';')[0].trim();
    }
    if (mimeType === 'audio/opus') {
      mimeType = 'audio/ogg';
    }

    console.log(`[VOICE] Sending to Gemini: mimeType=${mimeType}, base64Length=${audioBase64.length}`);

    // Call Gemini API using fetch
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      }),
    });

    console.log(`[VOICE] Gemini response status: ${geminiResponse.status}`);
    
    const geminiData: any = await geminiResponse.json();
    
    if (geminiData.error) {
      console.error(`[VOICE] Gemini API error: ${geminiData.error.code} - ${geminiData.error.message}`);
      return null;
    }

    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      console.log(`[VOICE] Transcription successful: "${text.substring(0, 100)}"`);
      return text.trim();
    } else {
      console.error(`[VOICE] No text in response. finishReason: ${geminiData.candidates?.[0]?.finishReason}, response: ${JSON.stringify(geminiData).substring(0, 500)}`);
      return null;
    }

  } catch (error: any) {
    console.error(`[VOICE] Transcription error: ${error?.message || error}`);
    console.error(`[VOICE] Stack: ${error?.stack}`);
    return null;
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

  // Log everything about the message for debugging — use console.log to guarantee Railway visibility
  console.log(`[PRIME] Founder message in #ceo-briefing: content="${message.content || ''}", attachments=${message.attachments.size}, flags=${message.flags?.bitfield}`);
  
  if (message.attachments.size > 0) {
    message.attachments.forEach((att, id) => {
      console.log(`[PRIME] Attachment: id=${id}, name=${att.name}, contentType=${att.contentType}, size=${att.size}, waveform=${(att as any).waveform ? 'yes' : 'no'}`);
    });
  }

  let userText = message.content || '';

  // If the user is replying to a specific message, include that context
  if (message.reference?.messageId) {
    try {
      const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMsg) {
        const refAuthor = referencedMsg.author?.username || referencedMsg.author?.tag || 'someone';
        const refContent = referencedMsg.content || '';
        const embedTexts = referencedMsg.embeds?.map(e => [e.title, e.description, ...(e.fields?.map(f => `${f.name}: ${f.value}`) || [])].filter(Boolean).join('\n')).join('\n') || '';
        const refText = refContent || embedTexts;
        if (refText) {
          userText = `[Replying to ${refAuthor}'s message: "${refText.substring(0, 1000)}"]\n\n${userText}`;
          console.log(`[PRIME] Included reply context from ${refAuthor}: ${refText.substring(0, 100)}...`);
        }
      }
    } catch (err: any) {
      console.warn(`[PRIME] Could not fetch referenced message: ${err?.message}`);
    }
  }

  // Check for voice memo attachments
  const voiceAttachment = findVoiceAttachment(message);

  if (voiceAttachment) {
    console.log(`[PRIME] Voice memo detected — starting transcription`);
    try { await (message.channel as any).sendTyping(); } catch {}

    const transcription = await transcribeVoiceMemo(voiceAttachment);
    if (transcription) {
      userText = transcription;
      
      const router = getChannelRouter();
      if (router) {
        await router.sendAsAgent('ceo-briefing', 'manus-prime', `Got your voice memo. Here's what I heard:\n\n"${transcription}"`);
      }
    } else {
      console.error(`[PRIME] Voice transcription failed — returning error to user`);
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
