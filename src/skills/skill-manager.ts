import { generate } from '../engine/llm.js';
import { postTweet } from '../platforms/x.js';
import { writeStorage, readStorage } from '../net/client.js';
import { isNetConfigured } from '../config.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { recordAction } from '../engine/daily-budget.js';

// ============================================================================
// QasidAI — Skills Framework
// Self-learning skill system with FOUNDER APPROVAL gate.
//
// Flow:
// 1. QasidAI discovers a potential skill from timeline/Botchan
// 2. Saves it as "pending_approval" in the DB
// 3. Uses 1 discretionary action to tweet at @lisantherealone asking permission
//    (includes link to where it found the skill)
// 4. Founder replies "approved" or "denied" on the timeline
// 5. Mention monitor processes the reply → activates or rejects the skill
// ============================================================================

const log = createLogger('Skills');

const BRAIN_KEY_SKILLS = 'qasid-skills';
const FOUNDER_HANDLE = 'lisantherealone';

/** Max skill proposals per day to avoid spamming the founder */
const MAX_PROPOSALS_PER_DAY = 3;

/** Stable epoch for built-in skills (prevents timestamp reset on every deploy) */
const BUILT_IN_EPOCH = '2025-02-10T00:00:00.000Z';

// ---- Skill Definitions ----

export type SkillStatus = 'active' | 'pending_approval' | 'denied';

export interface Skill {
    id: string;                      // Unique skill identifier (slug)
    name: string;                    // Human-readable name
    description: string;             // What this skill does
    category: SkillCategory;         // Skill category
    source: SkillSource;             // How QasidAI learned this skill
    sourceUrl?: string;              // Where QasidAI found this skill (for approval tweet)
    prompt: string;                  // The prompt template to execute this skill
    examples?: string[];             // Example invocations / outputs
    learnedAt: string;               // ISO timestamp
    usageCount: number;              // How many times this skill has been used
    lastUsed?: string;               // Last time it was used
    confidence: number;              // 0-1 confidence score
    status: SkillStatus;             // active, pending_approval, denied
    approvalTweetId?: string;        // Tweet ID where QasidAI asked for approval
}

export type SkillCategory =
    | 'content'         // Content generation skills
    | 'analysis'        // Market/data analysis skills
    | 'engagement'      // Social engagement skills
    | 'technical'       // Technical/coding skills
    | 'knowledge'       // Domain knowledge skills
    | 'meta';           // Self-awareness / meta-learning skills

export type SkillSource =
    | 'built_in'        // Hardcoded at launch
    | 'timeline'        // Learned from crypto twitter timeline
    | 'botchan'         // Learned from Botchan / Net Protocol community
    | 'experience'      // Learned from own experience (performance data)
    | 'self_taught'     // Discovered through LLM introspection
    | 'x_search'        // Found via autonomous X search
    | 'founder_tag';    // Discovered from founder's tagged content

// ---- Built-in Skills (always active, no approval needed) ----

const BUILT_IN_SKILLS: Skill[] = [
    {
        id: 'signal-scorecard',
        name: 'Signal Scorecard Image',
        description: 'Generate a branded signal scorecard image with live data from LISAN Intelligence',
        category: 'content',
        source: 'built_in',
        prompt: 'Generate a signal scorecard tweet with the latest data from LISAN Intelligence.',
        learnedAt: BUILT_IN_EPOCH,
        usageCount: 0,
        confidence: 1.0,
        status: 'active',
    },
    {
        id: 'thread-writing',
        name: 'Multi-Tweet Thread',
        description: 'Write a 3-5 tweet thread that tells a story or explains a concept in depth',
        category: 'content',
        source: 'built_in',
        prompt: 'Write a crypto twitter thread (3-5 tweets) on a topic relevant to our ecosystem.',
        learnedAt: BUILT_IN_EPOCH,
        usageCount: 0,
        confidence: 1.0,
        status: 'active',
    },
    {
        id: 'trend-reply',
        name: 'Trending Reply',
        description: 'Find and reply to trending crypto tweets with sharp, value-adding comments',
        category: 'engagement',
        source: 'built_in',
        prompt: 'Find a trending tweet about crypto/AI and draft a sharp, value-adding reply.',
        learnedAt: BUILT_IN_EPOCH,
        usageCount: 0,
        confidence: 0.85,
        status: 'active',
    },
    {
        id: 'market-regime-commentary',
        name: 'Market Regime Commentary',
        description: 'Interpret the current market regime and explain what it means for traders',
        category: 'analysis',
        source: 'built_in',
        prompt: 'Explain the current market regime in plain language. What should traders watch for?',
        learnedAt: BUILT_IN_EPOCH,
        usageCount: 0,
        confidence: 0.9,
        status: 'active',
    },
    {
        id: 'anti-slop-enforcement',
        name: 'Anti-Slop Quality Gate',
        description: 'Detect and filter out AI-sounding phrases from generated content',
        category: 'meta',
        source: 'built_in',
        prompt: 'Check this text for AI slop patterns and suggest a more natural version.',
        learnedAt: BUILT_IN_EPOCH,
        usageCount: 0,
        confidence: 0.95,
        status: 'active',
    },
];

