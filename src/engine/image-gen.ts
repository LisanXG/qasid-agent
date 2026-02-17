import { config } from '../config.js';
import { generate } from './llm.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — AI Image Generation
// Generates branded images using Replicate's Flux model via HTTP API.
// No npm dependency required — uses native fetch.
// ============================================================================

const log = createLogger('ImageGen');

// Fix 4: Startup warning for missing Replicate token
if (!config.REPLICATE_API_TOKEN) {
    log.warn('⚠️ REPLICATE_API_TOKEN not set — AI image generation disabled. Set it in Railway env vars to enable.');
}

const REPLICATE_API_URL = 'https://api.replicate.com/v1/predictions';

// Lisan brand style guidance for image prompts
const BRAND_STYLE = `Dark, futuristic aesthetic. Deep navy/midnight blue palette with gold and cyan accents.
Clean, professional crypto/fintech vibes. Minimalist, data-driven feel.
Subtle grid patterns, circuit board textures, or abstract data visualizations.
NO text in the image. NO faces. NO logos. Abstract and geometric preferred.`;

export interface GeneratedImage {
    buffer: Buffer;
    prompt: string;
    mimeType: string;
}

/**
 * Check if image generation is configured.
 */
export function isImageGenConfigured(): boolean {
    return !!config.REPLICATE_API_TOKEN;
}

/**
 * Generate an image for a given topic/content.
 * First, the LLM generates an optimized image prompt from the content.
 * Then, Replicate's Flux model generates the image.
 */
export async function generateContentImage(content: string, contentType: string): Promise<GeneratedImage | null> {
    if (!config.REPLICATE_API_TOKEN) {
        log.debug('REPLICATE_API_TOKEN not set — skipping image generation');
        return null;
    }

    try {
        // Step 1: Generate an optimized image prompt using the LLM
        const promptResult = await generate({
            prompt: `Generate a concise image prompt for an AI image generator (Flux).

The image should visually complement this crypto/AI marketing tweet:
"${content}"

CONTENT TYPE: ${contentType}
BRAND STYLE: ${BRAND_STYLE}

Rules:
- One paragraph, max 100 words
- Describe the visual composition, colors, mood, and elements
- Focus on abstract/data-driven visuals, NOT literal depictions
- NO text, logos, faces, or product screenshots
- Think: Bloomberg Terminal meets cyberpunk meets clean fintech
- Include lighting direction and atmosphere

Reply with ONLY the image prompt:`,
            maxTokens: 150,
            temperature: 0.7,
        });

        const imagePrompt = promptResult.content.trim();
        log.info('Generated image prompt', { prompt: imagePrompt.slice(0, 100) });

        // Step 2: Call Replicate's Flux model
        const image = await callReplicate(imagePrompt);
        if (!image) return null;

        return {
            buffer: image,
            prompt: imagePrompt,
            mimeType: 'image/webp',
        };
    } catch (error) {
        log.error('Image generation failed', { error: String(error) });
        return null;
    }
}

/**
 * Generate a standalone scroll-stopper image with a hot take.
 * Returns both the tweet text and the image.
 */
export async function generateScrollStopper(): Promise<{ text: string; image: GeneratedImage } | null> {
    if (!config.REPLICATE_API_TOKEN) {
        return null;
    }

    try {
        const result = await generate({
            prompt: `Generate a short, punchy crypto/AI hot take (under 200 chars) that would pair well with an eye-catching visual.

Topics: AI agents, autonomous marketing, on-chain data, solo builders, crypto culture.
Voice: QasidAI — sharp, caustic, data-driven, slightly unhinged yet professional.

Reply with ONLY the tweet text:`,
            maxTokens: 80,
            temperature: 0.95,
        });

        const text = result.content.trim();
        const image = await generateContentImage(text, 'engagement_bait');
        if (!image) return null;

        return { text, image };
    } catch (error) {
        log.error('Scroll stopper generation failed', { error: String(error) });
        return null;
    }
}

// ---- Replicate HTTP Client ----

async function callReplicate(prompt: string): Promise<Buffer | null> {
    try {
        // Create prediction
        const createResponse = await fetch(REPLICATE_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.REPLICATE_API_TOKEN}`,
                'Content-Type': 'application/json',
                'Prefer': 'wait', // Synchronous mode — waits up to 60s
            },
            body: JSON.stringify({
                // Flux Schnell — fastest, cheapest (~$0.003/image)
                version: 'black-forest-labs/flux-schnell',
                input: {
                    prompt,
                    num_outputs: 1,
                    aspect_ratio: '16:9',
                    output_format: 'webp',
                    output_quality: 80,
                },
            }),
        });

        if (!createResponse.ok) {
            const errorText = await createResponse.text();
            log.error('Replicate API error', { status: createResponse.status, error: errorText });
            return null;
        }

        const prediction = await createResponse.json() as any;

        // If using synchronous mode and prediction is complete
        if (prediction.status === 'succeeded' && prediction.output) {
            const imageUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
            return await downloadImage(imageUrl);
        }

        // If async, poll for completion
        if (prediction.urls?.get) {
            return await pollPrediction(prediction.urls.get);
        }

        log.error('Unexpected Replicate response', { prediction });
        return null;
    } catch (error) {
        log.error('Replicate API call failed', { error: String(error) });
        return null;
    }
}

async function pollPrediction(url: string): Promise<Buffer | null> {
    const maxAttempts = 30; // 30 * 2s = 60s max
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${config.REPLICATE_API_TOKEN}`,
            },
        });

        if (!response.ok) continue;
        const prediction = await response.json() as any;

        if (prediction.status === 'succeeded' && prediction.output) {
            const imageUrl = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
            return await downloadImage(imageUrl);
        }
        if (prediction.status === 'failed' || prediction.status === 'canceled') {
            log.error('Prediction failed', { status: prediction.status, error: prediction.error });
            return null;
        }
    }
    log.error('Prediction timed out after 60s');
    return null;
}

async function downloadImage(url: string): Promise<Buffer | null> {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        log.error('Failed to download generated image', { error: String(error) });
        return null;
    }
}
