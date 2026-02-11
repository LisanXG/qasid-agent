import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { buildSystemPrompt } from '../personality/system-prompt.js';
import { createLogger } from '../logger.js';

// ============================================================================
// QasidAI — LLM Client
// Handles all communication with Claude API
// ============================================================================

const log = createLogger('LLM');

let client: Anthropic | null = null;

function getClient(): Anthropic {
    if (!client) {
        client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    }
    return client;
}

export interface GenerateOptions {
    /** The user-facing prompt (what to generate) */
    prompt: string;
    /** Optional strategy context from learning engine */
    strategyContext?: string;
    /** Max tokens for response */
    maxTokens?: number;
    /** Temperature (0-1, higher = more creative) */
    temperature?: number;
}

export interface GenerateResult {
    content: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const { prompt, strategyContext, maxTokens = 300, temperature = 0.9 } = options;

    const systemPrompt = buildSystemPrompt(strategyContext);

    log.debug('Generating content', { promptLength: prompt.length, maxTokens, temperature });

    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await getClient().messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: maxTokens,
                temperature,
                system: systemPrompt,
                messages: [{ role: 'user', content: prompt }],
            });

            const textBlock = response.content.find(block => block.type === 'text');
            const content = textBlock ? textBlock.text : '';

            const result: GenerateResult = {
                content,
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                model: response.model,
            };

            log.info('Generated content', {
                tokens: `${result.inputTokens}in/${result.outputTokens}out`,
                contentLength: content.length,
            });

            return result;
        } catch (error: any) {
            // Don't retry client errors (auth, billing, bad request)
            const status = error?.status ?? error?.statusCode;
            if (status && status >= 400 && status < 500) {
                log.error('LLM generation failed (non-retryable)', { error: String(error), status });
                throw error;
            }

            if (attempt < MAX_RETRIES) {
                const delay = Math.pow(2, attempt) * 1000; // 2s, 4s
                log.warn(`LLM attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms...`, { error: String(error) });
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                log.error('LLM generation failed after all retries', { error: String(error) });
                throw error;
            }
        }
    }

    // Unreachable, but TypeScript needs it
    throw new Error('LLM generation failed');
}