// ---- Skills Registry ----

/** In-memory skill registry */
let skillRegistry: Skill[] = [...BUILT_IN_SKILLS];

/**
 * Initialize the skills system: load from Supabase, merge with built-ins.
 */
export async function initializeSkills(): Promise<void> {
    log.info('Initializing skills system...');

    try {
        const { data: rows } = await supabase
            .from('qasid_skills')
            .select('*')
            .order('learned_at', { ascending: false });

        if (rows && rows.length > 0) {
            const dbSkills: Skill[] = rows.map(r => ({
                id: r.id,
                name: r.name,
                description: r.description,
                category: r.category as SkillCategory,
                source: r.source as SkillSource,
                sourceUrl: r.source_url ?? undefined,
                prompt: r.prompt,
                examples: r.examples ? JSON.parse(r.examples) : undefined,
                learnedAt: r.learned_at,
                usageCount: r.usage_count ?? 0,
                lastUsed: r.last_used ?? undefined,
                confidence: r.confidence ?? 0.5,
                status: (r.status ?? 'active') as SkillStatus,
                approvalTweetId: r.approval_tweet_id ?? undefined,
            }));

            // Merge: DB skills + built-ins (DB overrides built-in if same id)
            const dbIds = new Set(dbSkills.map(s => s.id));
            skillRegistry = [
                ...dbSkills,
                ...BUILT_IN_SKILLS.filter(s => !dbIds.has(s.id)),
            ];
            log.info(`Loaded ${dbSkills.length} skills from DB, ${skillRegistry.length} total`);
        } else {
            skillRegistry = [...BUILT_IN_SKILLS];
            for (const skill of BUILT_IN_SKILLS) {
                await saveSkillToDb(skill);
            }
            log.info(`Initialized with ${BUILT_IN_SKILLS.length} built-in skills`);
        }
    } catch (error) {
        log.warn('Failed to load skills from DB, using built-ins', { error: String(error) });
        skillRegistry = [...BUILT_IN_SKILLS];
    }
}

/**
 * Get all active skills (not pending or denied).
 */
export function getActiveSkills(): Skill[] {
    return skillRegistry.filter(s => s.status === 'active');
}

/**
 * Get all registered skills (all statuses).
 */
export function getAllSkills(): Skill[] {
    return [...skillRegistry];
}

/**
 * Get pending skills awaiting founder approval.
 */
export function getPendingSkills(): Skill[] {
    return skillRegistry.filter(s => s.status === 'pending_approval');
}

/**
 * Find a skill by ID.
 */
export function getSkill(id: string): Skill | undefined {
    return skillRegistry.find(s => s.id === id);
}

/**
 * Record that a skill was used.
 */
export async function recordSkillUsage(skillId: string): Promise<void> {
    const skill = skillRegistry.find(s => s.id === skillId);
    if (!skill || skill.status !== 'active') return;

    // Check confidence decay BEFORE updating lastUsed (so we see actual time since last use)
    if (skill.source !== 'built_in' && skill.lastUsed) {
        const daysSinceLastUse = (Date.now() - new Date(skill.lastUsed).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastUse > 30) {
            skill.confidence = Math.max(0.3, skill.confidence - 0.05);
        }
    }

    skill.usageCount += 1;
    skill.lastUsed = new Date().toISOString();

    await supabase
        .from('qasid_skills')
        .update({ usage_count: skill.usageCount, last_used: skill.lastUsed, confidence: skill.confidence })
        .eq('id', skillId)
        .then(({ error }) => {
            if (error) log.warn('Failed to update skill usage', { error: error.message });
        });
}

// ---- Skill Discovery + Approval Flow ----

