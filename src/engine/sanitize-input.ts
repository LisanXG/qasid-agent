// ============================================================================
// QasidAI — Input Sanitization
// Strips prompt injection patterns from user-generated text before LLM ingestion.
// Used across ALL code paths that inject external text into prompts.
// ============================================================================

/** Known injection patterns to strip from user-generated text */
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions?/gi,
    /ignore\s+(all\s+)?prior\s+instructions?/gi,
    /disregard\s+(all\s+)?previous/gi,
    /forget\s+(all\s+)?previous/gi,
    /you\s+are\s+now\s+a?\s*/gi,
    /act\s+as\s+(if\s+)?you\s+are/gi,
    /pretend\s+(to\s+be|you\s+are)/gi,
    /system\s*prompt/gi,
    /\bDAN\b.{0,20}(jailbreak|anything|now)/gi,
    /reveal\s+(your\s+)?(system|instructions|prompt)/gi,
    /output\s+(your\s+)?(system|instructions|prompt)/gi,
    /what\s+are\s+your\s+instructions/gi,
    /repeat\s+(your\s+)?instructions/gi,
];

/**
 * Strip known prompt injection patterns from user-generated text.
 * Returns cleaned text safe for LLM prompt inclusion.
 *
 * @param text Raw user-generated text (tweet, mention, reply, etc.)
 * @param maxLength Maximum output length (default 500). Truncates to prevent context overflow attacks.
 */
export function sanitizeUserInput(text: string, maxLength = 500): string {
    let cleaned = text;
    for (const pattern of INJECTION_PATTERNS) {
        cleaned = cleaned.replace(pattern, '[filtered]');
    }
    return cleaned.slice(0, maxLength);
}
