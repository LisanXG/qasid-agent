import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { buildSystemPromptFromBrain } from '../personality/system-prompt.js';
import { createLogger } from '../logger.js';
import { withRetry } from '../retry.js';

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
    /** Optional time-of-day context for content tone */
    timeContext?: string;
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
    const { prompt, strategyContext, timeContext, maxTokens = 300, temperature = 0.9 } = options;

    const systemPrompt = await buildSystemPromptFromBrain(strategyContext, timeContext);

    log.debug('Generating content', { promptLength: prompt.length, maxTokens, temperature });

    return withRetry(async () => {
        const response = await getClient().messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
            temperature,
            // Prompt caching: system prompt (~9,700 tokens) stays cached for 5 min
            // Cuts input cost from $1.00/MTok → $0.10/MTok for cached portion
            system: [{
                type: 'text' as const,
                text: systemPrompt,
                cache_control: { type: 'ephemeral' as const },
            }],
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
    }, {
        maxRetries: 3,
        baseDelayMs: 1000,
        skipClientErrors: true,
        label: 'LLM generation',
        circuitBreakerKey: 'anthropic',
    });
}