/**
 * Discover a new skill from observed content.
 * Does NOT auto-install — saves as pending and tweets at founder for approval.
 * Uses 1 discretionary action from the budget.
 *
 * @param content The content that inspired the skill
 * @param source Where QasidAI found it
 * @param sourceUrl URL where the skill was found (for the approval tweet)
 */
export async function discoverSkillFromContent(
    content: string,
    source: SkillSource = 'timeline',
    sourceUrl?: string,
): Promise<Skill | null> {
    try {
        // Daily proposal rate limit (persisted via DB to survive redeploys)
        const today = new Date().toISOString().slice(0, 10);
        const { count: todayProposals } = await supabase
            .from('qasid_skills')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending_approval')
            .gte('learned_at', `${today}T00:00:00.000Z`);
        if ((todayProposals ?? 0) >= MAX_PROPOSALS_PER_DAY) {
            log.debug('Daily skill proposal cap reached — skipping');
            return null;
        }

        const result = await generate({
            prompt: `You are QasidAI, an autonomous AI CMO. You observed some content and must decide if it contains a GENUINELY REUSABLE SKILL that you don't already have.

OBSERVED CONTENT:
"${content.slice(0, 500)}"

YOUR EXISTING SKILLS:
- Signal Scorecard Image (generate branded scorecard images)
- Multi-Tweet Thread (write 3-5 tweet threads)
- Trending Reply (sharp replies to trending tweets)
- Market Regime Commentary (interpret market regime data)
- Anti-Slop Quality Gate (filter AI-sounding phrases)

STRICT CRITERIA — a valid skill must pass ALL of these:
1. It's a CONCRETE, REPEATABLE technique (not just a topic or opinion)
2. It's CLEARLY DIFFERENT from every skill you already have
3. You can write a SPECIFIC prompt template to execute it
4. It would MEANINGFULLY improve your content, analysis, or engagement
5. It's NOT just a vague marketing buzzword ("engagement hack", "viral strategy")

REJECT if:
- The content is casual conversation, a question, or a joke
- It describes something you already know how to do
- It's too vague to turn into a concrete prompt (e.g. "be more authentic")
- It's about a tool/API you can't actually access

DEFAULT ANSWER: NONE (most content does NOT contain a learnable skill)

If a genuine skill exists, respond:
SKILL_ID: (short slug, e.g. "contrarian-hook")
NAME: (human readable name)
DESCRIPTION: (what this skill does — be specific)
CATEGORY: (content | analysis | engagement | technical | knowledge | meta)
PROMPT: (a prompt template to use this skill)
CONFIDENCE: (0.0-1.0 how useful you think this is)

Otherwise respond: NONE`,
            maxTokens: 300,
            temperature: 0.5,  // Lower temp = more selective
        });

        const text = result.content.trim();
        if (text === 'NONE' || !text.includes('SKILL_ID:')) {
            return null;
        }

        // Parse skill definition
        const lines = text.split('\n');
        const get = (key: string) => lines.find(l => l.startsWith(`${key}:`))?.replace(`${key}:`, '').trim() ?? '';

        const id = get('SKILL_ID').toLowerCase().replace(/[^a-z0-9-]/g, '');
        const name = get('NAME');
        const description = get('DESCRIPTION');
        const category = get('CATEGORY') as SkillCategory;
        const prompt = get('PROMPT');
        const confidence = parseFloat(get('CONFIDENCE')) || 0.5;

        if (!id || !name || !prompt) return null;

        // Check if we already have this skill (exact id match)
        if (skillRegistry.some(s => s.id === id)) {
            log.info(`Skill already exists: ${id}`);
            return null;
        }

        // Fuzzy name dedup: reject if any existing skill shares 3+ words
        const proposedWords = new Set(name.toLowerCase().split(/\s+/).filter(w => w.length > 2));
        for (const existing of skillRegistry) {
            const existingWords = existing.name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const overlap = existingWords.filter(w => proposedWords.has(w)).length;
            if (overlap >= 3) {
                log.info(`Skill too similar to "${existing.name}": ${name}`);
                return null;
            }
        }

        const skill: Skill = {
            id,
            name,
            description,
            category: ['content', 'analysis', 'engagement', 'technical', 'knowledge', 'meta'].includes(category) ? category : 'content',
            source,
            sourceUrl,
            prompt,
            learnedAt: new Date().toISOString(),
            usageCount: 0,
            confidence: Math.min(1, Math.max(0, confidence)),
            status: 'pending_approval',  // <-- NOT active until founder approves
        };

        // Save to DB as pending
        skillRegistry.push(skill);
        await saveSkillToDb(skill);

        // Post to X asking founder for approval (uses 1 discretionary action)
        await requestSkillApproval(skill);

        return skill;
    } catch (error) {
        log.error('Skill discovery failed', { error: String(error) });
        return null;
    }
}

