import { generate } from './llm.js';
import { addKnowledge } from './dynamic-knowledge.js';
import { supabase } from '../supabase.js';
import { createLogger } from '../logger.js';
import { createHash } from 'node:crypto';
import { withRetry } from '../retry.js';

// ============================================================================
// QasidAI — GitHub Organization Monitor
// Watches github.com/LisanXG for new repos and README changes
// Uses GitHub's public REST API (no auth required, 60 req/hr limit)
// ============================================================================

const log = createLogger('GitHubMonitor');

const GITHUB_ORG = 'LisanXG';
const GITHUB_API = 'https://api.github.com';

interface GitHubRepo {
    name: string;
    full_name: string;
    description: string | null;
    html_url: string;
    updated_at: string;
    pushed_at: string;
    language: string | null;
    stargazers_count: number;
    topics: string[];
}

/**
 * Fetch all public repos for the GitHub org.
 */
async function fetchOrgRepos(): Promise<GitHubRepo[]> {
    try {
        const response = await fetch(
            `${GITHUB_API}/orgs/${GITHUB_ORG}/repos?sort=updated&per_page=30`,
            {
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': 'QasidAI/1.0',
                },
                signal: AbortSignal.timeout(15_000),
            },
        );

        if (!response.ok) {
            log.warn('GitHub API returned non-200', { status: response.status });
            return [];
        }

        return await response.json() as GitHubRepo[];
    } catch (error) {
        log.warn('GitHub API fetch failed', { error: String(error) });
        return [];
    }
}

/**
 * Fetch a repo's README content.
 */
async function fetchReadme(repoFullName: string): Promise<string | null> {
    try {
        const response = await fetch(
            `${GITHUB_API}/repos/${repoFullName}/readme`,
            {
                headers: {
                    'Accept': 'application/vnd.github.raw+json',
                    'User-Agent': 'QasidAI/1.0',
                },
                signal: AbortSignal.timeout(10_000),
            },
        );

        if (!response.ok) return null;
        const text = await response.text();
        return text.slice(0, 4000); // Cap README length
    } catch {
        return null;
    }
}

function hashContent(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Check a single repo for README changes or if it's new.
 */
async function checkRepo(repo: GitHubRepo): Promise<number> {
    const url = `github://${repo.full_name}/README`;
    const readme = await fetchReadme(repo.full_name);

    if (!readme || readme.length < 20) return 0;

    const newHash = hashContent(readme);

    // Check stored hash
    const { data: existing } = await supabase
        .from('qasid_content_hashes')
        .select('hash, raw_text')
        .eq('url', url)
        .single();

    if (existing?.hash === newHash) return 0;

    const isNew = !existing;
    log.info(`${isNew ? 'New repo' : 'README change'}: ${repo.full_name}`);

    const result = await withRetry(async () => {
        return generate({
            prompt: `You are QasidAI, autonomous CMO of Lisan Holdings. A GitHub repository in the LisanXG organization has been ${isNew ? 'discovered' : 'updated'}.

REPO: ${repo.full_name}
DESCRIPTION: ${repo.description ?? 'No description'}
LANGUAGE: ${repo.language ?? 'Unknown'}
URL: ${repo.html_url}
TOPICS: ${repo.topics?.join(', ') || 'none'}

README CONTENT:
${readme.slice(0, 2000)}

${isNew
                    ? 'This is a NEW repository. Extract the key facts about what this repo is, what it does, and why it matters for Lisan Holdings.'
                    : `PREVIOUS README:\n${(existing?.raw_text ?? '').slice(0, 1000)}\n\nWhat changed? Extract any new features, updates, or important changes.`
                }

If nothing meaningful, respond with: NONE

Output specific facts, one per line:`,
            maxTokens: 250,
            temperature: 0.3,
        });
    }, {
        maxRetries: 2,
        baseDelayMs: 1000,
        label: 'github readme extraction',
        circuitBreakerKey: 'anthropic',
    });

    // Update stored hash
    await supabase
        .from('qasid_content_hashes')
        .upsert({
            url,
            hash: newHash,
            raw_text: readme.slice(0, 3000),
            checked_at: new Date().toISOString(),
        }, { onConflict: 'url' });

    const text = result.content.trim();
    if (text === 'NONE' || text.length < 5) return 0;

    const facts = text
        .split('\n')
        .map(line => line.replace(/^[-•*]\s*/, '').trim())
        .filter(line => line.length > 10);

    let stored = 0;
    for (const fact of facts) {
        const added = await addKnowledge(fact, 'github_scrape', repo.html_url);
        if (added) stored++;
    }

    return stored;
}

/**
 * Run the GitHub org monitor — checks all repos for changes.
 */
export async function runGitHubMonitor(): Promise<number> {
    log.info('🐙 GitHub monitor starting...');

    const repos = await fetchOrgRepos();
    if (repos.length === 0) {
        log.info('No repos found for org');
        return 0;
    }

    log.info(`Found ${repos.length} repo(s) in ${GITHUB_ORG}`);

    let totalFacts = 0;

    for (const repo of repos) {
        try {
            const facts = await checkRepo(repo);
            totalFacts += facts;
        } catch (error) {
            log.warn('Failed to check repo', { repo: repo.full_name, error: String(error) });
        }
    }

    log.info(`🐙 GitHub monitor complete: ${totalFacts} new fact(s) from ${repos.length} repo(s)`);
    return totalFacts;
}
