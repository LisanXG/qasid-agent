/**
 * Quick test: Force QasidAI to generate and post an AI image.
 * Run: npx tsx scripts/test-image-post.ts
 */
import { generateContentImage, isImageGenConfigured } from '../src/engine/image-gen.js';
import { generatePost } from '../src/engine/content.js';
import { postTweetWithImage } from '../src/platforms/x.js';

async function main() {
    console.log('🖼️  Testing AI image pipeline...\n');

    // 1. Check Replicate config
    if (!isImageGenConfigured()) {
        console.error('❌ REPLICATE_API_TOKEN not set. Cannot generate images.');
        process.exit(1);
    }
    console.log('✅ Replicate API configured');

    // 2. Generate a post (engagement_bait — an image-eligible type)
    console.log('📝 Generating post content...');
    const post = await generatePost({ contentType: 'engagement_bait' });
    console.log(`📝 Post (${post.contentType}): ${post.content.slice(0, 120)}...\n`);

    // 3. Generate AI image
    console.log('🎨 Generating AI image via Replicate Flux...');
    const image = await generateContentImage(post.content, post.contentType);
    if (!image) {
        console.error('❌ Image generation failed');
        process.exit(1);
    }
    console.log(`✅ Image generated (${image.mimeType}, ${(image.buffer.length / 1024).toFixed(1)} KB)`);
    console.log(`   Prompt: ${image.prompt.slice(0, 100)}...`);

    // 4. Post to X with image
    console.log('\n📤 Posting to X with image...');
    const tweetId = await postTweetWithImage(post.content, image.buffer, image.mimeType);
    if (tweetId) {
        console.log(`\n🎉 SUCCESS! Tweet posted with AI image`);
        console.log(`   https://x.com/QasidAI34321/status/${tweetId}`);
    } else {
        console.error('❌ Failed to post tweet with image');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