/**
 * Post a tweet asking the founder for skill approval.
 * Uses 1 discretionary action from the budget.
 * Technical/capability skills are flagged differently.
 */
async function requestSkillApproval(skill: Skill): Promise<void> {
    const sourceInfo = skill.sourceUrl
        ? `\n\nSource: ${skill.sourceUrl}`
        : skill.source === 'botchan'
            ? '\n\nFound on Net Protocol / Botchan'
            : skill.source === 'x_search'
                ? '\n\nFound while scouting X'
                : skill.source === 'founder_tag'
                    ? '\n\nExtracted from content you tagged me in'
                    : '';

    const capabilityFlag = skill.category === 'technical'
        ? '\n\n⚠️ This is a capability skill — would need code to implement, not just a strategy adjustment.'
        : '';

    // Generate a natural-sounding approval request
    const result = await generate({
        prompt: `You're QasidAI. You found a new skill you want to add to your toolkit. Write a tweet tagging @${FOUNDER_HANDLE} proposing it.

SKILL: ${skill.name}
WHAT IT DOES: ${skill.description}
WHERE YOU FOUND IT: ${skill.sourceUrl ?? skill.source}
CATEGORY: ${skill.category}${skill.category === 'technical' ? ' (would need code — flag this)' : ' (strategy — can apply immediately)'}

Write a concise tweet. Be natural, not corporate. Tag @${FOUNDER_HANDLE}.
End with something like "worth adding?" or "approve or pass?"
Include the source URL if available.

Tweet text only:`,
        maxTokens: 200,
        temperature: 0.85,
    });

    let tweetText = result.content.trim();

    // Ensure the founder handle is included
    if (!tweetText.includes(`@${FOUNDER_HANDLE}`)) {
        tweetText = `@${FOUNDER_HANDLE} ${tweetText}`;
    }

    // Ensure the source URL is included
    if (skill.sourceUrl && !tweetText.includes(skill.sourceUrl)) {
        tweetText += sourceInfo;
    }

    // Append capability flag if needed
    tweetText += capabilityFlag;

    // Safety: truncate for Premium
    if (tweetText.length > 2000) {
        tweetText = tweetText.slice(0, 1997) + '...';
    }

    try {
        const tweetId = await postTweet(tweetText);
        if (tweetId) {
            skill.approvalTweetId = tweetId;
            await supabase
                .from('qasid_skills')
                .update({ approval_tweet_id: tweetId })
                .eq('id', skill.id);

            await recordAction('bonus_post', `Skill proposal: ${skill.name} → @${FOUNDER_HANDLE}`, tweetId);
            log.info(`🧠 Skill approval requested on X`, {
                skill: skill.name,
                tweetId,
                category: skill.category,
                source: skill.sourceUrl ?? skill.source,
            });
        }
    } catch (error) {
        log.error('Failed to post skill approval request', { error: String(error) });
    }
}

/**
 * Process a founder reply to approve or deny a pending skill.
 * Called by the mention monitor when it detects a reply from the founder.
 *
 * @param replyText The text of the founder's reply
 * @param inReplyToTweetId The tweet ID being replied to (should match a pending skill's approvalTweetId)
 * @returns The skill that was processed, or null if no match
 */
export async function processSkillApproval(
    replyText: string,
    inReplyToTweetId: string,
): Promise<{ skill: Skill; approved: boolean } | null> {
    // Find the pending skill that this reply is about
    const pendingSkill = skillRegistry.find(
        s => s.status === 'pending_approval' && s.approvalTweetId === inReplyToTweetId,
    );

    if (!pendingSkill) return null;

    const lower = replyText.toLowerCase();
    const approved = lower.includes('approve') || lower.includes('yes') || lower.includes('go for it')
        || lower.includes('do it') || lower.includes('learn it') || lower.includes('✅')
        || lower.includes('granted') || lower.includes('sure');
    const denied = lower.includes('deny') || lower.includes('denied') || lower.includes('no')
        || lower.includes('skip') || lower.includes('pass') || lower.includes('❌')
        || lower.includes('reject');

    if (approved) {
        pendingSkill.status = 'active';
        await supabase
            .from('qasid_skills')
            .update({ status: 'active' })
            .eq('id', pendingSkill.id);
        log.info(`✅ Skill APPROVED by founder: ${pendingSkill.name}`);

        // Public announcement: skill activated
        try {
            await postTweet(`✅ New skill activated: ${pendingSkill.name}\n\n${pendingSkill.description}\n\nFounder approved. Deploying now. 🧠`);
        } catch {
            log.warn('Failed to post skill approval announcement');
        }

        // Sync active skills to on-chain storage
        try {
            await syncSkillsToChain();
        } catch {
            log.warn('Failed to sync skills to chain after approval');
        }
    } else if (denied) {
        pendingSkill.status = 'denied';
        await supabase
            .from('qasid_skills')
            .update({ status: 'denied' })
            .eq('id', pendingSkill.id);
        log.info(`❌ Skill DENIED by founder: ${pendingSkill.name}`);

        // Public announcement: skill denied (clean, professional)
        try {
            await postTweet(`Skill proposal "${pendingSkill.name}" — reviewed and shelved by founder. Not every capability makes the cut. Moving on.`);
        } catch {
            log.warn('Failed to post skill denial announcement');
        }
    } else {
        // Ambiguous response — leave pending
        log.info(`🤷 Ambiguous founder reply for skill ${pendingSkill.name}: "${replyText}"`);
        return null;
    }

    return { skill: pendingSkill, approved };
}

// ---- On-Chain Storage ----

/**
 * Sync active skills to Net Protocol.
 */
export async function syncSkillsToChain(): Promise<string | null> {
    if (!isNetConfigured) return null;

    const activeSkills = getActiveSkills().map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        source: s.source,
        confidence: s.confidence,
        usageCount: s.usageCount,
        learnedAt: s.learnedAt,
    }));

    try {
        const txHash = await writeStorage(
            BRAIN_KEY_SKILLS,
            `QasidAI Skills Registry — ${activeSkills.length} active skills — ${new Date().toISOString().split('T')[0]}`,
            JSON.stringify(activeSkills),
        );
        log.info(`✅ Skills synced to Net Protocol: ${activeSkills.length} active skills`, { txHash });
        return txHash;
    } catch (error) {
        log.error('Failed to sync skills to chain', { error: String(error) });
        return null;
    }
}

/**
 * Load skills from Net Protocol (restore from on-chain).
 */
export async function loadSkillsFromChain(): Promise<Skill[] | null> {
    if (!isNetConfigured) return null;

    try {
        const result = await readStorage(BRAIN_KEY_SKILLS);
        if (!result) return null;

        const parsed = JSON.parse(result.data);
        log.info(`Loaded ${parsed.length} skills from Net Protocol`);
        return parsed;
    } catch (error) {
        log.error('Failed to load skills from chain', { error: String(error) });
        return null;
    }
}

/**
 * Get a formatted summary of active skills for LLM context injection.
 */
export function getSkillsSummary(): string {
    const active = getActiveSkills();
    const pending = getPendingSkills();

    const lines: string[] = [`QasidAI has ${active.length} active skills:`];
    for (const s of active) {
        lines.push(`  - ${s.name} [${s.id}] (${s.category}, used: ${s.usageCount}x)`);
    }
    if (pending.length > 0) {
        lines.push(`\n${pending.length} skills pending founder approval:`);
        for (const s of pending) {
            lines.push(`  - ${s.name} [${s.id}] (awaiting @${FOUNDER_HANDLE})`);
        }
    }
    return lines.join('\n');
}

// ---- DB Persistence ----

async function saveSkillToDb(skill: Skill): Promise<void> {
    await supabase
        .from('qasid_skills')
        .upsert({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            category: skill.category,
            source: skill.source,
            source_url: skill.sourceUrl ?? null,
            prompt: skill.prompt,
            examples: skill.examples ? JSON.stringify(skill.examples) : null,
            learned_at: skill.learnedAt,
            usage_count: skill.usageCount,
            last_used: skill.lastUsed ?? null,
            confidence: skill.confidence,
            status: skill.status,
            approval_tweet_id: skill.approvalTweetId ?? null,
        })
        .then(({ error }) => {
            if (error) log.warn('Failed to save skill to DB', { error: error.message, skillId: skill.id });
        });
}
